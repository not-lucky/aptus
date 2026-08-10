import type {
  AttemptObservation,
  GatewayRequest,
  GatewayResult,
  JsonValue,
  ProviderResponse,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { TranslationCoordinator } from "../translation/contracts.ts";
import { createSseDecoder, createSseEncoder } from "../translation/sse.ts";
import { TranslatedStreamPump } from "../translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../translation/stream-state.ts";
import {
  type AttemptContext,
  acquireLease,
  classifyAbortReason,
  finishAttempt,
  parseJsonBytes,
  recordCancellation,
} from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { dispatchFailure, failureJson } from "./failures.ts";
import { relayTranslatedStream } from "./translated-stream-relay.ts";

const utf8Encoder = new TextEncoder();

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
 * Pre-dispatch decode/validation/preflight failures return with zero lease and zero dispatch.
 * Early decode/frame errors before client headers are emitted are treated as dispatch failures,
 * permitting normal candidate retry and fallback.
 */
export async function executeTranslatedStreamAttempt(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  translation: TranslationCoordinator,
): Promise<TranslatedStreamAttemptOutcome> {
  // 1. Request translation (decode -> validate -> preflight -> encode) BEFORE any key lease
  const targetDefaultMaxTokens = candidate.model.defaults?.max_tokens;
  const translated = translation.translateStreamRequest({
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

  // 3. Prepare translated provider request with stream: true
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
    stream: true,
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
    stream: true,
  });
  ctx.observer.observe({
    type: "attempt_started",
    aptusRequestId: request.aptusRequestId,
    attemptNumber,
    candidateIndex: candidate.index,
    provider: candidate.provider.name,
    targetProtocol: candidate.provider.protocol,
  });

  // 4. Dispatch with cancellation awareness
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

  // 5. 2xx success: Bootstrap stream decoding before committing client headers
  const sessionBundle = translation.createStreamSession({
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    logicalModel: request.canonicalPublicName,
    sourceWireOptions: translated.value.sourceWireOptions,
  });

  const sseDecoder = createSseDecoder();
  const sseEncoder = createSseEncoder();
  const stateMachine = createIrStreamStateMachine({
    expectedResponseId: sessionBundle.session.responseId,
    expectedModel: sessionBundle.session.model,
  });

  const providerSink = ctx.trace.openBytes("provider_stream");
  const irEventsSink = ctx.trace.openBytes("ir_events");

  const pump = new TranslatedStreamPump(
    sseDecoder,
    sseEncoder,
    sessionBundle.providerDecoder,
    stateMachine,
    sessionBundle.clientEncoder,
    (evt) => {
      void irEventsSink.append(utf8Encoder.encode(`${JSON.stringify(evt)}\n`));
    },
  );

  const discardTraceSinks = async (): Promise<void> => {
    await providerSink.discard().catch(() => undefined);
    await irEventsSink.discard().catch(() => undefined);
  };

  const reader = response.body.getReader();
  const initialClientChunks: Uint8Array[] = [];
  let isInitialComplete = false;

  while (initialClientChunks.length === 0 && !isInitialComplete) {
    let chunkResult: { done: boolean; value?: Uint8Array };
    try {
      chunkResult = await reader.read();
    } catch (readErr) {
      await discardTraceSinks();
      const failure = dispatchFailure(readErr);
      finishAttempt(
        ctx,
        request,
        candidate,
        lease,
        attemptNumber,
        { result: failure.category, beforeClientBytes: true },
        response.status,
        dispatchDurationMs,
        false,
      );
      return { kind: "dispatch_failed", failure };
    }

    if (chunkResult.done) {
      isInitialComplete = true;

      const finishResult = pump.finish();
      if (!finishResult.ok) {
        await discardTraceSinks();
        finishAttempt(
          ctx,
          request,
          candidate,
          lease,
          attemptNumber,
          { result: finishResult.error.category, beforeClientBytes: true },
          response.status,
          dispatchDurationMs,
          false,
        );
        return { kind: "dispatch_failed", failure: finishResult.error };
      }
      initialClientChunks.push(...finishResult.value);

      if (!pump.isTerminal()) {
        await discardTraceSinks();
        const failure = {
          category: "stream_interrupted" as const,
          message: "Upstream stream ended abruptly before reaching a terminal state",
          retryable: false,
        };
        finishAttempt(
          ctx,
          request,
          candidate,
          lease,
          attemptNumber,
          { result: "stream_interrupted", beforeClientBytes: true },
          response.status,
          dispatchDurationMs,
          false,
        );
        return { kind: "dispatch_failed", failure };
      }

      break;
    }

    // Chunk received from provider
    if (chunkResult.value !== undefined && chunkResult.value.length > 0) {
      void providerSink.append(chunkResult.value);

      const pushResult = pump.pushBytes(chunkResult.value);
      if (!pushResult.ok) {
        await discardTraceSinks();
        await reader.cancel().catch(() => undefined);
        finishAttempt(
          ctx,
          request,
          candidate,
          lease,
          attemptNumber,
          { result: pushResult.error.category, beforeClientBytes: true },
          response.status,
          dispatchDurationMs,
          false,
        );
        return { kind: "dispatch_failed", failure: pushResult.error };
      }
      initialClientChunks.push(...pushResult.value);
    }
  }

  // 6. Bootstrap succeeded: construct streaming relay and transfer ownership
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
    providerName: candidate.provider.name,
    canonicalName: request.canonicalPublicName,
    pricing: candidate.model.pricing ?? null,
    requestSignal: request.signal,
    reader,
    pump,
    providerSink,
    irEventsSink,
    initialClientChunks,
    isInitialComplete,
  });

  return {
    kind: "stream_ready",
    result: relayResult,
  };
}
