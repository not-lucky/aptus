import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  GatewayResult,
  JsonObject,
  Protocol,
  TerminalCoordinator,
  TerminalFact,
  TraceByteSink,
  TraceSession,
} from "../../src/domain/contracts.ts";
import type { NormalizedFailure } from "../../src/domain/operations.ts";
import type { PricingConfig } from "../../src/domain/pricing.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import { runStreamRelay, type StreamEofVerdict, type StreamTransform } from "../../src/routing/stream-relay.ts";
import { systemClock } from "../../src/routing/timing.ts";

const utf8Decoder = new TextDecoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Narrow a gateway result to the streaming variant, failing the test otherwise. */
function streamResult(result: GatewayResult): Extract<GatewayResult, { readonly kind: "stream" }> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream gateway result");
  }
  return result;
}

/** Scripted reader double replaying queued results, optionally throwing after N successful reads. */
function scriptedReader(
  chunks: readonly Uint8Array[],
  options: { readonly failReadAfter?: number } = {},
): ReadableStreamDefaultReader<Uint8Array> {
  const queue = [...chunks];
  let succeeded = 0;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (options.failReadAfter !== undefined && succeeded >= options.failReadAfter) {
        throw new Error("scripted stream failure");
      }
      const next = queue.shift();
      if (next !== undefined) {
        succeeded++;
        return { done: false, value: next };
      }
      return { done: true, value: undefined };
    },
    cancel: async () => {},
    releaseLock: () => {},
    closed: Promise.resolve(),
  };
  return reader as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** Capturing trace byte sink recording its lifecycle transitions on a live counter object. */
function fakeSink(): { sink: TraceByteSink; counts: { appended: number; completed: number; discarded: number } } {
  const counts = { appended: 0, completed: 0, discarded: 0 };
  const sink: TraceByteSink = {
    append: async () => {
      counts.appended++;
    },
    complete: async () => {
      counts.completed++;
    },
    discard: async () => {
      counts.discarded++;
    },
  };
  return { sink, counts };
}

/** Capturing terminal coordinator recording every submitted fact. */
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
function trackingObserver(): { observer: GatewayObservability; cancelled: Array<{ by: string; phase: string }> } {
  const cancelled: Array<{ by: string; phase: string }> = [];
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
    cancelled: (fields) => {
      cancelled.push({ by: fields.by, phase: fields.phase });
    },
    setKeyPoolAvailable: () => {},
    traceFailure: () => {},
    retentionRun: () => {},
    shutdownStarted: () => {},
    shutdownCompleted: () => {},
  };
  return { observer, cancelled };
}

/** Tracking trace session capturing recorded cancellation stages. */
function trackingTrace(): { trace: TraceSession; stages: Array<{ stage: string; value: JsonObject }> } {
  const stages: Array<{ stage: string; value: JsonObject }> = [];
  const trace: TraceSession = {
    recordJson: async (stage, value) => {
      stages.push({ stage, value: value as JsonObject });
    },
    recordBytes: async () => {},
    openBytes: () => ({
      append: async () => {},
      complete: async () => {},
      discard: async () => {},
    }),
    finish: async () => {},
  };
  return { trace, stages };
}

/** Controllable stream transform double with live call counters. */
function scriptedTransform(options: {
  readonly feedChunks?: (chunk: Uint8Array) => readonly Uint8Array[];
  readonly feedFailure?: NormalizedFailure;
  readonly finishChunks?: readonly Uint8Array[];
  readonly finishFailure?: NormalizedFailure;
  readonly verdict: StreamEofVerdict;
}): {
  transform: StreamTransform;
  calls: { feedCalls: number; finishCalls: number; verdictCalls: number };
} {
  const calls = { feedCalls: 0, finishCalls: 0, verdictCalls: 0 };
  const transform: StreamTransform = {
    feed(chunk) {
      calls.feedCalls++;
      if (options.feedFailure !== undefined) {
        return { ok: false as const, error: options.feedFailure };
      }
      return { ok: true as const, value: options.feedChunks?.(chunk) ?? [chunk] };
    },
    finish() {
      calls.finishCalls++;
      if (options.finishFailure !== undefined) {
        return { ok: false as const, error: options.finishFailure };
      }
      return { ok: true as const, value: options.finishChunks ?? [] };
    },
    eofVerdict() {
      calls.verdictCalls++;
      return options.verdict;
    },
  };
  return { transform, calls };
}

