import type {
  AttemptObservation,
  DryRunProviderRequest,
  DryRunResult,
  GatewayRequest,
  JsonObject,
  JsonValue,
  OwnedBody,
  ProviderResponse,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Redactor } from "../observability/trace/redaction.ts";
import type { TranslateCompleteOutcomeResult, TranslationCoordinator } from "../translation/contracts.ts";
import { targetDefaultMaxTokensFrom } from "../translation/coordinator.ts";
import { type AttemptContext, dispatchOneAttempt, finishAttempt } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { dispatchFailure, failureJson, unavailableFailure } from "./failures.ts";
import { spoolResponseBody } from "./spool.ts";
import { createTranslatedPreparer } from "./translated-preparer.ts";

const utf8Decoder = new TextDecoder();

/**
 * Outcome of one cross-protocol translation attempt.
 */
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
 * Executes a translated attempt: translates request into IR and target format,
 * acquires a key, dispatches to provider, spools 2xx body, and translates outcome.
 *
 * Pre-dispatch decode/validation/preflight failures return with zero lease and zero dispatch.
 *
 * @param candidate - Target candidate.
 * @param request - Admitted client gateway request.
 * @param ctx - Attempt context.
 * @param translation - Translation coordinator bundle.
 * @returns Translated attempt outcome for Gateway orchestration.
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

  // Non-2xx response head follows normal retry/fallback policy (decided by Gateway).
  // Single key observation with the head category.
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

  // 2xx success: spool body and translate outcome (single observation below).
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
    // A 2xx body that is not valid JSON is a provider protocol violation.
    // Finish the attempt and surface a provider failure rather than an internal fault.
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

export type TranslatedDryRunOutcome =
  | { readonly kind: "dry_run"; readonly result: DryRunResult }
  | { readonly kind: "skipped"; readonly failure: NormalizedFailure }
  | { readonly kind: "key_unavailable"; readonly failure: NormalizedFailure };

/**
 * Executes a translated dry-run: translates request into IR and target format,
 * previews the key without leasing, redacts secrets, and returns DryRunResult.
 *
 * @param candidate - Target candidate.
 * @param request - Admitted client gateway request.
 * @param ctx - Attempt context.
 * @param translation - Translation coordinator bundle.
 * @param redactor - Field-aware secret redactor.
 * @returns Dry run evaluation outcome.
 */
export async function executeTranslatedDryRun(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  translation: TranslationCoordinator,
  redactor: Redactor,
): Promise<TranslatedDryRunOutcome> {
  const translated = translation.translateRequest({
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    sourceBody: request.body,
    logicalModel: request.canonicalPublicName,
    targetModel: candidate.model.upstreamModel,
    stream: request.stream,
    targetDefaultMaxTokens: targetDefaultMaxTokensFrom(candidate.model.defaults),
  });

  if (!translated.ok) {
    await request.trace.recordJson("ir_request", {
      ok: false,
      failure: failureJson(translated.error),
    });
    await request.trace.recordJson("translation_failure", failureJson(translated.error));
    return { kind: "skipped", failure: translated.error };
  }

  await request.trace.recordJson("ir_request", {
    ok: true,
    ir: translated.value.irRequest as unknown as JsonValue,
  });
  await request.trace.recordJson("translation_egress", { ok: true });

  const preview = candidate.pool.preview();
  if (preview === undefined) {
    return { kind: "key_unavailable", failure: unavailableFailure() };
  }

  await request.trace.recordJson("key_selection", {
    provider: candidate.provider.name,
    keyName: preview.keyName,
    strategy: candidate.provider.keyStrategy,
  });

  const prepared = translation.prepareTicketRequest(translated.value, {
    providerName: candidate.provider.name,
    baseUrl: candidate.provider.baseUrl,
    clientHeaders: request.headers,
    providerHeaders: candidate.provider.headers,
    providerSecret: preview.secret,
    deadlineMs: ctx.deadlineMs,
    streamIdleMs: ctx.streamIdleMs,
  });

  const redactedHeaders = redactor.redactHeaders(prepared.headers);
  const parsedBody = JSON.parse(utf8Decoder.decode(prepared.body)) as JsonObject;
  const redactedBody = redactor.redactJson(parsedBody) as JsonObject;

  const dryRunProviderRequest: DryRunProviderRequest = {
    method: "POST",
    url: prepared.url,
    headers: redactedHeaders,
    body: redactedBody,
  };

  await request.trace.recordJson("provider_request", dryRunProviderRequest as unknown as JsonValue);

  const dryRunResult: DryRunResult = {
    dryRun: true,
    aptusRequestId: request.aptusRequestId,
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    publicName: request.canonicalPublicName,
    candidate: {
      provider: candidate.provider.name,
      model: candidate.model.upstreamModel,
      key: preview.keyName,
    },
    mutations: prepared.mutations,
    preflight: { ok: true },
    providerRequest: dryRunProviderRequest,
  };

  return { kind: "dry_run", result: dryRunResult };
}
