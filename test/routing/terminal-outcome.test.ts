import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  JsonObject,
  Protocol,
  TerminalCoordinator,
  TerminalFact,
  TraceSession,
} from "../../src/domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../../src/domain/operations.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import {
  buildTerminalFact,
  finalizeTerminal,
  type TerminalFactContext,
  type TerminalOutcome,
} from "../../src/routing/terminal-outcome.ts";
import { systemClock } from "../../src/routing/timing.ts";

/**
 * Unit and coordinator-composition tests for the shared terminal-outcome vocabulary.
 *
 * The unit tests pin the spec → fact mapping {@link buildTerminalFact} owns — status and
 * outcome category derivation, trace terminal shapes, and context merging — without any
 * stream, relay, or HTTP machinery. The functional tests then push specs through the real
 * exactly-once {@link createTerminalCoordinator} (with a capturing trace and observer) to
 * prove that the derived facts drive the trace terminal write, the telemetry fields, and
 * the completion-log gating exactly as the hand-built facts did before the vocabulary was
 * extracted.
 */

const ALL_PROTOCOLS: readonly Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"];

function failureOf(category: IrFailureCategory): NormalizedFailure {
  return { category, message: `failure for ${category}`, retryable: false };
}

/** Default request context exercising every shared field, overridable per test. */
function context(overrides: Partial<TerminalFactContext> = {}): TerminalFactContext {
  return {
    attempts: 3,
    stream: true,
    clientProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    provider: "provider-a",
    canonicalPublicName: "model-a",
    ...overrides,
  };
}

// ============================================================================
// Unit: the outcome vocabulary derives status, category, and trace terminal.
// ============================================================================

test.concurrent("complete spec yields the complete category, the delivered status, and a complete trace terminal", () => {
  const fact = buildTerminalFact(context(), { kind: "complete", status: 200 });
  assert.equal(fact.outcomeCategory, "complete");
  assert.equal(fact.status, 200);
  assert.deepEqual(fact.terminal, { kind: "complete", status: 200 });
});

test.concurrent("complete spec carries usage and cost into both the fact and the trace terminal", () => {
  const usage: JsonObject = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
  const fact = buildTerminalFact(context(), { kind: "complete", status: 201, usage, estimatedCostUsd: "0.00012" });
  assert.equal(fact.outcomeCategory, "complete");
  assert.equal(fact.status, 201);
  assert.deepEqual(fact.usage, usage);
  assert.equal(fact.estimatedCostUsd, "0.00012");
  assert.deepEqual(fact.terminal, { kind: "complete", status: 201, usage, estimatedCostUsd: "0.00012" });
});

test.concurrent("complete spec without usage leaves both the fact and terminal free of usage keys", () => {
  const fact = buildTerminalFact(context(), { kind: "complete", status: 200 });
  assert.equal("usage" in fact, false, "top-level usage must be absent when the spec omits it");
  assert.equal("estimatedCostUsd" in fact, false);
  if (fact.terminal.kind === "complete") {
    assert.equal("usage" in fact.terminal, false, "trace terminal usage must be absent when the spec omits it");
    assert.equal("estimatedCostUsd" in fact.terminal, false);
  }
});

test.concurrent("failed spec derives the category's HTTP status for the client protocol", () => {
  // The invariants the architecture review names, asserted per client protocol so the
  // derivation is pinned where it previously drifted.
  const expected: Readonly<Record<IrFailureCategory, number>> = {
    invalid_request: 400,
    authentication: 401,
    permission: 403,
    not_found: 404,
    conflict: 409,
    payload_too_large: 413,
    rate_limit: 429,
    quota: 429,
    timeout: 504,
    unavailable: 503,
    provider: 502,
    unsupported_capability: 400,
    stream_interrupted: 502,
  };
  const anthropicOverrides: Readonly<Partial<Record<IrFailureCategory, number>>> = { unavailable: 529 };

  for (const protocol of ALL_PROTOCOLS) {
    for (const [category, status] of Object.entries(expected) as Array<[IrFailureCategory, number]>) {
      const anthropic = protocol === "anthropic-messages";
      const expectedStatus = anthropic ? (anthropicOverrides[category] ?? status) : status;
      const fact = buildTerminalFact(context({ clientProtocol: protocol }), {
        kind: "failed",
        failure: failureOf(category),
      });
      assert.equal(fact.outcomeCategory, "failed", `${category} over ${protocol}`);
      assert.equal(fact.status, expectedStatus, `${category} over ${protocol} maps to its derived status`);
      assert.deepEqual(fact.terminal, { kind: "failed", failure: failureOf(category) });
    }
  }
});