/** Consumes a streaming gateway result body, resolving with bytes or the controller error. */
async function readStream(
  result: GatewayResult,
): Promise<{ bytes: string; error: unknown }> {
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
  return { bytes: utf8Decoder.decode(concat(parts)), error };
}

type StreamRelayOptions = Parameters<typeof runStreamRelay>[0];

function baseOptions(overrides: Partial<StreamRelayOptions> = {}) {
  const { coordinator, facts } = capturingCoordinator();
  const { observer, cancelled } = trackingObserver();
  const { trace, stages } = trackingTrace();
  const clock = { nowMonotonicMs: () => 1400, nowWall: systemClock.nowWall };
  const options: StreamRelayOptions = {
    aptusRequestId: createRequestId(),
    coordinator,
    clock,
    started: 1000,
    attemptCount: 2,
    targetProtocol: "openai-chat" as Protocol,
    clientProtocol: "openai-chat" as Protocol,
    providerName: "provider-a",
    canonicalName: "model-a",
    pricing: null,
    requestSignal: new AbortController().signal,
    trace,
    observer,
    reader: scriptedReader([new TextEncoder().encode("chunk-a")]),
    sinks: [],
    transform: scriptedTransform({ verdict: { kind: "complete" } }).transform,
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...overrides,
  };
  return { options, facts, cancelled, stages };
}

const CHUNK_A = new TextEncoder().encode("chunk-a");

