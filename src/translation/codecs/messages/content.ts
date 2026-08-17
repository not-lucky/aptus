import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { PromptCacheBreakpoint } from "../../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../../failures.ts";
import type { IrAssistantPart, IrInputPart, IrItem, IrToolCall, JsonObject, NonEmpty } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { firstUnknownKey } from "../shared/controls.ts";
import {
  encryptedContentFailure,
  MESSAGES_HOSTED_BLOCK_TYPES,
  MESSAGES_SERVER_TOOL_USE_NAMES,
} from "../shared/hosted-tools.ts";

const MESSAGES_CACHE_CONTROL_TTLS = new Set(["5m", "1h"]);

export interface MessagesTextRunEntry {
  readonly text: string;
  readonly markerPath?: string;
  readonly marker?: unknown;
}

export function parseMessagesCacheControl(path: string, value: unknown): Result<void, NormalizedFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest(`${path} cache_control must be an object`);
  }
  const marker = value as Record<string, unknown>;
  const extra = firstUnknownKey(marker, ["type", "ttl"]);
  if (extra !== undefined) return invalidRequest(`${path} cache_control.${extra} is not recognized`);
  if (marker.type !== "ephemeral") return invalidRequest(`${path} cache_control.type must be 'ephemeral'`);
  if (marker.ttl !== undefined && (typeof marker.ttl !== "string" || !MESSAGES_CACHE_CONTROL_TTLS.has(marker.ttl))) {
    return invalidRequest(`${path} cache_control.ttl must be '5m' or '1h'`);
  }
  return ok(undefined);
}

export function messagesHostedBlockFailure(block: unknown): NormalizedFailure | undefined {
  const encrypted = encryptedContentFailure(block);
  if (encrypted !== undefined) return encrypted;
  if (block === undefined || block === null || typeof block !== "object") return undefined;
  const type = (block as Record<string, unknown>).type;
  if (typeof type !== "string") return undefined;
  const capability = MESSAGES_HOSTED_BLOCK_TYPES[type];
  return capability === undefined ? undefined : unsupportedCapabilityFailure(capability);
}

export function messagesServerToolUseFailure(block: Record<string, unknown>): NormalizedFailure {
  const capability = typeof block.name === "string" ? MESSAGES_SERVER_TOOL_USE_NAMES[block.name] : undefined;
  return unsupportedCapabilityFailure(capability ?? "unknown-content-item");
}

export function messagesToolUseCallerFailure(caller: unknown): NormalizedFailure | undefined {
  if (caller === undefined) return undefined;
  if (typeof caller !== "object" || caller === null || Array.isArray(caller)) {
    return invalidRequestFailure("tool_use caller must be an object when present");
  }
  const callerRecord = caller as Record<string, unknown>;
  if (callerRecord.type === "direct") {
    const extra = firstUnknownKey(callerRecord, ["type"]);
    return extra === undefined
      ? undefined
      : invalidRequestFailure(`tool_use caller.${extra} is not documented on type 'direct'`);
  }
  if (callerRecord.type === "code_execution_20250825" || callerRecord.type === "code_execution_20260120") {
    return unsupportedCapabilityFailure("hosted-code-execution");
  }
  return invalidRequestFailure(`tool_use caller type '${String(callerRecord.type)}' is not documented`);
}

/** Parses the shared Messages `tool_use` block for request and outcome paths. */
export function parseMessagesToolUseBlock(
  block: Record<string, unknown>,
  context: string,
): Result<IrToolCall, NormalizedFailure> {
  if (typeof block.id !== "string" || block.id.trim() === "") {
    return invalidRequest(`${context}: id must be a non-empty string`);
  }
  if (typeof block.name !== "string" || block.name.trim() === "") {
    return invalidRequest(`${context}: name must be a non-empty string`);
  }
  if (typeof block.input !== "object" || block.input === null || Array.isArray(block.input)) {
    return invalidRequest(`${context}: input must be a JSON object`);
  }
  const callerFailure = messagesToolUseCallerFailure(block.caller);
  if (callerFailure !== undefined) return failure(callerFailure);
  return ok({
    type: "function",
    callId: block.id,
    name: block.name,
    argumentsText: JSON.stringify(block.input),
    arguments: block.input as JsonObject,
  });
}

export function flushMessagesTextRun(
  run: MessagesTextRunEntry[],
  items: IrItem[],
  role: "user" | "assistant",
  breakpoints: PromptCacheBreakpoint[],
): Result<void, NormalizedFailure> {
  if (run.length === 0) return ok(undefined);
  const runItemIndex = items.length;
  const content = run.map((entry) => ({ type: "text", text: entry.text }));
  items.push(
    role === "user"
      ? { type: "message", role: "user", content: content as unknown as NonEmpty<IrInputPart> }
      : { type: "message", role: "assistant", content: content as unknown as NonEmpty<IrAssistantPart> },
  );
  for (let pIdx = 0; pIdx < run.length; pIdx++) {
    const entry = run[pIdx];
    if (entry?.marker === undefined || entry.markerPath === undefined) continue;
    const markerResult = parseMessagesCacheControl(entry.markerPath, entry.marker);
    if (!markerResult.ok) return markerResult;
    breakpoints.push({ itemIndex: runItemIndex, partIndex: pIdx });
  }
  run.length = 0;
  return ok(undefined);
}

