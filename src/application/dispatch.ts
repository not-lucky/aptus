import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  CostMetrics,
  GatewayError,
  JsonValue,
  RouteCandidate,
  TokenUsage,
} from "../domain/index.js";
import { createGatewayError, redactValue } from "../domain/index.js";
import type {
  CredentialStatePort,
  DispatchAttemptBudget,
  DispatchCandidatePolicy,
  ProviderDispatchPort,
  TracePort,
} from "../ports/index.js";
import type { ClockPort } from "../ports/infrastructure.js";
import type { DispatchCommitmentState } from "./lifecycle.js";
import type { CandidateIterator, RouteAttempt } from "./routing.js";
import type {
  CostAuditDecorator,
  GuardedDispatchProxy,
  RedactingTraceDecorator,
  RetryBudgetDecorator,
  TimeoutDecorator,
} from "./patterns.js";

/** Application-owned request-state keys shared with policy plugins. */
export const DISPATCH_STATE_KEYS = Object.freeze({
  /** Effective request dry-run decision. */
  dryRun: "dispatch:dry-run",
  /** Candidate cost estimate safe for dry-run and budget checks. */
  costEstimate: "dispatch:cost-estimate",
  /** Immutable safe attempt audit snapshots. */
  attempts: "dispatch:attempts",
  /** Candidate key whose thrown failure already updated credential state. */
  credentialOutcomeHandled: "dispatch:credential-outcome-handled",
} as const);

/** Safe request-local cost estimate retained by Application. */
export interface DispatchCostEstimate {
  /** Estimated token usage. */
  readonly usage: TokenUsage;
  /** Estimated canonical cost. */
  readonly cost: CostMetrics;
}

/** Reason a candidate cannot begin within the request-local budget. */
export type DispatchBudgetBlockReason =
  | "duplicate"
  | "attempts"
  | "latency"
  | "cost"
  | "cancelled";

/** Fixed safe error for illegal ledger sequencing. */
export class DispatchBudgetStateError extends Error {
  /** Creates a safe internal state error. */
  constructor() {
    super("dispatch budget state is invalid");
    this.name = "DispatchBudgetStateError";
  }
}

function key(candidate: RouteCandidate): string {
  return `${candidate.routeId}\u0000${candidate.providerId}\u0000${candidate.credentialId}\u0000${candidate.physicalModel}`;
}

