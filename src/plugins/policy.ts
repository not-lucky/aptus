import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  CostMetrics,
  GatewayError,
  PricesPerMillionUsd,
  RouteCandidate,
  TokenUsage,
} from "../domain/index.js";

import {
  calculateCost,
  checkRequiredCapabilities,
  createGatewayError,
  isSafeCanonicalResponse,
  redactValue,
  validateCanonicalRequest,
  zeroCost,
} from "../domain/index.js";
import type {
  GatewayAuthenticationCapability,
  GatewayAuthenticationResult,
  GatewayContext,
  GatewayPlugin,
  HookResult,
} from "../application/index.js";
import { DISPATCH_STATE_KEYS } from "../application/dispatch.js";
import {
  CredentialStatePolicyError,
  classifyCredentialFailure,
} from "../ports/index.js";
import type {
  CachePort,
  ClockPort,
  CredentialFailure,
  CredentialStatePort,
  LoggerPort,
  MetricsPort,
  RateLimitPort,
  TracePort,
} from "../ports/index.js";

/** Namespaced request state keys owned by the policy plugins. */
export const POLICY_STATE_KEYS = Object.freeze({
  authenticationClient: "authentication:client",
  authenticationPolicy: "authentication:policy",
  rateLimitReservation: "rate-limit:reservation",
  rateLimitReserved: "rate-limit:reserved",
  costEstimate: "cost-audit:estimate",
  costActual: "cost-audit:actual",
  cacheResponse: "cache-lookup:response",
  cacheKey: "cache-lookup:key",
} as const);

/** Safe authenticated client identity retained for this request. */
export interface AuthenticationClient {
  /** Policy contract member `clientId`. */
  readonly clientId: string;
}
/** Safe authenticated policy retained for this request. */
export interface AuthenticationPolicy {
  /** Policy contract member `allowedModelAliases`. */
  readonly allowedModelAliases: ReadonlySet<string>;
  /** Policy contract member `limits`. */
  readonly limits: {
    /** Policy contract member `rpm`. */
    readonly rpm: number;
    /** Policy contract member `tpm`. */
    readonly tpm: number;
    /** Policy contract member `dailyTokens`. */
    readonly dailyTokens: number;
    /** Policy contract member `dailyCostUsd`. */
    readonly dailyCostUsd: number;
  };
  /** Policy contract member `dryRun`. */
  readonly dryRun: boolean;
}
/** Authentication plugin construction options. */
export interface AuthenticationPluginOptions {
  /** Policy contract member `auth`. */
  readonly auth: GatewayAuthenticationCapability;
  /** Policy contract member `tokenHashAlgorithm`. */
  readonly tokenHashAlgorithm: "sha256";
}

function error(
  context: GatewayContext,
  category: GatewayError["category"],
  code: string,
  message: string,
  status: number,
  retryable = false,
): GatewayError {
  return createGatewayError({
    category,
    code,
    message,
    status,
    retryable,
    requestId: context.requestId,
  });
}

function continuation<T>(value: T): HookResult<T> {
  return { kind: "continue", value };
}

function isAuthenticationResult(value: unknown): value is GatewayAuthenticationResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<GatewayAuthenticationResult>;
  const limits = result.limits;
  const finiteNonNegative = (number: unknown): number is number =>
    typeof number === "number" && Number.isFinite(number) && number >= 0;
  return (
    typeof result.clientId === "string" && result.clientId.length > 0 &&
    result.allowedModelAliases instanceof Set &&
    [...result.allowedModelAliases].every((alias) => typeof alias === "string") &&
    typeof limits === "object" && limits !== null &&
    finiteNonNegative(limits.rpm) &&
    finiteNonNegative(limits.tpm) &&
    finiteNonNegative(limits.dailyTokens) &&
    finiteNonNegative(limits.dailyCostUsd) &&
    typeof result.dryRun === "boolean"
  );
}

