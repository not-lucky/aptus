import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AptusConfig, ProviderConfig, SecretString } from "../../src/config/types.ts";
import type { Gateway, GatewayRequest, JsonObject, LifecycleEvent } from "../../src/domain/contracts.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import type { GatewayObservability } from "../../src/observability/lifecycle-observer.ts";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.ts";
import { createProtocolAdapters } from "../../src/providers/adapters.ts";
import { createGateway } from "../../src/routing/gateway.ts";
import { type Clock, systemClock } from "../../src/routing/timing.ts";
import { COMPLETE_CHAT_BYTES, ERROR_BYTES, SSE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import { createFixtureDispatcher, type FixtureDispatcher } from "../helpers/fixture-dispatcher.ts";
import { TestClock, TestRandomSource, TestSleeper } from "../helpers/test-timing.ts";

let activeTraceRecorder: ReturnType<typeof createFileTraceRecorder> | undefined;
let activeObserver: GatewayObservability | undefined;
let activeClock: Clock | undefined;

function trackingObserver(): { observer: GatewayObservability; events: LifecycleEvent[]; logs: string[] } {
  const events: LifecycleEvent[] = [];
  const logs: string[] = [];
  const noop = (): void => undefined;

  const observer: GatewayObservability = {
    observe(event: LifecycleEvent) {
      events.push(event);
    },
    requestIngress: () => logs.push("requestIngress"),
    requestTerminal: () => logs.push("requestTerminal"),
    authResult: () => logs.push("authResult"),
    nameResolved: () => logs.push("nameResolved"),
    candidateSkipped: (f) => logs.push(`candidateSkipped:${f.provider}`),
    keySelected: (f) => logs.push(`keySelected:${f.keyName}`),
    attemptStarted: (f) => logs.push(`attemptStarted:${f.attemptNumber}:${f.provider}`),
    attemptCompleted: (f) => logs.push(`attemptCompleted:${f.attemptNumber}:${f.attemptResult}`),
    firstByte: (f) => logs.push(`firstByte:${f.attemptNumber}`),
    retryScheduled: (f) => logs.push(`retryScheduled:${f.attemptNumber}:${f.provider}:${f.category}`),
    fallbackSelected: (f) => logs.push(`fallbackSelected:${f.fromCandidateIndex}->${f.toCandidateIndex}`),
    completed: (f) => logs.push(`completed:${f.outcomeCategory}`),
    httpTerminal: (f) => logs.push(`httpTerminal:${f.outcomeCategory}`),
    catalogCompleted: () => logs.push("catalogCompleted"),
    cancelled: (f) => logs.push(`cancelled:${f.phase}`),
    setKeyPoolAvailable: noop,
    traceFailure: noop,
    retentionRun: noop,
    shutdownStarted: noop,
    shutdownCompleted: noop,
  };
  return { observer, events, logs };
}

function catalog() {
  return {
    openai: { created: 1, ownedBy: "aptus" },
    anthropic: {
      createdAt: "2026-01-01T00:00:00Z",
      displayName: "Aptus",
      capabilities: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function buildConfig(overrides: Partial<AptusConfig> = {}): AptusConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1048576,
      maxInFlight: 100,
      requestDeadlineMs: 60000,
      streamIdleMs: 30000,
      shutdownDrainMs: 5000,
      trustedProxyCidrs: [],
    },
    operations: { host: "127.0.0.1", port: 0 },
    auth: { clientKeys: [{ name: "client", secret: "client-secret" as SecretString, allow: ["*"] }] },
    providers: [
      {
        name: "chat-provider",
        protocol: "openai-chat",
        baseUrl: "https://chat.example/v1",
        headers: { "openai-organization": "org" },
        keys: [
          { name: "key-1", secret: "provider-secret-1" as SecretString, enabled: true },
          { name: "key-2", secret: "provider-secret-2" as SecretString, enabled: true },
          { name: "key-3", secret: "provider-secret-3" as SecretString, enabled: true },
        ],
        keyStrategy: "fill-first",
      },
      {
        name: "backup-chat-provider",
        protocol: "openai-chat",
        baseUrl: "https://backup.example/v1",
        headers: {},
        keys: [{ name: "backup-key-1", secret: "backup-secret-1" as SecretString, enabled: true }],
        keyStrategy: "fill-first",
      },
      {
        name: "anthropic-provider",
        protocol: "anthropic-messages",
        baseUrl: "https://anthropic.example/v1",
        headers: {},
        keys: [{ name: "anthropic-key-1", secret: "anthropic-secret" as SecretString, enabled: true }],
        keyStrategy: "fill-first",
      },
    ],
    models: [
      {
        name: "gpt-main",
        aliases: [],
        provider: "chat-provider",
        upstreamModel: "gpt-5.4",
        defaults: { temperature: 0.2 },
        extraBody: {},
        overrides: { store: false },
        pricing: null,
        catalog: catalog(),
      },
      {
        name: "claude-main",
        aliases: [],
        provider: "anthropic-provider",
        upstreamModel: "claude-4",
        defaults: {},
        extraBody: {},
        overrides: {},
        pricing: null,
        catalog: catalog(),
      },
      {
        name: "gpt-backup",
        aliases: [],
        provider: "backup-chat-provider",
        upstreamModel: "gpt-5.4-backup",
        defaults: {},
        extraBody: {},
        overrides: {},
        pricing: null,
        catalog: catalog(),
      },
    ],
    routes: [
      {
        name: "retry-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: ["rate_limit", "quota", "timeout", "unavailable"],
        fallbackOn: ["rate_limit", "quota", "timeout", "unavailable"],
        catalog: catalog(),
      },
      {
        name: "head-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["rate_limit", "quota", "timeout", "unavailable", "conflict", "provider"],
        catalog: catalog(),
      },
      {
        name: "timeout-no-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["rate_limit"], // timeout is NOT in fallbackOn
        catalog: catalog(),
      },
      {
        name: "transport-no-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["rate_limit"], // unavailable/transport error is NOT in fallbackOn
        catalog: catalog(),
      },
      {
        name: "no-unavailable-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["rate_limit"], // unavailable is NOT in fallbackOn
        catalog: catalog(),
      },
      {
        name: "skip-after-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "claude-main"], // claude-main is incompatible protocol (preflight skip)
        retryOn: [],
        fallbackOn: ["rate_limit"],
        catalog: catalog(),
      },
      {
        name: "body-interrupt-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: ["stream_interrupted"],
        fallbackOn: ["stream_interrupted"],
        catalog: catalog(),
      },
      {
        name: "body-interrupt-strict-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: [],
        catalog: catalog(),
      },
    ],
    routing: {
      keyPool: {
        failureCooldownMs: [500, 1000],
        rateLimitFallbackMs: 500,
        maxRetryAfterMs: 60_000,
        jitterRatio: 0,
      },
    },
    metrics: { enabled: true },
    logging: { enabled: true, level: "info" },
    tracing: {
      enabled: true,
      root: "/tmp/traces",
      retention: { maxAgeMs: 86400000, maxBytes: 10485760, cleanupIntervalMs: 60000 },
    },
    dryRun: { enabled: false },
    ...overrides,
  };
}

interface Harness {
  gateway: Gateway;
  dispatcher: FixtureDispatcher;
  traceRoot: string;
  clock: TestClock;
  sleeper: TestSleeper;
  observer: GatewayObservability;
  events: LifecycleEvent[];
  logs: string[];
}

function buildHarness(configOverrides: Partial<AptusConfig> = {}): Harness {
  const traceRoot = mkdtempSync(join(tmpdir(), "aptus-gateway-"));
  const dispatcher = createFixtureDispatcher();
  const clock = new TestClock(1000);
  const sleeper = new TestSleeper(clock);
  const random = new TestRandomSource([0]);
  const { observer, events, logs } = trackingObserver();

  const traceRecorder = createFileTraceRecorder({
    root: traceRoot,
    secrets: new Set([
      "client-secret",
      "provider-secret-1",
      "provider-secret-2",
      "provider-secret-3",
      "anthropic-secret",
    ]),
    onFailure: () => undefined,
    onDegrade: () => undefined,
    onRecover: () => undefined,
  });

  activeTraceRecorder = traceRecorder;
  activeObserver = observer;
  activeClock = clock;

  const gateway = createGateway({
    config: buildConfig(configOverrides),
    revision: "sha256:test",
    adapters: createProtocolAdapters(),
    dispatcher,
    traceRecorder,
    observer,
    clock,
    sleeper,
    random,
  });
  return { gateway, dispatcher, traceRoot, clock, sleeper, observer, events, logs };
}

const SINGLE_KEY_PROVIDERS: readonly ProviderConfig[] = [
  {
    name: "chat-provider",
    protocol: "openai-chat",
    baseUrl: "https://chat.example/v1",
    headers: {},
    keys: [{ name: "single-key", secret: "sec" as SecretString, enabled: true }],
    keyStrategy: "fill-first",
  },
];

async function request(body: JsonObject, overrides: Partial<GatewayRequest> = {}): Promise<GatewayRequest> {
  const aptusRequestId = overrides.aptusRequestId ?? createRequestId();
  const protocol = overrides.protocol ?? "openai-chat";
  const clock = activeClock ?? systemClock;
  const observer = activeObserver ?? trackingObserver().observer;
  const trace =
    overrides.trace ??
    (activeTraceRecorder !== undefined
      ? await activeTraceRecorder.start({
          aptusRequestId,
          startedAtLocal: "2026-08-17T12-00-00.000+0000",
          configRevision: "sha256:test",
          sourceProtocol: protocol,
        })
      : {
          recordJson: async () => {},
          recordBytes: async () => {},
          openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
          finish: async () => {},
        });
  const coordinator =
    overrides.coordinator ??
    createTerminalCoordinator({
      aptusRequestId,
      endpointProtocol: protocol,
      startedMs: clock.nowMonotonicMs(),
      trace,
      observer,
      clock,
    });
  coordinator.markIngress(body.stream === true);
  observer.observe({ type: "request_ingress", aptusRequestId, sourceProtocol: protocol, stream: body.stream === true });
  return {
    aptusRequestId,
    protocol,
    endpoint: "/chat/completions",
    headers: { "content-type": "application/json" },
    body,
    clientKeyName: "client",
    signal: new AbortController().signal,
    canonicalPublicName: typeof body.model === "string" ? body.model : "chat-default",
    resolutionKind: "model",
    stream: body.stream === true,
    coordinator,
    trace,
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function traceFiles(root: string): string[] {
  const dir = readdirSync(root).find((name) => !name.startsWith("."));
  assert.ok(dir, "trace directory created");
  return readdirSync(join(root, dir)).sort();
}

function readTrace(root: string, filename: string): unknown {
  const dir = readdirSync(root).find((name) => !name.startsWith("."));
  assert.ok(dir);
  return JSON.parse(readFileSync(join(root, dir, filename), "utf8"));
}

test.concurrent("complete Chat relays exact bytes with mutation, model replacement, and auth", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(
    await request({ model: "gpt-main", messages: [{ role: "user", content: "hi" }], unknown: [1, 2] }),
  );
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.body.bytes(), COMPLETE_CHAT_BYTES);
  await result.onDelivered?.(10);

  const dispatched = dispatcher.lastRequest()?.prepared;
  assert.ok(dispatched);
  assert.equal(dispatched.url, "https://chat.example/v1/chat/completions");
  assert.equal(dispatched.headers.authorization, "Bearer provider-secret-1");
  assert.equal(dispatched.headers["openai-organization"], "org");
  const dispatchedBody = JSON.parse(new TextDecoder().decode(dispatched.body)) as JsonObject;
  assert.equal(dispatchedBody.model, "gpt-5.4");
  assert.equal(dispatchedBody.temperature, 0.2);
  assert.equal(dispatchedBody.store, false);
  assert.deepEqual(dispatchedBody.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(dispatchedBody.unknown, [1, 2]);

  assert.deepEqual(traceFiles(traceRoot), [
    "000_manifest.json",
    "001_preflight.json",
    "002_key_selection.json",
    "003_mutation.json",
    "004_provider_request.json",
    "005_provider_response_head.json",
    "006_provider_response.json",
    "007_client_response.json",
    "999_terminal.json",
  ]);
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "complete",
    status: 200,
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  });
});

