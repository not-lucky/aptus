import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";

/**
 * Egress encoder for OpenAI Responses requests and responses.
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

  encodeRequest(request: IrRequest, targetModel: string): JsonObject {
    const input: JsonObject[] = [];

    for (const item of request.items) {
      if (item.type === "instruction") {
        input.push({
          role: item.authority,
          content: [
            {
              type: "input_text",
              text: item.text,
            },
          ],
        });
      } else if (item.type === "message") {
        if (item.role === "user") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          input.push({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text,
              },
            ],
          });
        } else if (item.role === "assistant") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          input.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text,
              },
            ],
          });
        }
      }
    }

    return {
      model: targetModel,
      input,
      stream: false,
    };
  }

  encodeOutcome(outcome: IrOutcome): {
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
    const status = isLength ? "incomplete" : "completed";

    // Never fabricate usage: the IR outcome decides presence, and absence is
    // distinct from zero (a Chat source may omit usage entirely).
    const usage: JsonObject | undefined =
      outcome.usage === undefined
        ? undefined
        : {
            input_tokens: outcome.usage.input,
            output_tokens: outcome.usage.output,
            ...(outcome.usage.total !== undefined ? { total_tokens: outcome.usage.total } : {}),
          };

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
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
