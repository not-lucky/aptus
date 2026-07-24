import { describe, expect, it } from "vitest";
import { DefaultGatewayApplication } from "../../src/application/index.js";
import {
  ConfiguredRouteResolver,
  GatewayConfigSchema,
} from "../../src/config/index.js";
import type {
  GatewayPlugin,
  HookManager,
  HookTimeoutConfiguration,
} from "../../src/application/index.js";
import {
  PluginRegistry,
  type PluginRegistration,
} from "../../src/plugins/index.js";
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
} from "../../src/domain/index.js";
import type {
  AdapterRegistry,
  ProviderFactory,
  RouteResolver,
} from "../../src/application/index.js";
import type {
  ClockPort,
  ProviderDispatchPort,
  RawIngressInput,
} from "../../src/ports/index.js";
import type { CredentialStatePort } from "../../src/ports/index.js";

const requestId = "req-lifecycle";
const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential",
  physicalModel: "model",
  capabilities: new Set(),
  estimatedCostUsd: 0,
};
const request: CanonicalRequest = {
  requestId,
  receivedAt: "2026-07-19T00:00:00Z",
  source: { adapter: "custom", protocol: "custom", path: "/v1/custom" },
  model: "test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  routing: {},
  stream: false,
};
const streamRequest = { ...request, stream: true };
const response: CanonicalResponse = {
  requestId,
  responseId: "response",
  createdAt: "2026-07-19T00:00:00Z",
  model: "test",
  status: "completed",
  choices: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  cost: {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    totalUsd: 0,
    currency: "USD",
  },
  provider: {
    providerId: "provider",
    credentialId: "credential",
    physicalModel: "model",
    responseHeaders: {},
    upstreamStatus: 200,
  },
};
const chunks: CanonicalChunk[] = [
  {
    type: "response_start",
    responseId: "response",
    model: "test",
    createdAt: "2026-07-19T00:00:00Z",
  },
  {
    type: "text_delta",
    address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
    text: "hello",
  },
  { type: "response_end", status: "completed" },
];

const hookTimeouts: HookTimeoutConfiguration = {
  onIngressReceived: { timeoutMs: 1000, retryable: false },
  onCanonicalTranslate: { timeoutMs: 1000, retryable: false },
  onRouteResolve: { timeoutMs: 1000, retryable: true },
  beforeUpstreamDispatch: { timeoutMs: 1000, retryable: true },
  onUpstreamResponse: { timeoutMs: 1000, retryable: true },
  onStreamChunk: { timeoutMs: 1000, retryable: true },
  onEgressTranslate: { timeoutMs: 1000, retryable: false },
  onError: { timeoutMs: 1000, retryable: false },
};

