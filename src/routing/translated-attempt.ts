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
import {
  type AttemptContext,
  acquireLease,
  classifyAbortReason,
  finishAttempt,
  parseJsonBytes,
  recordCancellation,
} from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { dispatchFailure, failureJson, unavailableFailure } from "./failures.ts";
import { spoolResponseBody } from "./spool.ts";

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
  // 1. Request translation (decode -> validate -> preflight -> encode) BEFORE any key lease
  const targetDefaultMaxTokens = candidate.model.defaults?.max_tokens;
  const translated = translation.translateCompleteRequest({
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    sourceBody: request.body,
    logicalModel: request.canonicalPublicName,
    targetModel: candidate.model.upstreamModel,
    targetDefaultMaxTokens: typeof targetDefaultMaxTokens === "number" ? targetDefaultMaxTokens : undefined,
  });

  if (!translated.ok) {
    await ctx.trace.recordJson("ir_request", {
      ok: false,
      failure: failureJson(translated.error),
    });
    await ctx.trace.recordJson("translation_failure", failureJson(translated.error));
    return { kind: "prepare_failed", failure: translated.error };
  }

  await ctx.trace.recordJson("ir_request", {
    ok: true,
    ir: translated.value.irRequest as unknown as JsonValue,
  });
  await ctx.trace.recordJson("translation_egress", { ok: true });

  if (request.signal.aborted) {
    const reason = classifyAbortReason(request.signal);
    if (reason === "timeout") {
      return { kind: "deadline_exceeded" };
    }
    await recordCancellation(ctx, request, "routing", reason);
    return { kind: "cancelled", phase: "routing" };
  }

  // 2. Key acquisition
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

  // 3. Prepare translated provider request
  const prepared = translation.prepareTranslatedProviderRequest({
    providerName: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
    baseUrl: candidate.provider.baseUrl,
    clientHeaders: request.headers,
    providerHeaders: candidate.provider.headers,
    providerSecret: lease.secret,
    body: translated.value.body,
    deadlineMs: ctx.deadlineMs,
    streamIdleMs: ctx.streamIdleMs,
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
    stream: false,
  });
  ctx.observer.observe({
    type: "attempt_started",
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    candidateIndex: candidate.index,
    provider: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
  });

  // 4. Dispatch
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
          false,
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
        false,
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
      false,
    );
    return { kind: "dispatch_failed", failure };
  }

  const dispatchDurationMs = ctx.clock.nowMonotonicMs() - dispatchStarted;

  await ctx.trace.recordJson("provider_response_head", {
    status: response.status,
    headers: response.headers,
    finalUrl: response.finalUrl,
  });

  const observation = ctx.adapters[candidate.provider.protocol].classify(response, ctx.clock.nowWall().getTime());

  // Non-2xx response head follows normal retry/fallback policy (decided by Gateway)
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
    return {
      kind: "response",
      response,
      observation,
      cooldownMs,
      attemptNumber,
    };
  }

  // 5. 2xx success: spool body and translate outcome
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
  const targetDefaultMaxTokens = candidate.model.defaults?.max_tokens;
  const translated = translation.translateCompleteRequest({
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    sourceBody: request.body,
    logicalModel: request.canonicalPublicName,
    targetModel: candidate.model.upstreamModel,
    targetDefaultMaxTokens: typeof targetDefaultMaxTokens === "number" ? targetDefaultMaxTokens : undefined,
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

  const prepared = translation.prepareTranslatedProviderRequest({
    providerName: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
    baseUrl: candidate.provider.baseUrl,
    clientHeaders: request.headers,
    providerHeaders: candidate.provider.headers,
    providerSecret: preview.secret,
    body: translated.value.body,
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