test.concurrent("two 429s with three keys rotate keys with zero sleep and succeed on third attempt", async () => {
  const { gateway, dispatcher, sleeper, traceRoot, events } = buildHarness();

  // Attempt 1: 429 with key-1
  dispatcher.enqueue({ status: 429, headers: { "retry-after": "1" }, body: ERROR_BYTES });
  // Attempt 2: 429 with key-2
  dispatcher.enqueue({ status: 429, headers: { "retry-after": "1" }, body: ERROR_BYTES });
  // Attempt 3: 200 with key-3
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  if (result.kind === "complete") {
    await result.onDelivered?.(10);
  }
  assert.equal(dispatcher.dispatchCount(), 3);

  // Assert keys rotated across the 3 attempts:
  const requests = dispatcher.requests();
  assert.equal(requests[0]?.prepared.headers.authorization, "Bearer provider-secret-1");
  assert.equal(requests[1]?.prepared.headers.authorization, "Bearer provider-secret-2");
  assert.equal(requests[2]?.prepared.headers.authorization, "Bearer provider-secret-3");

  // Zero sleep occurred because a healthy key was available immediately for rotation
  assert.deepEqual(sleeper.sleeps, []);

  // Assert lifecycle event sequence
  const eventTypes = events.map((e) => e.type);
  assert.deepEqual(eventTypes, [
    "request_ingress",
    "attempt_started",
    "retry_scheduled",
    "attempt_started",
    "retry_scheduled",
    "attempt_started",
    "request_terminal",
  ]);

  // Assert retry trace stages exist
  const files = traceFiles(traceRoot);
  assert.ok(files.some((f) => f.includes("_retry.json")));
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "complete",
    status: 200,
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  });
});

