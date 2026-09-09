/**
 * @fileoverview Egress encoder for the OpenAI Chat Completions protocol.
 *
 * Translates intermediate representation (IR) requests and outcomes onto the
 * OpenAI Chat Completions wire format. Request encoding projects generation controls,
 * transcript items, tools, and sidecar options into the Chat schema. Outcome encoding
 * reconstructs completion envelopes, choices, finish reasons, usage, and moderation facts.
 *
 * Encoding is total over preflight-validated IR structures; usage counters are emitted
 * only when reported by the IR, and text runs and refusals are coalesced consistently.
 */

import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { chatOutputFormatFields } from "../shared/output-format.ts";
import { chatToolFields } from "../shared/tool-fields.ts";
import {
  buildChatMessages,
  chatFinishReason,
  chatGenerationFields,
  partitionOutcomeParts,
} from "../shared/transcript.ts";
import { chatUsageBody } from "../shared/usage.ts";
import { chatOutcomeWireFields, chatResponsesRequestFields } from "../shared/wire-options.ts";

/**
 * Encodes IR requests and outcomes onto the OpenAI Chat Completions wire format.
 *
 * Implements {@link EgressEncoder} for `openai-chat`. Delegates transcript assembly,
 * tool mapping, output format, and usage serialization to shared codec helpers while
 * assembling the final request and response envelopes.
 */
export class ChatEgressEncoder implements EgressEncoder {
  /** Clock supplying whole Unix epoch seconds for envelope `created` timestamps. */
  private readonly now: () => number;

  /**
   * Creates a Chat egress encoder with an optional clock override.
   *
   * @param now - Factory returning whole Unix epoch seconds, defaulting to system time.
   */
  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  /**
   * Encodes an admitted IR request into an OpenAI Chat Completions request body.
   *
   * Reconstructs messages with prompt cache breakpoints, projects generation parameters,
   * tool configurations, and output formats. Sets `stream: false`.
   *
   * @param request - Preflight-validated IR request to encode.
   * @param targetModel - Provider-facing model name for the target payload.
   * @param requestWireOptions - Optional wire sidecars captured during ingress.
   * @returns Serialized Chat Completions JSON request body.
   */
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const messages = buildChatMessages(request.items, markedItems, requestWireOptions);

    return {
      model: targetModel,
      messages,
      stream: false,
      ...chatGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
      ...chatToolFields(request, requestWireOptions),
      ...chatOutputFormatFields(request.output, requestWireOptions),
    };
  }

  /**
   * Encodes an IR outcome into an OpenAI Chat Completions response envelope.
   *
   * Partitions output parts into text runs and tool calls, maps finish reasons,
   * formats usage counters if present, and projects wire sidecar options.
   *
   * @param outcome - Preflight-validated IR outcome to encode.
   * @param outcomeWireOptions - Optional wire options including moderation and service tier.
   * @returns HTTP response payload containing status 200, JSON headers, and the completion body.
   */
  encodeOutcome(
    outcome: IrOutcome,
    outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  } {
    // Collapse text runs through one shared rule so Chat cannot drift from Messages and Responses.
    const segments = partitionOutcomeParts(outcome.parts);
    const textRuns = segments.flatMap((segment) => (segment.type === "text" ? [segment.text] : []));
    const text = textRuns.join("");
    const toolCalls: JsonObject[] = segments.flatMap((segment): JsonObject[] =>
      segment.type !== "tool_call"
        ? []
        : [
            segment.call.type === "function"
              ? {
                  id: segment.call.callId,
                  type: "function",
                  function: { name: segment.call.name, arguments: segment.call.argumentsText },
                }
              : {
                  id: segment.call.callId,
                  type: "custom",
                  custom: { name: segment.call.name, input: segment.call.inputText },
                },
          ],
    );

    const finishReason = chatFinishReason(outcome.finish.reason);
    // Coalesce every refusal text because preflight keeps translated refusals unreachable here.
    const refusalTexts = outcome.parts.flatMap((p) => (p.type === "refusal" ? [p.text ?? ""] : []));
    const refusalPart = refusalTexts.length > 0 ? { text: refusalTexts.join("") } : undefined;

    // Keep usage absent when the IR reports no counters because absence differs from zero.
    // Subdivisions travel inside the documented details objects and never inflate the totals.
    const usage = outcome.usage !== undefined ? chatUsageBody(outcome.usage) : undefined;

    const body: JsonObject = {
      id: `chatcmpl-${outcome.responseId}`,
      object: "chat.completion",
      created: this.now(),
      model: outcome.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            // Carry null content for tool-only and refusal outcomes and scalar content otherwise.
            content: textRuns.length > 0 ? text : refusalPart !== undefined || toolCalls.length > 0 ? null : "",
            ...(refusalPart !== undefined ? { refusal: refusalPart.text ?? "" } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      ...(usage !== undefined ? { usage } : {}),
      // Reuse the shared projection for the verdict envelope and the tier echo.
      ...chatOutcomeWireFields(outcomeWireOptions),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
