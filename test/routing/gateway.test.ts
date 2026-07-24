import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AptusConfig, SecretString } from "../../src/config/types.js";
import type { Gateway, GatewayRequest, JsonObject } from "../../src/domain/contracts.js";
import { createRequestId } from "../../src/domain/request-id.js";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.js";
import { createProtocolAdapters } from "../../src/providers/adapters.js";
import { createGateway, type GatewayObservability } from "../../src/routing/gateway.js";
import { COMPLETE_CHAT_BYTES, ERROR_BYTES, SSE_CHAT_BYTES } from "../helpers/chat-fixtures.js";
import { createFixtureDispatcher, type FixtureDispatcher } from "../helpers/fixture-dispatcher.js";

function noopObserver(): GatewayObservability {
  const noop = (): void => undefined;
  return {
    requestIngress: noop,
    requestTerminal: noop,
    authResult: noop,
    nameResolved: noop,
    candidateSkipped: noop,
    keySelected: noop,
    attemptStarted: noop,
    attemptCompleted: noop,
    firstByte: noop,
    completed: noop,
    cancelled: noop,
    setKeyPoolAvailable: noop,
  };
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

function buildConfig(): AptusConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1024,
      maxInFlight: 10,
      requestDeadlineMs: 60_000,
      streamIdleMs: 60_000,
      shutdownDrainMs: 1000,
      trustedProxyCidrs: [],
    },
    operations: { host: "127.0.0.1", port: 0 },
    auth: { clientKeys: [{ name: "client", secret: "client-secret" as SecretString }] },
    providers: [
      {
        name: "chat-provider",
        protocol: "openai-chat",
        baseUrl: "https://chat.example/v1",
        headers: { "openai-organization": "org" },
        keys: [{ name: "chat-key", secret: "provider-secret" as SecretString, enabled: true }],
        keyStrategy: "fill-first",
      },
      {
        name: "anthropic-provider",
        protocol: "anthropic-messages",
        baseUrl: "https://anthropic.example",
        headers: {},
        keys: [{ name: "anthropic-key", secret: "anthropic-secret" as SecretString, enabled: true }],
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
        catalog: catalog(),
        pricing: null,
      },
      {
        name: "claude-main",
        aliases: [],
        provider: "anthropic-provider",
        upstreamModel: "claude-opus",
        defaults: {},
        extraBody: {},
        overrides: {},
        catalog: catalog(),
        pricing: null,
      },
    ],
    routes: [
      {
        name: "cross-route",
        aliases: [],
        candidates: ["claude-main", "gpt-main"],
        retryOn: [],
        fallbackOn: [],
        catalog: catalog(),
      },
    ],
    routing: { keyPool: { failureCooldownMs: [1, 2], rateLimitFallbackMs: 1, maxRetryAfterMs: 1, jitterRatio: 0 } },
    tracing: { enabled: true, root: "./traces", retention: { maxAgeMs: 1, maxBytes: 1, cleanupIntervalMs: 1 } },
    logging: { enabled: false, level: "info" },
    metrics: { enabled: true },
    dryRun: { enabled: false },
  };
}

interface Harness {
  gateway: Gateway;
  dispatcher: FixtureDispatcher;
  traceRoot: string;
}

function buildHarness(): Harness {
  const traceRoot = mkdtempSync(join(tmpdir(), "aptus-gateway-"));
  const dispatcher = createFixtureDispatcher();
  const gateway = createGateway({
    config: buildConfig(),
    revision: "sha256:test",
    adapters: createProtocolAdapters(),
    dispatcher,
    traceRecorder: createFileTraceRecorder({
      root: traceRoot,
      secrets: new Set(["client-secret", "provider-secret", "anthropic-secret"]),
      onFailure: () => undefined,
      onRecover: () => undefined,
    }),
    observer: noopObserver(),
  });
  return { gateway, dispatcher, traceRoot };
}

