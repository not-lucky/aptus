import { describe, expect, it, vi } from "vitest";
import {
  ConfiguredRouteResolver,
  GatewayConfigSchema,
  type GatewayConfig,
} from "../../src/config/index.js";
import type {
  GatewayCommand,
  GatewayContext,
} from "../../src/application/index.js";
import type {
  CanonicalRequest,
  RouteCandidate,
  TokenUsage,
} from "../../src/domain/index.js";
import type {
  CredentialState,
  CredentialStatePort,
  RouteConfigPort,
} from "../../src/ports/index.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function rawConfig(): GatewayConfig {
  return {
    server: {
      port: 11248,
      cors: { origins: ["https://console.example.com"] },
      bodyTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      streamIdleTimeoutMs: 1000,
      logLevel: "info",
      trace: { enabled: false, destination: "stdout" },
      metrics: { enabled: true, path: "/metrics" },
      health: { path: "/health", upstreamCheck: true },
      defaultDryRun: false,
    },
    clients: [
      {
        id: "client-one",
        tokenHashRef: "env:CLIENT_HASH",
        limits: { rpm: 10, tpm: 1000, dailyTokens: 1000, dailyCostUsd: 10 },
        allowedModelAliases: ["chat-model", "other-model"],
      },
    ],
    providers: [
      {
        id: "provider-a",
        protocol: "openai-chat",
        baseUrl: "https://a.example.com",
        timeoutMs: 9999,
        customHeaders: { Secret: "not-a-candidate-field" },
        credentials: [
          { id: "cred-a-two", secretRef: "env:KEY_A2", weight: 2 },
          { id: "cred-a-one", secretRef: "env:KEY_A1", weight: 2 },
        ],
        credentialSelection: "fill-first",
      },
      {
        id: "provider-b",
        protocol: "anthropic-messages",
        baseUrl: "https://b.example.com",
        timeoutMs: 9999,
        customHeaders: {},
        credentials: [
          { id: "cred-b-one", secretRef: "file:/secret/b", weight: 3 },
        ],
        credentialSelection: "weighted-round-robin",
      },
      {
        id: "provider-c",
        protocol: "custom",
        baseUrl: "https://c.example.com",
        timeoutMs: 9999,
        customHeaders: {},
        credentials: [
          { id: "cred-c-one", secretRef: "secretmanager:c", weight: 1 },
        ],
        credentialSelection: "round-robin",
      },
    ],
    models: [
      {
        alias: "chat-model",
        targets: [
          {
            providerId: "provider-a",
            physicalModel: "z-model",
            pricesPerMillionUsd: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            capabilities: ["vision", "tools"],
            contextTokens: 1000,
          },
          {
            providerId: "provider-a",
            physicalModel: "a-model",
            pricesPerMillionUsd: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            capabilities: ["tools", "vision"],
            contextTokens: 1000,
          },
          {
            providerId: "provider-b",
            physicalModel: "b-model",
            pricesPerMillionUsd: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            capabilities: ["tools"],
            contextTokens: 1000,
          },
          {
            providerId: "provider-c",
            physicalModel: "c-model",
            pricesPerMillionUsd: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            capabilities: ["tools", "vision"],
            contextTokens: 1000,
          },
        ],
      },
      {
        alias: "other-model",
        targets: [
          {
            providerId: "provider-c",
            physicalModel: "other-physical",
            pricesPerMillionUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            capabilities: [],
            contextTokens: 1000,
          },
        ],
      },
    ],
    routes: [
      {
        id: "route-root",
        modelAliases: ["chat-model"],
        orderedCandidates: [
          { providerId: "provider-a", modelAlias: "chat-model", weight: 1 },
          { providerId: "provider-b", modelAlias: "chat-model", weight: 100 },
        ],
        requiredCapabilities: ["tools"],
        conditions: [],
        fallbackGroups: [],
        attemptBudget: { maxAttempts: 20, maxLatencyMs: 100, maxCostUsd: 1 },
        statusPolicy: { retryable: [500], nonRetryable: [400] },
      },
    ],
    plugins: [
      {
        id: "authentication",
        version: "1.0.0",
        enabled: true,
        hooks: ["onIngressReceived"],
        priority: 1,
      },
    ],
  };
}

