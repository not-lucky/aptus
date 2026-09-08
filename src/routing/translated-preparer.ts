import type { GatewayRequest, JsonValue } from "../domain/contracts.ts";
import type { TranslatedTicket, TranslationCoordinator } from "../translation/contracts.ts";
import { targetDefaultMaxTokensFrom } from "../translation/coordinator.ts";
import type { AttemptPreparer } from "./attempt.ts";
import { failureJson } from "./failures.ts";

/**
 * Shared cross-protocol attempt preparer behind the unified dispatch seam.
 *
 * Single owner of the translate-then-prepare order for every translated path:
 * `translateRequest` (decode, validate, preflight, encode, finalize) before
 * any key lease, ticketed provider preparation after, and target-protocol
 * classification. The complete and stream attempts differ only in the `stream`
 * selector, so a wrong-variant call is unrepresentable.
 *
 * @param translation - Translation coordinator bundle.
 * @param stream - Delivery mode, threaded through translate and prepare by construction.
 * @returns An {@link AttemptPreparer} producing translation tickets.
 */
export function createTranslatedPreparer(
  translation: TranslationCoordinator,
  stream: boolean,
): AttemptPreparer<TranslatedTicket> {
  return {
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
    classify: (candidate, _request, ctx, response) =>
      ctx.adapters[candidate.provider.protocol].classify(response, ctx.clock.nowWall().getTime()),
  };
}