/** Authenticates the outer authorization value without retaining it. */
export class AuthenticationPlugin implements GatewayPlugin {
  /** Policy contract member `id`. */
  readonly id = "authentication";
  /** Policy contract member `version`. */
  readonly version = "1.0.0";
  /** Policy contract member `hooks`. */
  readonly hooks = ["onIngressReceived"] as const;
  /** Policy contract member `priority`. */
  readonly priority = -100;
  constructor(private readonly options: AuthenticationPluginOptions) {}
  async onIngressReceived(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<HookResult<CanonicalRequest>> {
    let result;
    try {
      result = await this.options.auth.authenticate(context.authorization, context.signal);
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
      return { kind: "abort", error: error(context, "authentication", "invalid_client_credentials", "invalid client credentials", 401) };
    }
    if (!isAuthenticationResult(result))
      return { kind: "abort", error: error(context, "authentication", "invalid_client_credentials", "invalid client credentials", 401) };
    context.setState(POLICY_STATE_KEYS.authenticationClient, { clientId: result.clientId });
    context.setState(POLICY_STATE_KEYS.authenticationPolicy, {
      allowedModelAliases: result.allowedModelAliases,
      limits: result.limits,
      dryRun: result.dryRun,
    });
    context.setState(DISPATCH_STATE_KEYS.dryRun, result.dryRun);
    return continuation(request);
  }
}

/** Typed reservation request sent to the rate-limit port. */
export interface RateLimitReservationRequest {
  /** Policy contract member `clientId`. */
  readonly clientId: string;
  /** Policy contract member `requestId`. */
  readonly requestId: string;
  /** Policy contract member `rpm`. */
  readonly rpm: number;
  /** Policy contract member `tpm`. */
  readonly tpm: number;
  /** Policy contract member `dailyTokens`. */
  readonly dailyTokens: number;
  /** Policy contract member `dailyCostUsd`. */
  readonly dailyCostUsd: number;
  /** Policy contract member `estimatedTokens`. */
  readonly estimatedTokens: number;
  /** Policy contract member `estimatedCostUsd`. */
  readonly estimatedCostUsd: number;
  /** Policy contract member `dryRun`. */
  readonly dryRun: boolean;
}

/** Rate-limit reservation and estimate dependencies. */
export interface RateLimitPluginOptions {
  /** Rate-limit reservation boundary. */
  readonly port: RateLimitPort<RateLimitReservationRequest>;
  /** Deterministically estimates request token consumption before routing. */
  readonly estimateTokens: (request: CanonicalRequest) => number;
  /** Deterministically estimates request cost before routing. */
  readonly estimateCostUsd: (request: CanonicalRequest) => number;
}

/** Reserves one request quota and registers exactly-once release cleanup. */
export class RateLimitPlugin implements GatewayPlugin {
  /** Policy contract member `id`. */
  readonly id = "rate-limit";
  /** Policy contract member `version`. */
  readonly version = "1.0.0";
  /** Reservation and cleanup stages. */
  readonly hooks = ["onCanonicalTranslate", "onError"] as const;
  /** Runs after authentication and before cache lookup. */
  readonly priority = -50;
  constructor(private readonly options: RateLimitPluginOptions) {}