function config(mutator?: (raw: GatewayConfig) => void): GatewayConfig {
  const raw = rawConfig();
  mutator?.(raw);
  return deepFreeze(GatewayConfigSchema.parse(raw));
}

const usage: TokenUsage = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
});

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return deepFreeze({
    requestId: "req-route",
    receivedAt: "2026-07-20T00:00:00.000Z",
    source: { adapter: "test", protocol: "custom", path: "/v1/test" },
    model: "chat-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    routing: {},
    stream: false,
    ...overrides,
  });
}

function context(canonical: CanonicalRequest, signal = new AbortController().signal): GatewayContext {
  const state = new Map<string, unknown>();
  return {
    request: canonical,
    requestId: canonical.requestId,
    signal,
    commitment: { isCommitted: () => false },
    auth: { authenticate: async () => undefined },
    state,
    getState: <T>(key: string) => state.get(key) as T | undefined,
    setState: <T>(key: string, value: T) => { state.set(key, value); },
    execute: async <T>(command: GatewayCommand<T>) => command.execute(signal),
  };
}

class FakeConfiguration implements RouteConfigPort<GatewayConfig> {
  readonly snapshot = vi.fn<() => Readonly<GatewayConfig>>();
  constructor(value: GatewayConfig) { this.snapshot.mockReturnValue(value); }
}

class FakeCredentials implements CredentialStatePort {
  constructor(private readonly states: Readonly<Record<string, CredentialState>> = {}) {}
  state(credentialId: string): CredentialState { return this.states[credentialId] ?? "active"; }
  snapshot(credentialId: string) { return { state: this.state(credentialId), penaltyCount: 0 } as const; }
  eligible(credentialId: string): boolean { return this.state(credentialId) === "active"; }
  hasEligible(): boolean { return Object.values(this.states).some((value) => value === "active") || Object.keys(this.states).length === 0; }
  counts() {
    const counts = { active: 0, cooldown: 0, critical_failure: 0, suspended: 0 };
    for (const value of Object.values(this.states)) counts[value] += 1;
    return counts;
  }
  failure(): never { throw new Error("read-only credential fixture"); }
  success(): never { throw new Error("read-only credential fixture"); }
  quarantine(): never { throw new Error("read-only credential fixture"); }
  reset(): never { throw new Error("read-only credential fixture"); }
  probe(): never { throw new Error("read-only credential fixture"); }
}

function resolver(
  snapshot: GatewayConfig,
  states: Readonly<Record<string, CredentialState>> = {},
  estimate: (value: CanonicalRequest) => TokenUsage = () => usage,
  latency: (providerId: string, physicalModel: string, value: CanonicalRequest) => number | undefined = () => 20,
): { value: ConfiguredRouteResolver; configuration: FakeConfiguration } {
  const configuration = new FakeConfiguration(snapshot);
  return {
    configuration,
    value: new ConfiguredRouteResolver({
      configuration,
      credentials: new FakeCredentials(states),
      estimate,
      estimateLatencyMs: latency,
    }),
  };
}

function projection(candidates: ReadonlyArray<RouteCandidate>): unknown {
  return candidates.map((candidate) => ({
    ...candidate,
    capabilities: [...candidate.capabilities],
  }));
}

async function expectExhausted(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toEqual({
    category: "routing",
    code: "route_exhausted",
    message: "no eligible route candidate",
    status: 503,
    retryable: true,
    requestId: "req-route",
  });
}

