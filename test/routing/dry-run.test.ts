import assert from "node:assert/strict";
import { test } from "vitest";
import type { AptusConfig, SecretString } from "../../src/config/types.ts";
import type { GatewayRequest, JsonObject } from "../../src/domain/contracts.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import type { LifecycleEvent, LifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { aptusLogger } from "../../src/observability/logging.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";
import { createNoopTraceRecorder } from "../../src/observability/trace/noop-recorder.ts";
import { createProtocolAdapters } from "../../src/providers/adapters.ts";
import { createGateway } from "../../src/routing/gateway.ts";
import { systemClock, systemSleeper } from "../../src/routing/timing.ts";
import { COMPLETE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import { createFixtureDispatcher } from "../helpers/fixture-dispatcher.ts";

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

function buildDryRunConfig(): AptusConfig {
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
        keys: [{ name: "key-1", secret: "provider-secret-1" as SecretString, enabled: true }],
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
    ],
    routes: [],
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
    dryRun: { enabled: true },
  };
}

/**
 * Records observed telemetry moments for dry-run versus dispatch parity assertions.
 */
function parityObserver(logs: LifecycleEvent[]): LifecycleObserver {
  return {
    observe(event) {
      logs.push(event);
    },
  };
}

function createTestRequest(body: JsonObject): GatewayRequest {
  const aptusRequestId = createRequestId();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics: createMetricsRegistry(),
    loggingEnabled: false,
    metricsEnabled: false,
  });

  const coordinator = createTerminalCoordinator({
    aptusRequestId,
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: {
      recordJson: async () => {},
      recordBytes: async () => {},
      openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
      finish: async () => {},
    },
    observer,
    clock: systemClock,
  });

  return {
    aptusRequestId,
    protocol: "openai-chat",
    endpoint: "/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer client-secret" },
    body,
    clientKeyName: "client",
    signal: new AbortController().signal,
    canonicalPublicName: typeof body.model === "string" ? body.model : "gpt-main",
    resolutionKind: "model",
    stream: false,
    coordinator,
    trace: {
      recordJson: async () => {},
      recordBytes: async () => {},
      openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
      finish: async () => {},
    },
  };
}

test.concurrent("dry run returns complete inspection payload with zero network dispatch", async () => {
  const config = buildDryRunConfig();
  const dispatcher = createFixtureDispatcher();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics: createMetricsRegistry(),
    loggingEnabled: false,
    metricsEnabled: false,
  });

  const gateway = createGateway({
    config,
    revision: "test-rev",
    adapters: createProtocolAdapters(),
    dispatcher,
    traceRecorder: createNoopTraceRecorder(),
    observer,
    clock: systemClock,
    sleeper: systemSleeper,
  });

  const request = createTestRequest({
    model: "gpt-main",
    messages: [{ role: "user", content: "Hello world" }],
  });

  const result = await gateway.execute(request);

  // 1. Zero dispatch
  assert.equal(dispatcher.dispatchCount(), 0);

  // 2. Dry run result structure
  assert.equal(result.kind, "dry_run");
  if (result.kind !== "dry_run") return;

  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/vnd.aptus.dry-run+json");

  const body = result.body;
  assert.equal(body.dryRun, true);
  assert.equal(body.sourceProtocol, "openai-chat");
  assert.equal(body.targetProtocol, "openai-chat");
  assert.equal(body.publicName, "gpt-main");
  assert.deepEqual(body.candidate, {
    provider: "chat-provider",
    model: "gpt-5.4",
    key: "key-1",
  });

  // 3. Mutations applied and tracked
  assert.ok(body.mutations.includes("/model"));
  assert.ok(body.mutations.includes("/temperature"));
  assert.ok(body.mutations.includes("/store"));

  // 4. Provider request headers & body redacted
  assert.equal(body.providerRequest.url, "https://chat.example/v1/chat/completions");
  assert.equal(body.providerRequest.headers.authorization, "[REDACTED]");
  assert.equal(body.providerRequest.headers["openai-organization"], "org");
  assert.equal(body.providerRequest.body.model, "gpt-5.4");
  assert.equal(body.providerRequest.body.temperature, 0.2);
  assert.equal(body.providerRequest.body.store, false);
});

