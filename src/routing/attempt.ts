/**
 * @fileoverview
 * Shared candidate attempt execution mechanics and key lease lifecycle management.
 *
 * Implements the core execution pipeline for dispatching an attempt to an upstream provider:
 * pre-lease preparation, key acquisition with deadline-aware cooldown sleep, provider request
 * construction, network dispatch, response head classification, and key health settlement.
 * Serves both native requests (via {@link executeAttempt}) and translated paths (via {@link dispatchOneAttempt}).
 */

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

/** Terminal conditions occurring prior to or during provider dispatch. */
export type AttemptHeadOutcome =
  | { readonly kind: "key_unavailable" }
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "cancelled"; readonly phase: "routing" | "wait" | "dispatch" }
  | { readonly kind: "prepare_failed"; readonly failure: NormalizedFailure }
  | { readonly kind: "dispatch_failed"; readonly failure: NormalizedFailure };

/** Full outcome of a native candidate attempt, including successful response heads. */
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

/** Shared context and service dependencies provided to each attempt of a request. */
export interface AttemptContext {
  /** Protocol adapters keyed by protocol identifier. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Network dispatcher executing provider HTTP requests. */
  readonly dispatcher: ProviderDispatcher;
  /** Active trace session recording attempt stages. */
  readonly trace: TraceSession;
  /** Telemetry observer tracking request lifecycle events. */
  readonly observer: GatewayObservability;
  /** Monotonic clock source. */
  readonly clock: Clock;
  /** Abortable sleep timer for cooldown waits. */
  readonly sleeper: Sleeper;
  /** Monotonic millisecond request deadline. */
  readonly deadlineMs: number;
  /** Inactivity timeout for chunk streaming in milliseconds. */
  readonly streamIdleMs: number;
  /** Allocates the next one-based attempt counter for this request. */
  nextAttemptNumber(): number;
}

/**
 * Classifies an abort signal reason into standardized gateway cancellation categories.
 *
 * @param signal - Aborted signal to inspect.
 * @returns Classified cause: "timeout", "shutdown", or "client".
 */
export function classifyAbortReason(signal: AbortSignal): "timeout" | "shutdown" | "client" {
  if (signal.reason === "timeout") return "timeout";
  if (signal.reason === "shutdown") return "shutdown";
  return "client";
}

/**
 * Protocol preparation adapter isolating native from translated attempt transformations.
 */
export interface AttemptPreparer<Pre> {
  /** Runs pre-lease preparation (e.g. cross-protocol translation IR mapping). */
  prepareBeforeLease(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
  ): Promise<Result<Pre, NormalizedFailure>>;

  /** Builds the concrete dispatchable provider request using the acquired key lease. */
  buildRequest(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
    lease: KeyLease,
    pre: Pre,
  ): Result<PreparedProviderRequest, NormalizedFailure>;

  /** Classifies the upstream response head using protocol-specific rules. */
  classify(
    candidate: CandidateDescriptor,
    request: GatewayRequest,
    ctx: AttemptContext,
    response: ProviderResponse,
  ): AttemptObservation;

  /** Whether the core should record a native mutation trace stage. */
  readonly traceNativeMutation?: boolean;
}

/** Result of dispatching an attempt head, deferring key health observation to the caller. */
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
 * Dispatches a single attempt head through pre-lease preparation, key leasing, request building,
 * dispatch, and response classification without settling the key observation.
 *
 * @param candidate - Selected candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Shared attempt execution context.
 * @param preparer - Protocol preparation adapter.
 * @returns Dispatched attempt outcome or pre-dispatch terminal failure.
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
 * Executes a native attempt on a candidate, including key leasing, dispatch, and inline observation settlement.
 *
 * @param candidate - Target candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context.
 * @returns Final native attempt outcome.
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

/** Outcome variants resulting from key lease acquisition. */
export type LeaseResult =
  | { readonly kind: "lease"; readonly lease: KeyLease }
  | { readonly kind: "unavailable" }
  | { readonly kind: "deadline" }
  | { readonly kind: "cancelled"; readonly phase: "wait" };

/**
 * Acquires an active key lease from the provider pool, sleeping through cooldowns if within request deadline.
 *
 * @param candidate - Target candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context.
 * @returns Lease acquisition outcome.
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
 * Finalizes an attempt by reporting completion telemetry and updating key pool health.
 *
 * @param ctx - Attempt execution context.
 * @param request - Inbound gateway request.
 * @param candidate - Executed candidate descriptor.
 * @param lease - Provider key lease used.
 * @param attemptNumber - Attempt index for this request.
 * @param observation - Attempt result observation.
 * @param status - HTTP response status code, if received.
 * @param durationMs - Attempt dispatch duration in milliseconds.
 * @param stream - Whether the request was dispatched in streaming mode.
 * @returns Applied cooldown delay in milliseconds, if any.
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

/**
 * Records cancellation in durable trace logs and live telemetry.
 *
 * @param ctx - Attempt execution context.
 * @param request - Inbound gateway request.
 * @param phase - Processing phase during which cancellation was detected.
 * @param by - Cause of the cancellation ("shutdown" or "client").
 */
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
 * Parses UTF-8 JSON bytes into a JSON value, returning null on error.
 *
 * @param bytes - Byte buffer containing serialized JSON.
 * @returns Parsed JSON value, or null on parse failure.
 */
export function parseJsonBytes(bytes: Uint8Array): JsonValue {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as JsonValue;
  } catch {
    return null;
  }
}
