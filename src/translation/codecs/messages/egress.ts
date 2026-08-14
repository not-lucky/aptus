import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { buildMessagesRequestBody, messagesStopReason, messagesUsageBody } from "../shared.ts";

/**
 * Egress encoder for Anthropic Messages requests and responses.
 *
 * Request encoding delegates to {@link buildMessagesRequestBody}, which
 * projects IR generation controls and the T2 wire-only sidecar fields onto
 * Messages wire fields: metadata collapses to the single user_id entry, only
 * the `auto` service tier maps, and prompt-cache breakpoints are re-anchored
 * as per-block `cache_control` markers with declared TTL loss. The required
 * `max_tokens` is resolved by the coordinator (user value first, model
 * default as fallback) and is intentionally not emitted here.
 *
 * Outcome encoding reconstructs Anthropic usage accounting from the IR totals
 * (`input_tokens = input - cacheRead - cacheWrite`) and echoes a matched stop
 * sequence with the `stop_sequence` stop reason.
 */
export class MessagesEgressEncoder implements EgressEncoder {
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject {
    return buildMessagesRequestBody(request, targetModel, false, requestWireOptions);
  }

  encodeOutcome(
    outcome: IrOutcome,
    _outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  } {
    let text = "";
    for (const part of outcome.parts) {
      if (part.type === "text") {
        text += part.text;
      }
    }

    // A matched stop sequence is echoed with its own stop reason so the M
    // framing stays valid; other reasons keep their natural spelling.
    const stopReason = messagesStopReason(outcome.finish);

    // Never fabricate usage: absence is distinct from zero, so the field is
    // omitted unless the IR outcome actually reports counters. The base input
    // excludes the cached subdivisions because M's `input_tokens` counts only
    // tokens after the last cache breakpoint (subdivisions are never re-added).
    const usage = outcome.usage !== undefined ? messagesUsageBody(outcome.usage) : undefined;

    const id = outcome.responseId.startsWith("msg_") ? outcome.responseId : `msg_${outcome.responseId}`;

    const body: JsonObject = {
      id,
      type: "message",
      role: "assistant",
      model: outcome.model,
      content: [
        {
          type: "text",
          text,
        },
      ],
      stop_reason: stopReason,
      stop_sequence: outcome.finish.stopSequence ?? null,
      ...(usage !== undefined ? { usage } : {}),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
