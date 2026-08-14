import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder, OutcomeWireOptions, RequestWireOptions } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";
import {
  buildResponsesInput,
  chatResponsesRequestFields,
  reanchorResponsesBreakpoints,
  responsesFinishStatus,
  responsesGenerationFields,
  responsesOutcomeWireFields,
  responsesUsageBody,
} from "../shared.ts";

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
    const build = buildResponsesInput(request.items);

    // Re-anchor prompt-cache breakpoints onto the reconstructed input parts.
    reanchorResponsesBreakpoints(build, requestWireOptions?.promptCacheBreakpoints);

    return {
      model: targetModel,
      input: build.entries,
      stream: false,
      ...responsesGenerationFields(request.generation),
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

    const isLength = outcome.finish.reason === "length";
    const status = responsesFinishStatus(outcome.finish.reason);

    // Never fabricate usage: the IR outcome decides presence, and absence is
    // distinct from zero (a Chat source may omit usage entirely). Subdivisions
    // ride in the documented details objects and are never re-added.
    const usage = outcome.usage !== undefined ? responsesUsageBody(outcome.usage) : undefined;

    const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const outputItem: JsonObject = {
      type: "message",
      id: msgId,
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    };

    const body: JsonObject = {
      id: `resp_${outcome.responseId}`,
      object: "response",
      created_at: this.now(),
      status,
      ...(isLength ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      model: outcome.model,
      output: [outputItem],
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
