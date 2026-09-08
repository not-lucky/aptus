import type { AttemptObservation, GatewayRequest, GatewayResult, ProviderResponse } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction, TranslationCoordinator } from "../translation/contracts.ts";
import { type AttemptContext, dispatchOneAttempt, finishAttempt } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { createTranslatedPreparer } from "./translated-preparer.ts";
import { bootstrapTranslatedStream, relayTranslatedStream } from "./translated-stream-relay.ts";

/**
 * Outcome of one cross-protocol streaming attempt.
 */
export type TranslatedStreamAttemptOutcome =
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
    }
  | {
      readonly kind: "stream_ready";
      readonly result: GatewayResult;
    };

/**
 * Executes a streaming translated attempt with pre-header bootstrap decoding.
 *
 * Dispatch mechanics (lease, dispatch, classify) are owned by the shared
 * `dispatchOneAttempt` core; pump plus sink creation and the pre-header loop
 * are owned by the relay module's `bootstrapTranslatedStream`. This module
 * only binds the translation ticket to a session and settles the single key
 * observation.
 *
 * Pre-dispatch decode/validation/preflight failures return with zero lease and
 * zero dispatch. Early decode/frame errors before client headers are emitted
 * are treated as dispatch failures, permitting normal candidate retry and
 * fallback.
 */
export async function executeTranslatedStreamAttempt(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  translation: TranslationCoordinator,
): Promise<TranslatedStreamAttemptOutcome> {
  const dispatchStarted = ctx.clock.nowMonotonicMs();

  const dispatched = await dispatchOneAttempt(candidate, request, ctx, createTranslatedPreparer(translation, true));

  if (dispatched.kind !== "dispatched") {
    return dispatched;
  }
  const { response, observation, lease, attemptNumber, dispatchDurationMs } = dispatched;

  // Non-2xx response head follows normal retry/fallback policy (decided by Gateway).
  if (observation.result !== "success") {
    const cooldownMs = finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      observation,
      observation.status,
      dispatchDurationMs,
      false,
    );
    return { kind: "response", response, observation, cooldownMs, attemptNumber };
  }

  // 2xx success: bind the ticket carried in the dispatched payload to a
  // session, then hand pump ownership to the relay module for pre-header
  // bootstrap.
  const sessionBundle = translation.createTicketSession(dispatched.pre);

  const bootstrap = await bootstrapTranslatedStream({
    trace: ctx.trace,
    response,
    sessionBundle,
    direction: `${request.protocol}->${candidate.provider.protocol}` as Direction,
  });
  if (bootstrap.kind === "failure") {
    finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      { result: bootstrap.failure.category, beforeClientBytes: true },
      response.status,
      dispatchDurationMs,
      false,
    );
    return { kind: "dispatch_failed", failure: bootstrap.failure };
  }

  // Bootstrap succeeded: single success observation, then transfer byte
  // ownership to the relay.
  finishAttempt(
    ctx,
    request,
    candidate,
    lease,
    attemptNumber,
    observation,
    observation.status,
    dispatchDurationMs,
    true,
  );

  const relayResult = relayTranslatedStream({
    coordinator: request.coordinator,
    clock: ctx.clock,
    started: dispatchStarted,
    attemptCount: attemptNumber,
    targetProtocol: candidate.provider.protocol,
    clientProtocol: request.protocol,
    providerName: candidate.provider.name,
    canonicalName: request.canonicalPublicName,
    pricing: candidate.model.pricing ?? null,
    requestSignal: request.signal,
    reader: bootstrap.reader,
    pump: bootstrap.pump,
    providerSink: bootstrap.providerSink,
    irEventsSink: bootstrap.irEventsSink,
    initialClientChunks: bootstrap.initialClientChunks,
    isInitialComplete: bootstrap.isInitialComplete,
  });

  return { kind: "stream_ready", result: relayResult };
}