/**
 * Decodes one Messages user or assistant content array. The role is data, not
 * a second walker: shared text-run/marker logic is followed by the only
 * role-specific block admissions (tool_result for user, tool_use for assistant).
 */
export function decodeMessagesContent(
  content: unknown,
  role: "user" | "assistant",
  messageIndex: number,
  items: IrItem[],
  breakpoints: PromptCacheBreakpoint[],
): Result<void, NormalizedFailure> {
  if (!Array.isArray(content)) {
    return invalidRequest(`Messages ${role} message [${messageIndex}] missing string or array content`);
  }
  const textRun: MessagesTextRunEntry[] = [];
  const itemIndex = items.length;
  for (let partIndex = 0; partIndex < content.length; partIndex++) {
    const block = content[partIndex] as Record<string, unknown>;
    const blockPath = `message [${messageIndex}] block [${partIndex}]`;

    if (block?.type === "text" && typeof block.text === "string") {
      const hosted = messagesHostedBlockFailure(block);
      if (hosted !== undefined) return failure(hosted);
      if (role === "assistant" && block.signature !== undefined) {
        return unsupportedCapability("reasoning-signature");
      }
      textRun.push({
        text: block.text,
        ...(block.cache_control !== undefined ? { markerPath: blockPath, marker: block.cache_control } : {}),
      });
      continue;
    }

    const flushResult = flushMessagesTextRun(textRun, items, role, breakpoints);
    if (!flushResult.ok) return flushResult;
    // Tool-use input is client JSON, not a hosted result container: its own
    // property names (including `encrypted_content`) are ordinary tool data.
    // Run hosted recognition on the block before generic assistant branches,
    // but only after admitting this client-managed tool surface.
    if (!(role === "assistant" && block?.type === "tool_use")) {
      const hosted = messagesHostedBlockFailure(block);
      if (hosted !== undefined) return failure(hosted);
    }

    if (role === "user") {
      if (block?.type === "image") return unsupportedCapability("image-url");
      if (block?.type === "document") return unsupportedCapability("document-inline-bytes");
      if (block?.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || block.tool_use_id.trim() === "") {
          return invalidRequest(`${blockPath}: tool_use_id must be a non-empty string`);
        }
        if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
          return invalidRequest(`${blockPath}: is_error must be a boolean when present`);
        }
        const resultParts: IrInputPart[] = [];
        if (typeof block.content === "string") {
          resultParts.push({ type: "text", text: block.content });
        } else if (Array.isArray(block.content)) {
          for (const rawElement of block.content) {
            const element = rawElement as Record<string, unknown>;
            if (element?.type === "text" && typeof element.text === "string") {
              resultParts.push({ type: "text", text: element.text });
            } else if (element?.type === "image") {
              return unsupportedCapability("image-url");
            } else if (element?.type === "document") {
              return unsupportedCapability("document-inline-bytes");
            } else {
              const elementHosted = messagesHostedBlockFailure(element);
              if (elementHosted !== undefined) return failure(elementHosted);
              return unsupportedCapability("unknown-content-item");
            }
          }
        } else if (block.content !== undefined) {
          return invalidRequest(`${blockPath}: content must be a string or an array`);
        }
        const resultItemIndex = items.length;
        items.push({
          type: "tool_result",
          callId: block.tool_use_id,
          isError: block.is_error === true,
          content: resultParts,
        });
        if (block.cache_control !== undefined) {
          const markerResult = parseMessagesCacheControl(blockPath, block.cache_control);
          if (!markerResult.ok) return markerResult;
          breakpoints.push({ itemIndex: resultItemIndex });
        }
        continue;
      }
      return unsupportedCapability("unknown-content-item");
    }

    if (block?.type === "tool_use") {
      const callResult = parseMessagesToolUseBlock(block, blockPath);
      if (!callResult.ok) return callResult;
      const callItemIndex = items.length;
      items.push({ type: "tool_call", call: callResult.value });
      if (block.cache_control !== undefined) {
        const markerResult = parseMessagesCacheControl(blockPath, block.cache_control);
        if (!markerResult.ok) return markerResult;
        breakpoints.push({ itemIndex: callItemIndex });
      }
      continue;
    }
    if (block?.type === "thinking") return unsupportedCapability("readable-reasoning");
    if (block?.type === "redacted_thinking") return unsupportedCapability("redacted-reasoning");
    if (block?.type === "server_tool_use") return failure(messagesServerToolUseFailure(block));
    return unsupportedCapability("unknown-content-item");
  }

  const finalFlushResult = flushMessagesTextRun(textRun, items, role, breakpoints);
  if (!finalFlushResult.ok) return finalFlushResult;
  if (items.length === itemIndex) {
    return invalidRequest(`Messages ${role} message [${messageIndex}] has empty content`);
  }
  return ok(undefined);
}