  async onCanonicalTranslate(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<HookResult<CanonicalRequest>> {
    const client = context.getState<AuthenticationClient>(POLICY_STATE_KEYS.authenticationClient);
    const policy = context.getState<AuthenticationPolicy>(POLICY_STATE_KEYS.authenticationPolicy);
    if (client === undefined || policy === undefined)
      return { kind: "abort", error: error(context, "authentication", "invalid_client_credentials", "invalid client credentials", 401) };
    if (request.routing.dryRun === true || context.getState<boolean>(DISPATCH_STATE_KEYS.dryRun) === true)
      return continuation(request);
    let estimatedTokens: number;
    let estimatedCostUsd: number;
    try {
      estimatedTokens = this.options.estimateTokens(request);
      estimatedCostUsd = this.options.estimateCostUsd(request);
    } catch {
      return { kind: "abort", error: error(context, "internal", "cost_estimate_failed", "cost estimate failed", 500) };
    }
    if (
      !Number.isFinite(estimatedTokens) || estimatedTokens < 0 ||
      !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0
    )
      return { kind: "abort", error: error(context, "internal", "cost_estimate_failed", "cost estimate failed", 500) };
    const reservationRequest: RateLimitReservationRequest = {
      clientId: client.clientId,
      requestId: context.requestId,
      ...policy.limits,
      estimatedTokens,
      estimatedCostUsd,
      dryRun: false,
    };
    let reservation: unknown;
    try {
      reservation = await context.execute({
        execute: (signal) => this.options.port.reserve(reservationRequest, signal),
        undo: async () => {
          if (context.getState<boolean>(POLICY_STATE_KEYS.rateLimitReserved) === true) {
            context.setState(POLICY_STATE_KEYS.rateLimitReserved, false);
            await this.options.port.release(reservation);
          }
        },
      });
    } catch {
      return { kind: "abort", error: error(context, "rate_limit", "rate_limit_exceeded", "rate limit exceeded", 429, true) };
    }
    context.setState(POLICY_STATE_KEYS.rateLimitReservation, reservation);
    context.setState(POLICY_STATE_KEYS.rateLimitReserved, true);
    return continuation(request);
  }
  async onError(context: GatewayContext, current: GatewayError): Promise<HookResult<GatewayError>> {
    const reservation = context.getState<unknown>(POLICY_STATE_KEYS.rateLimitReservation);
    if (context.getState<boolean>(POLICY_STATE_KEYS.rateLimitReserved) === true && reservation !== undefined) {
      context.setState(POLICY_STATE_KEYS.rateLimitReserved, false);
      await this.options.port.release(reservation);
    }
    return continuation(current);
  }
}

/** Immutable route policy options. */
export interface RouteValidationPluginOptions {
  /** Policy contract member `allowedModelAliases`. */
  readonly allowedModelAliases?: ReadonlySet<string>;
  /** Policy contract member `requiredCapabilities`. */
  readonly requiredCapabilities?: ReadonlyArray<string>;
  /** Policy contract member `excludedProviders`. */
  readonly excludedProviders?: ReadonlySet<string>;
  /** Policy contract member `preferredProviders`. */
  readonly preferredProviders?: ReadonlySet<string>;
  /** Policy contract member `maxCostUsd`. */
  readonly maxCostUsd?: number;
  /** Policy contract member `maxLatencyMs`. */
  readonly maxLatencyMs?: number;
}

/** Enforces client and route constraints over resolved candidates. */
export class RouteValidationPlugin implements GatewayPlugin {
  /** Policy contract member `id`. */
  readonly id = "route-validation";
  /** Policy contract member `version`. */
  readonly version = "1.0.0";
  /** Policy contract member `hooks`. */
  readonly hooks = ["onRouteResolve"] as const;
  /** Policy contract member `priority`. */
  readonly priority = 0;
  constructor(private readonly options: RouteValidationPluginOptions = {}) {}
  onRouteResolve(context: GatewayContext, candidates: ReadonlyArray<RouteCandidate>): HookResult<ReadonlyArray<RouteCandidate>> {
    const validation = validateCanonicalRequest(context.request);
    if (!validation.valid) return { kind: "abort", error: error(context, "validation", "invalid_route_policy", "invalid route policy", 400) };
    const policy = context.getState<AuthenticationPolicy>(POLICY_STATE_KEYS.authenticationPolicy);
    const routing = context.request.routing;
    const model = routing.modelAlias ?? context.request.model;
    const allowed = policy?.allowedModelAliases;
    if ((allowed !== undefined && !allowed.has(model)) || (this.options.allowedModelAliases !== undefined && !this.options.allowedModelAliases.has(model)))
      return { kind: "abort", error: error(context, "authorization", "model_not_authorized", "model is not authorized", 403) };
    const required = [...(routing.requiredCapabilities ?? []), ...(this.options.requiredCapabilities ?? [])];
    const excluded = new Set([...(routing.excludedProviders ?? []), ...(this.options.excludedProviders ?? [])]);
    const maxCost = Math.min(...[routing.maxCostUsd, this.options.maxCostUsd].filter((v): v is number => v !== undefined));
    const maxLatency = Math.min(...[routing.maxLatencyMs, this.options.maxLatencyMs].filter((v): v is number => v !== undefined));
    const eligible = candidates.filter((candidate) =>
      !excluded.has(candidate.providerId) &&
      (maxCost === Infinity || candidate.estimatedCostUsd <= maxCost) &&
      (maxLatency === Infinity || (candidate.estimatedLatencyMs !== undefined && candidate.estimatedLatencyMs <= maxLatency)) &&
      checkRequiredCapabilities(required, [...candidate.capabilities]).satisfied,
    );
    if (eligible.length === 0 && candidates.length > 0)
      return { kind: "abort", error: error(context, "authorization", "model_not_authorized", "route is not authorized", 403) };
    const preferred = new Set([...(routing.preferredProviders ?? []), ...(this.options.preferredProviders ?? [])]);
    return continuation([...eligible].sort((a, b) => Number(preferred.has(b.providerId)) - Number(preferred.has(a.providerId))));
  }
}


/** Cache lookup plugin options. */
export interface CacheLookupPluginOptions {
  /** Cancellation-aware canonical response cache. */
  readonly port: CachePort<CanonicalResponse>;
}
function stable(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => item instanceof Set ? [...item].sort() : item); }
async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Looks up and safely short-circuits canonical responses. */
export class CacheLookupPlugin implements GatewayPlugin {
  /** Policy contract member `id`. */
  readonly id = "cache-lookup";
  /** Policy contract member `version`. */
  readonly version = "1.0.0";
  /** Policy contract member `hooks`. */
  readonly hooks = ["onCanonicalTranslate", "onUpstreamResponse"] as const;
  /** Runs after cost audit for response cache writes. */
  readonly priority = 30;
  constructor(private readonly options: CacheLookupPluginOptions) {}
  async onCanonicalTranslate(context: GatewayContext, request: CanonicalRequest): Promise<HookResult<CanonicalRequest>> {
    if (request.routing.dryRun === true || context.getState<boolean>(DISPATCH_STATE_KEYS.dryRun) === true)
      return continuation(request);
    const key = await digest(stable(redactValue({ protocol: request.source.protocol, model: request.model, messages: request.messages, tools: request.tools, toolChoice: request.toolChoice, sampling: request.sampling, reasoning: request.reasoning, output: request.output, routing: request.routing, stream: request.stream })));
    context.setState(POLICY_STATE_KEYS.cacheKey, key);
    let hit: CanonicalResponse | undefined;
    try { hit = await this.options.port.get(key, context.signal); } catch { return continuation(request); }
    if (!isSafeCanonicalResponse(hit, request.requestId)) return continuation(request);
    context.setState(POLICY_STATE_KEYS.cacheResponse, hit);
    return { kind: "shortCircuit", value: request };
  }
  async onUpstreamResponse(context: GatewayContext, response: CanonicalResponse): Promise<HookResult<CanonicalResponse>> {
    const key = context.getState<string>(POLICY_STATE_KEYS.cacheKey);
    const actual = context.getState<CostMetrics>(POLICY_STATE_KEYS.costActual);
    if (
      context.request.routing.dryRun !== true &&
      context.getState<boolean>(DISPATCH_STATE_KEYS.dryRun) !== true &&
      key !== undefined &&
      actual !== undefined &&
      response.provider.upstreamStatus >= 200 &&
      response.provider.upstreamStatus <= 299 &&
      response.error === undefined &&
      !response.choices.some((choice) => choice.finishReason === "content_filter") &&
      isSafeCanonicalResponse(response, context.requestId)
    )
      void this.options.port.set(
        key,
        { ...response, cost: actual },
        context.signal,
      ).catch(() => undefined);
    return continuation(response);
  }
}

/** Cost audit plugin options. */
export interface CostAuditPluginOptions {
  /** Target pricing lookup for the selected candidate. */
  readonly prices: (candidate: RouteCandidate, request: CanonicalRequest) => PricesPerMillionUsd | undefined;
  /** Deterministic request token estimate. */
  readonly estimate: (request: CanonicalRequest) => TokenUsage;
}

/** Computes bounded estimates and actual costs. */
export class CostAuditPlugin implements GatewayPlugin {
  /** Stable plugin identifier. */
  readonly id = "cost-audit";
  /** Validated plugin version. */
  readonly version = "1.0.0";
  /** Lifecycle stages used for estimates and actual usage. */
  readonly hooks = ["beforeUpstreamDispatch", "onUpstreamResponse", "onStreamChunk"] as const;
  /** Stable ordering priority. */
  readonly priority = 10;
  constructor(private readonly options: CostAuditPluginOptions) {}

