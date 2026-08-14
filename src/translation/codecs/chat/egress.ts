import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import {
  buildChatMessages,
  chatFinishReason,
  chatGenerationFields,
  chatOutcomeWireFields,
  chatResponsesRequestFields,
  chatUsageBody,
  reanchorChatBreakpoints,
} from "../shared.ts";

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
    const build = buildChatMessages(request.items);

    // Re-anchor prompt-cache breakpoints onto the reconstructed message parts.
    reanchorChatBreakpoints(build, requestWireOptions?.promptCacheBreakpoints);

    return {
      model: targetModel,
      messages: build.entries,
      stream: false,
      ...chatGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
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
    let text = "";
    for (const part of outcome.parts) {
      if (part.type === "text") {
        text += part.text;
      }
    }

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
            content: text,
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