test.concurrent("failed spec accepts an explicit status that overrides the category derivation", () => {
  // The native complete relay relays an upstream error body verbatim, so its fact must
  // report the upstream status actually delivered, not the category's canonical mapping.
  const fact = buildTerminalFact(context(), {
    kind: "failed",
    failure: failureOf("provider"),
    status: 418,
  });
  assert.equal(fact.outcomeCategory, "failed");
  assert.equal(fact.status, 418);
  assert.deepEqual(fact.terminal, { kind: "failed", failure: failureOf("provider") });
});

test.concurrent("cancelled spec maps to the fixed 499 cancelled terminal for client and shutdown", () => {
  for (const by of ["client", "shutdown"] as const) {
    const fact = buildTerminalFact(context(), { kind: "cancelled", by });
    assert.equal(fact.outcomeCategory, "cancelled");
    assert.equal(fact.status, 499);
    assert.deepEqual(fact.terminal, { kind: "cancelled", by });
  }
});

test.concurrent("fault spec maps to a 500 failed terminal recording the internal-fault reason", () => {
  const fact = buildTerminalFact(context(), { kind: "fault" });
  assert.equal(fact.outcomeCategory, "failed");
  assert.equal(fact.status, 500);
  assert.deepEqual(fact.terminal, { kind: "incomplete", reason: "internal_fault" });
});

test.concurrent("dry_run spec maps to a 200 complete terminal without dispatch fields", () => {
  const fact = buildTerminalFact(context(), { kind: "dry_run" });
  assert.equal(fact.outcomeCategory, "complete");
  assert.equal(fact.status, 200);
  assert.deepEqual(fact.terminal, { kind: "dry_run" });
});

test.concurrent("the shared context merges attempt, stream, identity, and completion-log fields", () => {
  const fact = buildTerminalFact(
    {
      attempts: 7,
      stream: false,
      clientProtocol: "anthropic-messages",
      targetProtocol: "openai-chat",
      provider: "provider-b",
      canonicalPublicName: "route-a",
      emitCompleted: false,
    },
    { kind: "failed", failure: failureOf("timeout") },
  );
  assert.equal(fact.attempts, 7);
  assert.equal(fact.stream, false);
  assert.equal(fact.targetProtocol, "openai-chat");
  assert.equal(fact.provider, "provider-b");
  assert.equal(fact.canonicalPublicName, "route-a");
  assert.equal(fact.emitCompleted, false);
});

test.concurrent("context identity fields are omitted from the fact when the caller does not know them", () => {
  const fact = buildTerminalFact(
    { attempts: 0, stream: false, clientProtocol: "openai-chat", emitCompleted: false },
    { kind: "dry_run" },
  );
  for (const key of ["targetProtocol", "provider", "canonicalPublicName"] as const) {
    assert.equal(key in fact, false, `${key} must be absent when resolution never succeeded`);
  }
  assert.equal(fact.emitCompleted, false);
});

test.concurrent("buildTerminalFact never stamps durationMs; callers spread the actual delivery duration", () => {
  const fact = buildTerminalFact(context(), { kind: "complete", status: 200 });
  assert.equal("durationMs" in fact, false, "duration must be deferred to client-delivery time");
});

// ============================================================================
// Functional: derived facts finalize through the real coordinator exactly once.
// ============================================================================

const noopTrace: TraceSession = {
  recordJson: async () => {},
  recordBytes: async () => {},
  openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
  finish: async () => {},
};

/** Observer capturing the fields the coordinator forwards to telemetry sinks. */
function trackingObserver(): {
  observer: GatewayObservability;
  completed: Array<Record<string, unknown>>;
  httpTerminal: Array<Record<string, unknown>>;
} {
  const completed: Array<Record<string, unknown>> = [];
  const httpTerminal: Array<Record<string, unknown>> = [];
  const noop = (): void => undefined;
  const observer: GatewayObservability = {
    observe: noop,
    requestIngress: noop,
    requestTerminal: noop,
    authResult: noop,
    nameResolved: noop,
    candidateSkipped: noop,
    keySelected: noop,
    attemptStarted: noop,
    attemptCompleted: noop,
    firstByte: noop,
    retryScheduled: noop,
    fallbackSelected: noop,
    completed: (fields) => completed.push({ ...fields }),
    httpTerminal: (fields) => httpTerminal.push({ ...fields }),
    catalogCompleted: noop,
    cancelled: noop,
    setKeyPoolAvailable: noop,
    traceFailure: noop,
    retentionRun: noop,
    shutdownStarted: noop,
    shutdownCompleted: noop,
  };
  return { observer, completed, httpTerminal };
}

function coordinatorWith(overrides: { trace?: TraceSession; observer?: GatewayObservability } = {}): {
  coordinator: ReturnType<typeof createTerminalCoordinator>;
  terminals: unknown[];
  completed: Array<Record<string, unknown>>;
  httpTerminal: Array<Record<string, unknown>>;
} {
  const terminals: unknown[] = [];
  const { observer, completed, httpTerminal } = trackingObserver();
  const trace: TraceSession = {
    ...noopTrace,
    finish: async (terminal) => {
      terminals.push(terminal);
    },
  };
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: 0,
    clock: { nowMonotonicMs: () => 42, nowWall: systemClock.nowWall },
    trace: overrides.trace ?? trace,
    observer: overrides.observer ?? observer,
  });
  coordinator.markIngress(true);
  return { coordinator, terminals, completed, httpTerminal };
}