describe("ConfiguredRouteResolver", () => {
  it("expands targets and credentials in exact deterministic secret-free order", async () => {
    const configured = config();
    const routeResolver = resolver(configured).value;
    const canonical = request({
      routing: { preferredProviders: ["provider-b"] },
    });

    const first = await routeResolver.resolve(canonical, context(canonical));
    expect(Object.isFrozen(first)).toBe(true);
    expect(projection(first)).toEqual([
      { routeId: "route-root", providerId: "provider-a", credentialId: "cred-a-one", physicalModel: "a-model", capabilities: ["tools", "vision"], estimatedCostUsd: 0.00002, estimatedLatencyMs: 20 },
      { routeId: "route-root", providerId: "provider-a", credentialId: "cred-a-one", physicalModel: "z-model", capabilities: ["tools", "vision"], estimatedCostUsd: 0.00002, estimatedLatencyMs: 20 },
      { routeId: "route-root", providerId: "provider-a", credentialId: "cred-a-two", physicalModel: "a-model", capabilities: ["tools", "vision"], estimatedCostUsd: 0.00002, estimatedLatencyMs: 20 },
      { routeId: "route-root", providerId: "provider-a", credentialId: "cred-a-two", physicalModel: "z-model", capabilities: ["tools", "vision"], estimatedCostUsd: 0.00002, estimatedLatencyMs: 20 },
      { routeId: "route-root", providerId: "provider-b", credentialId: "cred-b-one", physicalModel: "b-model", capabilities: ["tools"], estimatedCostUsd: 0.00002, estimatedLatencyMs: 20 },
    ]);
    const second = await routeResolver.resolve(canonical, context(canonical));
    expect(JSON.stringify(projection(second))).toBe(JSON.stringify(projection(first)));
    expect(JSON.stringify(projection(first))).not.toMatch(/secretRef|baseUrl|customHeaders|PROVIDER|KEY_A|timeoutMs/);
  });

  it("uses effective alias and gives override route strict precedence", async () => {
    const configured = config((raw) => {
      const root = raw.routes[0]!;
      raw.routes.push({
        ...root, id: "route-other", modelAliases: ["other-model"],
        orderedCandidates: [{ providerId: "provider-c", modelAlias: "other-model", weight: 1 }],
      });
    });
    const routeResolver = resolver(configured).value;
    const aliased = request({ model: "other-model", routing: { modelAlias: "chat-model" } });
    expect((await routeResolver.resolve(aliased, context(aliased)))[0]?.routeId).toBe("route-root");

    const wrongOverride = request({ routing: { overrideRoute: "route-other" } });
    await expectExhausted(routeResolver.resolve(wrongOverride, context(wrongOverride)));
  });

  it("evaluates own paths, omitted equality, and structural JSON equality", async () => {
    const configured = config((raw) => {
      raw.routes[0]!.conditions = [
        { field: "stream" },
        { field: "metadata.shape", equals: { b: [1, { x: true }], a: "ok" } },
      ];
    });
    const routeResolver = resolver(configured).value;
    const passing = request({ stream: true, metadata: { shape: { a: "ok", b: [1, { x: true }] } } });
    await expect(routeResolver.resolve(passing, context(passing))).resolves.toHaveLength(5);

    for (const canonical of [
      request({ stream: false, metadata: { shape: { a: "ok", b: [1, { x: true }] } } }),
      request({ stream: true }),
      request({ stream: true, metadata: { shape: { a: "ok", b: [{ x: true }, 1] } } }),
    ]) await expectExhausted(routeResolver.resolve(canonical, context(canonical)));

    const forbidden = config((raw) => { raw.routes[0]!.conditions = [{ field: "__proto__.polluted", equals: true }]; });
    const canonical = request();
    await expectExhausted(resolver(forbidden).value.resolve(canonical, context(canonical)));
  });

  it("traverses fallbacks depth-first, bounds cycles, and applies the root attempt budget", async () => {
    const configured = config((raw) => {
      const root = raw.routes[0]!;
      root.orderedCandidates = [{ providerId: "provider-b", modelAlias: "chat-model", weight: 1 }];
      root.fallbackGroups = ["route-fallback", "route-last"];
      root.attemptBudget.maxAttempts = 3;
      raw.routes.push({
        ...root, id: "route-fallback", fallbackGroups: ["route-root", "route-last"],
        orderedCandidates: [{ providerId: "provider-a", modelAlias: "chat-model", weight: 1 }],
        attemptBudget: { ...root.attemptBudget, maxAttempts: 2 },
      });
      raw.routes.push({
        ...root, id: "route-last", fallbackGroups: [],
        orderedCandidates: [{ providerId: "provider-c", modelAlias: "chat-model", weight: 1 }],
      });
    });
    const canonical = request({ routing: { overrideRoute: "route-root" } });
    const candidates = await resolver(configured).value.resolve(canonical, context(canonical));
    expect(candidates.map((candidate) => candidate.routeId)).toEqual([
      "route-root", "route-fallback", "route-fallback",
    ]);
  });

  it("unions capabilities and filters excluded providers before preference", async () => {
    const configured = config();
    const canonical = request({ routing: {
      requiredCapabilities: ["vision", "vision"],
      excludedProviders: ["provider-a"],
      preferredProviders: ["provider-a", "provider-b"],
    } });
    await expectExhausted(resolver(configured).value.resolve(canonical, context(canonical)));
  });

  it("accepts only active credentials across every credential state", async () => {
    for (const state of ["cooldown", "critical_failure", "suspended"] as const) {
      const configured = config((raw) => {
        raw.models[0]!.targets = [raw.models[0]!.targets[2]!];
        raw.models[1]!.targets = [raw.models[1]!.targets[0]!];
        raw.routes[0]!.orderedCandidates = [{ providerId: "provider-b", modelAlias: "chat-model", weight: 1 }];
      });
      const canonical = request();
      await expectExhausted(resolver(configured, { "cred-b-one": state }).value.resolve(canonical, context(canonical)));
    }
    const canonical = request();
    await expect(resolver(config()).value.resolve(canonical, context(canonical))).resolves.toHaveLength(5);
  });

  it("enforces context, cost, and latency limits including missing latency", async () => {
    const canonical = request();
    const tooSmall = config((raw) => { for (const target of raw.models[0]!.targets) target.contextTokens = 9; });
    await expectExhausted(resolver(tooSmall).value.resolve(canonical, context(canonical)));

    const overCost = request({ routing: { maxCostUsd: 0.000019 } });
    await expectExhausted(resolver(config()).value.resolve(overCost, context(overCost)));

    const overLatency = request({ routing: { maxLatencyMs: 19 } });
    await expectExhausted(resolver(config()).value.resolve(overLatency, context(overLatency)));
    await expectExhausted(resolver(config(), {}, () => usage, () => undefined).value.resolve(canonical, context(canonical)));
  });

  it("deduplicates repeated candidate expansion and honors explicit order before weights", async () => {
    const configured = config((raw) => {
      raw.routes[0]!.orderedCandidates = [
        { providerId: "provider-b", modelAlias: "chat-model", weight: 1 },
        { providerId: "provider-a", modelAlias: "chat-model", weight: 999 },
        { providerId: "provider-b", modelAlias: "chat-model", weight: 1000 },
      ];
    });
    const canonical = request();
    const candidates = await resolver(configured).value.resolve(canonical, context(canonical));
    expect(candidates[0]?.providerId).toBe("provider-b");
    expect(candidates.filter((candidate) => candidate.providerId === "provider-b")).toHaveLength(1);
  });

  it("selects a provider snapshot once across multiple physical models", async () => {
    const configured = config((raw) => {
      raw.providers[0]!.credentialSelection = "round-robin";
      raw.routes[0]!.orderedCandidates = [
        { providerId: "provider-a", modelAlias: "chat-model", weight: 1 },
      ];
    });
    const configuration = new FakeConfiguration(configured);
    const routeResolver = new ConfiguredRouteResolver({
      configuration,
      credentials: new FakeCredentials(),
      estimate: () => usage,
      estimateLatencyMs: () => 20,
      cursor: (namespace, length) => {
        expect(namespace).toBe("provider-a");
        expect(length).toBe(4);
        return 1;
      },
    });
    const canonical = request();
    const candidates = await routeResolver.resolve(canonical, context(canonical));
    expect(candidates.map(({ credentialId, physicalModel }) =>
      `${credentialId}:${physicalModel}`,
    )).toEqual([
      "cred-a-two:a-model",
      "cred-a-one:z-model",
      "cred-a-one:a-model",
      "cred-a-two:z-model",
    ]);
  });

  it("reads one snapshot and propagates estimator exceptions", async () => {
    const configured = config();
    const created = resolver(configured);
    const canonical = request();
    await created.value.resolve(canonical, context(canonical));
    expect(created.configuration.snapshot).toHaveBeenCalledTimes(1);

    const failure = new Error("estimate failed");
    await expect(resolver(configured, {}, () => { throw failure; }).value.resolve(canonical, context(canonical))).rejects.toBe(failure);
  });

  it("fails safely for invalid estimates and preserves cancellation reasons", async () => {
    const configured = config();
    const canonical = request();
    await expectExhausted(resolver(configured, {}, () => ({ ...usage, inputTokens: Number.NaN })).value.resolve(canonical, context(canonical)));

    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const created = resolver(configured);
    await expect(created.value.resolve(canonical, context(canonical, controller.signal))).rejects.toBe(reason);
    expect(created.configuration.snapshot).not.toHaveBeenCalled();
  });
});