  async beforeUpstreamDispatch(context: GatewayContext, request: CanonicalRequest): Promise<HookResult<CanonicalRequest>> {
    const candidate = context.selectedCandidate;
    if (candidate === undefined)
      return { kind: "abort", error: error(context, "internal", "cost_estimate_failed", "cost estimate failed", 500) };
    let usage: TokenUsage;
    let result: ReturnType<typeof calculateCost>;
    try {
      usage = this.options.estimate(request);
      const prices = this.options.prices(candidate, request);
      result = prices === undefined
        ? { ok: true, cost: zeroCost() }
        : calculateCost(usage, prices);
    } catch {
      return { kind: "abort", error: error(context, "internal", "cost_estimate_failed", "cost estimate failed", 500) };
    }
    if (!result.ok)
      return { kind: "abort", error: error(context, "internal", "cost_estimate_failed", "cost estimate failed", 500) };
    const estimate = { usage, cost: result.cost };
    context.setState(DISPATCH_STATE_KEYS.costEstimate, estimate);
    context.setState(POLICY_STATE_KEYS.costEstimate, estimate);
    if (request.routing.maxCostUsd !== undefined && result.cost.totalUsd > request.routing.maxCostUsd)
      return { kind: "abort", error: error(context, "authorization", "cost_limit_exceeded", "cost limit exceeded", 403) };
    return continuation(request);
  }

