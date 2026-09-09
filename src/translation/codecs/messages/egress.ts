/**
 * @fileoverview Egress encoder for the Anthropic Messages protocol.
 *
 * Translates intermediate representation (IR) requests and outcomes onto the
 * Anthropic Messages wire format. Request encoding delegates to {@link buildMessagesRequestBody}
 * to project generation controls, transcript items, and request sidecar options. Outcome encoding
 * projects content blocks, stop reasons, and Anthropic-specific usage token breakdowns.
 *
 * Refusal content parts are prohibited on Messages and rejected. Usage counters are emitted
 * only when reported by the IR outcome.
 */

import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { buildMessagesRequestBody } from "../shared/messages-request.ts";
import { messagesStopReason, partitionOutcomeParts } from "../shared/transcript.ts";
import { messagesUsageBody } from "../shared/usage.ts";

/**
 * Encodes IR requests and outcomes onto the Anthropic Messages wire format.
 *
 * Implements {@link EgressEncoder} for `anthropic-messages`. Projects requests via
 * {@link buildMessagesRequestBody} and formats outcomes into Messages JSON responses.
 */
export class MessagesEgressEncoder implements EgressEncoder {
  /**
   * Encodes an admitted IR request into an Anthropic Messages request body.
   *
   * @param request - Preflight-validated IR request to encode.
   * @param targetModel - Provider-facing model name.
   * @param requestWireOptions - Optional request-side wire options.
   * @returns Serialized Messages JSON request body with `stream: false`.
   */
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject {
    return buildMessagesRequestBody(request, targetModel, false, requestWireOptions);
  }

  /**
   * Encodes an IR outcome into an Anthropic Messages response envelope.
   *
   * @param outcome - Preflight-validated IR outcome to encode.
   * @param _outcomeWireOptions - Unused by Messages outcome encoding.
   * @returns HTTP response payload containing status 200, JSON headers, and the response body.
   * @throws Error if an untranslatable refusal content part is encountered.
   */
  encodeOutcome(
    outcome: IrOutcome,
    _outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  } {
    // Content blocks preserve part order, and an outcome with no parts still carries one empty text block.
    // Preflight rejects every refusal that did not originate from a Chat or Responses source before encoding,
    // so the refusal arm below is unreachable in translated turns and the throw is an invariant assertion
    // that fails loudly on preflight drift.
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
            // Preflight admits only function calls with parsed arguments into a Messages client, so the parse
            // fallback keeps the encoder total for admitted input without hiding a missing parse.
            input:
              segment.call.type === "function"
                ? (segment.call.arguments ?? JSON.parse(segment.call.argumentsText))
                : JSON.parse(segment.call.inputText),
          };
    });
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    // A matched stop sequence is echoed only with its own stop reason so the Messages framing stays valid.
    // The Messages wire pairs a non-null stop sequence with the stop sequence reason and nothing else.
    const stopReason = messagesStopReason(outcome.finish);

    // Usage absence is distinct from zero, so the field is omitted unless the IR outcome reports counters.
    // The base input excludes the cached subdivisions because the Messages `input_tokens` field counts only
    // tokens after the last cache breakpoint, and subdivisions are never re-added to totals.
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
