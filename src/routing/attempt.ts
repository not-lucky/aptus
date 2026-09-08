import type {
  AttemptObservation,
  GatewayRequest,
  JsonValue,
  KeyLease,
  PreparedProviderRequest,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  ProviderResponse,
  Result,
  TraceSession,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { dispatchFailure, failureJson } from "./failures.ts";
import type { Clock, Sleeper } from "./timing.ts";

const utf8Decoder = new TextDecoder();

/**
 * The outcome of one candidate attempt, consumed by the Gateway's policy loop.
 *
 * `AttemptHeadOutcome` holds the candidate-level terminal conditions shared by
 * every path (client cancellation, deadline expiry, preparation failure, key
 * exhaustion, or transport dispatch failure); success shapes differ per path
 * and are unioned separately.
 */
export type AttemptHeadOutcome =
  | { readonly kind: "key_unavailable" }
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "cancelled"; readonly phase: "routing" | "wait" | "dispatch" }
  | { readonly kind: "prepare_failed"; readonly failure: NormalizedFailure }
  | { readonly kind: "dispatch_failed"; readonly failure: NormalizedFailure };

export type AttemptOutcome =
  | AttemptHeadOutcome
  | {
      readonly kind: "response";
      readonly response: ProviderResponse;
      readonly observation: AttemptObservation;
      readonly cooldownMs: number | undefined;
      readonly attemptNumber: number;
      readonly streamRequested: boolean;
    };

/**
 * Execution dependencies shared by every attempt of one request.
 */
export interface AttemptContext {
  /** Protocol adapters keyed by protocol. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Network dispatcher. */
  readonly dispatcher: ProviderDispatcher;
  /** Active trace session for this request. */
  readonly trace: TraceSession;
  /** Telemetry observer. */
  readonly observer: GatewayObservability;
  /** Monotonic clock seam. */
  readonly clock: Clock;
  /** Abortable sleeper seam. */
  readonly sleeper: Sleeper;
  /** Absolute monotonic request deadline in milliseconds. */
  readonly deadlineMs: number;
  /** Stream idle limit passed to the prepared provider request. */
  readonly streamIdleMs: number;
  /** Allocates the next global attempt number for this request. */
  nextAttemptNumber(): number;
}

export function classifyAbortReason(signal: AbortSignal): "timeout" | "shutdown" | "client" {
  if (signal.reason === "timeout") return "timeout";
  if (signal.reason === "shutdown") return "shutdown";
  return "client";
}

/**
 * Per-path request preparation adapter behind the unified attempt seam.
 *
 * The unified attempt core owns lease, dispatch, classify, and bookkeeping
 * once; each adapter supplies only path-specific preparation. Native prepares
 * via `prepareNative`, translated paths via the coordinator ticket.
 */
export interface AttemptPreparer<Pre> {
  /**
   * Runs before any key lease (translate for cross-protocol paths, no-op for
   * native). Records its own `ir_request` traces; a failure returns with zero
   * lease and zero dispatch.
   */
  prepareBeforeLease(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
  ): Promise<Result<Pre, NormalizedFailure>>;
  /**
   * Builds the dispatchable provider request from the leased key and the
   * pre-lease product. A failure is recorded as `prepare_failed`.
   */
  buildRequest(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
    lease: KeyLease,
    pre: Pre,
  ): Result<PreparedProviderRequest, NormalizedFailure>;
  /**
   * Classifies the response head with the path's owning adapter
   * (`request.protocol` for native, target protocol for translated).
   */
  classify(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
    response: ProviderResponse,
  ): AttemptObservation;
  /**
   * When true, the core records the native `mutation` trace (defaults,
   * extraBody, overrides, upstreamModel). Translated paths leave this false:
   * they apply no native mutations and historically emit no such stage, so
   * emitting one would shift trace numbering.
   */
  readonly traceNativeMutation?: boolean;
}

/**
 * Result of dispatching one attempt head without key observation.
 *
 * The core owns lease, dispatch, and classify mechanics; the caller owns the
 * single `finishAttempt` observation so translated paths can settle with the
 * post-success (spooled outcome / bootstrap) category instead of the raw head.
 * The dispatched variant carries the preparer product (e.g. the translation
 * ticket) so callers need no closure capture to continue post-success work.
 */
export type DispatchedAttempt<Pre> =
  | AttemptHeadOutcome
  | {
      readonly kind: "dispatched";
      readonly response: ProviderResponse;
      readonly observation: AttemptObservation;
      readonly lease: KeyLease;
      readonly attemptNumber: number;
      readonly dispatchDurationMs: number;
      readonly stream: boolean;
      readonly pre: Pre;
    };

/**
 * Dispatches one attempt head: pre-lease preparation, lease, build, dispatch,
 * and classify — without key observation.
 *
 * Single owner of pairing faults: abort checks, key selection telemetry,
 * `provider_request` / `provider_response_head` traces, attempt numbering,
 * and dispatch error mapping live here once. Callers perform exactly one
 * `finishAttempt` with the final (possibly post-success) observation.
 */