  onUpstreamResponse(context: GatewayContext, response: CanonicalResponse): HookResult<CanonicalResponse> {
    try {
      const candidate = context.selectedCandidate;
      const prices = candidate === undefined ? undefined : this.options.prices(candidate, context.request);
      const actual = prices === undefined ? { ok: true as const, cost: zeroCost() } : calculateCost(response.usage, prices);
      context.setState(POLICY_STATE_KEYS.costActual, actual.ok ? actual.cost : zeroCost());
    } catch { context.setState(POLICY_STATE_KEYS.costActual, zeroCost()); }
    return continuation(response);
  }

  onStreamChunk(context: GatewayContext, chunk: CanonicalChunk): HookResult<CanonicalChunk> {
    if (chunk.type !== "usage") return continuation(chunk);
    try {
      const candidate = context.selectedCandidate;
      const prices = candidate === undefined ? undefined : this.options.prices(candidate, context.request);
      const actual = prices === undefined ? { ok: true as const, cost: zeroCost() } : calculateCost(chunk.usage, prices);
      context.setState(POLICY_STATE_KEYS.costActual, actual.ok ? actual.cost : zeroCost());
    } catch {
      context.setState(POLICY_STATE_KEYS.costActual, zeroCost());
    }
    return continuation(chunk);
  }
}

/** Bounded logging observer options. */
export interface LoggingPluginOptions {
  /** Sink receiving already-redacted bounded entries. */
  readonly logger: LoggerPort;
}

/** Emits fixed-schema redacted lifecycle log entries. */
export class LoggingPlugin implements GatewayPlugin {
  /** Stable plugin identifier. */
  readonly id = "logging";
  /** Validated plugin version. */
  readonly version = "1.0.0";
  /** Observed lifecycle stages. */
  readonly hooks = ["onError"] as const;
  /** Stable observer priority. */
  readonly priority = 100;
  constructor(private readonly options: LoggingPluginOptions) {}
  async onError(context: GatewayContext, value: GatewayError): Promise<HookResult<GatewayError>> {
    try {
      await this.options.logger.log(redactValue({ schema: "aptus.gateway.log", version: 1, requestId: context.requestId, phase: "error", status: value.status, category: value.category, code: value.code }) as never);
    } catch {
      /* observer sink failures never alter canonical output */
    }
    return continuation(value);
  }
}

/** Tracing observer options. */
export interface TracingPluginOptions {
  /** Sink receiving already-redacted bounded trace records. */
  readonly trace: TracePort;
}

/** Emits fixed-schema redacted lifecycle trace records. */
export class TracingPlugin implements GatewayPlugin {
  /** Stable plugin identifier. */
  readonly id = "tracing";
  /** Validated plugin version. */
  readonly version = "1.0.0";
  /** Observed lifecycle stages. */
  readonly hooks = ["onError"] as const;
  /** Stable observer priority. */
  readonly priority = 100;
  constructor(private readonly options: TracingPluginOptions) {}
  async onError(context: GatewayContext, value: GatewayError): Promise<HookResult<GatewayError>> {
    try {
      await this.options.trace.record(redactValue({ schema: "aptus.gateway.trace", version: 1, requestId: context.requestId, phase: "error", status: value.status, category: value.category, code: value.code }) as never);
    } catch {
      /* observer sink failures never alter canonical output */
    }
    return continuation(value);
  }
}

/** Cooldown plugin options. */
export interface CooldownPluginOptions {
  /** Authoritative credential lifecycle owner. */
  readonly state: CredentialStatePort;
  /** Injected clock used only to interpret date-form Retry-After values. */
  readonly clock: ClockPort;
}

function lifecyclePolicyError(context: GatewayContext): GatewayError {
  return createGatewayError({
    category: "internal",
    code: "credential_state_policy",
    message: "credential lifecycle policy rejected the upstream outcome",
    status: 500,
    retryable: false,
    requestId: context.requestId,
  });
}

function parseRfc3339Ms(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null)
    throw new CredentialStatePolicyError("invalid_retry_after");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    month < 1 || month > 12 || day < 1 ||
    daysInMonth === undefined || day > daysInMonth || hour > 23 ||
    minute > 59 || second > 59 || offsetHour > 14 ||
    (offsetHour === 14 && offsetMinute !== 0) || offsetMinute > 59
  )
    throw new CredentialStatePolicyError("invalid_retry_after");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new CredentialStatePolicyError("invalid_retry_after");
  return parsed;
}