test.concurrent("attempt cap limits same-candidate retries to at most two retries after first attempt", async () => {
  const { gateway, dispatcher } = buildHarness();

  // 3 continuous 429s on candidate 1 (exhausting 1 initial + 2 retries)
  dispatcher.enqueue({ status: 429, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 429, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 429, body: ERROR_BYTES });
  // Backup candidate succeeds on its first attempt
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");

  // Exactly 3 attempts on candidate 1 (initial + 2 retries), then 1 attempt on candidate 2
  assert.equal(dispatcher.dispatchCount(), 4);
  const requests = dispatcher.requests();
  assert.equal(requests[0]?.prepared.provider, "chat-provider");
  assert.equal(requests[1]?.prepared.provider, "chat-provider");
  assert.equal(requests[2]?.prepared.provider, "chat-provider");
  assert.equal(requests[3]?.prepared.provider, "backup-chat-provider");
});

test.concurrent("503 exhausts retries on candidate 1 then falls back to candidate 2", async () => {
  const { gateway, dispatcher, events } = buildHarness();

  // 3 consecutive 503s on candidate 1
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });
  // Candidate 2 succeeds
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 4);

  // Assert fallback event occurred
  const fallbackEvent = events.find((e) => e.type === "fallback_selected");
  assert.ok(fallbackEvent);
  if (fallbackEvent && fallbackEvent.type === "fallback_selected") {
    assert.equal(fallbackEvent.fromCandidateIndex, 0);
    assert.equal(fallbackEvent.toCandidateIndex, 1);
    assert.equal(fallbackEvent.category, "unavailable");
  }
});