function request(body: JsonObject, overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    aptusRequestId: createRequestId(),
    protocol: "openai-chat",
    endpoint: "/chat/completions",
    headers: { "content-type": "application/json" },
    body,
    clientKeyName: "client",
    signal: new AbortController().signal,
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

test("complete Chat relays exact bytes with mutation, model replacement, and auth", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(
    request({ model: "gpt-main", messages: [{ role: "user", content: "hi" }], unknown: [1, 2] }),
  );
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, COMPLETE_CHAT_BYTES);

  const dispatched = dispatcher.lastRequest()?.prepared;
  assert.ok(dispatched);
  assert.equal(dispatched.url, "https://chat.example/v1/chat/completions");
  assert.equal(dispatched.headers.authorization, "Bearer provider-secret");
  assert.equal(dispatched.headers["openai-organization"], "org");
  const dispatchedBody = JSON.parse(new TextDecoder().decode(dispatched.body)) as JsonObject;
  assert.equal(dispatchedBody.model, "gpt-5.4");
  assert.equal(dispatchedBody.temperature, 0.2);
  assert.equal(dispatchedBody.store, false);
  assert.deepEqual(dispatchedBody.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(dispatchedBody.unknown, [1, 2]);

  assert.deepEqual(traceFiles(traceRoot), [
    "000_manifest.json",
    "001_client_request.json",
    "002_authentication.json",
    "003_resolution.json",
    "004_preflight.json",
    "005_key_selection.json",
    "006_mutation.json",
    "007_provider_request.json",
    "008_provider_response_head.json",
    "009_provider_response.json",
    "010_client_response.json",
    "999_terminal.json",
  ]);
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), { kind: "complete", status: 200 });
});

test("SSE Chat relays byte-exact stream including [DONE]", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: SSE_CHAT_BYTES }],
  });

  const result = await gateway.execute(request({ model: "gpt-main", stream: true }));
  assert.equal(result.kind, "stream");
  if (result.kind !== "stream") return;
  assert.equal(result.status, 200);
  assert.deepEqual(await readAll(result.body), SSE_CHAT_BYTES);

  assert.deepEqual(traceFiles(traceRoot), [
    "000_manifest.json",
    "001_client_request.json",
    "002_authentication.json",
    "003_resolution.json",
    "004_preflight.json",
    "005_key_selection.json",
    "006_mutation.json",
    "007_provider_request.json",
    "008_provider_response_head.json",
    "009_provider_stream.sse",
    "010_client_stream.sse",
    "999_terminal.json",
  ]);
  const dir = readdirSync(traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir);
  assert.deepEqual(new Uint8Array(readFileSync(join(traceRoot, dir, "009_provider_stream.sse"))), SSE_CHAT_BYTES);
  assert.deepEqual(new Uint8Array(readFileSync(join(traceRoot, dir, "010_client_stream.sse"))), SSE_CHAT_BYTES);
});

test("protocol-mismatch candidate is skipped with zero dispatch", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

  const result = await gateway.execute(request({ model: "cross-route" }));
  assert.equal(result.kind, "complete");
  assert.equal(dispatcher.dispatchCount(), 1);
  assert.equal(dispatcher.lastRequest()?.prepared.provider, "chat-provider");
  assert.deepEqual(readTrace(traceRoot, "004_candidate_skip.json"), {
    candidateIndex: 0,
    provider: "anthropic-provider",
    targetProtocol: "anthropic-messages",
    category: "unsupported_capability",
    capability: "anthropic-messages",
  });
});

test("non-2xx provider response is relayed unchanged with a failed terminal", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({ status: 401, body: ERROR_BYTES });

  const result = await gateway.execute(request({ model: "gpt-main" }));
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, ERROR_BYTES);
  assert.deepEqual(readTrace(traceRoot, "999_terminal.json"), {
    kind: "failed",
    failure: { category: "authentication", message: "upstream provider request failed", retryable: false },
  });
});

test("stream error surfaces as a failure with the typed category", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: "data: x\n\n" }],
    streamError: { kind: "idle_timeout", afterChunks: 1 },
  });

  const result = await gateway.execute(request({ model: "gpt-main", stream: true }));
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

test("client abort cancels the provider body and records a cancelled terminal", async () => {
  const { gateway, dispatcher, traceRoot } = buildHarness();
  dispatcher.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    segments: [{ bytes: "data: x\n\n" }],
    heldOpen: true,
  });

  const controller = new AbortController();
  const result = await gateway.execute(request({ model: "gpt-main", stream: true }, { signal: controller.signal }));
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
