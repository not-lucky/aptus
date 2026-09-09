/**
 * @fileoverview
 * Translated streaming attempt execution with pre-header bootstrap decoding.
 *
 * Coordinates cross-protocol streaming dispatches: prepares and executes upstream streaming
 * requests, binds tickets to translation sessions, executes pre-header chunk bootstrapping
 * via {@link bootstrapTranslatedStream} to catch early protocol errors before committing
 * client HTTP headers, settles key health, and hands live stream pumps over to the relay.
 */

import type { AttemptObservation, GatewayRequest, GatewayResult, ProviderResponse } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction, TranslationCoordinator } from "../translation/contracts.ts";
import { type AttemptContext, dispatchOneAttempt, finishAttempt } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { createTranslatedPreparer } from "./translated-preparer.ts";
import { bootstrapTranslatedStream, relayTranslatedStream } from "./translated-stream-relay.ts";

/** Outcome variants resulting from a translated streaming attempt execution. */
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
 * Executes a translated streaming attempt with pre-header chunk bootstrap verification.
 *
 * @param candidate - Selected candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context.
 * @param translation - Translation coordinator managing session tickets.
 * @returns Streaming attempt outcome ready for candidate runner orchestration.
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

  // Non-2xx response head: settle key observation and return for retry/fallback handling.
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

  // 2xx response head: bind session ticket and bootstrap initial chunks before committing client headers.
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

  // Bootstrap succeeded without client exposure: settle key observation as success and hand off to relay.
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
    aptusRequestId: request.aptusRequestId,
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
    trace: request.trace,
    observer: ctx.observer,
    reader: bootstrap.reader,
    pump: bootstrap.pump,
    providerSink: bootstrap.providerSink,
    irEventsSink: bootstrap.irEventsSink,
    initialClientChunks: bootstrap.initialClientChunks,
    isInitialComplete: bootstrap.isInitialComplete,
  });

  return { kind: "stream_ready", result: relayResult };
}
