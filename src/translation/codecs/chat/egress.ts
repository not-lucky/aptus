import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";

/**
 * Egress encoder for OpenAI Chat Completions requests and responses.
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

  encodeRequest(request: IrRequest, targetModel: string): JsonObject {
    const messages: JsonObject[] = [];

    for (const item of request.items) {
      if (item.type === "instruction") {
        messages.push({
          role: item.authority,
          content: item.text,
        });
      } else if (item.type === "message") {
        if (item.role === "user") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          messages.push({
            role: "user",
            content: text,
          });
        } else if (item.role === "assistant") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          messages.push({
            role: "assistant",
            content: text,
          });
        }
      }
    }

    return {
      model: targetModel,
      messages,
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

    const finishReason = outcome.finish.reason === "length" ? "length" : "stop";

    // Never fabricate usage: Chat may omit it, so the field is present only when
    // the IR outcome actually reports counters (absence is distinct from zero).
    const usage: JsonObject | undefined =
      outcome.usage === undefined
        ? undefined
        : {
            prompt_tokens: outcome.usage.input,
            completion_tokens: outcome.usage.output,
            ...(outcome.usage.total !== undefined ? { total_tokens: outcome.usage.total } : {}),
          };

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
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