test.concurrent("503 head with interrupted body retries on the head category, not stream_interrupted", async () => {
  const { gateway, dispatcher } = buildHarness();

  dispatcher.enqueue({ status: 503, streamError: { kind: "transport", afterChunks: 0 } });
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  // The clean 503 head retries once (key rotation) instead of terminating or
  // falling back with stream_interrupted.
  assert.equal(dispatcher.dispatchCount(), 2);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(dispatcher.requests()[1]?.prepared.provider, "chat-provider");
});

test.concurrent("503 head with interrupted body falls back on the head category when retryOn excludes it", async () => {
  const { gateway, dispatcher, events } = buildHarness({
    routes: [
      {
        name: "head-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["unavailable"],
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 503, streamError: { kind: "transport", afterChunks: 0 } });
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "head-fallback-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 2);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(dispatcher.requests()[1]?.prepared.provider, "backup-chat-provider");

  // The fallback category is the head's "unavailable", not "stream_interrupted".
  const fallbackEvent = events.find((e) => e.type === "fallback_selected");
  assert.ok(fallbackEvent);
  if (fallbackEvent && fallbackEvent.type === "fallback_selected") {
    assert.equal(fallbackEvent.category, "unavailable");
  }
});

test.concurrent("transport/timeout failure does not retry same-candidate and falls back directly per policy", async () => {
  const { gateway, dispatcher } = buildHarness();

  // Candidate 1 throws a timeout dispatch error
  dispatcher.enqueue({ status: 0, throwDispatch: { kind: "timeout", message: "timed out" } });
  // Candidate 2 succeeds
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  // Candidate 1 dispatched once (no same-candidate retry for timeout), then fell back to candidate 2
  assert.equal(dispatcher.dispatchCount(), 2);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(dispatcher.requests()[1]?.prepared.provider, "backup-chat-provider");
});

test.concurrent("timeout does not fall back when fallbackOn excludes timeout", async () => {
  const { gateway, dispatcher } = buildHarness({
    routes: [
      {
        name: "timeout-no-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["unavailable"], // timeout intentionally excluded
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 0, throwDispatch: { kind: "timeout", message: "timed out" } });

  const result = await gateway.execute(await request({ model: "timeout-no-fallback-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.category, "timeout");
  }
  // No same-candidate retry and no fallback: exactly one dispatch.
  assert.equal(dispatcher.dispatchCount(), 1);
});

test.concurrent("transport failure does not fall back when fallbackOn excludes provider", async () => {
  const { gateway, dispatcher } = buildHarness({
    routes: [
      {
        name: "transport-no-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["unavailable"], // provider (transport) intentionally excluded
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 0, throwDispatch: { kind: "transport", message: "connection reset" } });

  const result = await gateway.execute(await request({ model: "transport-no-fallback-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.category, "provider");
  }
  assert.equal(dispatcher.dispatchCount(), 1);
});

test.concurrent("deadline expiry during retry wait aborts request with timeout failure without extra dispatch", async () => {
  // Config with short 500ms deadline
  const { gateway, dispatcher } = buildHarness({
    server: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1024,
      maxInFlight: 10,
      requestDeadlineMs: 500,
      streamIdleMs: 60_000,
      shutdownDrainMs: 1000,
      trustedProxyCidrs: [],
    },
    routing: {
      keyPool: {
        failureCooldownMs: [1000, 2000],
        rateLimitFallbackMs: 1000,
        maxRetryAfterMs: 5000,
        jitterRatio: 0,
      },
    },
    // Only 1 key so a failure forces a 1000ms wait
    providers: SINGLE_KEY_PROVIDERS,
  });

  dispatcher.enqueue({ status: 429, headers: { "retry-after": "5" }, body: ERROR_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    // Fails with timeout because 5s wait exceeds remaining deadline of 500ms
    assert.equal(result.failure.category, "timeout");
  }
  // Exactly 1 dispatch; did not perform retry dispatch past deadline
  assert.equal(dispatcher.dispatchCount(), 1);
});

test.concurrent("all candidates skipped returns unsupported_capability terminal with all skips traced", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness({
    routes: [
      {
        name: "all-mismatch-route",
        aliases: [],
        candidates: ["claude-main"], // anthropic-messages protocol vs openai-chat client
        retryOn: [],
        fallbackOn: [],
        catalog: catalog(),
      },
    ],
  });

  const result = await gateway.execute(await request({ model: "all-mismatch-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.category, "unsupported_capability");
    await result.finalize?.(10);
  }
  assert.equal(dispatcher.dispatchCount(), 0);

  const files = traceFiles(traceRoot);
  assert.ok(files.some((f) => f.includes("_candidate_skip.json")));
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "failed",
    failure: {
      category: "unsupported_capability",
      message: "no compatible provider candidate",
      capability: "openai-chat",
      retryable: false,
    },
  });
});

test.concurrent("public model dispatches once and never retries or falls back", async () => {
  const { gateway, dispatcher } = buildHarness();
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });

  // gpt-main is a public model, not a route
  const result = await gateway.execute(await request({ model: "gpt-main" }));
  assert.equal(result.kind, "complete");
  if (result.kind === "complete") {
    assert.equal(result.status, 503);
  }
  // Exactly 1 dispatch, no retry
  assert.equal(dispatcher.dispatchCount(), 1);
});

test.concurrent("SSE Chat relays byte-exact stream including [DONE]", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: SSE_CHAT_BYTES }],
  });

  const result = await gateway.execute(await request({ model: "gpt-main", stream: true }));
  assert.equal(result.kind, "stream");
  if (result.kind !== "stream") return;
  assert.equal(result.status, 200);
  assert.deepEqual(await readAll(result.body), SSE_CHAT_BYTES);
  await result.onDelivered?.(10);

  assert.deepEqual(traceFiles(traceRoot), [
    "000_manifest.json",
    "001_preflight.json",
    "002_key_selection.json",
    "003_mutation.json",
    "004_provider_request.json",
    "005_provider_response_head.json",
    "006_provider_stream.sse",
    "999_terminal.json",
  ]);
  const dir = readdirSync(traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir);
  assert.deepEqual(new Uint8Array(readFileSync(join(traceRoot, dir, "006_provider_stream.sse"))), SSE_CHAT_BYTES);
});

test.concurrent("stream error surfaces as a failure with the typed category", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: "data: x\n\n" }],
    streamError: { kind: "idle_timeout", afterChunks: 1 },
  });

  const result = await gateway.execute(await request({ model: "gpt-main", stream: true }));
  assert.equal(result.kind, "stream");
  if (result.kind !== "stream") return;
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await assert.rejects(reader.read());
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "failed",
    failure: { category: "timeout", message: "provider stream timed out", retryable: false },
  });
});

