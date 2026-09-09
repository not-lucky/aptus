/**
 * @fileoverview Egress encoder for the OpenAI Responses protocol.
 *
 * Encodes intermediate representation (IR) requests and outcomes onto the OpenAI Responses
 * wire format. Translates generation controls, text verbosity, reasoning effort, prompt
 * cache breakpoints, tool declarations, output partitioning, usage accounting, and
 * sidecar options.
 */
import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import { responsesTextConfig } from "../shared/output-format.ts";
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
 * Encodes IR requests and outcomes onto the OpenAI Responses wire shape.
 */
export class ResponsesEgressEncoder implements EgressEncoder {
  /** Clock supplying whole Unix epoch seconds for envelope created_at timestamps. */
  private readonly now: () => number;

  /**
   * Creates an encoder with an optional clock override.
   *
   * @param now - Function returning current time as whole Unix epoch seconds. Defaults to `Date.now`.
   */
  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  /**
   * Encodes an IR request into an OpenAI Responses request body.
   *
   * Projects transcript items, generation controls, text config, tools, and wire options.
   *
   * @param request - The admitted IR request to encode.
   * @param targetModel - The provider model name for the target.
   * @param requestWireOptions - Optional request wire options captured at ingress.
   * @returns The Responses request body as a JSON object.
   */
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const input = buildResponsesInput(request.items, markedItems, requestWireOptions);

    return {
      model: targetModel,
      input,
      stream: false,
      ...responsesGenerationFields(request.generation),
      ...responsesTextConfig(request.generation, request.output, requestWireOptions),
      ...chatResponsesRequestFields(requestWireOptions),
      ...responsesToolFields(request, requestWireOptions),
    };
  }

  /**
   * Encodes an IR outcome as an OpenAI Responses response envelope.
   *
   * Partitions output parts, maps finish status, and reconstructs usage and sidecar fields.
   *
   * @param outcome - The IR outcome to encode.
   * @param outcomeWireOptions - Optional outcome wire options captured at ingress.
   * @returns Response envelope containing status code, headers, and body.
   */
  encodeOutcome(
    outcome: IrOutcome,
    outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  } {
    const isLength = outcome.finish.reason === "length";
    const isContentFilter = outcome.finish.reason === "content_filter";
    const status = responsesFinishStatus(outcome.finish.reason);

    // Usage absence is distinct from zero, so the field is omitted unless the IR outcome reports counters.
    // A Chat source can omit usage entirely, and subdivisions ride in the documented details objects without
    // ever being re-added to totals.
    const usage = outcome.usage !== undefined ? responsesUsageBody(outcome.usage) : undefined;

    // Output items preserve part order, and a tool-only outcome emits no empty message item. An outcome with
    // no parts still carries one empty message item so the envelope always carries at least one output item.
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
          : segment.type === "refusal"
            ? {
                type: "message",
                id: msgId(),
                status: "completed",
                role: "assistant",
                content: [{ type: "refusal", refusal: segment.text }],
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
      ...(isContentFilter ? { incomplete_details: { reason: "content_filter" } } : {}),
      model: outcome.model,
      output,
      ...(usage !== undefined ? { usage } : {}),
      // The moderation result rides in the singular-verdict form that Responses carries, and the service tier
      // echo passes through. Both projections are shared with the streaming client encoder so complete and
      // streaming paths keep wire parity by structure.
      ...responsesOutcomeWireFields(outcomeWireOptions),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
