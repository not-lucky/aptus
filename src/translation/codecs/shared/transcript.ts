/**
 * @fileoverview Egress reconstruction of request transcripts, finish reasons, and generation controls.
 *
 * Implements wire projections for OpenAI Chat (`messages`), OpenAI Responses (`input`), and
 * associated envelope facts (generation controls, sidecar fields, outcome partitioning, and finish reasons).
 *
 * Shared between complete and streaming egress encoders to maintain structural parity across
 * response delivery modes.
 */

import type { ProviderFileRef, RequestWireOptions } from "../../contracts.ts";
import type {
  IrFinish,
  IrFinishReason,
  IrGenerationControls,
  IrInputPart,
  IrItem,
  IrOutputPart,
  IrRequest,
  IrToolCall,
  JsonObject,
  JsonValue,
} from "../../ir.ts";

/**
 * Re-anchors prompt cache breakpoints from the sidecar onto projected wire parts.
 *
 * @param parts - Projected wire content parts to mutate in-place.
 * @param itemIndex - Index of the parent IR item.
 * @param markedItems - Set of item indexes flagged with cache breakpoints.
 * @param requestWireOptions - Request sidecar containing breakpoint metadata.
 * @param marker - Cache breakpoint marker object to attach.
 */
function attachPromptCacheBreakpoints(
  parts: Array<Record<string, unknown>>,
  itemIndex: number,
  markedItems: ReadonlySet<number>,
  requestWireOptions: RequestWireOptions | undefined,
  marker: { readonly mode: "explicit" },
): void {
  if (!markedItems.has(itemIndex)) return;
  const breakpoints = (requestWireOptions?.promptCacheBreakpoints ?? []).filter((b) => b.itemIndex === itemIndex);
  for (const b of breakpoints) {
    const targetPart = b.partIndex !== undefined && parts[b.partIndex] ? parts[b.partIndex] : parts[0];
    if (targetPart) targetPart.prompt_cache_breakpoint = marker;
  }
  if (breakpoints.length === 0 && parts[0]) parts[0].prompt_cache_breakpoint = marker;
}

/**
 * Projects a captured provider file reference into a Chat `file` content part.
 *
 * @param ref - Captured provider file reference.
 * @returns Chat wire file part object.
 */
function chatFileRefPart(ref: ProviderFileRef): Record<string, unknown> {
  return {
    type: "file",
    file: {
      file_id: ref.fileId,
      ...(ref.filename ? { filename: ref.filename } : {}),
    },
  };
}

/**
 * Projects a captured provider file reference into a Responses `input_image` or `input_file` part.
 *
 * @param ref - Captured provider file reference.
 * @returns Responses wire content part object.
 */
function responsesFileRefPart(ref: ProviderFileRef): Record<string, unknown> {
  if (ref.mediaKind === "image") {
    return {
      type: "input_image",
      file_id: ref.fileId,
      ...(ref.detail ? { detail: ref.detail } : {}),
    };
  }
  return {
    type: "input_file",
    file_id: ref.fileId,
    ...(ref.filename ? { filename: ref.filename } : {}),
  };
}

/**
 * Projects an IR input part (text, image, document) into a Chat wire content part.
 *
 * @param part - IR input part to project.
 * @returns Chat wire content part, or `undefined` if unsupported on Chat.
 */
