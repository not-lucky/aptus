import { describe, expect, it } from "vitest";
import {
  DefaultGatewayApplication,
  DISPATCH_STATE_KEYS,
  type GatewayApplicationDependencies,
} from "../../src/application/index.js";
import {
  AtomicAdapterRegistry,
  createBuiltInProtocolAdapterFactory,
} from "../../src/adapters/index.js";
import { PluginRegistry } from "../../src/plugins/index.js";
import type {
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
} from "../../src/domain/index.js";
import type {
  CredentialStatePort,
  DispatchPolicyPort,
  ProviderDispatchPort,
} from "../../src/ports/index.js";

const NOW = "2026-07-22T00:00:00.000Z";
const candidate: RouteCandidate = {
  routeId: "route-a",
  providerId: "provider-a",
  credentialId: "credential-a",
  physicalModel: "physical-a",
  capabilities: new Set(["tools", "vision"]),
  estimatedCostUsd: 0,
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
const dispatchPolicies: DispatchPolicyPort = {
  snapshot: () => ({
    defaultDryRun: false,
    resolve: () => ({
      attemptBudget: { maxAttempts: 1, maxLatencyMs: 10_000, maxCostUsd: 100 },
      statusPolicy: { retryable: [], nonRetryable: [] },
      providerTimeoutMs: 10_000,
      streamIdleTimeoutMs: 10_000,
      contextTokens: 10_000,
    }),
  }),
};
const response: CanonicalResponse = {
  requestId: "facade-request",
  responseId: "response-a",
  createdAt: NOW,
  model: "json-model",
  status: "completed",
  choices: [
    { index: 0, output: [{ type: "text", text: "ok" }], finishReason: "stop" },
  ],
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
    providerId: candidate.providerId,
    credentialId: candidate.credentialId,
    physicalModel: candidate.physicalModel,
    responseHeaders: {},
    upstreamStatus: 200,
  },
};

function application(
  observed: CanonicalRequest[],
  trustedIngressProxyIds: ReadonlySet<string> = new Set(["proxy-a"]),
): DefaultGatewayApplication {
  const factory = createBuiltInProtocolAdapterFactory({ now: () => NOW });
  const adapters = new AtomicAdapterRegistry([
    { protocol: "openai-chat", factory },
    { protocol: "openai-responses", factory },
    { protocol: "anthropic-messages", factory },
  ]);
  const dispatch: ProviderDispatchPort = {
    dispatch: async (_candidate, request) => {
      return {
        ...response,
        requestId: request.requestId,
        model: request.model,
      };
    },
    stream: async function* () {
      yield { type: "response_end", status: "completed" };
    },
  };
  const dependencies: GatewayApplicationDependencies = {
    adapters,
    hooks: new PluginRegistry([
      {
        plugin: {
          id: "authentication",
          version: "1.0.0",
          hooks: [],
          priority: -1,
        },
        enabled: true,
      },
      {
        plugin: {
          id: "estimate",
          version: "1.0.0",
          hooks: ["beforeUpstreamDispatch"],
          priority: 0,
          beforeUpstreamDispatch: (context, value) => {
            context.setState(DISPATCH_STATE_KEYS.costEstimate, {
              usage: response.usage,
              cost: response.cost,
            });
            return { kind: "continue" as const, value };
          },
        },
        enabled: true,
      },
    ]),
    routes: {
      resolve: async (request) => {
        observed.push(request);
        return [candidate];
      },
    },
    providers: { create: () => dispatch },
    clock: {
      now: () => Date.parse(NOW),
      sleep: async (_delay, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
    requestIds: () => "facade-request",
    hookTimeouts: {
      onIngressReceived: { timeoutMs: 1000, retryable: false },
      onCanonicalTranslate: { timeoutMs: 1000, retryable: false },
      onRouteResolve: { timeoutMs: 1000, retryable: false },
      beforeUpstreamDispatch: { timeoutMs: 1000, retryable: false },
      onUpstreamResponse: { timeoutMs: 1000, retryable: false },
      onStreamChunk: { timeoutMs: 1000, retryable: false },
      onEgressTranslate: { timeoutMs: 1000, retryable: false },
      onError: { timeoutMs: 1000, retryable: false },
    },
    auth: { authenticate: async () => undefined },
    dispatchPolicies,
    credentials,
    trace: { record: async () => undefined },
    trustedIngressProxyIds,
  };
  return new DefaultGatewayApplication(dependencies);
}

describe("translation registry application facade", () => {
  it("returns a correlated typed 404 for an unknown path", async () => {
    const result = await application([]).handle({
      path: "/missing",
      headers: {},
      body: {},
      requestId: "unknown-request",
    });
    expect(result).toMatchObject({
      code: "unknown_path",
      category: "validation",
      status: 404,
      requestId: "unknown-request",
    });
  });

  it("applies trusted routing headers after JSON routing normalization", async () => {
    const observed: CanonicalRequest[] = [];
    const result = await application(observed).handle({
      path: "/v1/chat/completions",
      ingressProxyId: "proxy-a",
      requestId: "facade-request",
      headers: {
        "X-Gateway-Model-Alias": "trusted-model",
        "x-gateway-route": "route-a",
        "x-gateway-max-cost-usd": "0",
        "x-gateway-max-latency-ms": "900",
        "x-gateway-dry-run": "false",
        "x-gateway-required-capability": ["tools", "vision", "tools"],
        "x-provider-api-key": "must-not-forward",
      },
      body: {
        model: "json-model",
        messages: [{ role: "user", content: "hello" }],
        routing: {
          modelAlias: "json-alias",
          overrideRoute: "json-route",
          maxCostUsd: 10,
          maxLatencyMs: 5_000,
          dryRun: true,
          requiredCapabilities: ["json"],
        },
      },
    });
    expect(result).toMatchObject({
      requestId: "facade-request",
      responseId: "response-a",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.source).toEqual({
      adapter: "openai-chat",
      protocol: "openai-chat",
      path: "/v1/chat/completions",
    });
    expect(observed[0]?.routing).toEqual({
      modelAlias: "trusted-model",
      overrideRoute: "route-a",
      maxCostUsd: 0,
      maxLatencyMs: 900,
      dryRun: false,
      requiredCapabilities: ["tools", "vision"],
    });
    expect(JSON.stringify(observed[0]?.extensions)).not.toContain(
      "must-not-forward",
    );
  });

  it("ignores identical routing headers from an untrusted ingress", async () => {
    const observed: CanonicalRequest[] = [];
    await application(observed).handle({
      path: "/chat/completions",
      ingressProxyId: "untrusted-proxy",
      requestId: "facade-request",
      headers: { "x-gateway-model-alias": "attacker-model" },
      body: {
        model: "json-model",
        messages: [{ role: "user", content: "hello" }],
        routing: { modelAlias: "json-alias" },
      },
    });
    expect(observed[0]?.routing.modelAlias).toBe("json-alias");
  });
});
