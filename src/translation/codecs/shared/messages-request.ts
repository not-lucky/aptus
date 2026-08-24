import type { RequestWireOptions } from "../../contracts.ts";
import type { IrInputPart, IrRequest, JsonObject, JsonValue } from "../../ir.ts";
import { messagesOutputConfigFields } from "./output-format.ts";
import { messagesToolFields } from "./tool-fields.ts";
import { messagesGenerationFields, messagesWireOptionFields } from "./transcript.ts";

/**
 * Builds the Anthropic Messages request body. The assembler is separate from
 * transcript builders because it performs M-specific system extraction,
 * adjacent-turn merging, and per-block cache marker attachment.
 */
export function buildMessagesRequestBody(
  request: IrRequest,
  targetModel: string,
  stream: boolean,
  requestWireOptions?: RequestWireOptions,
): JsonObject {
  const systemBlocks: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const blocksByAnchor = new Map<string, Record<string, unknown>>();
  let scanningLeadingInstructions = true;

  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex++) {
    const item = request.items[itemIndex];
    if (item === undefined) continue;
    if (item.type === "instruction" && scanningLeadingInstructions) {
      const block: Record<string, unknown> = { type: "text", text: item.text };
      systemBlocks.push(block);
      blocksByAnchor.set(`${itemIndex}`, block);
      continue;
    }
    scanningLeadingInstructions = false;

    if (item.type === "message") {
      const contentBlocks: Array<Record<string, unknown>> = [];
      for (let partIndex = 0; partIndex < item.content.length; partIndex++) {
        const part = item.content[partIndex];
        if (part === undefined || part.type !== "text") continue;
        const block: Record<string, unknown> = { type: "text", text: part.text };
        contentBlocks.push(block);
        blocksByAnchor.set(`${itemIndex}:${partIndex}`, block);
      }
      const lastMessage = messages[messages.length - 1] as { role: unknown; content: unknown } | undefined;
      if (lastMessage !== undefined && lastMessage.role === item.role) {
        (lastMessage.content as Array<Record<string, unknown>>).push(...contentBlocks);
      } else {
        messages.push({ role: item.role, content: contentBlocks });
      }
      continue;
    }

    if (item.type === "tool_call") {
      const call = item.call;
      const block: Record<string, unknown> = {
        type: "tool_use",
        id: call.callId,
        name: call.name,
        input:
          call.type === "function" ? (call.arguments ?? JSON.parse(call.argumentsText)) : JSON.parse(call.inputText),
      };
      blocksByAnchor.set(`${itemIndex}`, block);
      const lastMessage = messages[messages.length - 1] as { role: unknown; content: unknown } | undefined;
      if (lastMessage !== undefined && lastMessage.role === "assistant") {
        (lastMessage.content as Array<Record<string, unknown>>).push(block);
      } else {
        messages.push({ role: "assistant", content: [block] });
      }
      continue;
    }

    if (item.type === "tool_result") {
      const block: Record<string, unknown> = { type: "tool_result", tool_use_id: item.callId };
      if (item.isError === true) block.is_error = true;
      if (item.content.length === 1 && item.content[0]?.type === "text") {
        block.content = item.content[0].text;
      } else if (item.content.length > 1) {
        block.content = item.content
          .filter((part): part is Extract<IrInputPart, { type: "text" }> => part.type === "text")
          .map((part) => ({ type: "text", text: part.text }));
      }
      blocksByAnchor.set(`${itemIndex}`, block);
      const lastMessage = messages[messages.length - 1] as { role: unknown; content: unknown } | undefined;
      if (lastMessage !== undefined && lastMessage.role === "user") {
        (lastMessage.content as Array<Record<string, unknown>>).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    }
  }

  for (const anchor of requestWireOptions?.promptCacheBreakpoints ?? []) {
    const block =
      (anchor.partIndex !== undefined ? blocksByAnchor.get(`${anchor.itemIndex}:${anchor.partIndex}`) : undefined) ??
      blocksByAnchor.get(`${anchor.itemIndex}`);
    if (block !== undefined) block.cache_control = { type: "ephemeral" };
  }

  const payload: Record<string, JsonValue> = {
    model: targetModel,
    messages: messages as JsonValue,
    stream,
    ...messagesGenerationFields(request.generation),
    ...messagesWireOptionFields(requestWireOptions),
    ...messagesToolFields(request, requestWireOptions),
    ...messagesOutputConfigFields(request.output),
  };
  if (systemBlocks.length > 0) payload.system = systemBlocks as JsonValue;
  return payload as JsonObject;
}