test.concurrent("post-first-byte stream failure cannot fall back to a later candidate", async () => {
  const { gateway, dispatcher, events } = buildHarness();
  // Candidate 1 streams a chunk, then errors mid-stream. Because bytes have
  // reached the client, the gateway must not fall back to candidate 2.
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: "data: x\n\n" }],
    streamError: { kind: "idle_timeout", afterChunks: 1 },
  });

  const result = await gateway.execute(await request({ model: "retry-route", stream: true }));
  assert.equal(result.kind, "stream");
  if (result.kind !== "stream") return;
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await assert.rejects(reader.read());

  // Exactly one dispatch: no retry, no fallback after the first byte.
  assert.equal(dispatcher.dispatchCount(), 1);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(
    events.some((e) => e.type === "fallback_selected"),
    false,
  );
});

test.concurrent("client abort cancels the provider body and records a cancelled terminal", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: "data: x\n\n" }],
    heldOpen: true,
  });

  const controller = new AbortController();
  const result = await gateway.execute(
    await request({ model: "gpt-main", stream: true }, { signal: controller.signal }),
  );
  assert.equal(result.kind, "stream");
  if (result.kind !== "stream") return;
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  controller.abort();
  await assert.rejects(reader.read());
  assert.equal(dispatcher.lastRequest()?.cancelledAtMs !== undefined, true);
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), { kind: "cancelled", by: "client" });
});

