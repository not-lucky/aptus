/**
 * @fileoverview
 * Shared cross-protocol attempt preparer for translated gateway dispatches.
 *
 * Implements the {@link AttemptPreparer} interface for cross-protocol requests via
 * {@link createTranslatedPreparer}: translates client requests to target provider formats
 * before key acquisition, prepares authenticated provider payloads with the leased key,
 * and classifies response heads using the target provider protocol adapter.
 */

import type { GatewayRequest, JsonValue } from "../domain/contracts.ts";
import type { TranslatedTicket, TranslationCoordinator } from "../translation/contracts.ts";
import { targetDefaultMaxTokensFrom } from "../translation/coordinator.ts";
import type { AttemptPreparer } from "./attempt.ts";
import { failureJson } from "./failures.ts";

/**
 * Creates an {@link AttemptPreparer} driving cross-protocol request translation and preparation.
 *
 * @param translation - Translation coordinator handling request/response transformation.
 * @param stream - Whether the request was admitted for streaming delivery.
 * @returns Attempt preparer yielding {@link TranslatedTicket} instances.
 */
export function createTranslatedPreparer(
  translation: TranslationCoordinator,
  stream: boolean,
): AttemptPreparer<TranslatedTicket> {
  return {
    /**
     * Translates the inbound request into the intermediate representation and target wire payload prior to leasing.
     *
     * @param candidate - Target candidate descriptor.
     * @param request - Inbound gateway request.
     * @param ctx - Attempt execution context.
     * @returns Translated ticket on success, or normalized translation failure on rejection.
     */
    prepareBeforeLease: async (candidate, request, ctx) => {
      const translated = translation.translateRequest({
        sourceProtocol: request.protocol,
        targetProtocol: candidate.provider.protocol,
        sourceBody: request.body,
        logicalModel: request.canonicalPublicName,
        targetModel: candidate.model.upstreamModel,
        stream,
        targetDefaultMaxTokens: targetDefaultMaxTokensFrom(candidate.model.defaults),
      });
      if (!translated.ok) {
        await ctx.trace.recordJson("ir_request", {
          ok: false,
          failure: failureJson(translated.error),
        });
        await ctx.trace.recordJson("translation_failure", failureJson(translated.error));
        return translated;
      }
      await ctx.trace.recordJson("ir_request", {
        ok: true,
        ir: translated.value.irRequest as unknown as JsonValue,
      });
      await ctx.trace.recordJson("translation_egress", { ok: true });
      return { ok: true as const, value: translated.value };
    },

    /**
     * Builds the concrete dispatchable provider request from the translation ticket and acquired key lease.
     *
     * @param candidate - Target candidate descriptor.
     * @param request - Inbound gateway request.
     * @param ctx - Attempt execution context.
     * @param lease - Acquired provider key lease.
     * @param pre - Translation ticket prepared prior to lease acquisition.
     * @returns Result wrapping the prepared provider request.
     */
    buildRequest: (candidate, request: GatewayRequest, ctx, lease, pre) => ({
      ok: true as const,
      value: translation.prepareTicketRequest(pre, {
        providerName: candidate.provider.name,
        baseUrl: candidate.provider.baseUrl,
        clientHeaders: request.headers,
        providerHeaders: candidate.provider.headers,
        providerSecret: lease.secret,
        deadlineMs: ctx.deadlineMs,
        streamIdleMs: ctx.streamIdleMs,
      }),
    }),

    /**
     * Classifies the response head using the target candidate provider protocol adapter.
     *
     * @param candidate - Target candidate descriptor.
     * @param _request - Inbound gateway request.
     * @param ctx - Attempt execution context.
     * @param response - Received provider response head.
     * @returns Classified attempt observation.
     */
    classify: (candidate, _request, ctx, response) =>
      ctx.adapters[candidate.provider.protocol].classify(response, ctx.clock.nowWall().getTime()),
  };
}