function validPositive(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function validNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Traverses a copied candidate list once in resolver order under an attempt cap. */
export class BoundedCandidateIterator implements CandidateIterator {
  private readonly candidates: ReadonlyArray<RouteCandidate>;

  /** Copies candidates and validates the positive attempt bound. */
  constructor(
    candidates: ReadonlyArray<RouteCandidate>,
    private readonly maxAttempts: number,
    private readonly signal: AbortSignal,
  ) {
    if (!validPositive(maxAttempts)) throw new DispatchBudgetStateError();
    this.candidates = Object.freeze([...candidates]);
  }

  /** Yields unique candidates in resolver order while observing cancellation. */
  async *[Symbol.asyncIterator](): AsyncIterator<RouteCandidate> {
    const seen = new Set<string>();
    let yielded = 0;
    for (const candidate of this.candidates) {
      this.signal.throwIfAborted();
      const candidateKey = key(candidate);
      if (seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      if (yielded >= this.maxAttempts) return;
      yielded += 1;
      yield candidate;
    }
  }
}

function safeErrorProjection(error: GatewayError): GatewayError {
  return createGatewayError({
    category: error.category,
    code: error.code,
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    requestId: error.requestId,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

function safeResponseProjection(response: CanonicalResponse): CanonicalResponse {
  return Object.freeze({
    requestId: response.requestId,
    responseId: response.responseId,
    createdAt: response.createdAt,
    model: response.model,
    status: response.status,
    choices: [],
    usage: Object.freeze({ ...response.usage }),
    cost: Object.freeze({ ...response.cost }),
    provider: Object.freeze({
      providerId: response.provider.providerId,
      credentialId: "redacted",
      physicalModel: response.provider.physicalModel,
      responseHeaders: Object.freeze({}),
      upstreamStatus: response.provider.upstreamStatus,
    }),
  });
}

/** Owns bounded attempt sequencing, cost charging, and safe audit projections. */
export class DispatchBudgetLedger {
  private readonly startedAtMs: number;
  private readonly seen = new Set<string>();
  private readonly records: RouteAttempt[] = [];
  private active:
    | { readonly candidate: RouteCandidate; readonly startedAt: string }
    | undefined;
  private _spentCostUsd = 0;

  /** Validates and starts one request-local hard budget. */
  constructor(
    private readonly budget: DispatchAttemptBudget,
    private readonly clock: ClockPort,
    private readonly signal: AbortSignal,
    private readonly commitment: DispatchCommitmentState,
  ) {
    if (
      !validPositive(budget.maxAttempts) ||
      !validPositive(budget.maxLatencyMs) ||
      !validNonNegative(budget.maxCostUsd)
    )
      throw new DispatchBudgetStateError();
    this.startedAtMs = clock.now();
  }

  /** Total estimated or observed cost charged to completed attempts. */
  get spentCostUsd(): number {
    return this._spentCostUsd;
  }

  /** Returns why a candidate cannot start, without mutating the ledger. */
  blockReason(candidate: RouteCandidate): DispatchBudgetBlockReason | undefined {
    if (this.signal.aborted) return "cancelled";
    if (this.commitment.isCommitted() || this.seen.has(key(candidate))) return "duplicate";
    if (this.active !== undefined || this.records.length >= this.budget.maxAttempts)
      return "attempts";
    if (this.remainingLatencyMs() <= 0) return "latency";
    if (
      !validNonNegative(candidate.estimatedCostUsd) ||
      this._spentCostUsd + candidate.estimatedCostUsd > this.budget.maxCostUsd
    )
      return "cost";
    return undefined;
  }

  /** Begins exactly one candidate after a successful eligibility check. */
  begin(candidate: RouteCandidate): void {
    if (this.active !== undefined || this.blockReason(candidate) !== undefined)
      throw new DispatchBudgetStateError();
    this.seen.add(key(candidate));
    this.active = Object.freeze({
      candidate,
      startedAt: new Date(this.clock.now()).toISOString(),
    });
  }

  /** Finalizes the active attempt once and charges the larger safe cost value. */
  finish(
    outcome: GatewayError | CanonicalResponse,
    observedCostUsd?: number,
  ): void {
    const active = this.active;
    if (active === undefined) throw new DispatchBudgetStateError();
    const observed =
      observedCostUsd !== undefined && validNonNegative(observedCostUsd)
        ? observedCostUsd
        : active.candidate.estimatedCostUsd;
    this._spentCostUsd += Math.max(active.candidate.estimatedCostUsd, observed);
    this.records.push(
      Object.freeze({
        candidate: active.candidate,
        startedAt: active.startedAt,
        emittedBytes: this.commitment.isCommitted(),
        outcome: "provider" in outcome
          ? safeResponseProjection(outcome)
          : safeErrorProjection(outcome),
      }),
    );
    this.active = undefined;
  }

  /** Remaining hard cascade latency in milliseconds. */
  remainingLatencyMs(): number {
    return Math.max(0, this.budget.maxLatencyMs - (this.clock.now() - this.startedAtMs));
  }

  /** Returns an immutable snapshot of finalized safe attempts. */
  attempts(): ReadonlyArray<RouteAttempt> {
    return Object.freeze([...this.records]);
  }
}

function linkedController(signal: AbortSignal): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    unlink: () => signal.removeEventListener("abort", abort),
  };
}

function timeoutError(requestId: string, stream: boolean): GatewayError {
  return createGatewayError({
    category: "timeout",
    code: stream ? "upstream_stream_idle_timeout" : "upstream_timeout",
    message: stream ? "upstream stream idle timeout" : "upstream request timed out",
    status: 504,
    retryable: true,
    requestId,
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  clock: ClockPort,
  delayMs: number,
  controller: AbortController,
  requestId: string,
  stream: boolean,
): Promise<T> {
  if (delayMs <= 0) throw timeoutError(requestId, stream);
  const timerController = new AbortController();
  const winner = await Promise.race([
    operation.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    clock.sleep(delayMs, timerController.signal).then(() => ({ kind: "timeout" as const })),
  ]);
  timerController.abort();
  if (winner.kind === "timeout") {
    const error = timeoutError(requestId, stream);
    controller.abort(error);
    void operation.catch(() => undefined);
    throw error;
  }
  if (winner.kind === "error") throw winner.error;
  return winner.value;
}

/** Enforces linked provider and stream-idle timeouts without replacing caller cancellation. */
export class TimeoutDispatchDecorator implements TimeoutDecorator {
  /** Inner provider boundary receiving each forwarded call exactly once. */
  readonly inner: ProviderDispatchPort;

  /** Creates a timeout decorator for one candidate policy and ledger. */
  constructor(
    inner: ProviderDispatchPort,
    private readonly policy: DispatchCandidatePolicy,
    private readonly ledger: DispatchBudgetLedger,
    private readonly clock: ClockPort,
    private readonly requestId: string,
  ) {
    this.inner = inner;
  }

  /** Bounds one non-stream dispatch by provider and remaining cascade latency. */
  async dispatch(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    signal.throwIfAborted();
    const linked = linkedController(signal);
    try {
      return await withTimeout(
        this.inner.dispatch(candidate, request, linked.controller.signal),
        this.clock,
        Math.min(this.policy.providerTimeoutMs, this.ledger.remainingLatencyMs()),
        linked.controller,
        this.requestId,
        false,
      );
    } finally {
      linked.unlink();
    }
  }

  /** Bounds every iterator read by stream-idle and remaining cascade latency. */
  stream(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk> {
    const self = this;
    return (async function* (): AsyncGenerator<CanonicalChunk> {
      signal.throwIfAborted();
      const linked = linkedController(signal);
      const iterator = self.inner.stream(candidate, request, linked.controller.signal)[Symbol.asyncIterator]();
      let returned = false;
      const close = async (): Promise<void> => {
        if (returned) return;
        returned = true;
        await iterator.return?.();
      };
      try {
        while (true) {
          const next = await withTimeout(
            iterator.next(),
            self.clock,
            Math.min(self.policy.streamIdleTimeoutMs, self.ledger.remainingLatencyMs()),
            linked.controller,
            self.requestId,
            true,
          );
          if (next.done) return;
          yield next.value;
        }
      } finally {
        linked.unlink();
        await close();
      }
    })();
  }
}

/** Begins one ledger attempt around one forwarded provider call without hidden retries. */
export class RetryBudgetDispatchDecorator implements RetryBudgetDecorator {
  /** Inner provider boundary receiving each forwarded call exactly once. */
  readonly inner: ProviderDispatchPort;
  /** Creates one-attempt ledger ownership around the inner dispatch. */
  constructor(inner: ProviderDispatchPort, private readonly ledger: DispatchBudgetLedger) {
    this.inner = inner;
  }
  dispatch(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    this.ledger.begin(candidate);
    return this.inner.dispatch(candidate, request, signal);
  }
  stream(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk> {
    this.ledger.begin(candidate);
    return this.inner.stream(candidate, request, signal);
  }
}

function normalizeDispatchFailure(value: unknown, requestId: string): GatewayError {
  if (typeof value === "object" && value !== null) {
    const failure = value as Record<string, unknown>;
    if (
      typeof failure["category"] === "string" &&
      typeof failure["code"] === "string" &&
      typeof failure["message"] === "string" &&
      typeof failure["status"] === "number" &&
      typeof failure["retryable"] === "boolean"
    ) {
      return createGatewayError({
        category: failure["category"] as GatewayError["category"],
        code: failure["code"] as string,
        message: failure["message"] as string,
        status: failure["status"] as number,
        retryable: failure["retryable"] as boolean,
        requestId,
        ...(typeof failure["details"] === "object" && failure["details"] !== null
          ? { details: failure["details"] as Record<string, unknown> }
          : {}),
      });
    }
    const code = typeof failure["code"] === "string" ? failure["code"].toUpperCase() : "";
    if (["ENOTFOUND", "EAI_AGAIN", "DNS"].includes(code))
      return createGatewayError({ category: "upstream", code: "upstream_dns", message: "upstream DNS resolution failed", status: 502, retryable: true, requestId });
    if (["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(code))
      return createGatewayError({ category: "upstream", code: "upstream_connection", message: "upstream connection failed", status: 502, retryable: true, requestId });
    if (failure["name"] === "AbortError" || code === "ETIMEDOUT")
      return createGatewayError({ category: "timeout", code: "upstream_timeout", message: "upstream request timed out", status: 504, retryable: true, requestId });
  }
  return createGatewayError({ category: "upstream", code: "upstream_dispatch_failed", message: "upstream dispatch failed", status: 502, retryable: false, requestId });
}

/** Finalizes every begun attempt exactly once and owns observed-cost charging. */
export class CostAuditDispatchDecorator implements CostAuditDecorator {
  /** Inner provider boundary receiving each forwarded call exactly once. */
  readonly inner: ProviderDispatchPort;
  /** Creates the sole attempt-finalization and cost-charging decorator. */
  constructor(inner: ProviderDispatchPort, private readonly ledger: DispatchBudgetLedger, private readonly requestId: string) {
    this.inner = inner;
  }
  async dispatch(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    try {
      const response = await this.inner.dispatch(candidate, request, signal);
      this.ledger.finish(response, response.cost.totalUsd);
      return response;
    } catch (value: unknown) {
      const error = normalizeDispatchFailure(value, this.requestId);
      this.ledger.finish(error);
      throw error;
    }
  }
  stream(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk> {
    const self = this;
    return (async function* (): AsyncGenerator<CanonicalChunk> {
      let observedCostUsd: number | undefined;
      try {
        for await (const chunk of self.inner.stream(candidate, request, signal)) {
          if (chunk.type === "usage" && chunk.cost !== undefined && validNonNegative(chunk.cost.totalUsd)) observedCostUsd = chunk.cost.totalUsd;
          if (chunk.type === "error") throw chunk.error;
          yield chunk;
        }
        const response = createGatewayError({ category: "upstream", code: "stream_completed", message: "stream completed", status: 200, retryable: false, requestId: self.requestId });
        self.ledger.finish(response, observedCostUsd);
      } catch (value: unknown) {
        const error = normalizeDispatchFailure(value, self.requestId);
        self.ledger.finish(error, observedCostUsd);
        throw error;
      }
    })();
  }
}

/** Emits fixed-schema redacted dispatch observations and isolates trace failures. */
export class RedactingTraceDispatchDecorator implements RedactingTraceDecorator {
  /** Inner provider boundary receiving each forwarded call exactly once. */
  readonly inner: ProviderDispatchPort;
  constructor(
    inner: ProviderDispatchPort,
    private readonly trace: TracePort,
    private readonly requestId: string,
    private readonly ledger: DispatchBudgetLedger,
    private readonly clock: ClockPort,
    private readonly commitment: DispatchCommitmentState,
  ) {
    this.inner = inner;
  }
  private record(event: string, candidate: RouteCandidate, extra: Record<string, JsonValue> = {}): void {
    const record = redactValue({
      schema: "aptus.dispatch.trace",
      version: 1,
      event,
      requestId: this.requestId,
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      physicalModel: candidate.physicalModel,
      attempt: this.ledger.attempts().length + 1,
      remainingLatencyMs: this.ledger.remainingLatencyMs(),
      spentCostUsd: this.ledger.spentCostUsd,
      committed: this.commitment.isCommitted(),
      ...extra,
    }) as Readonly<Record<string, JsonValue>>;
    void this.trace.record(record).catch(() => undefined);
  }
  async dispatch(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    const started = this.clock.now();
    this.record("dispatch_start", candidate);
    try {
      const response = await this.inner.dispatch(candidate, request, signal);
      this.record("dispatch_end", candidate, { latencyMs: Math.max(0, this.clock.now() - started), status: response.provider.upstreamStatus });
      return response;
    } catch (value: unknown) {
      const error = normalizeDispatchFailure(value, this.requestId);
      this.record("dispatch_error", candidate, { latencyMs: Math.max(0, this.clock.now() - started), code: error.code, status: error.status });
      throw error;
    }
  }
  stream(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk> {
    const self = this;
    return (async function* (): AsyncGenerator<CanonicalChunk> {
      const started = self.clock.now();
      self.record("dispatch_start", candidate);
      try {
        for await (const chunk of self.inner.stream(candidate, request, signal)) yield chunk;
        self.record("dispatch_end", candidate, { latencyMs: Math.max(0, self.clock.now() - started) });
      } catch (value: unknown) {
        const error = normalizeDispatchFailure(value, self.requestId);
        self.record("dispatch_error", candidate, { latencyMs: Math.max(0, self.clock.now() - started), code: error.code, status: error.status });
        throw error;
      }
    })();
  }
}

/** Rejects committed, budget-blocked, cancelled, or credential-ineligible calls. */
export class DefaultGuardedDispatchProxy implements GuardedDispatchProxy {
  /** Inner provider boundary receiving each eligible call exactly once. */
  readonly inner: ProviderDispatchPort;
  constructor(
    inner: ProviderDispatchPort,
    private readonly ledger: DispatchBudgetLedger,
    private readonly credentials: CredentialStatePort,
    private readonly requestId: string,
  ) {
    this.inner = inner;
  }
  private check(candidate: RouteCandidate, signal: AbortSignal): void {
    signal.throwIfAborted();
    const reason = this.ledger.blockReason(candidate);
    if (reason !== undefined || !this.credentials.eligible(candidate.credentialId))
      throw createGatewayError({ category: "routing", code: "route_exhausted", message: "no eligible route candidate", status: 503, retryable: true, requestId: this.requestId });
  }
  dispatch(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    this.check(candidate, signal);
    return this.inner.dispatch(candidate, request, signal);
  }
  stream(candidate: RouteCandidate, request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk> {
    this.check(candidate, signal);
    return this.inner.stream(candidate, request, signal);
  }
}

/** Dependencies for the canonical provider-dispatch decorator chain. */
export interface ProviderDispatchCompositionOptions {
  /** Candidate represented by this composition. */
  readonly candidate: RouteCandidate;
  /** Captured candidate policy. */
  readonly policy: DispatchCandidatePolicy;
  /** Stable request identity. */
  readonly requestId: string;
  /** Monotonic writer commitment state. */
  readonly commitment: DispatchCommitmentState;
  /** Request-local hard budget ledger. */
  readonly ledger: DispatchBudgetLedger;
  /** Injected process clock. */
  readonly clock: ClockPort;
  /** Authoritative credential lifecycle state. */
  readonly credentials: CredentialStatePort;
  /** Sink receiving only redacted fixed-schema observations. */
  readonly trace: TracePort;
}

/** Constructs guard -> trace -> cost -> retry-budget -> timeout -> provider. */
export function composeProviderDispatch(
  inner: ProviderDispatchPort,
  options: ProviderDispatchCompositionOptions,
): GuardedDispatchProxy {
  const timeout = new TimeoutDispatchDecorator(inner, options.policy, options.ledger, options.clock, options.requestId);
  const retry = new RetryBudgetDispatchDecorator(timeout, options.ledger);
  const cost = new CostAuditDispatchDecorator(retry, options.ledger, options.requestId);
  const trace = new RedactingTraceDispatchDecorator(cost, options.trace, options.requestId, options.ledger, options.clock, options.commitment);
  return new DefaultGuardedDispatchProxy(trace, options.ledger, options.credentials, options.requestId);
}
