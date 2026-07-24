import { describe, expect, it } from "vitest";
import { ConfiguredDispatchPolicyPort, DispatchPolicyResolutionError, GatewayConfigSchema } from "../../src/config/index.js";

const config = GatewayConfigSchema.parse({
  server: { port: 11248, cors: { origins: ["https://example.com"] }, bodyTimeoutMs: 100, requestTimeoutMs: 1000, streamIdleTimeoutMs: 200, logLevel: "info", trace: { enabled: false, destination: "stdout" }, metrics: { enabled: true, path: "/metrics" }, health: { path: "/health", upstreamCheck: false }, defaultDryRun: true },
  clients: [{ id: "client-one", tokenHashRef: "env:HASH", limits: { rpm: 1, tpm: 1, dailyTokens: 1, dailyCostUsd: 1 }, allowedModelAliases: ["model-one"] }],
  providers: [{ id: "provider-one", protocol: "custom", baseUrl: "https://provider.example.com", timeoutMs: 300, customHeaders: {}, credentials: [{ id: "credential-one", secretRef: "env:KEY", weight: 1 }], credentialSelection: "fill-first" }],
  models: [{ alias: "model-one", targets: [{ providerId: "provider-one", physicalModel: "physical-one", pricesPerMillionUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, capabilities: [], contextTokens: 4096 }] }],
  routes: [{ id: "route-one", modelAliases: ["model-one"], orderedCandidates: [{ providerId: "provider-one", modelAlias: "model-one", weight: 1 }], requiredCapabilities: [], conditions: [], fallbackGroups: [], attemptBudget: { maxAttempts: 2, maxLatencyMs: 900, maxCostUsd: 1 }, statusPolicy: { retryable: [500], nonRetryable: [503] } }],
  plugins: [{ id: "authentication", version: "1.0.0", enabled: true, hooks: ["onIngressReceived"], priority: 0 }],
});

describe("ConfiguredDispatchPolicyPort", () => {
  it("captures one immutable policy snapshot and resolves candidate policy", () => {
    let reads = 0;
    const port = new ConfiguredDispatchPolicyPort({ configuration: { snapshot: () => { reads += 1; return config; } } });
    const snapshot = port.snapshot();
    const policy = snapshot.resolve({ routeId: "route-one", providerId: "provider-one", credentialId: "credential-one", physicalModel: "physical-one", capabilities: new Set(), estimatedCostUsd: 0 });
    expect(reads).toBe(1);
    expect(snapshot.defaultDryRun).toBe(true);
    expect(policy).toMatchObject({ providerTimeoutMs: 300, streamIdleTimeoutMs: 200, contextTokens: 4096, attemptBudget: { maxAttempts: 2 }, statusPolicy: { retryable: [500], nonRetryable: [503] } });
    expect(Object.isFrozen(policy.statusPolicy.retryable)).toBe(true);
    expect(reads).toBe(1);
  });

  it("throws the fixed safe error for missing captured references", () => {
    const snapshot = new ConfiguredDispatchPolicyPort({ configuration: { snapshot: () => config } }).snapshot();
    expect(() => snapshot.resolve({ routeId: "route-one", providerId: "provider-one", credentialId: "credential-one", physicalModel: "missing", capabilities: new Set(), estimatedCostUsd: 0 })).toThrow(DispatchPolicyResolutionError);
  });
});