test.concurrent("clean terminal relays bytes and defers the complete fact to onDelivered", async () => {
  const sinkState = fakeSink();
  const transformState = scriptedTransform({
    feedChunks: () => [CHUNK_A],
    verdict: { kind: "complete" },
  });
  const { options, facts, cancelled } = baseOptions({
    reader: scriptedReader([CHUNK_A]),
    sinks: [sinkState.sink],
    transform: transformState.transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { bytes, error } = await readStream(result);
  assert.equal(error, undefined);
  assert.equal(bytes, "chunk-a");
  assert.equal(result.status, 200);
  assert.deepEqual(result.headers, { "content-type": "text/event-stream" });

  // No terminal fact before client delivery completes.
  assert.equal(facts.length, 0);
  await result.onDelivered?.(777);

  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "complete");
  assert.equal(fact.status, 200);
  assert.equal(fact.attempts, 2);
  assert.equal(fact.stream, true);
  assert.equal(fact.targetProtocol, "openai-chat");
  assert.equal(fact.provider, "provider-a");
  assert.equal(fact.canonicalPublicName, "model-a");
  assert.equal(fact.durationMs, 777);

  // EOF is a terminal: sink completed, never discarded. Per-chunk appends are the adapter's job.
  assert.equal(sinkState.counts.completed, 1);
  assert.equal(sinkState.counts.discarded, 0);
  assert.equal(transformState.calls.feedCalls, 1);
  assert.equal(transformState.calls.finishCalls, 1);
  assert.equal(transformState.calls.verdictCalls, 1);
  assert.equal(cancelled.length, 0);
});

test.concurrent("clean terminal attaches usage and cost when the verdict provides them", async () => {
  const pricing: PricingConfig = {
    inputUsdPerMillionTokens: "1",
    outputUsdPerMillionTokens: "2",
    cacheReadUsdPerMillionTokens: null,
    cacheWriteUsdPerMillionTokens: null,
  };
  const usageRecord: JsonObject = { input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 };
  const { options, facts } = baseOptions({
    pricing,
    reader: scriptedReader([CHUNK_A]),
    transform: scriptedTransform({
      feedChunks: () => [CHUNK_A],
      verdict: {
        kind: "complete",
        usageRecord,
        costUsage: { input: 1_000_000, output: 500_000, total: 1_500_000 },
      },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  await readStream(result);
  await result.onDelivered?.(100);

  const fact = facts[0]!;
  assert.deepEqual(fact.usage, usageRecord);
  assert.equal(fact.estimatedCostUsd, "2");
  assert.equal(fact.terminal.kind, "complete");
  if (fact.terminal.kind === "complete") {
    assert.deepEqual(fact.terminal.usage, usageRecord);
    assert.equal(fact.terminal.estimatedCostUsd, "2");
  }
});

test.concurrent("no-terminal EOF is interrupted: failed fact, error controller, sinks completed", async () => {
  const sinkState = fakeSink();
  const { options, facts } = baseOptions({
    reader: scriptedReader([CHUNK_A]),
    sinks: [sinkState.sink],
    transform: scriptedTransform({
      feedChunks: () => [CHUNK_A],
      verdict: { kind: "no_terminal" },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { error } = await readStream(result);
  assert.ok(error !== undefined, "stream must error after an interrupted EOF");
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "stream_interrupted");
  }
  assert.equal(fact.outcomeCategory, "failed");
  assert.equal(fact.status, 502);
  // EOF reached cleanly: sinks complete rather than discard.
  assert.equal(sinkState.counts.completed, 1);
  assert.equal(sinkState.counts.discarded, 0);
});

test.concurrent("in-band failure closes politely and finalizes failed with the mapped status", async () => {
  const sinkState = fakeSink();
  const failure: NormalizedFailure = { category: "invalid_request", message: "provider refused", retryable: false };
  const { options, facts } = baseOptions({
    reader: scriptedReader([CHUNK_A]),
    sinks: [sinkState.sink],
    transform: scriptedTransform({
      feedChunks: () => [CHUNK_A],
      verdict: { kind: "inband_failure", failure },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { bytes, error } = await readStream(result);
  // Polite close: bytes arrive and the stream does not error.
  assert.equal(bytes, "chunk-a");
  assert.equal(error, undefined);
  assert.equal(facts.length, 0);

  await result.onDelivered?.(50);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "invalid_request");
  }
  assert.equal(fact.outcomeCategory, "failed");
  assert.equal(fact.status, 400);
  assert.equal(sinkState.counts.completed, 1);
  assert.equal(sinkState.counts.discarded, 0);
});

test.concurrent("transform hard failure at finish errors the controller and completes sinks at EOF", async () => {
  const sinkState = fakeSink();
  const failure: NormalizedFailure = { category: "stream_interrupted", message: "truncated", retryable: false };
  const { options, facts } = baseOptions({
    reader: scriptedReader([CHUNK_A]),
    sinks: [sinkState.sink],
    transform: scriptedTransform({
      feedChunks: () => [CHUNK_A],
      finishFailure: failure,
      verdict: { kind: "complete" },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { error } = await readStream(result);
  assert.ok(error !== undefined);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "stream_interrupted");
  }
  assert.equal(sinkState.counts.completed, 1);
});

test.concurrent("timeout abort mid-stream discards sinks and finalizes a 504 timeout fact", async () => {
  const controller = new AbortController();
  controller.abort("timeout");
  const sinkState = fakeSink();
  const { options, facts, cancelled, stages } = baseOptions({
    requestSignal: controller.signal,
    reader: scriptedReader([], { failReadAfter: 0 }),
    sinks: [sinkState.sink],
    transform: scriptedTransform({ verdict: { kind: "complete" } }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { error } = await readStream(result);
  assert.ok(error !== undefined);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "timeout");
  }
  assert.equal(fact.status, 504);
  // Aborts discard the sinks so no partial stream files survive.
  assert.equal(sinkState.counts.discarded, 1);
  assert.equal(sinkState.counts.completed, 0);
  assert.equal(cancelled.length, 0, "timeouts are failures, not cancellations");
  assert.equal(stages.length, 0);
});

test.concurrent("client abort mid-stream records a single relay cancellation and discards sinks", async () => {
  const controller = new AbortController();
  controller.abort("client");
  const sinkState = fakeSink();
  const { options, facts, cancelled, stages } = baseOptions({
    requestSignal: controller.signal,
    reader: scriptedReader([], { failReadAfter: 0 }),
    sinks: [sinkState.sink],
    transform: scriptedTransform({ verdict: { kind: "complete" } }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { error } = await readStream(result);
  assert.ok(error !== undefined);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "cancelled");
  if (fact.terminal.kind === "cancelled") {
    assert.equal(fact.terminal.by, "client");
  }
  assert.equal(fact.status, 499);
  assert.deepEqual(stages, [{ stage: "cancellation", value: { phase: "relay", by: "client" } }]);
  assert.deepEqual(cancelled, [{ by: "client", phase: "relay" }]);
  assert.equal(sinkState.counts.discarded, 1);
});

test.concurrent("shutdown abort mid-stream cancels by shutdown", async () => {
  const controller = new AbortController();
  controller.abort("shutdown");
  const sinkState = fakeSink();
  const { options, facts, cancelled } = baseOptions({
    requestSignal: controller.signal,
    reader: scriptedReader([], { failReadAfter: 0 }),
    sinks: [sinkState.sink],
    transform: scriptedTransform({ verdict: { kind: "complete" } }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  await readStream(result);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "cancelled");
  if (fact.terminal.kind === "cancelled") {
    assert.equal(fact.terminal.by, "shutdown");
  }
  assert.deepEqual(cancelled, [{ by: "shutdown", phase: "relay" }]);
  assert.equal(sinkState.counts.discarded, 1);
});

test.concurrent("non-abort transport error finalizes a mapped stream failure and discards sinks", async () => {
  const sinkState = fakeSink();
  const { options, facts, cancelled } = baseOptions({
    reader: scriptedReader([], { failReadAfter: 0 }),
    sinks: [sinkState.sink],
    transform: scriptedTransform({ verdict: { kind: "complete" } }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { error } = await readStream(result);
  assert.ok(error !== undefined);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "failed");
  if (fact.terminal.kind === "failed") {
    assert.equal(fact.terminal.failure.category, "stream_interrupted");
  }
  assert.equal(fact.status, 502);
  assert.equal(sinkState.counts.discarded, 1);
  assert.equal(cancelled.length, 0);
});

test.concurrent("consumer cancel() cancels the provider reader, discards sinks, and finalizes once", async () => {
  const controller = new AbortController();
  let providerCancelled = 0;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => ({ done: false, value: CHUNK_A }),
    cancel: async () => {
      providerCancelled++;
    },
    releaseLock: () => {},
    closed: Promise.resolve(),
  };
  const sinkState = fakeSink();
  const { options, facts, cancelled } = baseOptions({
    requestSignal: controller.signal,
    reader: reader as unknown as ReadableStreamDefaultReader<Uint8Array>,
    sinks: [sinkState.sink],
    transform: scriptedTransform({
      feedChunks: () => [CHUNK_A],
      verdict: { kind: "complete" },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const bodyReader = result.body.getReader();
  const first = await bodyReader.read();
  assert.equal(first.done, false);

  // Consumer abandons the stream mid-delivery.
  await bodyReader.cancel("client");
  await bodyReader.releaseLock();

  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "cancelled");
  if (fact.terminal.kind === "cancelled") {
    assert.equal(fact.terminal.by, "client");
  }
  assert.equal(fact.status, 499);
  assert.deepEqual(cancelled, [{ by: "client", phase: "relay" }]);
  assert.equal(providerCancelled, 1);
  assert.equal(sinkState.counts.discarded, 1);

  // Close-once: a second cancel is a no-op.
  await bodyReader.cancel("client").catch(() => undefined);
  assert.equal(facts.length, 1);
  assert.equal(cancelled.length, 1);
  assert.equal(sinkState.counts.discarded, 1);
});

test.concurrent("isInitialComplete carry-over finishes without touching the transform feed or finish", async () => {
  const sinkState = fakeSink();
  const transformState = scriptedTransform({ verdict: { kind: "complete" } });
  const { options, facts } = baseOptions({
    reader: scriptedReader([]),
    sinks: [sinkState.sink],
    transform: transformState.transform,
    initialClientChunks: [new TextEncoder().encode("bootstrapped")],
    isInitialComplete: true,
  });

  const result = streamResult(runStreamRelay(options));
  const { bytes, error } = await readStream(result);
  assert.equal(error, undefined);
  assert.equal(bytes, "bootstrapped");
  assert.equal(transformState.calls.feedCalls, 0);
  assert.equal(transformState.calls.finishCalls, 0);
  assert.equal(transformState.calls.verdictCalls, 1, "bootstrap already finalized the stream");

  await result.onDelivered?.(10);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.terminal.kind, "complete");
  assert.equal(sinkState.counts.completed, 1);
});

test.concurrent("multi-frame transforms drain in order and finish chunks flush before close", async () => {
  const frame1 = new TextEncoder().encode("frame-1");
  const frame2 = new TextEncoder().encode("frame-2");
  const frame3 = new TextEncoder().encode("frame-3");
  const sinkState = fakeSink();
  const { options, facts } = baseOptions({
    reader: scriptedReader([new TextEncoder().encode("raw-1"), new TextEncoder().encode("raw-2")]),
    sinks: [sinkState.sink],
    transform: scriptedTransform({
      feedChunks: (chunk) => {
        const raw = utf8Decoder.decode(chunk);
        if (raw === "raw-1") return [];
        return [frame1, frame2];
      },
      finishChunks: [frame3],
      verdict: { kind: "complete" },
    }).transform,
  });

  const result = streamResult(runStreamRelay(options));
  const { bytes, error } = await readStream(result);
  assert.equal(error, undefined);
  assert.equal(bytes, "frame-1frame-2frame-3");

  await result.onDelivered?.(25);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.terminal.kind, "complete");
  assert.equal(sinkState.counts.completed, 1);
});