test.concurrent("single-key 429 waits out the observed Retry-After cooldown and succeeds on retry", async () => {
  const { gateway, dispatcher, sleeper } = buildHarness({ providers: SINGLE_KEY_PROVIDERS });

  dispatcher.enqueue({ status: 429, headers: { "retry-after": "1" }, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 2);
  // No healthy key to rotate to: exactly one wait for the observed 1s cooldown.
  assert.deepEqual(sleeper.sleeps, [1000]);
});

test.concurrent("observed Retry-After on 503 overrides the fixed failure cooldown rung", async () => {
  const { gateway, dispatcher, sleeper } = buildHarness({ providers: SINGLE_KEY_PROVIDERS });

  dispatcher.enqueue({ status: 503, headers: { "retry-after": "2" }, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "retry-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 2);
  // The fixed rung would be 500ms; the observed Retry-After wins with 2000ms.
  assert.deepEqual(sleeper.sleeps, [2000]);
});

test.concurrent("exhausted 503 stays on the candidate when fallbackOn excludes unavailable", async () => {
  const { gateway, dispatcher, events } = buildHarness({
    routes: [
      {
        name: "no-unavailable-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: ["unavailable"],
        fallbackOn: ["timeout"], // unavailable intentionally excluded
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });
  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });

  const result = await gateway.execute(await request({ model: "no-unavailable-fallback-route" }));
  // Retries exhausted, no fallback permitted: the native 503 body relays unchanged.
  assert.equal(result.kind, "complete");
  if (result.kind === "complete") {
    assert.equal(result.status, 503);
  }
  assert.equal(dispatcher.dispatchCount(), 3);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(
    events.some((e) => e.type === "fallback_selected"),
    false,
  );
});

test.concurrent("fallback into a protocol-skipped candidate surfaces the original failure as terminal", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness({
    routes: [
      {
        name: "skip-after-fallback-route",
        aliases: [],
        candidates: ["gpt-main", "claude-main"], // claude-main is anthropic: skipped for a chat client
        retryOn: [],
        fallbackOn: ["unavailable"],
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 503, body: ERROR_BYTES });

  const result = await gateway.execute(await request({ model: "skip-after-fallback-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    // The real 503 outcome, not a synthetic key-unavailable stand-in.
    assert.equal(result.failure.category, "unavailable");
    assert.equal(result.failure.message, "upstream provider request failed");
    await result.finalize?.(10);
  }
  assert.equal(dispatcher.dispatchCount(), 1);
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "failed",
    failure: { category: "unavailable", message: "upstream provider request failed", retryable: false },
  });
});

test.concurrent("interrupted non-stream provider body falls back by policy before any client byte", async () => {
  const { gateway, dispatcher } = buildHarness({
    routes: [
      {
        name: "body-interrupt-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: ["rate_limit"],
        fallbackOn: ["unavailable", "stream_interrupted"],
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 200, streamError: { kind: "transport", afterChunks: 0 } });
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(await request({ model: "body-interrupt-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 2);
  assert.equal(dispatcher.requests()[0]?.prepared.provider, "chat-provider");
  assert.equal(dispatcher.requests()[1]?.prepared.provider, "backup-chat-provider");
});

test.concurrent("interrupted non-stream provider body terminates with stream_interrupted when policy excludes it", async () => {
  const { gateway, dispatcher } = buildHarness({
    routes: [
      {
        name: "body-interrupt-strict-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["unavailable"],
        catalog: catalog(),
      },
    ],
  });

  dispatcher.enqueue({ status: 200, streamError: { kind: "transport", afterChunks: 0 } });

  const result = await gateway.execute(await request({ model: "body-interrupt-strict-route" }));
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.category, "stream_interrupted");
  }
  assert.equal(dispatcher.dispatchCount(), 1);
});

test.concurrent("large complete response exceeding 64 KiB spools to disk and streams without full-RAM materialization", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();

  // Create a 128 KiB JSON response (exceeds 64 KiB memory threshold)
  const largePadding = "x".repeat(128 * 1024);
  const largeJson = JSON.stringify({
    id: "chatcmpl-large",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: largePadding } }],
    usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
  });
  const largeBytes = new TextEncoder().encode(largeJson);

  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: largeBytes,
  });

  const result = await gateway.execute(await request({ model: "gpt-main" }));
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;

  assert.equal(result.status, 200);
  assert.equal(result.body.inMemoryBytes, undefined, "Large body must be spooled to disk, not retained in RAM");

  // Read the body stream to verify exact bytes
  const streamReader = result.body.stream().getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  assert.equal(totalLength, largeBytes.length);

  await result.onDelivered?.(25);
  await result.body.dispose();

  // Trace recorded stages properly
  const files = traceFiles(traceRoot);
  assert.ok(files.includes("000_manifest.json"));
  assert.ok(files.includes("006_provider_response.bin"));
  assert.ok(files.includes("999_terminal.json"));

  const dir = readdirSync(traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir);
  const traceBytes = new Uint8Array(readFileSync(join(traceRoot, dir, "006_provider_response.bin")));
  assert.equal(traceBytes.length, largeBytes.length);
});
