import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { responsesToolFields } from "../shared/tool-fields.ts";
import {
  buildResponsesInput,
  partitionOutcomeParts,
  responsesFinishStatus,
  responsesGenerationFields,
} from "../shared/transcript.ts";
import { responsesUsageBody } from "../shared/usage.ts";
import { chatResponsesRequestFields, responsesOutcomeWireFields } from "../shared/wire-options.ts";

/**
 * Egress encoder for OpenAI Responses requests and responses.
 *
 * Request encoding projects IR generation controls (including `text.verbosity`
 * and `reasoning.effort`) and the admitted wire-only sidecar fields onto
 * Responses wire fields; per-part prompt-cache breakpoints are re-anchored onto
 * the reconstructed input parts. Outcome encoding emits usage subdivisions,
 * the moderation result in Responses' singular-verdict form, and the effective
 * service-tier echo.
 */
export class ResponsesEgressEncoder implements EgressEncoder {
  /**
   * Wall-clock Unix epoch seconds used to synthesize the envelope `created_at`
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
    const input = buildResponsesInput(request.items, markedItems);

    return {
      model: targetModel,
      input,
      stream: false,
      ...responsesGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
      ...responsesToolFields(request, requestWireOptions),
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
    const isLength = outcome.finish.reason === "length";
    const status = responsesFinishStatus(outcome.finish.reason);

    // Never fabricate usage: the IR outcome decides presence, and absence is
    // distinct from zero (a Chat source may omit usage entirely). Subdivisions
    // ride in the documented details objects and are never re-added.
    const usage = outcome.usage !== undefined ? responsesUsageBody(outcome.usage) : undefined;

    // Output items preserve part order and a tool-only outcome emits no empty
    // message item; an outcome with no parts still carries one.
    const msgId = (): string => `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const output: JsonObject[] = partitionOutcomeParts(outcome.parts).map(
      (segment): JsonObject =>
        segment.type === "text"
          ? {
              type: "message",
              id: msgId(),
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: segment.text, annotations: [] }],
            }
          : segment.call.type === "function"
            ? {
                type: "function_call",
                call_id: segment.call.callId,
                name: segment.call.name,
                arguments: segment.call.argumentsText,
                status: "completed",
              }
            : {
                type: "custom_tool_call",
                call_id: segment.call.callId,
                name: segment.call.name,
                input: segment.call.inputText,
              },
    );
    if (output.length === 0) {
      output.push({
        type: "message",
        id: msgId(),
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      });
    }

    const body: JsonObject = {
      id: `resp_${outcome.responseId}`,
      object: "response",
      created_at: this.now(),
      status,
      ...(isLength ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      model: outcome.model,
      output,
      ...(usage !== undefined ? { usage } : {}),
      // The moderation result rides in Responses' singular-verdict form and the
      // tier echo passes through; both projections are shared with the
      // streaming client encoder.
      ...responsesOutcomeWireFields(outcomeWireOptions),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