function retryAfterMs(
  response: CanonicalResponse,
  clock: ClockPort,
): number | undefined {
  const entry = Object.entries(response.provider.responseHeaders).find(
    ([name]) => name.toLowerCase() === "retry-after",
  );
  if (entry === undefined) return undefined;
  const value = entry[1].trim();
  let milliseconds: number;
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const deadlineMs = parseRfc3339Ms(value);
    const referenceMs = clock.now();
    if (!Number.isFinite(deadlineMs) || !Number.isFinite(referenceMs))
      throw new CredentialStatePolicyError("invalid_retry_after");
    milliseconds = deadlineMs - referenceMs;
  }
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 60_000
  )
    throw new CredentialStatePolicyError("invalid_retry_after");
  return milliseconds;
}

function responseFailure(
  response: CanonicalResponse,
  clock: ClockPort,
): CredentialFailure | undefined {
  const status = response.provider.upstreamStatus;
  if (status === 429)
    return classifyCredentialFailure({
      status,
      retryAfterMs: retryAfterMs(response, clock),
    });
  if (response.error !== undefined)
    return classifyCredentialFailure(response.error);
  if (
    response.choices.some((choice) => choice.finishReason === "content_filter")
  )
    return { kind: "content_filter" };
  if (status === 401 || status === 403 || status >= 400)
    return classifyCredentialFailure({ status });
  return undefined;
}

/** Updates credential state from safe upstream outcomes. */
export class CooldownPlugin implements GatewayPlugin {
  /** Stable configured plugin identity. */
  readonly id = "cooldown";
  /** Stable configured plugin version. */
  readonly version = "1.0.0";
  /** Lifecycle hooks observed by credential policy. */
  readonly hooks = ["onUpstreamResponse", "onError"] as const;
  /** Runs after outcome-producing plugins and before observer-only plugins. */
  readonly priority = 90;

  /** Creates a stateless hook backed by the authoritative lifecycle owner. */
  constructor(private readonly options: CooldownPluginOptions) {}

  /** Applies the canonical upstream response before later route resolution. */
  onUpstreamResponse(
    context: GatewayContext,
    response: CanonicalResponse,
  ): HookResult<CanonicalResponse> {
    const candidate = context.selectedCandidate;
    if (candidate === undefined) return continuation(response);
    try {
      const failure = responseFailure(response, this.options.clock);
      if (failure === undefined)
        this.options.state.success(candidate.credentialId);
      else this.options.state.failure(candidate.credentialId, failure);
      return continuation(response);
    } catch (cause) {
      if (cause instanceof CredentialStatePolicyError)
        return { kind: "abort", error: lifecyclePolicyError(context) };
      throw cause;
    }
  }
  /** Applies one safe canonical error before later route resolution. */
  onError(
    context: GatewayContext,
    value: GatewayError,
  ): HookResult<GatewayError> {
    const candidate = context.selectedCandidate;
    if (candidate === undefined) return continuation(value);
    try {
      this.options.state.failure(
        candidate.credentialId,
        classifyCredentialFailure(value),
      );
      return continuation(value);
    } catch (cause) {
      if (cause instanceof CredentialStatePolicyError)
        return { kind: "abort", error: lifecyclePolicyError(context) };
      throw cause;
    }
  }
}
