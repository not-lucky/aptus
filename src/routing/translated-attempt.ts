/**
 * @fileoverview
 * Translated complete request execution and dry-run preview workflows.
 *
 * Implements end-to-end execution for cross-protocol non-streaming requests: translates
 * client requests to target provider format, leases a key, dispatches to upstream, spools
 * response payload bodies, and translates response outcomes back to the client format.
 * Also provides {@link executeTranslatedDryRun} for previewing translation and key selection.
 */

import type {
  AttemptObservation,
  GatewayRequest,
  JsonObject,
  JsonValue,
  OwnedBody,
  ProviderResponse,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { TranslateCompleteOutcomeResult, TranslationCoordinator } from "../translation/contracts.ts";
import { type AttemptContext, dispatchOneAttempt, finishAttempt } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { dispatchFailure, failureJson } from "./failures.ts";
import { spoolResponseBody } from "./spool.ts";
import { createTranslatedPreparer } from "./translated-preparer.ts";

/** Shared UTF-8 decoder for converting provider response buffers into JSON strings. */
const utf8Decoder = new TextDecoder();

/** Outcome variants for a cross-protocol complete attempt execution. */
export type TranslatedAttemptOutcome =
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
      readonly kind: "translated_response";
      readonly response: ProviderResponse;
      readonly body: OwnedBody;
      readonly outcome: TranslateCompleteOutcomeResult;
      readonly attemptNumber: number;
    };

/**
 * Executes a cross-protocol complete attempt, translating request and response bodies.
 *
 * @param candidate - Selected candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context.
 * @param translation - Translation coordinator handling protocol transformations.
 * @returns Translated attempt outcome for candidate runner orchestration.
 */
export async function executeTranslatedAttempt(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  translation: TranslationCoordinator,
): Promise<TranslatedAttemptOutcome> {
  const dispatched = await dispatchOneAttempt(candidate, request, ctx, createTranslatedPreparer(translation, false));

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

  // 2xx response head: spool the body and translate the outcome into client protocol envelope.
  let body: OwnedBody;
  try {
    body = await spoolResponseBody(response.body);
  } catch (error) {
    finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      { result: "provider", beforeClientBytes: true },
      response.status,
      dispatchDurationMs,
      false,
    );
    const failure = dispatchFailure(error);
    return { kind: "dispatch_failed", failure };
  }

  let parsedJson: JsonObject | undefined;
  if (body.inMemoryBytes !== undefined) {
    try {
      parsedJson = JSON.parse(utf8Decoder.decode(body.inMemoryBytes)) as JsonObject;
      await ctx.trace.recordJson("provider_response", parsedJson as unknown as JsonValue);
    } catch {
      await ctx.trace.recordBytes("provider_response", body.inMemoryBytes);
    }
  } else {
    const providerSink = ctx.trace.openBytes("provider_response");
    const reader = body.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0) {
          await providerSink.append(value);
        }
      }
      await providerSink.complete();
    } catch {
      await providerSink.discard().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }

  let rawOutcomeBody: JsonObject;
  try {
    rawOutcomeBody = parsedJson ?? (JSON.parse(utf8Decoder.decode(await body.bytes())) as JsonObject);
  } catch {
    const failure = {
      category: "provider" as const,
      message: "provider returned non-JSON response body",
      retryable: false,
    };
    finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      { result: "provider", beforeClientBytes: true },
      response.status,
      dispatchDurationMs,
      false,
    );
    return { kind: "dispatch_failed", failure };
  }

  const outcomeResult = translation.translateCompleteOutcome({
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    status: response.status,
    headers: response.headers,
    body: rawOutcomeBody,
    logicalModel: request.canonicalPublicName,
  });

  if (!outcomeResult.ok) {
    await ctx.trace.recordJson("translation_failure", failureJson(outcomeResult.error));
    finishAttempt(
      ctx,
      request,
      candidate,
      lease,
      attemptNumber,
      { result: outcomeResult.error.category, beforeClientBytes: true },
      response.status,
      dispatchDurationMs,
      false,
    );
    return { kind: "dispatch_failed", failure: outcomeResult.error };
  }

  await ctx.trace.recordJson("ir_outcome", outcomeResult.value.irOutcome as unknown as JsonValue);

  finishAttempt(
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

  return {
    kind: "translated_response",
    response,
    body,
    outcome: outcomeResult.value,
    attemptNumber,
  };
}