function plugin(
  id: string,
  hooks: GatewayPlugin["hooks"] = [],
  overrides: Partial<GatewayPlugin> = {},
): GatewayPlugin {
  return { id, version: "1.0.0", hooks, priority: 0, ...overrides };
}
function registry(plugins: ReadonlyArray<GatewayPlugin>): HookManager {
  const registrations: PluginRegistration[] = [
    { plugin: plugin("authentication"), enabled: true },
    ...plugins.map((value) => ({ plugin: value, enabled: true })),
    {
      plugin: plugin("cost-audit-fixture", ["beforeUpstreamDispatch"], {
        beforeUpstreamDispatch: (context, value) => {
          context.setState("dispatch:cost-estimate", {
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            cost: response.cost,
          });
          return { kind: "continue", value };
        },
      }),
      enabled: true,
    },
  ];
  return new PluginRegistry(registrations);
}
function clock(): ClockPort {
  return {
    now: () => 0,
    sleep: (_delay, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  };
}
const dispatchPolicy = {
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
const fixtureCredentials: CredentialStatePort = {
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
const trace = { record: async () => undefined };
function setup(
  dispatch: ProviderDispatchPort,
  hooks: HookManager,
  ingressRequest = request,
): { app: DefaultGatewayApplication; input: RawIngressInput } {
  const ingress = {
    protocol: "custom" as const,
    paths: new Set(["/v1/custom"]),
    canTranslate: () => true,
    translate: () => ingressRequest,
  };
  const egress = {
    protocol: "custom" as const,
    encodeResponse: () => "encoded-response",
    encodeChunk: () => "encoded-chunk",
    encodeError: () => "encoded-error",
  };
  const adapters: AdapterRegistry = {
    ingress: () => ingress,
    egress: () => egress,
  };
  const routes: RouteResolver = { resolve: async () => [candidate] };
  const providers: ProviderFactory = { create: () => dispatch };
  const app = new DefaultGatewayApplication({
    adapters,
    hooks,
    routes,
    providers,
    clock: clock(),
    requestIds: () => requestId,
    hookTimeouts,
    auth: { authenticate: async () => undefined },
    dispatchPolicies: dispatchPolicy,
    credentials: fixtureCredentials,
    trace,
  });
  return {
    app,
    input: {
      path: "/v1/custom",
      headers: {},
      body: { model: "test" },
      requestId,
    },
  };
}

describe("DefaultGatewayApplication lifecycle", () => {
  it("runs canonical stages in order and exposes egress only on an exchange", async () => {
    const events: string[] = [];
    let undone = 0;
    const hooks = registry([
      plugin(
        "order",
        [
          "onIngressReceived",
          "onCanonicalTranslate",
          "onRouteResolve",
          "beforeUpstreamDispatch",
          "onUpstreamResponse",
          "onEgressTranslate",
        ],
        {
          onIngressReceived: async (context, value) => {
            events.push("onIngressReceived");
            await context.execute({
              execute: async () => undefined,
              undo: async () => {
                undone += 1;
              },
            });
            return { kind: "continue", value };
          },
          onCanonicalTranslate: (_context, value) => {
            events.push("onCanonicalTranslate");
            return { kind: "continue", value };
          },
          onRouteResolve: (_context, value) => {
            events.push("onRouteResolve");
            return { kind: "continue", value };
          },
          beforeUpstreamDispatch: (_context, value) => {
            events.push("beforeUpstreamDispatch");
            return { kind: "continue", value };
          },
          onUpstreamResponse: (_context, value) => {
            events.push("onUpstreamResponse");
            return { kind: "continue", value };
          },
          onEgressTranslate: (_context, value) => {
            events.push("onEgressTranslate");
            return { kind: "continue", value };
          },
        },
      ),
    ]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => {
        events.push("dispatch");
        return response;
      },
      stream: async function* () {
        yield chunks[0]!;
      },
    };
    const { app, input } = setup(dispatch, hooks);
    expect(await app.handle(input)).toBe(response);
    expect(events).toEqual([
      "onIngressReceived",
      "onCanonicalTranslate",
      "onRouteResolve",
      "beforeUpstreamDispatch",
      "dispatch",
      "onUpstreamResponse",
    ]);
    const exchange = app.open(input);
    const canonical = await exchange.handle();
    expect(canonical).toBe(response);
    const encoded = await exchange.runEgress("encoded-response");
    exchange.commitEgress();
    expect(encoded).toBe("encoded-response");
    expect(events.at(-1)).toBe("onEgressTranslate");
    await exchange.close();
    expect(undone).toBe(2);
  });

  it("gates exchange stream reads on egress and closes the provider iterator", async () => {
    let reads = 0;
    let returned = 0;
    const iterator: AsyncIterator<CanonicalChunk> = {
      next: async () => {
        reads += 1;
        const chunk = chunks[reads - 1];
        return chunk === undefined
          ? { done: true, value: undefined }
          : { done: false, value: chunk };
      },
      return: async () => {
        returned += 1;
        return { done: true, value: undefined };
      },
    };
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    };
    const { app, input } = setup(dispatch, registry([]), streamRequest);
    const exchange = app.open(input);
    const stream = exchange.stream()[Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe("response_start");
    expect(reads).toBe(1);
    expect(await exchange.runEgress("encoded-chunk")).toBe("encoded-chunk");
    exchange.commitEgress();
    expect((await stream.next()).value?.type).toBe("text_delta");
    expect(reads).toBe(2);
    await stream.return?.();
    await exchange.close();
    expect(returned).toBe(1);
  });

  it("returns fixed safe errors for invalid request IDs without adapter access", async () => {
    let lookedUp = false;
    const hooks = registry([]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: async function* () {
        yield chunks[0]!;
      },
    };
    const { input } = setup(dispatch, hooks);
    const bad: RawIngressInput = {
      ...input,
      requestId: "bad id",
      body: { secret: "fixture-secret" },
    };
    const invalidApp = new DefaultGatewayApplication({
      adapters: {
        ingress: () => {
          lookedUp = true;
          throw new Error("secret");
        },
        egress: () => {
          throw new Error("secret");
        },
      },
      hooks,
      routes: { resolve: async () => [] },
      providers: { create: () => dispatch },
      clock: clock(),
      requestIds: () => requestId,
      hookTimeouts,
      auth: { authenticate: async () => undefined },
      dispatchPolicies: dispatchPolicy,
      credentials: fixtureCredentials,
      trace,
    });
    const result = await invalidApp.handle(bad);
    expect(result).toMatchObject({
      code: "invalid_request_id",
      message: "invalid request ID",
      status: 400,
      requestId: "bad id",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(lookedUp).toBe(false);
  });
  it("preserves concrete route exhaustion without opening an upstream", async () => {
    let providerCreates = 0;
    let dispatches = 0;
    let errors = 0;
    const configured = GatewayConfigSchema.parse({
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
      clients: [{
        id: "client-one",
        tokenHashRef: "env:CLIENT_HASH",
        limits: { rpm: 1, tpm: 1, dailyTokens: 1, dailyCostUsd: 1 },
        allowedModelAliases: ["test"],
      }],
      providers: [{
        id: "provider-one",
        protocol: "custom",
        baseUrl: "https://provider.example.com",
        timeoutMs: 1,
        customHeaders: {},
        credentials: [{ id: "credential-one", secretRef: "env:KEY", weight: 1 }],
        credentialSelection: "fill-first",
      }],
      models: [{
        alias: "test",
        targets: [{
          providerId: "provider-one",
          physicalModel: "physical",
          pricesPerMillionUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          capabilities: [],
          contextTokens: 100,
        }],
      }],
      routes: [{
        id: "route-one",
        modelAliases: ["test"],
        orderedCandidates: [{ providerId: "provider-one", modelAlias: "test", weight: 1 }],
        requiredCapabilities: [],
        conditions: [],
        fallbackGroups: [],
        attemptBudget: { maxAttempts: 1, maxLatencyMs: 100, maxCostUsd: 1 },
        statusPolicy: { retryable: [], nonRetryable: [] },
      }],
      plugins: [{
        id: "authentication", version: "1.0.0", enabled: true,
        hooks: ["onIngressReceived"], priority: 1,
      }],
    });
    const credentials: CredentialStatePort = {
      state: () => "suspended",
      snapshot: () => ({ state: "suspended", penaltyCount: 0 }),
      eligible: () => false,
      hasEligible: () => false,
      counts: () => ({ active: 0, cooldown: 0, critical_failure: 0, suspended: 1 }),
      failure: () => { throw new Error("read-only credential fixture"); },
      success: () => { throw new Error("read-only credential fixture"); },
      quarantine: () => { throw new Error("read-only credential fixture"); },
      reset: () => { throw new Error("read-only credential fixture"); },
      probe: () => { throw new Error("read-only credential fixture"); },
    };
    const routes = new ConfiguredRouteResolver({
      configuration: { snapshot: () => configured },
      credentials,
      estimate: () => ({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
      estimateLatencyMs: () => 1,
    });
    const hooks = registry([
      plugin("errors", ["onError"], {
        onError: (_context, error) => {
          errors += 1;
          return { kind: "continue", value: error };
        },
      }),
    ]);
    const ingress = {
      protocol: "custom" as const,
      paths: new Set(["/v1/custom"]),
      canTranslate: () => true,
      translate: () => request,
    };
    const app = new DefaultGatewayApplication({
      adapters: {
        ingress: () => ingress,
        egress: () => ({
          protocol: "custom" as const,
          encodeResponse: () => "response",
          encodeChunk: () => "chunk",
          encodeError: () => "error",
        }),
      },
      hooks,
      routes,
      providers: {
        create: () => {
          providerCreates += 1;
          return {
            dispatch: async () => {
              dispatches += 1;
              return response;
            },
            stream: async function* () { yield chunks[0]!; },
          };
        },
      },
      dispatchPolicies: dispatchPolicy,
      credentials,
      trace,
      clock: clock(),
      requestIds: () => requestId,
      hookTimeouts,
      auth: { authenticate: async () => undefined },
    });
    const result = await app.handle({
      path: "/v1/custom", headers: {}, body: {}, requestId,
    });
    expect(result).toEqual({
      category: "routing",
      code: "route_exhausted",
      message: "no eligible route candidate",
      status: 503,
      retryable: true,
      requestId,
    });
    expect({ providerCreates, dispatches, errors }).toEqual({
      providerCreates: 0,
      dispatches: 0,
      errors: 1,
    });
  });
});
