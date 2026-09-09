import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  GatewayResult,
  HeaderMap,
  JsonObject,
  Protocol,
  ProviderResponse,
  TerminalCoordinator,
  TerminalFact,
  TraceByteSink,
  TraceSession,
} from "../../src/domain/contracts.ts";
import type { PricingConfig } from "../../src/domain/pricing.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import { relayStream, type RelayContext } from "../../src/routing/relay.ts";
import { SSE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import { SSE_RESPONSES_ERROR_BYTES } from "../helpers/responses-fixtures.ts";

const utf8Decoder = new TextDecoder();

/** Narrow a gateway result to the streaming variant. */
function streamOf(result: GatewayResult): Extract<GatewayResult, { readonly kind: "stream" }> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream gateway result");
  }
  return result;
}

/** Builds a readable provider body that enqueues one chunk and closes (or stays open). */
function bytesStream(
  bytes: Uint8Array,
  options: { readonly holdOpen?: boolean } = {},
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (!options.holdOpen) controller.close();
    },
  });
}

/** Provider response double wrapping fixture bytes. */
function providerResponse(bytes: Uint8Array, options: { readonly holdOpen?: boolean } = {}): ProviderResponse {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: bytesStream(bytes, options),
    finalUrl: "http://upstream.example/v1/chat/completions",
  };
}

/** Recording trace byte sink plus a trace session that returns it from openBytes. */
function recordingTrace(): {
  trace: TraceSession;
  sink: TraceByteSink;
  counts: { appended: number; completed: number; discarded: number };
  stages: Array<{ stage: string; value: JsonObject }>;
  bytes: Uint8Array[];
} {
  const counts = { appended: 0, completed: 0, discarded: 0 };
  const bytes: Uint8Array[] = [];
  const stages: Array<{ stage: string; value: JsonObject }> = [];
  const sink: TraceByteSink = {
    append: async (chunk) => {
      counts.appended++;
      bytes.push(chunk);
    },
    complete: async () => {
      counts.completed++;
    },
    discard: async () => {
      counts.discarded++;
    },
  };
  const trace: TraceSession = {
    recordJson: async (stage, value) => {
      stages.push({ stage, value: value as JsonObject });
    },
    recordBytes: async () => {},
    openBytes: () => sink,
    finish: async () => {},
  };
  return { trace, sink, counts, stages, bytes };
}

/** Capturing terminal coordinator. */
function capturingCoordinator(): { coordinator: TerminalCoordinator; facts: TerminalFact[] } {
  const facts: TerminalFact[] = [];
  const coordinator: TerminalCoordinator = {
    finalized: Promise.resolve(),
    markIngress: () => {},
    markClientFirstByte: () => {},
    recordAttempt: () => {},
    getAttempts: () => 1,
    finalize: async (fact) => {
      facts.push(fact);
      return { won: true };
    },
  };
  return { coordinator, facts };
}

/** Tracking observer capturing cancellation events. */
function trackingObserver(): { observer: GatewayObservability; cancelled: string[] } {
  const cancelled: string[] = [];
  const observer: GatewayObservability = {
    observe: () => {},
    requestIngress: () => {},
    requestTerminal: () => {},
    authResult: () => {},
    nameResolved: () => {},
    candidateSkipped: () => {},
    keySelected: () => {},
    attemptStarted: () => {},
    attemptCompleted: () => {},
    firstByte: () => {},
    retryScheduled: () => {},
    fallbackSelected: () => {},
    completed: () => {},
    httpTerminal: () => {},
    catalogCompleted: () => {},
    cancelled: () => {
      cancelled.push("cancelled");
    },
    setKeyPoolAvailable: () => {},
    traceFailure: () => {},
    retentionRun: () => {},
    shutdownStarted: () => {},
    shutdownCompleted: () => {},
  };
  return { observer, cancelled };
}

function relayContext(overrides: Partial<RelayContext> = {}) {
  const { coordinator, facts } = capturingCoordinator();
  const { observer, cancelled } = trackingObserver();
  const { trace, counts, stages } = recordingTrace();
  const context: RelayContext = {
    aptusRequestId: createRequestId(),
    started: 1000,
    endpointProtocol: "openai-chat",
    canonicalName: "gpt-main",
    providerName: "openai-chat-primary",
    targetProtocol: "openai-chat",
    attemptCount: 1,
    trace,
    coordinator,
    observer,
    requestSignal: new AbortController().signal,
    clock: { nowMonotonicMs: () => 1400, nowWall: () => new Date("2026-06-01T00:00:00.000Z") },
    pricing: null,
    ...overrides,
  };
  return { context, facts, cancelled, counts, stages };
}

const PRICING: PricingConfig = {
  inputUsdPerMillionTokens: "2.50",
  outputUsdPerMillionTokens: "15.00",
  cacheReadUsdPerMillionTokens: "0.25",
  cacheWriteUsdPerMillionTokens: null,
};

async function readAll(result: GatewayResult): Promise<{ bytes: Uint8Array; error: unknown }> {
  assert.equal(result.kind, "stream");
  const reader = result.body.getReader();
  const parts: Uint8Array[] = [];
  let error: unknown;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) parts.push(value);
    }
  } catch (err) {
    error = err;
  } finally {
    reader.releaseLock();
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return { bytes: out, error };
}

