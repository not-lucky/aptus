import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationPlugin,
  CacheLookupPlugin,
  CooldownPlugin,
  CostAuditPlugin,
  LoggingPlugin,
  POLICY_STATE_KEYS,
  RateLimitPlugin,
  RouteValidationPlugin,
  TracingPlugin,
} from "../../src/plugins/index.js";
import type { CanonicalRequest, CanonicalResponse, RouteCandidate } from "../../src/domain/index.js";
import type { GatewayContext } from "../../src/application/index.js";
import type { ClockPort, CredentialStatePort } from "../../src/ports/index.js";

const request: CanonicalRequest = {
  requestId: "request-policy",
  receivedAt: "2026-07-20T00:00:00Z",
  source: { adapter: "test", protocol: "custom", path: "/test" },
  model: "model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  routing: {},
  stream: false,
};
const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential",
  physicalModel: "model",
  capabilities: new Set(["tools"]),
  estimatedCostUsd: 0,
};
const response: CanonicalResponse = {
  requestId: request.requestId,
  responseId: "response",
  createdAt: request.receivedAt,
  model: request.model,
  status: "completed",
  choices: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  cost: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0, currency: "USD" },
  provider: { providerId: "provider", credentialId: "credential", physicalModel: "model", responseHeaders: {}, upstreamStatus: 200 },
};
function context(): GatewayContext {
  const state = new Map<string, unknown>();
  return {
    request,
    requestId: request.requestId,
    signal: new AbortController().signal,
    commitment: { isCommitted: () => false },
    authorization: "Bearer fixture",
    auth: { authenticate: async () => undefined },
    state,
    getState: <T>(key: string) => state.get(key) as T | undefined,
    setState: (key, value) => state.set(key, value),
    execute: async (command) => command.execute(new AbortController().signal),
    selectedCandidate: candidate,
  };
}
const fixedClock: ClockPort = {
  now: () => 1_700_000_000_000,
  sleep: async () => undefined,
};

function cooldownState(
  overrides: Partial<CredentialStatePort> = {},
): CredentialStatePort {
  return {
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
    ...overrides,
  };
}

