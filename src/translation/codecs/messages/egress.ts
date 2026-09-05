import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { buildMessagesRequestBody } from "../shared/messages-request.ts";
import { messagesStopReason, partitionOutcomeParts } from "../shared/transcript.ts";
import { messagesUsageBody } from "../shared/usage.ts";

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
    // Content blocks preserve part order; an outcome with no parts still
    // carries one empty text block. Preflight rejects every non-C/R refusal
    // before encoding, so the refusal arm below is unreachable in translated
    // turns; it is an invariant assertion that fails loudly on preflight drift.
    const content: JsonObject[] = partitionOutcomeParts(outcome.parts).map((segment): JsonObject => {
      if (segment.type === "refusal") {
        throw new Error("Anthropic Messages does not support refusal content parts");
      }
      return segment.type === "text"
        ? { type: "text", text: segment.text }
        : {
            type: "tool_use",
            id: segment.call.callId,
            name: segment.call.name,
            // Preflight admits only function calls with parsed arguments into
            // an M client; the parse fallback keeps the encoder total.
            input:
              segment.call.type === "function"
                ? (segment.call.arguments ?? JSON.parse(segment.call.argumentsText))
                : JSON.parse(segment.call.inputText),
          };
    });
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    // A matched stop sequence is echoed only with its own stop reason so the
    // M framing stays valid; the M wire pairs a non-null stop_sequence with
    // stop_reason "stop_sequence" and nothing else.
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
      content,
      stop_reason: stopReason,
      stop_sequence: stopReason === "stop_sequence" ? (outcome.finish.stopSequence ?? null) : null,
      ...(usage !== undefined ? { usage } : {}),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
