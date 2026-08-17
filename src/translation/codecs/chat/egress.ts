import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
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
 * Egress encoder for OpenAI Chat Completions requests and responses.
 *
 * Request encoding projects IR generation controls and the admitted wire-only
 * sidecar fields onto Chat wire fields; per-part prompt-cache breakpoints are
 * re-anchored onto the reconstructed message parts. Outcome encoding emits
 * usage subdivisions, the moderation result (re-wrapped into the Chat verdict
 * envelope), and the effective service-tier echo.
 */
export class ChatEgressEncoder implements EgressEncoder {
  /**
   * Wall-clock Unix epoch seconds used to synthesize the envelope `created`
   * timestamp. Injectable so tests stay deterministic; defaults to the real clock.
   */
  private readonly now: () => number;

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const messages = buildChatMessages(request.items, markedItems);

    return {
      model: targetModel,
      messages,
      stream: false,
      ...chatGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
      ...chatToolFields(request, requestWireOptions),
    };
  }

  encodeOutcome(
    outcome: IrOutcome,
    outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  } {
    // One coalescing rule for every wire: text runs collapse in
    // partitionOutcomeParts, so Chat cannot drift from Messages and Responses.
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

    // Never fabricate usage: Chat may omit it, so the field is present only when
    // the IR outcome actually reports counters (absence is distinct from zero).
    // Subdivisions ride in the documented details objects and are never
    // re-added to the totals.
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
            // Tool-only outcomes carry null content; any text part (even one
            // concatenating to empty) is the scalar content spelling.
            content: textRuns.length > 0 ? text : toolCalls.length > 0 ? null : "",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      ...(usage !== undefined ? { usage } : {}),
      // The moderation result re-wraps into the Chat verdict envelope and the
      // tier echo passes through; both projections are shared with the
      // streaming client encoder.
      ...chatOutcomeWireFields(outcomeWireOptions),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