test.concurrent("dry run returns failure when candidate key is unavailable", async () => {
  const baseConfig = buildDryRunConfig();
  const config: AptusConfig = {
    ...baseConfig,
    providers: [
      {
        ...baseConfig.providers[0]!,
        keys: [{ name: "key-1", secret: "sec" as SecretString, enabled: false }],
      },
    ],
  };

  const gateway = createGateway({
    config,
    revision: "test-rev",
    adapters: createProtocolAdapters(),
    dispatcher: createFixtureDispatcher(),
    traceRecorder: createNoopTraceRecorder(),
    observer: createLifecycleObserver({
      logger: aptusLogger(),
      metrics: createMetricsRegistry(),
      loggingEnabled: false,
      metricsEnabled: false,
    }),
    clock: systemClock,
    sleeper: systemSleeper,
  });

  const request = createTestRequest({
    model: "gpt-main",
    messages: [{ role: "user", content: "Hello" }],
  });

  const result = await gateway.execute(request);
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.category, "unavailable");
  }
});

test.concurrent("dry run and dispatch share candidate fallback bookkeeping", async () => {
  const baseConfig = buildDryRunConfig();
  const config: AptusConfig = {
    ...baseConfig,
    providers: [
      {
        name: "chat-provider",
        protocol: "openai-chat",
        baseUrl: "https://chat.example/v1",
        headers: {},
        keys: [{ name: "key-1", secret: "sec" as SecretString, enabled: false }],
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
    ],
    models: [
      {
        name: "gpt-main",
        aliases: [],
        provider: "chat-provider",
        upstreamModel: "gpt-5.4",
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
        name: "fallback-route",
        aliases: [],
        candidates: ["gpt-main", "gpt-backup"],
        retryOn: [],
        fallbackOn: ["unavailable"],
        catalog: catalog(),
      },
    ],
  };

  const request = createTestRequest({
    model: "fallback-route",
    messages: [{ role: "user", content: "Hello" }],
  });

  // Dry-run mode: first candidate's pool is empty, so the engine falls back to
  // the second candidate and previews its key without ever dispatching.
  const dryRunLogs: LifecycleEvent[] = [];
  const dryRunObserver = parityObserver(dryRunLogs);
  const dryRunGateway = createGateway({
    config: { ...config, dryRun: { enabled: true } },
    revision: "test-rev",
    adapters: createProtocolAdapters(),
    dispatcher: createFixtureDispatcher(),
    traceRecorder: createNoopTraceRecorder(),
    observer: dryRunObserver,
    clock: systemClock,
    sleeper: systemSleeper,
  });
  const dryRunResult = await dryRunGateway.execute(request);
  assert.equal(dryRunResult.kind, "dry_run");
  if (dryRunResult.kind === "dry_run") {
    assert.equal(dryRunResult.body.candidate.provider, "backup-chat-provider");
  }
  assert.ok(
    dryRunLogs.some(
      (event) => event.type === "fallback_selected" && event.fromCandidateIndex === 0 && event.toCandidateIndex === 1,
    ),
    "dry run falls back through the engine",
  );

  // Dispatch mode: the same empty first pool takes the same fallback path, then
  // the second candidate actually dispatches.
  const dispatchLogs: LifecycleEvent[] = [];
  const dispatchObserver = parityObserver(dispatchLogs);
  const dispatchDispatcher = createFixtureDispatcher();
  dispatchDispatcher.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
  const dispatchGateway = createGateway({
    config: { ...config, dryRun: { enabled: false } },
    revision: "test-rev",
    adapters: createProtocolAdapters(),
    dispatcher: dispatchDispatcher,
    traceRecorder: createNoopTraceRecorder(),
    observer: dispatchObserver,
    clock: systemClock,
    sleeper: systemSleeper,
  });
  const dispatchResult = await dispatchGateway.execute(request);
  assert.equal(dispatchResult.kind, "complete");
  assert.equal(dispatchDispatcher.dispatchCount(), 1);
  assert.equal(dispatchDispatcher.lastRequest()?.prepared.provider, "backup-chat-provider");
  assert.ok(
    dispatchLogs.some(
      (event) => event.type === "fallback_selected" && event.fromCandidateIndex === 0 && event.toCandidateIndex === 1,
    ),
    "dispatch falls back through the engine",
  );
});
