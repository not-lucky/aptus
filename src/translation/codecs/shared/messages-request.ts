import type { RequestWireOptions } from "../../contracts.ts";
import type { IrBinarySource, IrDocumentSource, IrRequest, JsonObject, JsonValue } from "../../ir.ts";
import { messagesOutputConfigFields } from "./output-format.ts";
import { messagesToolFields } from "./tool-fields.ts";
import { messagesGenerationFields, messagesWireOptionFields } from "./transcript.ts";

/**
 * Maps an IR media source onto the Anthropic wire spelling. The gateway_file
 * arm is unreachable for admitted requests: preflight rejects gateway-file
 * references into Messages before any egress runs (capability
 * gateway-file-reference), so reaching it means the preflight invariant is
 * broken. Failing loudly there beats silently dropping the part or fabricating
 * content on the upstream wire.
 */
function messagesImageSource(source: IrBinarySource): Record<string, unknown> {
  switch (source.type) {
    case "url":
      return { type: "url", url: source.url };
    case "bytes":
      return { type: "base64", media_type: source.mediaType, data: source.base64 };
    case "gateway_file":
      throw new Error("gateway_file image source reached Messages egress; preflight must reject it first");
  }
}

/** Maps an IR document source onto the Anthropic wire spelling (see {@link messagesImageSource}). */
function messagesDocumentSource(source: IrDocumentSource): Record<string, unknown> {
  switch (source.type) {
    case "url":
      return { type: "url", url: source.url };
    case "text":
      return { type: "text", media_type: "text/plain", data: source.text };
    case "bytes":
      return { type: "base64", media_type: source.mediaType, data: source.base64 };
    case "gateway_file":
      throw new Error("gateway_file document source reached Messages egress; preflight must reject it first");
  }
}

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
        if (part === undefined) continue;
        let block: Record<string, unknown>;
        if (part.type === "text") {
          block = { type: "text", text: part.text };
        } else if (part.type === "image") {
          block = { type: "image", source: messagesImageSource(part.source) };
        } else if (part.type === "document") {
          block = {
            type: "document",
            source: messagesDocumentSource(part.source),
            ...(part.name !== undefined ? { title: part.name } : {}),
          };
        } else {
          continue;
        }
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
      } else if (item.content.length > 0) {
        block.content = item.content.map((part) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          }
          if (part.type === "image") {
            return { type: "image", source: messagesImageSource(part.source) };
          }
          return {
            type: "document",
            source: messagesDocumentSource(part.source),
            ...(part.name !== undefined ? { title: part.name } : {}),
          };
        });
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