test.concurrent("failed spec finalization writes the derived trace terminal and telemetry fields", async () => {
  const { coordinator, terminals, completed } = coordinatorWith();
  const outcome: TerminalOutcome = { kind: "failed", failure: failureOf("timeout") };
  const won = await finalizeTerminal(coordinator, context(), outcome, 100);
  await coordinator.finalized;

  assert.equal(won.won, true);
  assert.deepEqual(terminals, [{ kind: "failed", failure: failureOf("timeout") }]);
  const fields = completed[0];
  assert.ok(fields, "a completed telemetry observation must be emitted after ingress");
  assert.equal(fields.outcomeCategory, "failed");
  assert.equal(fields.status, 504);
  assert.equal(fields.attempts, 3);
  assert.equal(fields.stream, true);
  assert.equal(fields.targetProtocol, "anthropic-messages");
  assert.equal(fields.provider, "provider-a");
  assert.equal(fields.canonicalPublicName, "model-a");
  assert.equal(fields.durationMs, 100);
});

test.concurrent("cancelled and dry_run specs finalize with their fixed 499 and 200 invariants", async () => {
  const cancelled = coordinatorWith();
  await finalizeTerminal(cancelled.coordinator, context({ attempts: 2 }), { kind: "cancelled", by: "shutdown" }, 12);
  await cancelled.coordinator.finalized;
  assert.deepEqual(cancelled.terminals, [{ kind: "cancelled", by: "shutdown" }]);
  assert.equal(cancelled.completed[0]?.status, 499);
  assert.equal(cancelled.completed[0]?.outcomeCategory, "cancelled");

  const dryRun = coordinatorWith();
  await finalizeTerminal(dryRun.coordinator, context({ attempts: 0, stream: false }), { kind: "dry_run" }, 8);
  await dryRun.coordinator.finalized;
  assert.deepEqual(dryRun.terminals, [{ kind: "dry_run" }]);
  assert.equal(dryRun.completed[0]?.status, 200);
  assert.equal(dryRun.completed[0]?.outcomeCategory, "complete");
});

test.concurrent("the coordinator keeps exactly-once finalization when both paths speak the vocabulary", async () => {
  const { coordinator, terminals, completed } = coordinatorWith();
  const first = await finalizeTerminal(coordinator, context(), { kind: "failed", failure: failureOf("timeout") }, 100);
  const second = await finalizeTerminal(
    coordinator,
    context(),
    { kind: "fault" }, // a racing path must never clobber the winner
    150,
  );
  await coordinator.finalized;

  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.deepEqual(terminals, [{ kind: "failed", failure: failureOf("timeout") }]);
  assert.equal(completed.length, 1);
});

test.concurrent("emitCompleted false gates the completion log while still recording the HTTP terminal", async () => {
  const { coordinator, terminals, httpTerminal, completed } = coordinatorWith();
  await finalizeTerminal(
    coordinator,
    context({ attempts: 0, stream: false, canonicalPublicName: "unknown", emitCompleted: false }),
    { kind: "failed", failure: failureOf("not_found"), status: 404 },
    5,
  );
  await coordinator.finalized;

  assert.deepEqual(terminals, [{ kind: "failed", failure: failureOf("not_found") }]);
  assert.equal(completed.length, 0, "pre-gateway failures must not emit aptus.request.completed");
  assert.equal(httpTerminal.length, 1);
  assert.equal(httpTerminal[0]?.status, 404);
  assert.equal(httpTerminal[0]?.outcomeCategory, "failed");
});

test.concurrent("deferred delivery spreads the real client-end duration onto a prebuilt fact", async () => {
  // Mirrors the relay pattern: build the duration-free fact eagerly, then finalize once
  // the bytes have reached Express with the actual duration.
  const fact = buildTerminalFact(context(), {
    kind: "complete",
    status: 200,
    usage: { input_tokens: 5 },
    estimatedCostUsd: "0.00004",
  });
  const delivered: TerminalFact[] = [];
  const coordinator: TerminalCoordinator = {
    finalized: Promise.resolve(),
    markIngress: () => {},
    markClientFirstByte: () => {},
    recordAttempt: () => {},
    getAttempts: () => 3,
    finalize: async (submitted) => {
      delivered.push(submitted);
      return { won: true };
    },
  };

  await coordinator.finalize({ ...fact, durationMs: 777 });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.durationMs, 777);
  assert.equal(delivered[0]?.status, 200);
  assert.deepEqual(delivered[0]?.usage, { input_tokens: 5 });
  assert.equal(delivered[0]?.outcomeCategory, "complete");
});
