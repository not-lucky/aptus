import { describe, expect, it } from "vitest";
import { DefaultGatewayApplication } from "../../src/application/index.js";
import type { GatewayPlugin, HookManager, HookTimeoutConfiguration } from "../../src/application/index.js";
import { AuthenticationPlugin, CostAuditPlugin, PluginRegistry, RateLimitPlugin, type PluginRegistration } from "../../src/plugins/index.js";
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse, RouteCandidate } from "../../src/domain/index.js";
import type { AdapterRegistry } from "../../src/application/index.js";
import type { ProviderDispatchPort, RawIngressInput, DispatchPolicyPort, CredentialStatePort, TracePort } from "../../src/ports/index.js";

const dispatchPolicies: DispatchPolicyPort = {
  snapshot: () => ({
    defaultDryRun: false,
    resolve: () => ({
      attemptBudget: { maxAttempts: 1, maxLatencyMs: 1000, maxCostUsd: 1_000_000 },
      statusPolicy: { retryable: [], nonRetryable: [] },
      providerTimeoutMs: 1000,
      streamIdleTimeoutMs: 1000,
      contextTokens: 1000,
    }),
  }),
};
const credentials: CredentialStatePort = {
  state: () => "active",
  snapshot: () => ({ state: "active", penaltyCount: 0 }),
  eligible: () => true,
  hasEligible: () => true,
  counts: () => ({ active: 1, cooldown: 0, critical_failure: 0, suspended: 0 }),
  failure: () => ({ state: "active", delayMs: 0, retryable: false }),
  success: () => undefined,
  quarantine: () => undefined,
  reset: () => undefined,
  probe: () => undefined,
};
const trace: TracePort = { record: async () => undefined };
const request: CanonicalRequest = { requestId: "policy-app", receivedAt: "2026-07-20T00:00:00Z", source: { adapter: "test", protocol: "custom", path: "/test" }, model: "model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], routing: {}, stream: false };
const response: CanonicalResponse = { requestId: request.requestId, responseId: "cached", createdAt: request.receivedAt, model: request.model, status: "completed", choices: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0, currency: "USD" }, provider: { providerId: "provider", credentialId: "credential", physicalModel: "model", responseHeaders: {}, upstreamStatus: 200 } };
const candidate: RouteCandidate = { routeId: "route", providerId: "provider", credentialId: "credential", physicalModel: "model", capabilities: new Set(), estimatedCostUsd: 0 };
const timeouts: HookTimeoutConfiguration = Object.freeze({ onIngressReceived: { timeoutMs: 1000, retryable: false }, onCanonicalTranslate: { timeoutMs: 1000, retryable: false }, onRouteResolve: { timeoutMs: 1000, retryable: false }, beforeUpstreamDispatch: { timeoutMs: 1000, retryable: false }, onUpstreamResponse: { timeoutMs: 1000, retryable: false }, onStreamChunk: { timeoutMs: 1000, retryable: false }, onEgressTranslate: { timeoutMs: 1000, retryable: false }, onError: { timeoutMs: 1000, retryable: false } });
function plugin(id: string, overrides: Partial<GatewayPlugin>): GatewayPlugin { return { id, version: "1.0.0", hooks: [], priority: 0, ...overrides }; }
function setup(hooks: HookManager, dispatch: ProviderDispatchPort, translated: CanonicalRequest): { app: DefaultGatewayApplication; input: RawIngressInput } {
  const ingress = { protocol: "custom" as const, paths: new Set(["/test"]), canTranslate: () => true, translate: () => translated };
  const egress = { protocol: "custom" as const, encodeResponse: () => "encoded", encodeChunk: () => "chunk", encodeError: () => "error" };
  const adapters: AdapterRegistry = { ingress: () => ingress, egress: () => egress };
  const app = new DefaultGatewayApplication({ adapters, hooks, routes: { resolve: async () => [candidate] }, providers: { create: () => dispatch }, clock: { now: () => 0, sleep: async (_delay, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } }, requestIds: () => translated.requestId, hookTimeouts: timeouts, auth: { authenticate: async () => undefined }, dispatchPolicies, credentials, trace });
  return { app, input: { path: "/test", headers: {}, body: {}, requestId: translated.requestId } };
}
describe("policy application lifecycle", () => {
  it("returns cache response without dispatch and still runs egress", async () => {
    let dispatches = 0;
    let egresses = 0;
    const cache = plugin("cache-lookup", { hooks: ["onCanonicalTranslate", "onEgressTranslate"], onCanonicalTranslate: (context, value) => { context.setState("cache-lookup:response", response); return { kind: "shortCircuit", value }; }, onEgressTranslate: (_context, value) => { egresses += 1; return { kind: "continue", value }; } });
    const registry = new PluginRegistry([{ plugin: plugin("authentication", {}), enabled: true }, { plugin: cache, enabled: true } as PluginRegistration]);
    const dispatch: ProviderDispatchPort = { dispatch: async () => { dispatches += 1; return response; }, stream: async function* () { yield { type: "response_end", status: "completed" }; } };
    const { app, input } = setup(registry, dispatch, request);
    const exchange = app.open(input);
    expect(await exchange.handle()).toBe(response);
    const encoded = await exchange.runEgress("encoded");
    exchange.commitEgress();
    expect(encoded).toBe("encoded");
    await exchange.close();
    expect(dispatches).toBe(0);
    expect(egresses).toBe(1);
  });
  it("emits ordered cached choice content without opening provider stream", async () => {
    let streams = 0;
    const cachedResponse: CanonicalResponse = {
      ...response,
      choices: [{
        index: 0,
        output: [{ type: "text", text: "cached answer" }],
        finishReason: "stop",
      }],
    };
    const cached = plugin("cache-lookup", {
      hooks: ["onCanonicalTranslate"],
      onCanonicalTranslate: (context, value) => {
        context.setState("cache-lookup:response", cachedResponse);
        return { kind: "shortCircuit", value };
      },
    });
    const registry = new PluginRegistry([{ plugin: plugin("authentication", {}), enabled: true }, { plugin: cached, enabled: true } as PluginRegistration]);
    const dispatch: ProviderDispatchPort = { dispatch: async () => response, stream: async function* () { streams += 1; yield { type: "response_end", status: "completed" }; } };
    const { app, input } = setup(registry, dispatch, { ...request, stream: true });
    const chunks: CanonicalChunk[] = [];
    for await (const chunk of app.stream(input)) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response_start",
      "content_block_start",
      "text_delta",
      "content_block_stop",
      "choice_end",
      "usage",
      "response_end",
    ]);
    expect(chunks.find((chunk) => chunk.type === "text_delta")).toMatchObject({ text: "cached answer" });
    expect(chunks.map((chunk) => "sequenceNumber" in chunk ? chunk.sequenceNumber : undefined)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(streams).toBe(0);
  });
  it("gates each cached exchange chunk on prior egress", async () => {
    const cachedResponse: CanonicalResponse = {
      ...response,
      choices: [{ index: 0, output: [{ type: "text", text: "cached" }], finishReason: "stop" }],
    };
    const cached = plugin("cache-lookup", {
      hooks: ["onCanonicalTranslate"],
      onCanonicalTranslate: (context, value) => {
        context.setState("cache-lookup:response", cachedResponse);
        return { kind: "shortCircuit", value };
      },
    });
    const registry = new PluginRegistry([
      { plugin: plugin("authentication", {}), enabled: true },
      { plugin: cached, enabled: true } as PluginRegistration,
    ]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: async function* () { throw new Error("provider stream must not open"); },
    };
    const { app, input } = setup(registry, dispatch, { ...request, stream: true });
    const exchange = app.open(input);
    const iterator = exchange.stream()[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("response_start");
    let secondSettled = false;
    const second = iterator.next().then((result) => { secondSettled = true; return result; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    const encoded = await exchange.runEgress("encoded-cached-chunk");
    exchange.commitEgress();
    expect(encoded).toBe("encoded-cached-chunk");
    expect((await second).value?.type).toBe("content_block_start");
    await iterator.return?.();
    await exchange.close();
  });
  it("returns dry-run estimate without quota or provider calls", async () => {
    let dispatches = 0;
    const costAudit = new CostAuditPlugin({
      estimate: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      prices: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    });
    const registry = new PluginRegistry([
      { plugin: plugin("authentication", {}), enabled: true },
      { plugin: costAudit, enabled: true } as PluginRegistration,
    ]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => { dispatches += 1; return response; },
      stream: async function* () { dispatches += 1; yield { type: "response_end", status: "completed" }; },
    };
    const { app, input } = setup(registry, dispatch, {
      ...request,
      routing: { dryRun: true },
    });
    const result = await app.handle(input);
    expect(result).toMatchObject({
      status: "completed",
      usage: { totalTokens: 0 },
      cost: { totalUsd: 0.00002 },
      extensions: { custom: { dryRun: true, estimatedTokens: 15, actualCostUsd: 0 } },
    });
    expect(dispatches).toBe(0);
  });

  it("treats malformed cache values as misses", async () => {
    let dispatches = 0;
    const malformed = plugin("cache-lookup", {
      hooks: ["onCanonicalTranslate"],
      onCanonicalTranslate: (context, value) => {
        context.setState("cache-lookup:response", { ...response, status: "unknown" });
        return { kind: "continue", value };
      },
    });
    const registry = new PluginRegistry([
      { plugin: plugin("authentication", {}), enabled: true },
      { plugin: malformed, enabled: true } as PluginRegistration,
      { plugin: new CostAuditPlugin({ estimate: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), prices: () => undefined }), enabled: true } as PluginRegistration,
    ]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => { dispatches += 1; return response; },
      stream: async function* () { yield { type: "response_end", status: "completed" }; },
    };
    const { app, input } = setup(registry, dispatch, request);
    expect(await app.handle(input)).toBe(response);
    expect(dispatches).toBe(1);
  });
  it("reserves the concrete cost-audit estimate before provider dispatch", async () => {
    let reserved: unknown;
    const authentication = new AuthenticationPlugin({
      auth: { authenticate: async () => ({ clientId: "client", allowedModelAliases: new Set(["model"]), limits: { rpm: 10, tpm: 100, dailyTokens: 1000, dailyCostUsd: 5 }, dryRun: false }) },
      tokenHashAlgorithm: "sha256",
    });
    const costAudit = new CostAuditPlugin({
      estimate: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      prices: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    });

    const rateLimit = new RateLimitPlugin({
      estimateTokens: () => 15,
      estimateCostUsd: () => 0.00002,
      port: {
        reserve: async (value) => { reserved = value; return "reservation"; },
        release: async () => undefined,
      },
    });
    const registry = new PluginRegistry([
      { plugin: authentication, enabled: true },
      { plugin: costAudit, enabled: true },
      { plugin: rateLimit, enabled: true },
    ] as PluginRegistration[]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: async function* () { yield { type: "response_end", status: "completed" }; },
    };
    const { app, input } = setup(registry, dispatch, request);
    const authorizedInput = { ...input, authorization: "Bearer fixture" };
    await app.handle(authorizedInput);
    expect(registry.ordered("onCanonicalTranslate").map((entry) => entry.id)).toEqual(["rate-limit"]);
    expect(registry.ordered("beforeUpstreamDispatch").map((entry) => entry.id)).toEqual(["cost-audit"]);
    expect(reserved).toMatchObject({ estimatedTokens: 15, estimatedCostUsd: 0.00002, dailyCostUsd: 5 });
  });
});
