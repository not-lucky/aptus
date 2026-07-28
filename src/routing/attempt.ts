import type {
  AttemptObservation,
  GatewayRequest,
  JsonValue,
  KeyLease,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  ProviderResponse,
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
 * Every kind except `"response"` is a candidate-level terminal condition
 * (client cancellation, deadline expiry, preparation failure, key exhaustion,
 * or a transport dispatch failure); the Gateway decides retry, fallback, and
 * the client-facing terminal for each.
 */
export type AttemptOutcome =
  | { readonly kind: "key_unavailable" }
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "cancelled"; readonly phase: "routing" | "wait" | "dispatch" }
  | { readonly kind: "prepare_failed"; readonly failure: NormalizedFailure }
  | { readonly kind: "dispatch_failed"; readonly failure: NormalizedFailure }
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

/**
 * Executes exactly one attempt on a candidate: key acquisition (rotating to an
 * available key, waiting out cooldowns inside the deadline), native request
 * preparation, dispatch, response-head classification, and key observation.
 *
 * The executor owns the mechanical trace stages and telemetry of an attempt;
 * it never decides retry or fallback.
 *
 * @param candidate - The candidate being attempted.
 * @param request - The admitted client request.
 * @param ctx - Execution dependencies and the attempt-number allocator.
 * @returns The {@link AttemptOutcome} for the Gateway's policy loop.
 */
export async function executeAttempt(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
): Promise<AttemptOutcome> {
  if (request.signal.aborted) {
    await recordCancellation(ctx, request, "routing");
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

  const preparedResult = ctx.adapters[request.protocol].prepareNative({
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
  });
  if (!preparedResult.ok) {
    await ctx.trace.recordJson("mutation", { failure: failureJson(preparedResult.error) });
    return { kind: "prepare_failed", failure: preparedResult.error };
  }
  const prepared = { ...preparedResult.value, provider: candidate.provider.name };
  await ctx.trace.recordJson("mutation", {
    defaults: candidate.mutations.defaults,
    extraBody: candidate.mutations.extraBody,
    overrides: candidate.mutations.overrides,
    upstreamModel: candidate.model.upstreamModel,
  });
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
      await recordCancellation(ctx, request, "dispatch");
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

  const observation = ctx.adapters[request.protocol].classify(response, ctx.clock.nowWall().getTime());
  const cooldownMs = finishAttempt(
    ctx,
    request,
    candidate,
    lease,
    attemptNumber,
    observation,
    observation.status,
    dispatchDurationMs,
    prepared.stream,
  );

  return {
    kind: "response",
    response,
    observation,
    cooldownMs,
    attemptNumber,
    streamRequested: prepared.stream,
  };
}

type LeaseResult =
  | { readonly kind: "lease"; readonly lease: KeyLease }
  | { readonly kind: "unavailable" }
  | { readonly kind: "deadline" }
  | { readonly kind: "cancelled"; readonly phase: "wait" };

/**
 * Acquires a key from the candidate's pool, waiting out cooldowns while the
 * request deadline allows it. Rotation is implicit: `acquire` always prefers an
 * available key, so a wait happens only when every enabled key is cooling down.
 */
async function acquireLease(
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
      await recordCancellation(ctx, request, "wait");
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
function finishAttempt(
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

async function recordCancellation(ctx: AttemptContext, request: GatewayRequest, phase: string): Promise<void> {
  await ctx.trace.recordJson("cancellation", { phase, by: "client" });
  ctx.observer.cancelled({ aptusRequestId: request.aptusRequestId, phase, by: "client" });
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