describe("policy plugins", () => {
  it("stores only safe authentication identity and policy", async () => {
    const observed = context();
    const result = await new AuthenticationPlugin({
      auth: { authenticate: async (authorization) => authorization === "Bearer fixture" ? { clientId: "client", allowedModelAliases: new Set(["model"]), limits: { rpm: 1, tpm: 2, dailyTokens: 3, dailyCostUsd: 4 }, dryRun: false } : undefined },
      tokenHashAlgorithm: "sha256",
    }).onIngressReceived(observed, request);
    expect(result.kind).toBe("continue");
    expect(observed.getState(POLICY_STATE_KEYS.authenticationClient)).toEqual({ clientId: "client" });
    expect(JSON.stringify(observed.state)).not.toContain("Bearer fixture");
  });
  it("denies a missing identity", async () => {
    const result = await new AuthenticationPlugin({ auth: { authenticate: async () => undefined }, tokenHashAlgorithm: "sha256" }).onIngressReceived(context(), request);
    expect(result).toMatchObject({ kind: "abort", error: { category: "authentication", status: 401 } });
  });
  it("short-circuits valid cache hits with a digest key", async () => {
    const observed = context();
    const plugin = new CacheLookupPlugin({ port: { get: async () => response, set: async () => undefined } });
    const result = await plugin.onCanonicalTranslate(observed, request);
    expect(result).toMatchObject({ kind: "shortCircuit" });
    expect(observed.getState<string>(POLICY_STATE_KEYS.cacheKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(observed.getState(POLICY_STATE_KEYS.cacheResponse)).toBe(response);
  });
  it("maps malformed authentication results to the safe 401", async () => {
    const malformedAuth = { authenticate: async () => null } as unknown as GatewayContext["auth"];
    const result = await new AuthenticationPlugin({ auth: malformedAuth, tokenHashAlgorithm: "sha256" }).onIngressReceived(context(), request);
    expect(result).toMatchObject({ kind: "abort", error: { code: "invalid_client_credentials", status: 401 } });
  });
  it("rejects a route without required capability", () => {
    const observed = context();
    const result = new RouteValidationPlugin({ requiredCapabilities: ["vision"] }).onRouteResolve(observed, [candidate]);
    expect(result).toMatchObject({ kind: "abort", error: { category: "authorization", status: 403 } });
  });
  it("audits cost before dispatch", async () => {
    const observed = context();
    const plugin = new CostAuditPlugin({ estimate: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), prices: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }) });
    const result = await plugin.beforeUpstreamDispatch(observed, request);
    expect(observed.getState(POLICY_STATE_KEYS.costEstimate)).toMatchObject({ cost: { totalUsd: 0.000002 } });
  });
  it("reserves nonzero estimated cost and releases on error", async () => {
    let released = 0;
    let reservationRequest: unknown;
    const observed = context();
    observed.setState(POLICY_STATE_KEYS.authenticationClient, { clientId: "client" });
    observed.setState(POLICY_STATE_KEYS.authenticationPolicy, { allowedModelAliases: new Set(["model"]), limits: { rpm: 1, tpm: 2, dailyTokens: 3, dailyCostUsd: 4 }, dryRun: false });
    const plugin = new RateLimitPlugin({
      estimateTokens: () => 15,
      estimateCostUsd: () => 0.125,
      port: {
        reserve: async (value) => { reservationRequest = value; return "reservation"; },
        release: async () => { released += 1; },
      },
    });
    const result = await plugin.onCanonicalTranslate(observed, request);
    expect(result.kind).toBe("continue");
    expect(reservationRequest).toMatchObject({ estimatedTokens: 15, estimatedCostUsd: 0.125, dailyCostUsd: 4 });
    await plugin.onError(observed, { category: "internal", code: "x", message: "x", retryable: false, status: 500, requestId: request.requestId });
    expect(released).toBe(1);
  });
  it("preserves provider output when actual pricing throws", () => {
    const observed = context();
    const plugin = new CostAuditPlugin({
      estimate: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      prices: () => { throw new Error("pricing failed"); },
    });
    const result = plugin.onUpstreamResponse(observed, response);
    expect(result).toEqual({ kind: "continue", value: response });
    expect(observed.getState(POLICY_STATE_KEYS.costActual)).toMatchObject({ totalUsd: 0 });
  });
  it("caches only structurally safe responses after actual cost audit", async () => {
    const observed = context();
    let cached: CanonicalResponse | undefined;
    const plugin = new CacheLookupPlugin({
      port: {
        get: async () => undefined,
        set: async (_key, value) => { cached = value; },
      },
    });
    observed.setState(POLICY_STATE_KEYS.cacheKey, "a".repeat(64));
    await plugin.onUpstreamResponse(observed, response);
    expect(cached).toBeUndefined();
    observed.setState(POLICY_STATE_KEYS.costActual, response.cost);
    await plugin.onUpstreamResponse(observed, response);
    expect(cached).toEqual(response);
  });
  it("rejects routes exceeding maximum latency", () => {
    const observed = context();
    const result = new RouteValidationPlugin({ maxLatencyMs: 50 }).onRouteResolve(
      observed,
      [{ ...candidate, estimatedLatencyMs: 100 }],
    );
    expect(result).toMatchObject({ kind: "abort", error: { category: "authorization", status: 403 } });
  });

  it("rejects malformed cached cost components", async () => {
    const observed = context();
    const malformed = {
      ...response,
      cost: { ...response.cost, inputUsd: Number.NaN },
    };
    const result = await new CacheLookupPlugin({
      port: { get: async () => malformed, set: async () => undefined },
    }).onCanonicalTranslate(observed, request);
    expect(result.kind).toBe("continue");
    expect(observed.getState(POLICY_STATE_KEYS.cacheResponse)).toBeUndefined();
  });

  it("treats malformed cached output blocks as misses", async () => {
    const observed = context();
    const malformed = {
      ...response,
      choices: [{ index: 0, output: [null], finishReason: "stop" }],
    } as unknown as CanonicalResponse;
    const result = await new CacheLookupPlugin({
      port: { get: async () => malformed, set: async () => undefined },
    }).onCanonicalTranslate(observed, request);
    expect(result.kind).toBe("continue");
    expect(observed.getState(POLICY_STATE_KEYS.cacheResponse)).toBeUndefined();
  });

  it("isolates logging and tracing sink failures", async () => {
    const observed = context();
    const gatewayError = { category: "internal" as const, code: "failed", message: "failed", retryable: false, status: 500, requestId: request.requestId };
    const logging = await new LoggingPlugin({ logger: { log: async () => { throw new Error("log failed"); } } }).onError(observed, gatewayError);
    const tracing = await new TracingPlugin({ trace: { record: async () => { throw new Error("trace failed"); } } }).onError(observed, gatewayError);
    expect(logging).toEqual({ kind: "continue", value: gatewayError });
    expect(tracing).toEqual({ kind: "continue", value: gatewayError });
  });
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [503, "upstream_5xx"],
  ] as const)("classifies upstream status %s without changing the response", (status, kind) => {
    const failure = vi.fn();
    const state = cooldownState({ failure });
    const plugin = new CooldownPlugin({ state, clock: fixedClock });
    const upstream = {
      ...response,
      provider: { ...response.provider, upstreamStatus: status },
    };
    expect(plugin.onUpstreamResponse(context(), upstream)).toEqual({
      kind: "continue",
      value: upstream,
    });
    expect(failure).toHaveBeenCalledWith("credential", { kind, status });
  });

  it("uses case-insensitive bounded Retry-After values from the response", () => {
    const failure = vi.fn();
    const plugin = new CooldownPlugin({
      state: cooldownState({ failure }),
      clock: fixedClock,
    });
    const upstream = {
      ...response,
      provider: {
        ...response.provider,
        upstreamStatus: 429,
        responseHeaders: { "ReTrY-AfTeR": "10" },
      },
    };
    expect(plugin.onUpstreamResponse(context(), upstream)).toEqual({
      kind: "continue",
      value: upstream,
    });
    expect(failure).toHaveBeenCalledWith("credential", {
      kind: "rate_limit",
      status: 429,
      retryAfterMs: 10_000,
    });
  });

  it("rejects malformed and over-cap Retry-After without leaking headers", () => {
    const plugin = new CooldownPlugin({
      state: cooldownState(),
      clock: fixedClock,
    });
    for (const header of ["fixture-secret", "61", "-1", "Infinity"]) {
      const result = plugin.onUpstreamResponse(context(), {
        ...response,
        provider: {
          ...response.provider,
          upstreamStatus: 429,
          responseHeaders: { "retry-after": header },
        },
      });
      expect(result).toMatchObject({
        kind: "abort",
        error: { code: "credential_state_policy", status: 500 },
      });
      expect(JSON.stringify(result)).not.toContain(header);
    }
  });

  it("uses the injected clock for date-form Retry-After", () => {
    const failure = vi.fn();
    const plugin = new CooldownPlugin({
      state: cooldownState({ failure }),
      clock: fixedClock,
    });
    const upstream = {
      ...response,
      provider: {
        ...response.provider,
        upstreamStatus: 429,
        responseHeaders: {
          "retry-after": new Date(fixedClock.now() + 10_000).toISOString(),
        },
      },
    };
    plugin.onUpstreamResponse(context(), upstream);
    expect(failure).toHaveBeenCalledWith(
      "credential",
      expect.objectContaining({ retryAfterMs: 10_000 }),
    );
  });

  it("does not reset penalties for content-filter responses", () => {
    const failure = vi.fn();
    const success = vi.fn();
    const plugin = new CooldownPlugin({
      state: cooldownState({ failure, success }),
      clock: fixedClock,
    });
    const upstream = {
      ...response,
      choices: [{ index: 0, output: [], finishReason: "content_filter" as const }],
    };
    expect(plugin.onUpstreamResponse(context(), upstream)).toEqual({
      kind: "continue",
      value: upstream,
    });
    expect(failure).toHaveBeenCalledWith("credential", {
      kind: "content_filter",
    });
    expect(success).not.toHaveBeenCalled();
  });

  it.each([
    ["content_filter", 500],
    ["context_overflow", 400],
  ] as const)("prioritizes semantic %s response errors over status", (code, status) => {
    const failure = vi.fn();
    const success = vi.fn();
    const plugin = new CooldownPlugin({
      state: cooldownState({ failure, success }),
      clock: fixedClock,
    });
    const upstream = {
      ...response,
      status: "failed" as const,
      error: {
        category: "upstream" as const,
        code,
        message: "safe semantic error",
        retryable: false,
        status,
        requestId: request.requestId,
      },
      provider: { ...response.provider, upstreamStatus: status },
    };
    expect(plugin.onUpstreamResponse(context(), upstream)).toEqual({
      kind: "continue",
      value: upstream,
    });
    expect(failure).toHaveBeenCalledWith("credential", { kind: code });
    expect(success).not.toHaveBeenCalled();
  });

  it("preserves classified canonical errors and aborts only policy failures", () => {
    const failure = vi.fn();
    const plugin = new CooldownPlugin({
      state: cooldownState({ failure }),
      clock: fixedClock,
    });
    const timeout = {
      category: "timeout" as const,
      code: "upstream_timeout",
      message: "upstream request timed out",
      retryable: true,
      status: 504,
      requestId: request.requestId,
    };
    expect(plugin.onError(context(), timeout)).toEqual({
      kind: "continue",
      value: timeout,
    });
    expect(failure).toHaveBeenCalledWith("credential", { kind: "timeout" });

    const rejected = new CooldownPlugin({
      state: cooldownState({
        failure: () => {
          throw new Error("unexpected fixture failure");
        },
      }),
      clock: fixedClock,
    });
    expect(() => rejected.onError(context(), timeout)).toThrow(
      "unexpected fixture failure",
    );
  });
});
