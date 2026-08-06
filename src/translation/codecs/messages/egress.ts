import type { HeaderMap, JsonObject } from "../../../domain/contracts.ts";
import type { EgressEncoder } from "../../contracts.ts";
import type { IrOutcome, IrRequest } from "../../ir.ts";

/**
 * Egress encoder for Anthropic Messages requests and responses.
 */
export class MessagesEgressEncoder implements EgressEncoder {
  encodeRequest(request: IrRequest, targetModel: string): JsonObject {
    const systemBlocks: JsonObject[] = [];
    const messages: JsonObject[] = [];

    let scanningLeadingInstructions = true;

    for (const item of request.items) {
      if (item.type === "instruction" && scanningLeadingInstructions) {
        systemBlocks.push({
          type: "text",
          text: item.text,
        });
        continue;
      }

      scanningLeadingInstructions = false;

      if (item.type === "message") {
        const contentBlocks: JsonObject[] = [];
        for (const part of item.content) {
          if (part.type === "text") {
            contentBlocks.push({
              type: "text",
              text: part.text,
            });
          }
        }

        // T2: Turn merging for consecutive same-role turns into Messages
        const lastMessage = messages[messages.length - 1];
        if (lastMessage !== undefined && lastMessage.role === item.role) {
          const existingContent = lastMessage.content as JsonObject[];
          existingContent.push(...contentBlocks);
        } else {
          messages.push({
            role: item.role,
            content: contentBlocks,
          });
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: targetModel,
      messages,
      stream: false,
    };

    if (systemBlocks.length > 0) {
      payload.system = systemBlocks;
    }

    return payload as JsonObject;
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

    const stopReason = outcome.finish.reason === "length" ? "max_tokens" : "end_turn";

    // Never fabricate usage: absence is distinct from zero, so the field is
    // omitted unless the IR outcome actually reports counters.
    const usage: JsonObject | undefined =
      outcome.usage === undefined
        ? undefined
        : {
            input_tokens: outcome.usage.input,
            output_tokens: outcome.usage.output,
          };

    const id = outcome.responseId.startsWith("msg_") ? outcome.responseId : `msg_${outcome.responseId}`;

    const body: JsonObject = {
      id,
      type: "message",
      role: "assistant",
      model: outcome.model,
      content: [
        {
          type: "text",
          text,
        },
      ],
      stop_reason: stopReason,
      stop_sequence: outcome.finish.stopSequence ?? null,
      ...(usage !== undefined ? { usage } : {}),
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}
