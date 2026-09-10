/**
 * @fileoverview
 * Dry-run preview executors: resolution without dispatch.
 *
 * Implements native and cross-protocol dry-run previews as candidate-engine
 * strategies. Each executor previews a key without leasing or observing it,
 * constructs the provider request that dispatch would have sent, redacts
 * secrets for the client-visible payload, and assembles the {@link DryRunResult}.
 * Nothing is dispatched, attempts are never counted, and no attempt telemetry
 * is emitted — the dry-run outcome vocabulary (key_unavailable, prepare_failed,
 * dry_run) lets the shared candidate engine apply the same skip, fallback, and
 * terminal policy that governs real dispatch.
 */

import type {
  DryRunProviderRequest,
  DryRunResult,
  GatewayRequest,
  JsonObject,
  JsonValue,
  PreparedProviderRequest,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Redactor } from "../observability/trace/redaction.ts";
import type { TranslationCoordinator } from "../translation/contracts.ts";
import { targetDefaultMaxTokensFrom } from "../translation/coordinator.ts";
import type { AttemptContext } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { failureJson } from "./failures.ts";

const utf8Decoder = new TextDecoder();

/** Normalized dry-run outcome for the candidate engine: key unavailable, preparation failure, or a built preview. */
export type DryRunOutcome =
  | { readonly kind: "key_unavailable" }
  | { readonly kind: "prepare_failed"; readonly failure: NormalizedFailure }
  | { readonly kind: "dry_run"; readonly result: DryRunResult };

/**
 * Previews native (same-protocol) request construction and key selection without dispatching.
 *
 * Mirrors the dispatch attempt sequence up to the dispatch point: previews a key
 * (non-mutating), builds the provider request through the protocol adapter's
 * native preparation, records the mutation pointer list, and assembles the
 * redacted dry-run result.
 *
 * @param candidate - Target candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context supplying adapters, trace, and timeout parameters.
 * @param redactor - Redactor for scrubbing credentials from the returned preview payload.
 * @returns Dry-run outcome: preview result, key unavailable, or preparation failure.
 */
export async function executeNativeDryRun(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  redactor: Redactor,
): Promise<DryRunOutcome> {
  const preview = candidate.pool.preview();
  if (preview === undefined) {
    return { kind: "key_unavailable" };
  }

  await ctx.trace.recordJson("key_selection", {
    provider: candidate.provider.name,
    keyName: preview.keyName,
    strategy: candidate.provider.keyStrategy,
  });

  const adapter = ctx.adapters[request.protocol];
  const prepareResult = adapter.prepareNative({
    baseUrl: candidate.provider.baseUrl,
    protocol: candidate.provider.protocol,
    clientHeaders: request.headers,
    clientBody: request.body,
    mutations: candidate.mutations,
    upstreamModel: candidate.model.upstreamModel,
    providerSecret: preview.secret,
    providerHeaders: candidate.provider.headers,
    deadlineMs: ctx.deadlineMs,
    streamIdleMs: ctx.streamIdleMs,
  });
  if (!prepareResult.ok) {
    return { kind: "prepare_failed", failure: prepareResult.error };
  }

  const prepared = prepareResult.value;
  await ctx.trace.recordJson("mutation", { mutations: prepared.mutations });

  return {
    kind: "dry_run",
    result: await finalizeDryRunPreview(request, candidate, preview.keyName, prepared, redactor),
  };
}

/**
 * Previews cross-protocol translation, target request construction, and key selection without dispatching.
 *
 * Runs the request translation pipeline and builds the ticketed provider request
 * the way dispatch would, then assembles the redacted dry-run result. A failed
 * translation surfaces as a preparation failure so the candidate engine applies
 * its normal skip (unsupported capability) or terminal policy.
 *
 * @param candidate - Target candidate descriptor.
 * @param request - Inbound gateway request.
 * @param ctx - Attempt execution context supplying timeout parameters.
 * @param translation - Translation coordinator running the request pipeline.
 * @param redactor - Redactor for scrubbing credentials from the returned preview payload.
 * @returns Dry-run outcome: preview result, key unavailable, or preparation failure.
 */
export async function executeTranslatedDryRun(
  candidate: CandidateDescriptor,
  request: GatewayRequest,
  ctx: AttemptContext,
  translation: TranslationCoordinator,
  redactor: Redactor,
): Promise<DryRunOutcome> {
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
    return { kind: "prepare_failed", failure: translated.error };
  }

  await request.trace.recordJson("ir_request", {
    ok: true,
    ir: translated.value.irRequest as unknown as JsonValue,
  });
  await request.trace.recordJson("translation_egress", { ok: true });

  const preview = candidate.pool.preview();
  if (preview === undefined) {
    return { kind: "key_unavailable" };
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

  return {
    kind: "dry_run",
    result: await finalizeDryRunPreview(request, candidate, preview.keyName, prepared, redactor),
  };
}

/**
 * Records the redacted provider request in the trace and assembles the {@link DryRunResult}.
 *
 * Shared tail of both dry-run executors: redacts the prepared headers and body,
 * records the client-visible provider request in the trace, and builds the
 * inspection payload describing the candidate, applied mutations, and the exact
 * request that would have been dispatched.
 *
 * @param request - Inbound gateway request whose identity feeds the preview.
 * @param candidate - Candidate whose key and model were selected for the preview.
 * @param keyName - Name of the previewed key.
 * @param prepared - Fully constructed provider request that dispatch would have sent.
 * @param redactor - Redactor for scrubbing credentials from the returned preview payload.
 * @returns The assembled dry-run inspection result.
 */
async function finalizeDryRunPreview(
  request: GatewayRequest,
  candidate: CandidateDescriptor,
  keyName: string,
  prepared: PreparedProviderRequest,
  redactor: Redactor,
): Promise<DryRunResult> {
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

  return {
    dryRun: true,
    aptusRequestId: request.aptusRequestId,
    sourceProtocol: request.protocol,
    targetProtocol: candidate.provider.protocol,
    publicName: request.canonicalPublicName,
    candidate: {
      provider: candidate.provider.name,
      model: candidate.model.upstreamModel,
      key: keyName,
    },
    mutations: prepared.mutations,
    preflight: { ok: true },
    providerRequest: dryRunProviderRequest,
  };
}
