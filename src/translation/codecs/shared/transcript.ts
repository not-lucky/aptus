import type { RequestWireOptions } from "../../contracts.ts";
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
 * Egress reconstruction of the three transcript shapes and the finish/usage
 * envelope facts that ride with them.
 *
 * Every builder is shared verbatim by a protocol's complete egress encoder and
 * its streaming encoder, so complete-vs-stream wire parity is structural rather
 * than a convention the two paths have to keep in sync. IR item order is
 * preserved on every wire; coalescing rules (consecutive text parts, finish
 * reason narrowing) live here once instead of once per encoder.
 */

/**
 * Builds the OpenAI Chat `messages` array from IR items: instructions keep
 * their authority role, user/assistant text parts concatenate per message,
 * tool calls attach to the issuing assistant message (synthesizing a
 * tool-only assistant message when none precedes), and tool results become
 * `role:"tool"` messages.
 */
export function buildChatMessages(items: readonly IrItem[], markedItems: ReadonlySet<number>): JsonObject[] {
  const messages: JsonObject[] = [];
  const marker = { mode: "explicit" } as const;
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
      let text = "";
      for (const part of item.content) {
        if (part.type === "text") text += part.text;
      }
      messages.push({
        role: item.role,
        content: markedItems.has(itemIndex) ? [{ type: "text", text, prompt_cache_breakpoint: marker }] : text,
      });
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
 * Builds the OpenAI Responses `input` array from IR items (instructions keep
 * their authority role; user parts become `input_text`, assistant parts
 * `output_text`; tool calls become function_call/custom_tool_call items and
 * tool results the matching output items).
 */
export function buildResponsesInput(items: readonly IrItem[], markedItems: ReadonlySet<number>): JsonObject[] {
  const input: JsonObject[] = [];
  // Result items name their call kind through the referenced call: a result
  // for a custom call becomes custom_tool_call_output, otherwise
  // function_call_output.
  const callKindByCallId = new Map<string, "function" | "custom">();
  for (const item of items) {
    if (item?.type === "tool_call") callKindByCallId.set(item.call.callId, item.call.type);
  }
  const marker = { mode: "explicit" } as const;
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
      let text = "";
      for (const part of item.content) {
        if (part.type === "text") text += part.text;
      }
      input.push({
        type: "message",
        role: item.role,
        content: [
          {
            type: item.role === "assistant" ? "output_text" : "input_text",
            text,
            ...(markedItems.has(itemIndex) ? { prompt_cache_breakpoint: marker } : {}),
          },
        ],
      });
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
      // Tool result content is text-only by decode: zero parts emit the empty
      // string, one text part the bare string, several the content array.
      let output: JsonValue;
      if (item.content.length === 0) {
        output = "";
      } else if (item.content.length === 1 && item.content[0]?.type === "text") {
        output = item.content[0].text;
      } else {
        output = item.content
          .filter((part): part is Extract<IrInputPart, { type: "text" }> => part.type === "text")
          .map((part) => ({ type: "input_text", text: part.text }));
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
 * Projects IR generation controls onto Chat wire fields:
 * temperature / top_p / max_completion_tokens / stop / verbosity / reasoning_effort.
 * A single stop sequence round-trips in its scalar spelling; sets use the array form.
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
 * Projects IR generation controls onto Responses wire fields:
 * temperature / top_p / max_output_tokens / text.verbosity / reasoning.effort.
 */
export function responsesGenerationFields(generation: IrGenerationControls | undefined): Record<string, JsonValue> {
  if (generation === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  if (generation.temperature !== undefined) fields.temperature = generation.temperature;
  if (generation.topP !== undefined) fields.top_p = generation.topP;
  if (generation.maxOutputTokens !== undefined) fields.max_output_tokens = generation.maxOutputTokens;
  if (generation.verbosity !== undefined) fields.text = { verbosity: generation.verbosity };
  if (generation.reasoning?.effort !== undefined) fields.reasoning = { effort: generation.reasoning.effort };
  return fields;
}

/**
 * Projects IR generation controls onto Messages wire fields: temperature /
 * top_p / stop_sequences. `max_tokens` is coordinator-resolved and deliberately
 * omitted here so the resolution rule lives in exactly one place.
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
 * Projects the T2 wire-only sidecar fields onto Messages wire fields: metadata
 * collapses to the single `user_id` entry (every other key and the legacy C/R
 * `user` string are declared loss), and only the `auto` service tier maps.
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
 * One segment of a partitioned IR outcome: either a run of consecutive text
 * parts coalesced into one string, or a single tool call.
 */
export type OutcomeSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: IrToolCall };

/**
 * Splits IR output parts into ordered segments, coalescing every maximal run
 * of consecutive text parts into one segment and keeping each tool call as its
 * own segment. Shared by all three complete egress encoders and the Chat
 * outcome encoder so every wire orders and coalesces output identically.
 */
export function partitionOutcomeParts(parts: readonly IrOutputPart[]): OutcomeSegment[] {
  const segments: OutcomeSegment[] = [];
  let textRun: string | undefined;
  for (const part of parts) {
    if (part.type === "text") {
      textRun = (textRun ?? "") + part.text;
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
 * Narrows an admitted IR finish reason onto the Chat `finish_reason` wire:
 * token-limit and tool-call finishes keep their own spellings and every other
 * admitted reason is the natural stop. Shared verbatim by the complete egress
 * and the client stream encoder so complete-vs-stream parity is structural.
 */
export function chatFinishReason(reason: IrFinishReason): "length" | "stop" | "tool_calls" {
  return reason === "length" ? "length" : reason === "tool_calls" ? "tool_calls" : "stop";
}

/**
 * Narrows an admitted IR finish reason onto the Responses envelope status:
 * token-limit maps to `incomplete` (with `incomplete_details`) and every other
 * admitted reason to `completed`. Shared verbatim by the complete egress and
 * the client stream encoder so complete-vs-stream parity is structural.
 */
export function responsesFinishStatus(reason: IrFinishReason): "completed" | "incomplete" {
  return reason === "length" ? "incomplete" : "completed";
}

/**
 * Maps an IR finish onto the Anthropic Messages `stop_reason` wire value: a
 * tool-call finish maps to `tool_use`, a matched stop sequence echoes with the
 * `stop_sequence` reason so the M framing stays valid, token-limit keeps its
 * own spelling, and every other admitted reason maps to the natural
 * end-of-turn. Shared verbatim by the complete egress and the client stream
 * encoder so complete-vs-stream parity is structural.
 */
export function messagesStopReason(finish: IrFinish): string {
  if (finish.reason === "tool_calls") return "tool_use";
  return finish.reason === "length"
    ? "max_tokens"
    : finish.stopSequence !== undefined && finish.reason === "stop"
      ? "stop_sequence"
      : "end_turn";
}