test.concurrent("relayStream byte-relays chat SSE and finalizes complete with raw usage and cost", async () => {
  const { context, facts } = relayContext({ pricing: PRICING });
  const result = streamOf(relayStream(providerResponse(SSE_CHAT_BYTES), context));
  const { bytes, error } = await readAll(result);
  assert.equal(error, undefined);
  assert.deepEqual(bytes, SSE_CHAT_BYTES);
  assert.equal(facts.length, 0, "complete facts defer to onDelivered");

  await result.onDelivered?.(321);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "complete");
  if (fact.terminal.kind === "complete") {
    assert.equal(fact.terminal.status, 200);
    assert.deepEqual(fact.terminal.usage, {
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
    });
    assert.equal(fact.terminal.estimatedCostUsd, "0.0000825");
  }
  assert.deepEqual(fact.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  assert.equal(fact.estimatedCostUsd, "0.0000825");
  assert.equal(fact.status, 200);
  assert.equal(fact.stream, true);
  assert.equal(fact.attempts, 1);
  assert.equal(fact.durationMs, 321);
});

test.concurrent("relayStream interrupts an EOF without a terminal marker as a 502 failed fact", async () => {
  const partial = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const { context, facts, counts } = relayContext();
  const result = streamOf(relayStream(providerResponse(partial), context));

  const { error } = await readAll(result);
  assert.ok(error !== undefined, "a truncated SSE stream must error the relay stream");
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "stream_interrupted");
  }
  assert.equal(fact.outcomeCategory, "failed");
  assert.equal(fact.status, 502);

  // EOF reached cleanly: the provider byte sink commits, never discards.
  assert.equal(counts.completed, 1);
  assert.equal(counts.discarded, 0);
});

test.concurrent("relayStream relays a responses in-band error stream as a clean complete", async () => {
  const { context, facts } = relayContext({ targetProtocol: "openai-responses" as Protocol });
  const result = streamOf(relayStream(providerResponse(SSE_RESPONSES_ERROR_BYTES), context));
  const { bytes, error } = await readAll(result);
  // Responses `error` terminal is a valid terminal marker: byte-identical relay, client parses it.
  assert.equal(error, undefined);
  assert.deepEqual(bytes, SSE_RESPONSES_ERROR_BYTES);

  await result.onDelivered?.(10);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.terminal.kind, "complete");
  assert.equal(facts[0]?.usage, undefined);
});

test.concurrent("relayStream treats an anthropic error event without message_stop as complete", async () => {
  const errorOnly = new TextEncoder().encode(
    ['event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}', "", ""].join("\n"),
  );
  const { context, facts } = relayContext({ targetProtocol: "anthropic-messages" as Protocol });
  const result = streamOf(relayStream(providerResponse(errorOnly), context));
  const { bytes, error } = await readAll(result);
  assert.equal(error, undefined);
  assert.deepEqual(bytes, errorOnly);

  await result.onDelivered?.(10);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.terminal.kind, "complete", "provider-error bodies are byte-relayed, not interrupted");
});

test.concurrent("relayStream consumer cancel discards the sink, records relay cancellation once, and finalizes 499", async () => {
  const controller = new AbortController();
  const { context, facts, cancelled, counts, stages } = relayContext({ requestSignal: controller.signal });
  const result = streamOf(
    relayStream(providerResponse(new TextEncoder().encode("data: start\n\n"), { holdOpen: true }), context),
  );

  assert.equal(result.kind, "stream");
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel("client").catch(() => undefined);
  await reader.releaseLock();

  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "cancelled");
  if (fact.terminal.kind === "cancelled") {
    assert.equal(fact.terminal.by, "client");
  }
  assert.equal(fact.status, 499);
  assert.equal(cancelled.length, 1);
  assert.deepEqual(stages, [{ stage: "cancellation", value: { phase: "relay", by: "client" } }]);
  assert.equal(counts.discarded, 1);
  assert.equal(counts.completed, 0);

  // Close-once: a second cancel does not duplicate telemetry or sink work.
  await reader.cancel("client").catch(() => undefined);
  assert.equal(facts.length, 1);
  assert.equal(cancelled.length, 1);
  assert.equal(counts.discarded, 1);
});

test.concurrent("relayStream passes through stream status and headers from the provider head", async () => {
  const headers: HeaderMap = { "content-type": "text/event-stream", "x-provider": "fixture" };
  const { context } = relayContext();
  const response: ProviderResponse = {
    status: 200,
    headers,
    body: bytesStream(SSE_CHAT_BYTES),
    finalUrl: "http://upstream.example/v1/chat/completions",
  };
  const result = streamOf(relayStream(response, context));
  assert.equal(result.status, 200);
  assert.deepEqual(result.headers, headers);
  const { bytes } = await readAll(result);
  assert.deepEqual(bytes, SSE_CHAT_BYTES);
  assert.match(utf8Decoder.decode(bytes), /data: \[DONE\]/);
});