function chatPartToWire(part: IrInputPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    if (part.source.type === "url") {
      return {
        type: "image_url",
        image_url: {
          url: part.source.url,
          ...(part.detail ? { detail: part.detail } : {}),
        },
      };
    }
    if (part.source.type === "bytes") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.source.mediaType};base64,${part.source.base64}`,
          ...(part.detail ? { detail: part.detail } : {}),
        },
      };
    }
  } else if (part.type === "document" && part.source.type === "bytes") {
    return {
      type: "file",
      file: {
        file_data: part.source.base64,
        ...(part.name ? { filename: part.name } : {}),
      },
    };
  }
  return undefined;
}

/**
 * Projects an IR message input part into a Responses wire input part (`input_text`, `input_image`, `input_file`).
 *
 * @param part - IR input part to project.
 * @returns Responses wire part object, or `undefined` if unsupported.
 */
function responsesMessagePartToWire(part: IrInputPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") {
    if (part.source.type === "url") {
      return {
        type: "input_image",
        image_url: part.source.url,
        ...(part.detail ? { detail: part.detail } : {}),
      };
    }
    if (part.source.type === "bytes") {
      return {
        type: "input_image",
        image_url: `data:${part.source.mediaType};base64,${part.source.base64}`,
        ...(part.detail ? { detail: part.detail } : {}),
      };
    }
  } else if (part.type === "document") {
    if (part.source.type === "url") {
      return {
        type: "input_file",
        file_url: part.source.url,
        ...(part.name ? { filename: part.name } : {}),
      };
    }
    if (part.source.type === "text") {
      return {
        type: "input_file",
        file_data: Buffer.from(part.source.text, "utf8").toString("base64"),
        ...(part.name ? { filename: part.name } : {}),
      };
    }
    if (part.source.type === "bytes") {
      return {
        type: "input_file",
        file_data: part.source.base64,
        ...(part.name ? { filename: part.name } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Projects an IR tool result input part into a Responses tool result wire part.
 *
 * @param part - IR input part from a tool result.
 * @returns Responses wire part object, or `undefined` if unsupported.
 */
function responsesToolResultPartToWire(part: IrInputPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") {
    if (part.source.type === "url") {
      return { type: "input_image", image_url: part.source.url };
    }
    if (part.source.type === "bytes") {
      return {
        type: "input_image",
        image_url: `data:${part.source.mediaType};base64,${part.source.base64}`,
      };
    }
  } else if (part.type === "document") {
    if (part.source.type === "url") {
      return {
        type: "input_file",
        file_url: part.source.url,
        ...(part.name ? { filename: part.name } : {}),
      };
    }
    if (part.source.type === "text") {
      return {
        type: "input_file",
        file_data: Buffer.from(part.source.text, "utf8").toString("base64"),
        ...(part.name ? { filename: part.name } : {}),
      };
    }
    if (part.source.type === "bytes") {
      return {
        type: "input_file",
        file_data: part.source.base64,
        ...(part.name ? { filename: part.name } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Reconstructs the OpenAI Chat `messages` array from IR items and sidecar options.
 *
 * Concatenates consecutive text parts, interleaves captured file references, attaches
 * prompt cache breakpoints, and maps tool calls and results onto Chat message conventions.
 *
 * @param items - Semantic IR items in transcript order.
 * @param markedItems - Set of item indexes bearing prompt cache breakpoints.
 * @param requestWireOptions - Optional request sidecar carrying file references and breakpoints.
 * @returns Array of Chat wire message objects.
 */
export function buildChatMessages(
  items: readonly IrItem[],
  markedItems: ReadonlySet<number>,
  requestWireOptions?: RequestWireOptions,
): JsonObject[] {
  const messages: JsonObject[] = [];
  const marker = { mode: "explicit" } as const;
  const providerFileRefs = requestWireOptions?.providerFileRefs ?? [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (item === undefined) continue;
    if (item.type === "instruction") {
      messages.push({
        role: item.authority,
        content: markedItems.has(itemIndex)
          ? [{ type: "text", text: item.text, prompt_cache_breakpoint: marker }]
          : item.text,
      });
    } else if (item.type === "message") {
      if (item.role === "assistant") {
        let text = "";
        for (const part of item.content) {
          if (part.type === "text") text += part.text;
        }
        messages.push({
          role: item.role,
          content: markedItems.has(itemIndex) ? [{ type: "text", text, prompt_cache_breakpoint: marker }] : text,
        });
      } else {
        const itemRefs = providerFileRefs
          .filter((r) => r.itemIndex === itemIndex)
          .sort((a, b) => a.partIndex - b.partIndex);
        const hasMediaOrRefs = itemRefs.length > 0 || item.content.some((p) => p.type !== "text");

        if (!hasMediaOrRefs) {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") text += part.text;
          }
          messages.push({
            role: "user",
            content: markedItems.has(itemIndex) ? [{ type: "text", text, prompt_cache_breakpoint: marker }] : text,
          });
        } else {
          const parts: Array<Record<string, unknown>> = [];
          const refBySlot = new Map(itemRefs.map((r) => [r.partIndex, r] as const));
          const totalSlots = item.content.length + itemRefs.length;
          let irIdx = 0;
          for (let s = 0; s < totalSlots; s++) {
            const ref = refBySlot.get(s);
            if (ref !== undefined) {
              parts.push(chatFileRefPart(ref));
            } else {
              const part = item.content[irIdx++];
              if (part === undefined) continue;
              const wire = chatPartToWire(part);
              if (wire !== undefined) parts.push(wire);
            }
          }

          attachPromptCacheBreakpoints(parts, itemIndex, markedItems, requestWireOptions, marker);

          messages.push({ role: "user", content: parts as JsonObject[] });
        }
      }
    } else if (item.type === "tool_call") {
      const callEntry: JsonObject =
        item.call.type === "function"
          ? {
              id: item.call.callId,
              type: "function",
              function: { name: item.call.name, arguments: item.call.argumentsText },
            }
          : {
              id: item.call.callId,
              type: "custom",
              custom: { name: item.call.name, input: item.call.inputText },
            };
      const lastMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
      if (lastMessage !== undefined && lastMessage.role === "assistant") {
        const existing = lastMessage.tool_calls as JsonObject[] | undefined;
        if (existing !== undefined) existing.push(callEntry);
        else lastMessage.tool_calls = [callEntry];
      } else {
        messages.push({ role: "assistant", tool_calls: [callEntry] });
      }
    } else if (item.type === "tool_result") {
      // Preflight admits only single-text results targeting Chat.
      const textPart = item.content[0];
      const text = textPart !== undefined && textPart.type === "text" ? textPart.text : "";
      messages.push({
        role: "tool",
        tool_call_id: item.callId,
        content: markedItems.has(itemIndex) ? [{ type: "text", text, prompt_cache_breakpoint: marker }] : text,
      });
    }
  }
  return messages;
}

/**
 * Reconstructs the OpenAI Responses `input` array from IR items and sidecar options.
 *
 * Maps message turns to `input_text`/`output_text`, tool calls to `function_call`/`custom_tool_call`,
 * and tool results to corresponding output items.
 *
 * @param items - Semantic IR items in transcript order.
 * @param markedItems - Set of item indexes bearing prompt cache breakpoints.
 * @param requestWireOptions - Optional request sidecar carrying file references and breakpoints.
 * @returns Array of Responses wire input items.
 */
export function buildResponsesInput(
  items: readonly IrItem[],
  markedItems: ReadonlySet<number>,
  requestWireOptions?: RequestWireOptions,
): JsonObject[] {
  const input: JsonObject[] = [];
  // Result items name their call kind through the referenced call.
  const callKindByCallId = new Map<string, "function" | "custom">();
  for (const item of items) {
    if (item?.type === "tool_call") callKindByCallId.set(item.call.callId, item.call.type);
  }
  const marker = { mode: "explicit" } as const;
  const providerFileRefs = requestWireOptions?.providerFileRefs ?? [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (item === undefined) continue;
    if (item.type === "instruction") {
      input.push({
        role: item.authority,
        content: [
          {
            type: "input_text",
            text: item.text,
            ...(markedItems.has(itemIndex) ? { prompt_cache_breakpoint: marker } : {}),
          },
        ],
      });
    } else if (item.type === "message") {
      if (item.role === "assistant") {
        let text = "";
        for (const part of item.content) {
          if (part.type === "text") text += part.text;
        }
        input.push({
          type: "message",
          role: item.role,
          content: [
            {
              type: "output_text",
              text,
              ...(markedItems.has(itemIndex) ? { prompt_cache_breakpoint: marker } : {}),
            },
          ],
        });
      } else {
        const itemRefs = providerFileRefs
          .filter((r) => r.itemIndex === itemIndex)
          .sort((a, b) => a.partIndex - b.partIndex);
        const parts: Array<Record<string, unknown>> = [];
        const refBySlot = new Map(itemRefs.map((r) => [r.partIndex, r] as const));
        const totalSlots = item.content.length + itemRefs.length;
        let irIdx = 0;
        for (let s = 0; s < totalSlots; s++) {
          const ref = refBySlot.get(s);
          if (ref !== undefined) {
            parts.push(responsesFileRefPart(ref));
          } else {
            const part = item.content[irIdx++];
            if (part === undefined) continue;
            const wire = responsesMessagePartToWire(part);
            if (wire !== undefined) parts.push(wire);
          }
        }

        attachPromptCacheBreakpoints(parts, itemIndex, markedItems, requestWireOptions, marker);

        input.push({
          type: "message",
          role: "user",
          content: parts as JsonObject[],
        });
      }
    } else if (item.type === "tool_call") {
      input.push(
        item.call.type === "function"
          ? {
              type: "function_call",
              call_id: item.call.callId,
              name: item.call.name,
              arguments: item.call.argumentsText,
              status: "completed",
            }
          : {
              type: "custom_tool_call",
              call_id: item.call.callId,
              name: item.call.name,
              input: item.call.inputText,
            },
      );
    } else if (item.type === "tool_result") {
      let output: JsonValue;
      if (item.content.length === 0) {
        output = "";
      } else if (item.content.length === 1 && item.content[0]?.type === "text") {
        output = item.content[0].text;
      } else {
        const outParts: JsonObject[] = [];
        for (const part of item.content) {
          const wire = responsesToolResultPartToWire(part);
          if (wire !== undefined) outParts.push(wire as JsonObject);
        }
        output = outParts;
      }
      input.push(
        callKindByCallId.get(item.callId) === "custom"
          ? { type: "custom_tool_call_output", call_id: item.callId, output }
          : { type: "function_call_output", call_id: item.callId, output },
      );
    }
  }
  return input;
}

/**
 * Projects IR generation controls onto Chat request wire fields (`temperature`, `top_p`, `stop`, etc.).
 *
 * @param generation - IR generation controls specification.
 * @returns Record of Chat wire generation fields.
 */
export function chatGenerationFields(generation: IrGenerationControls | undefined): Record<string, JsonValue> {
  if (generation === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  if (generation.temperature !== undefined) fields.temperature = generation.temperature;
  if (generation.topP !== undefined) fields.top_p = generation.topP;
  if (generation.maxOutputTokens !== undefined) fields.max_completion_tokens = generation.maxOutputTokens;
  if (generation.verbosity !== undefined) fields.verbosity = generation.verbosity;
  if (generation.reasoning?.effort !== undefined) fields.reasoning_effort = generation.reasoning.effort;
  if (generation.stopSequences !== undefined) {
    fields.stop = generation.stopSequences.length === 1 ? generation.stopSequences[0] : [...generation.stopSequences];
  }
  return fields;
}

/**
 * Projects IR generation controls onto Responses request wire fields (`temperature`, `reasoning`, etc.).
 *
 * @param generation - IR generation controls specification.
 * @returns Record of Responses wire generation fields.
 */
export function responsesGenerationFields(generation: IrGenerationControls | undefined): Record<string, JsonValue> {
  if (generation === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  if (generation.temperature !== undefined) fields.temperature = generation.temperature;
  if (generation.topP !== undefined) fields.top_p = generation.topP;
  if (generation.maxOutputTokens !== undefined) fields.max_output_tokens = generation.maxOutputTokens;
  if (generation.reasoning?.effort !== undefined) fields.reasoning = { effort: generation.reasoning.effort };
  return fields;
}

/**
 * Projects IR generation controls onto Anthropic Messages request wire fields (`temperature`, `stop_sequences`).
 *
 * @param generation - IR generation controls specification.
 * @returns Record of Messages wire generation fields.
 */
export function messagesGenerationFields(generation: IrRequest["generation"]): Record<string, JsonValue> {
  if (generation === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  if (generation.temperature !== undefined) fields.temperature = generation.temperature;
  if (generation.topP !== undefined) fields.top_p = generation.topP;
  if (generation.stopSequences !== undefined) fields.stop_sequences = [...generation.stopSequences];
  return fields;
}

/**
 * Projects sidecar options (`metadata.user_id`, `service_tier: "auto"`) onto Messages request fields.
 *
 * @param options - Request sidecar containing wire-only options.
 * @returns Record of Messages wire fields.
 */
export function messagesWireOptionFields(options: RequestWireOptions | undefined): Record<string, JsonValue> {
  if (options === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  const userId = options.metadata?.user_id;
  if (typeof userId === "string") {
    fields.metadata = { user_id: userId };
  }
  if (options.serviceTier === "auto") {
    fields.service_tier = "auto";
  }
  return fields;
}

/**
 * Ordered segment of an IR outcome: consecutive text parts coalesced into a single string,
 * a tool call, or a refusal.
 */
export type OutcomeSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: IrToolCall }
  | { readonly type: "refusal"; readonly text: string };

/**
 * Partitions IR output parts into ordered segments, coalescing contiguous text runs.
 *
 * @param parts - IR output parts in emission order.
 * @returns Ordered array of OutcomeSegments.
 */
export function partitionOutcomeParts(parts: readonly IrOutputPart[]): OutcomeSegment[] {
  const segments: OutcomeSegment[] = [];
  let textRun: string | undefined;
  for (const part of parts) {
    if (part.type === "text") {
      textRun = (textRun ?? "") + part.text;
      continue;
    }
    if (part.type === "refusal") {
      if (textRun !== undefined) {
        segments.push({ type: "text", text: textRun });
        textRun = undefined;
      }
      segments.push({ type: "refusal", text: part.text ?? "" });
      continue;
    }
    if (textRun !== undefined) {
      segments.push({ type: "text", text: textRun });
      textRun = undefined;
    }
    if (part.type === "tool_call") segments.push({ type: "tool_call", call: part.call });
  }
  if (textRun !== undefined) segments.push({ type: "text", text: textRun });
  return segments;
}

/**
 * Narrows an admitted IR finish reason into a Chat `finish_reason` wire string.
 *
 * @param reason - Admitted IR finish reason.
 * @returns Chat wire finish reason (`stop`, `length`, `tool_calls`, `content_filter`).
 * @throws {Error} If an unsupported finish reason reaches egress.
 */
export function chatFinishReason(reason: IrFinishReason): "length" | "stop" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "stop":
    case "refusal":
      // Chat has no refusal finish value: the refusal text rides in the message `refusal` field
      // and the finish is the natural stop.
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "context_limit":
      // Unreachable in admitted directions: preflight rejects `finish-context-limit` before any
      // Chat egress runs. The throw keeps an unadmitted value from silently narrowing to "stop".
      // TODO(fix): The error message is missing the offending reason value; include `reason` in
      // the template literal so the operator sees which value was unadmitted.
      throw new Error(`OpenAI Chat does not support finish reason `);
  }
}

/**
 * Maps an admitted IR finish reason to a Responses envelope status (`completed` or `incomplete`).
 *
 * @param reason - Admitted IR finish reason.
 * @returns Responses envelope status.
 */
export function responsesFinishStatus(reason: IrFinishReason): "completed" | "incomplete" {
  return reason === "length" || reason === "content_filter" ? "incomplete" : "completed";
}

/**
 * Maps an IR finish descriptor to an Anthropic Messages `stop_reason` wire string.
 *
 * @param finish - IR finish descriptor.
 * @returns Messages wire stop reason (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`).
 * @throws {Error} If an unsupported finish reason reaches egress.
 */
export function messagesStopReason(finish: IrFinish): string {
  if (finish.reason === "tool_calls") return "tool_use";
  if (finish.reason === "length") return "max_tokens";
  if (finish.stopSequence !== undefined && finish.reason === "stop") return "stop_sequence";
  if (finish.reason === "stop") return "end_turn";
  throw new Error(`Anthropic Messages does not support finish reason '${finish.reason}'`);
}
