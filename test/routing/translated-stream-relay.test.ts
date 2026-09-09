import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  GatewayResult,
  JsonObject,
  TerminalCoordinator,
  TerminalFact,
  TraceByteSink,
  TraceSession,
} from "../../src/domain/contracts.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import {
  bootstrapTranslatedStream,
  relayTranslatedStream,
  type TranslatedStreamRelayContext,
} from "../../src/routing/translated-stream-relay.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";

const utf8Decoder = new TextDecoder();

/** Plain-text Responses SSE stream without unknown events (all six events translate to Chat). */
const SSE_RESPONSES_PLAIN_BYTES = new TextEncoder().encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01abc123","status":"in_progress"},"sequence_number":1}',
    "",
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_01"},"sequence_number":2}',
    "",
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from Responses","sequence_number":3}',
    "",
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":4}',
    "",
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_01abc123","status":"completed","usage":{"input_tokens":12,"output_tokens":24,"total_tokens":36}},"sequence_number":5}',
    "",
    "",
  ].join("\n"),
);

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

/** Per-stage trace sinks so provider bytes and IR events are counted independently. */
function recordingTrace(): {
  trace: TraceSession;
  provider: { appended: number; completed: number; discarded: number };
  ir: { appended: number; completed: number; discarded: number };
} {
  const provider = { appended: 0, completed: 0, discarded: 0 };
  const ir = { appended: 0, completed: 0, discarded: 0 };
  const makeSink = (counts: { appended: number; completed: number; discarded: number }): TraceByteSink => ({
    append: async () => {
      counts.appended++;
    },
    complete: async () => {
      counts.completed++;
    },
    discard: async () => {
      counts.discarded++;
    },
  });
  const trace: TraceSession = {
    recordJson: async () => {},
    recordBytes: async () => {},
    openBytes: (stage) => (stage === "provider_stream" ? makeSink(provider) : makeSink(ir)),
    finish: async () => {},
  };
  return { trace, provider, ir };
}

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

/** Narrow a gateway result to the streaming variant. */
function streamOf(result: GatewayResult): Extract<GatewayResult, { readonly kind: "stream" }> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream gateway result");
  }
  return result;
}

async function readAll(result: GatewayResult): Promise<{ text: string; error: unknown }> {
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
  return { text: utf8Decoder.decode(concat(parts)), error };
}

test.concurrent("translated stream relay re-frames responses SSE into chat SSE through the real pump", async () => {
  const { trace, provider, ir } = recordingTrace();
  const { coordinator, facts } = capturingCoordinator();
  const { observer } = trackingObserver();
  const translation = createDefaultTranslationCoordinator();
  const sessionBundle = translation.createStreamSession({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    logicalModel: "gpt-main",
    responseId: "resp_01abc123",
  });

  const bootstrap = await bootstrapTranslatedStream({
    trace,
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(SSE_RESPONSES_PLAIN_BYTES);
          controller.close();
        },
      }),
      finalUrl: "http://upstream.example/v1/responses",
    },
    sessionBundle,
    direction: "openai-chat->openai-responses",
  });
  if (bootstrap.kind !== "ready") {
    throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap.failure)}`);
  }

  const context: TranslatedStreamRelayContext = {
    aptusRequestId: createRequestId(),
    coordinator,
    clock: { nowMonotonicMs: () => 1400, nowWall: () => new Date("2026-06-01T00:00:00.000Z") },
    started: 1000,
    attemptCount: 1,
    targetProtocol: "openai-responses",
    clientProtocol: "openai-chat",
    providerName: "openai-responses-primary",
    canonicalName: "gpt-main",
    pricing: null,
    requestSignal: new AbortController().signal,
    trace,
    observer,
    reader: bootstrap.reader,
    pump: bootstrap.pump,
    providerSink: bootstrap.providerSink,
    irEventsSink: bootstrap.irEventsSink,
    initialClientChunks: bootstrap.initialClientChunks,
    isInitialComplete: bootstrap.isInitialComplete,
  };

  const result = streamOf(relayTranslatedStream(context));
  const { text, error } = await readAll(result);
  assert.equal(error, undefined);
  // The real pump re-frames Responses events into Chat SSE frames ending in [DONE].
  assert.ok(text.includes("Hello from Responses"), `client text missing delta: ${text}`);
  assert.ok(text.includes("data: [DONE]"), "chat client stream must terminate with [DONE]");
  assert.ok(!text.includes("event: response."), "no raw responses events may leak to the chat client");

  await result.onDelivered?.(77);
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.equal(fact.terminal.kind, "complete");
  const expectedUsage: JsonObject = { input_tokens: 12, output_tokens: 24, total_tokens: 36 };
  if (fact.terminal.kind === "complete") {
    assert.deepEqual(fact.terminal.usage, expectedUsage);
  }
  assert.deepEqual(fact.usage, expectedUsage);

  // Engine sink rule through the real path: both sinks complete, none discarded.
  assert.equal(provider.completed, 1);
  assert.equal(provider.discarded, 0);
  assert.equal(ir.completed, 1);
  assert.equal(ir.discarded, 0);
  assert.ok(provider.appended >= 1, "provider byte sink must receive raw chunks");
  assert.ok(ir.appended >= 1, "IR event sink must receive stream events");
});