export async function dispatchOneAttempt<Pre>(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  preparer: AttemptPreparer<Pre>,
): Promise<DispatchedAttempt<Pre>> {
  const preResult = await preparer.prepareBeforeLease(candidate, request, ctx);
  if (!preResult.ok) {
    return { kind: "prepare_failed", failure: preResult.error };
  }
  const pre = preResult.value;

  if (request.signal.aborted) {
    const reason = classifyAbortReason(request.signal);
    if (reason === "timeout") {
      return { kind: "deadline_exceeded" };
    }
    await recordCancellation(ctx, request, "routing", reason);
    return { kind: "cancelled", phase: "routing" };
  }

  const acquired = await acquireLease(candidate, request, ctx);
  if (acquired.kind !== "lease") {
    if (acquired.kind === "unavailable") return { kind: "key_unavailable" };
    if (acquired.kind === "deadline") return { kind: "deadline_exceeded" };
    return { kind: "cancelled", phase: acquired.phase };
  }
  const lease = acquired.lease;
  const attemptNumber = ctx.nextAttemptNumber();

  await ctx.trace.recordJson("key_selection", {
    provider: candidate.provider.name,
    strategy: candidate.provider.keyStrategy,
    keyName: lease.keyName,
  });
  ctx.observer.keySelected({
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    provider: candidate.provider.name,
    keyName: lease.keyName,
    strategy: candidate.provider.keyStrategy,
  });

  const built = preparer.buildRequest(candidate, request, ctx, lease, pre);
  if (!built.ok) {
    await ctx.trace.recordJson("mutation", { failure: failureJson(built.error) });
    return { kind: "prepare_failed", failure: built.error };
  }
  const prepared = { ...built.value, provider: candidate.provider.name };
  if (preparer.traceNativeMutation === true) {
    await ctx.trace.recordJson("mutation", {
      defaults: candidate.mutations.defaults,
      extraBody: candidate.mutations.extraBody,
      overrides: candidate.mutations.overrides,
      upstreamModel: candidate.model.upstreamModel,
    });
  }
  await ctx.trace.recordJson("provider_request", {
    provider: prepared.provider,
    protocol: prepared.protocol,
    url: prepared.url,
    headers: prepared.headers,
    body: parseJsonBytes(prepared.body),
  });

  ctx.observer.attemptStarted({
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    candidateIndex: candidate.index,
    provider: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
    stream: prepared.stream,
  });
  ctx.observer.observe({
    type: "attempt_started",
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    candidateIndex: candidate.index,
    provider: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
  });

  const dispatchStarted = ctx.clock.nowMonotonicMs();
  let response: ProviderResponse;
  try {
    response = await ctx.dispatcher.dispatch(prepared, request.signal);
  } catch (error) {
    const durationMs = ctx.clock.nowMonotonicMs() - dispatchStarted;
    if (request.signal.aborted) {
      const reason = classifyAbortReason(request.signal);
      if (reason === "timeout") {
        finishAttempt(
          ctx,
          request,
          candidate,
          lease,
          attemptNumber,
          { result: "timeout", beforeClientBytes: true },
          undefined,
          durationMs,
          prepared.stream,
        );
        return { kind: "deadline_exceeded" };
      }
      finishAttempt(
        ctx,
        request,
        candidate,
        lease,
        attemptNumber,
        { result: "client_cancelled", beforeClientBytes: true },
        undefined,
        durationMs,
        prepared.stream,
      );
      await recordCancellation(ctx, request, "dispatch", reason);
      return { kind: "cancelled", phase: "dispatch" };
    }
    const failure = dispatchFailure(error);
    finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      { result: failure.category, beforeClientBytes: true },
      undefined,
      durationMs,
      prepared.stream,
    );
    return { kind: "dispatch_failed", failure };
  }
  const dispatchDurationMs = ctx.clock.nowMonotonicMs() - dispatchStarted;

  await ctx.trace.recordJson("provider_response_head", {
    status: response.status,
    headers: response.headers,
    finalUrl: response.finalUrl,
  });

  const observation = preparer.classify(candidate, request, ctx, response);
  return {
    kind: "dispatched",
    response,
    observation,
    lease,
    attemptNumber,
    dispatchDurationMs,
    stream: prepared.stream,
    pre,
  };
}

/**
 * Executes exactly one attempt on a candidate: key acquisition (rotating to an
 * available key, waiting out cooldowns inside the deadline), native request
 * preparation, dispatch, response-head classification, and key observation.
 *
 * Native preparation and same-protocol classification supply the path-specific
 * seam of the shared dispatch core; the head observation is final here, so it
 * settles inline (translated paths use `dispatchOneAttempt` directly to defer
 * settlement past spool/bootstrap).
 */
