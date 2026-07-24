import { describe, expect, it } from "vitest";
import { DefaultGatewayApplication } from "../../src/application/index.js";
import type { GatewayPlugin, HookTimeoutConfiguration } from "../../src/application/index.js";
import { PluginRegistry } from "../../src/plugins/index.js";
import type { CanonicalRequest, CanonicalResponse, RouteCandidate } from "../../src/domain/index.js";
import type { CredentialStatePort, ProviderDispatchPort } from "../../src/ports/index.js";
const request: CanonicalRequest = { requestId: "req-cascade", receivedAt: "2026-07-21T00:00:00Z", source: { adapter: "test", protocol: "custom", path: "/test" }, model: "model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], routing: {}, stream: false };
const candidates: RouteCandidate[] = ["a", "b"].map((providerId) => ({ routeId: "route", providerId, credentialId: `credential-${providerId}`, physicalModel: "model", capabilities: new Set(), estimatedCostUsd: 0 }));
const success: CanonicalResponse = { requestId: request.requestId, responseId: "success", createdAt: request.receivedAt, model: request.model, status: "completed", choices: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0, currency: "USD" }, provider: { providerId: "b", credentialId: "credential-b", physicalModel: "model", responseHeaders: {}, upstreamStatus: 200 } };
const timeouts = Object.fromEntries(["onIngressReceived", "onCanonicalTranslate", "onRouteResolve", "beforeUpstreamDispatch", "onUpstreamResponse", "onStreamChunk", "onEgressTranslate", "onError"].map((name) => [name, { timeoutMs: 1000, retryable: false }])) as unknown as HookTimeoutConfiguration;
const credentials: CredentialStatePort = { state: () => "active", snapshot: () => ({ state: "active", penaltyCount: 0 }), eligible: () => true, hasEligible: () => true, counts: () => ({ active: 2, cooldown: 0, critical_failure: 0, suspended: 0 }), failure: () => ({ state: "cooldown", delayMs: 1, retryable: true }), success: () => undefined, quarantine: () => undefined, reset: () => undefined, probe: () => undefined };

function application(dispatches: Record<string, ProviderDispatchPort>, translated = request): DefaultGatewayApplication {
  const estimate: GatewayPlugin = { id: "estimate", version: "1.0.0", hooks: ["beforeUpstreamDispatch"], priority: 0, beforeUpstreamDispatch: (context, value) => { context.setState("dispatch:cost-estimate", { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: success.cost }); return { kind: "continue", value }; } };
  return new DefaultGatewayApplication({
    adapters: { ingress: () => ({ protocol: "custom", paths: new Set(["/test"]), canTranslate: () => true, translate: () => translated }), egress: () => ({ protocol: "custom", encodeResponse: () => "", encodeChunk: () => "", encodeError: () => "" }) },
    hooks: new PluginRegistry([{ plugin: { id: "authentication", version: "1.0.0", hooks: [], priority: -1 }, enabled: true }, { plugin: estimate, enabled: true }]),
    routes: { resolve: async () => candidates }, providers: { create: (id) => dispatches[id]! },
    clock: { now: () => 0, sleep: async (_delay, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } }, requestIds: () => request.requestId, hookTimeouts: timeouts, auth: { authenticate: async () => undefined },
    dispatchPolicies: { snapshot: () => ({ defaultDryRun: false, resolve: () => ({ attemptBudget: { maxAttempts: 2, maxLatencyMs: 1000, maxCostUsd: 1 }, statusPolicy: { retryable: [], nonRetryable: [] }, providerTimeoutMs: 100, streamIdleTimeoutMs: 100, contextTokens: 100 }) }) }, credentials, trace: { record: async () => undefined },
  });
}

describe("DefaultGatewayApplication dispatch cascade", () => {
  it("advances from retryable connection failure to the next candidate in order", async () => {
    const order: string[] = [];
    const app = application({ a: { dispatch: async () => { order.push("a"); throw Object.assign(new Error("secret"), { code: "ECONNRESET" }); }, stream: async function* () {} }, b: { dispatch: async () => { order.push("b"); return success; }, stream: async function* () {} } });
    expect(await app.handle({ path: "/test", headers: {}, body: {}, requestId: request.requestId })).toBe(success);
    expect(order).toEqual(["a", "b"]);
  });

  it("falls back before commitment and completes the second provider stream", async () => {
    const order: string[] = [];
    const streamRequest = { ...request, stream: true };
    const app = application({
      a: { dispatch: async () => success, stream: async function* () { order.push("a"); throw Object.assign(new Error("connection"), { code: "ECONNRESET" }); } },
      b: { dispatch: async () => success, stream: async function* () { order.push("b"); yield { type: "response_start", responseId: "stream", model: "model", createdAt: request.receivedAt }; yield { type: "response_end", status: "completed" }; } },
    }, streamRequest);
    const chunks = [];
    for await (const chunk of app.stream({ path: "/test", headers: {}, body: {}, requestId: request.requestId })) chunks.push(chunk);
    expect(order).toEqual(["a", "b"]);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["response_start", "response_end"]);
  });

  it("performs dry-run without creating a provider", async () => {
    let creates = 0;
    const app = application(new Proxy({}, { get: () => { creates += 1; throw new Error("provider must not be created"); } }) as Record<string, ProviderDispatchPort>, { ...request, routing: { dryRun: true } });
    const result = await app.handle({ path: "/test", headers: {}, body: {}, requestId: request.requestId });
    expect(result).toMatchObject({ responseId: "req-cascade-dry-run", provider: { credentialId: "dry-run" }, extensions: { custom: { dryRun: true, actualCostUsd: 0 } } });
    expect(creates).toBe(0);
  });
});
