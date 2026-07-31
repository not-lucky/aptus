import assert from "node:assert/strict";
import { test } from "vitest";
import type { TerminalFact, TraceSession } from "../../src/domain/contracts.ts";
import type { TraceTerminal } from "../../src/domain/operations.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import { systemClock } from "../../src/routing/timing.ts";

const noopTrace: TraceSession = {
  recordJson: async () => {},
  recordBytes: async () => {},
  openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
  finish: async () => {},
};

function trackingObserver(): {
  observer: GatewayObservability;
  calls: string[];
  terminalStreams: boolean[];
  firstBytes: Array<{ attemptNumber: number; durationMs: number }>;
} {
  const calls: string[] = [];
  const terminalStreams: boolean[] = [];
  const firstBytes: Array<{ attemptNumber: number; durationMs: number }> = [];
  const push = (name: string): void => {
    calls.push(name);
  };
  const observer: GatewayObservability = {
    observe: () => push("observe"),
    requestIngress: () => push("requestIngress"),
    requestTerminal: (f) => {
      push("requestTerminal");
      terminalStreams.push(f.stream);
    },
    authResult: () => push("authResult"),
    nameResolved: () => push("nameResolved"),
    candidateSkipped: () => push("candidateSkipped"),
    keySelected: () => push("keySelected"),
    attemptStarted: () => push("attemptStarted"),
    attemptCompleted: () => push("attemptCompleted"),
    firstByte: (f) => {
      push("firstByte");
      firstBytes.push({ attemptNumber: f.attemptNumber, durationMs: f.durationMs });
    },
    retryScheduled: () => push("retryScheduled"),
    fallbackSelected: () => push("fallbackSelected"),
    completed: () => push("completed"),
    httpTerminal: () => push("httpTerminal"),
    catalogCompleted: () => push("catalogCompleted"),
    cancelled: () => push("cancelled"),
    setKeyPoolAvailable: () => push("setKeyPoolAvailable"),
    traceFailure: () => push("traceFailure"),
    retentionRun: () => push("retentionRun"),
    shutdownStarted: () => push("shutdownStarted"),
    shutdownCompleted: () => push("shutdownCompleted"),
  };
  return { observer, calls, terminalStreams, firstBytes };
}

function completeFact(): TerminalFact {
  return {
    terminal: { kind: "complete", status: 200 },
    outcomeCategory: "complete",
    status: 200,
    attempts: 1,
    stream: false,
    durationMs: 10,
  };
}

test("pre-ingress finalization writes the trace terminal but skips accepted-request telemetry", async () => {
  const { observer, calls } = trackingObserver();
  const terminals: TraceTerminal[] = [];
  const trace: TraceSession = {
    ...noopTrace,
    finish: async (terminal) => {
      terminals.push(terminal);
    },
  };

  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace,
    observer,
  });

  const result = await coordinator.finalize(completeFact());
  await coordinator.finalized;

  assert.equal(result.won, true);
  assert.deepEqual(terminals, [{ kind: "complete", status: 200 }]);
  assert.ok(!calls.includes("requestTerminal"), "must not decrement in-flight before ingress");
  assert.ok(!calls.includes("completed"), "must not emit an accepted-request counter before ingress");
});

test("post-ingress finalization is atomic across duplicate claims", async () => {
  const { observer, calls } = trackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);

  const first = await coordinator.finalize(completeFact());
  const second = await coordinator.finalize(completeFact());
  await coordinator.finalized;

  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.equal(calls.filter((call) => call === "requestTerminal").length, 1);
  assert.equal(calls.filter((call) => call === "completed").length, 1);
});

test("pre-Gateway finalization records HTTP terminal without the completion log", async () => {
  const { observer, calls } = trackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);

  await coordinator.finalize({
    ...completeFact(),
    attempts: 0,
    canonicalPublicName: "unknown",
    emitCompleted: false,
  });
  await coordinator.finalized;

  assert.ok(calls.includes("requestTerminal"), "pre-Gateway failures still decrement in-flight");
  assert.ok(calls.includes("httpTerminal"), "pre-Gateway failures record the HTTP counter/duration");
  assert.ok(!calls.includes("completed"), "pre-Gateway failures must not emit aptus.request.completed");
  assert.ok(!calls.includes("firstByte"), "no attempt means no first-byte event");
});

test("first-byte is emitted with the winning attempt number when marked", async () => {
  const { observer, firstBytes } = trackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: 0,
    clock: { nowMonotonicMs: () => 45, nowWall: systemClock.nowWall },
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);
  coordinator.markClientFirstByte();

  await coordinator.finalize({ ...completeFact(), attempts: 3 });
  await coordinator.finalized;

  assert.deepEqual(firstBytes, [{ attemptNumber: 3, durationMs: 45 }]);
});

test("in-flight decrement uses the admitted stream label, not the terminal stream", async () => {
  const { observer, terminalStreams } = trackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  // Dry run: ingress admitted stream=true, terminal reports stream=false.
  coordinator.markIngress(true);

  await coordinator.finalize({ ...completeFact(), stream: false, attempts: 0 });
  await coordinator.finalized;

  assert.deepEqual(terminalStreams, [true], "decrement balances the ingress increment");
});