export async function executeAttempt(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
): Promise<AttemptOutcome> {
  const dispatched = await dispatchOneAttempt(candidate, request, ctx, {
    traceNativeMutation: true,
    prepareBeforeLease: async () => ({ ok: true as const, value: undefined }),
    buildRequest: (candidate, request, ctx, lease) =>
      ctx.adapters[request.protocol].prepareNative({
        protocol: request.protocol,
        baseUrl: candidate.provider.baseUrl,
        upstreamModel: candidate.model.upstreamModel,
        clientBody: request.body,
        clientHeaders: request.headers,
        providerHeaders: candidate.provider.headers,
        providerSecret: lease.secret,
        mutations: candidate.mutations,
        deadlineMs: ctx.deadlineMs,
        streamIdleMs: ctx.streamIdleMs,
      }),
    classify: (_candidate, request, ctx, response) =>
      ctx.adapters[request.protocol].classify(response, ctx.clock.nowWall().getTime()),
  });
  if (dispatched.kind !== "dispatched") {
    return dispatched;
  }
  const cooldownMs = finishAttempt(
    ctx,
    request,
    candidate,
    dispatched.lease,
    dispatched.attemptNumber,
    dispatched.observation,
    dispatched.observation.status,
    dispatched.dispatchDurationMs,
    dispatched.stream,
  );
  return {
    kind: "response",
    response: dispatched.response,
    observation: dispatched.observation,
    cooldownMs,
    attemptNumber: dispatched.attemptNumber,
    streamRequested: dispatched.stream,
  };
}

export type LeaseResult =
  | { readonly kind: "lease"; readonly lease: KeyLease }
  | { readonly kind: "unavailable" }
  | { readonly kind: "deadline" }
  | { readonly kind: "cancelled"; readonly phase: "wait" };

/**
 * Acquires a key from the candidate's pool, waiting out cooldowns while the
 * request deadline allows it. Rotation is implicit: `acquire` always prefers an
 * available key, so a wait happens only when every enabled key is cooling down.
 */
export async function acquireLease(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
): Promise<LeaseResult> {
  const publishAvailability = (): void => {
    ctx.observer.setKeyPoolAvailable(
      candidate.provider.name,
      candidate.provider.protocol,
      candidate.pool.availableCount(ctx.clock.nowMonotonicMs()),
    );
  };

  for (;;) {
    publishAvailability();
    const acquired = candidate.pool.acquire(ctx.clock.nowMonotonicMs());

    if (acquired.kind === "unavailable") {
      await ctx.trace.recordJson("key_selection", {
        provider: candidate.provider.name,
        strategy: candidate.provider.keyStrategy,
        keyName: null,
      });
      return { kind: "unavailable" };
    }
    if (acquired.kind === "acquired") {
      return { kind: "lease", lease: acquired.lease };
    }

    const nowMs = ctx.clock.nowMonotonicMs();
    const remainingDeadlineMs = ctx.deadlineMs - nowMs;
    if (acquired.untilMs - nowMs > remainingDeadlineMs || remainingDeadlineMs <= 0) {
      return { kind: "deadline" };
    }
    try {
      await ctx.sleeper.sleep(acquired.untilMs - nowMs, request.signal);
    } catch {
      const reason = classifyAbortReason(request.signal);
      if (reason === "timeout") {
        return { kind: "deadline" };
      }
      await recordCancellation(ctx, request, "wait", reason);
      return { kind: "cancelled", phase: "wait" };
    }
  }
}

/**
 * Emits attempt-completion telemetry, records the key observation, and
 * republishes the pool availability gauge.
 *
 * @returns The cooldown delay the key pool scheduled, if any.
 */
export function finishAttempt(
  ctx: AttemptContext,
  request: GatewayRequest,
  candidate: CandidateDescriptor,
  lease: KeyLease,
  attemptNumber: number,
  observation: AttemptObservation,
  status: number | undefined,
  durationMs: number,
  stream: boolean,
): number | undefined {
  ctx.observer.attemptCompleted({
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    provider: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
    status,
    attemptResult: observation.result,
    stream,
    durationMs,
  });
  const cooldownMs = candidate.pool.observe(lease, observation, ctx.clock.nowMonotonicMs());
  ctx.observer.setKeyPoolAvailable(
    candidate.provider.name,
    candidate.provider.protocol,
    candidate.pool.availableCount(ctx.clock.nowMonotonicMs()),
  );
  return cooldownMs;
}

export async function recordCancellation(
  ctx: AttemptContext,
  request: GatewayRequest,
  phase: string,
  by: "shutdown" | "client",
): Promise<void> {
  await ctx.trace.recordJson("cancellation", { phase, by });
  ctx.observer.cancelled({ aptusRequestId: request.aptusRequestId, phase, by });
}

/**
 * Parses UTF-8 JSON bytes into a JSON value (falling back to `null`).
 */
export function parseJsonBytes(bytes: Uint8Array): JsonValue {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as JsonValue;
  } catch {
    return null;
  }
}
