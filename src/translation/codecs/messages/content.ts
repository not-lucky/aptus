/**
 * @fileoverview Block-level content parsing for the Anthropic Messages protocol.
 *
 * Implements content block parsers for text, images, documents, tool calls, and tool results
 * shared across complete and streaming ingress decoders. Normalizes content blocks into IR items
 * and extracts per-part prompt cache breakpoints.
 *
 * Enforces fail-closed validation: unmapped, provider-owned, and encrypted blocks fail
 * with their exact matrix capability row rather than being silently dropped.
 */

import { randomUUID } from "node:crypto";
import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { PromptCacheBreakpoint } from "../../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../../failures.ts";
import type { IrAssistantPart, IrCitation, IrInputPart, IrItem, IrToolCall, JsonObject, NonEmpty } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { firstUnknownKey } from "../shared/controls.ts";
import {
  encryptedContentFailure,
  MESSAGES_HOSTED_BLOCK_TYPES,
  MESSAGES_SERVER_TOOL_USE_NAMES,
} from "../shared/hosted-tools.ts";
import { M_IMAGE_MEDIA_TYPES, validateHttpsUrl } from "../shared/media.ts";

/** Documented cache-control time-to-live literals supported on the Messages wire. */
const MESSAGES_CACHE_CONTROL_TTLS = new Set(["5m", "1h"]);

/**
 * Validates an Anthropic Messages `cache_control` marker object.
 *
 * @param path - Diagnostic path prefix for error attribution.
 * @param value - Raw `cache_control` value to validate.
 * @returns Result indicating successful validation or an invalid request failure.
 */
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

/**
 * Detects hosted, encrypted, or provider-owned blocks and returns the corresponding failure.
 *
 * @param block - Content block to inspect.
 * @returns Normalized failure if the block represents an unsupported capability, or undefined.
 */
export function messagesHostedBlockFailure(block: unknown): NormalizedFailure | undefined {
  const encrypted = encryptedContentFailure(block);
  if (encrypted !== undefined) return encrypted;
  if (block === undefined || block === null || typeof block !== "object") return undefined;
  const type = (block as Record<string, unknown>).type;
  if (typeof type !== "string") return undefined;
  const capability = MESSAGES_HOSTED_BLOCK_TYPES[type];
  return capability === undefined ? undefined : unsupportedCapabilityFailure(capability);
}

/**
 * Builds an unsupported capability failure for a Messages `server_tool_use` block.
 *
 * @param block - Decoded `server_tool_use` block object.
 * @returns Normalized failure matching the specific server tool or unknown content row.
 */
export function messagesServerToolUseFailure(block: Record<string, unknown>): NormalizedFailure {
  const capability = typeof block.name === "string" ? MESSAGES_SERVER_TOOL_USE_NAMES[block.name] : undefined;
  return unsupportedCapabilityFailure(capability ?? "unknown-content-item");
}

/**
 * Validates the `caller` field of a Messages `tool_use` block.
 *
 * @param caller - Raw caller specification from the tool use block.
 * @returns Normalized failure if the caller is invalid or provider-hosted, or undefined.
 */
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

/**
 * Parses a response-side Messages citation entry into an IR citation structure.
 *
 * @param cit - Decoded citation object.
 * @returns Result containing the parsed IR citation or capability rejection.
 */
export function parseMessagesCitation(cit: Record<string, unknown>): Result<IrCitation, NormalizedFailure> {
  if (cit.type === "web_search_result_location") {
    if (typeof cit.url === "string") {
      return ok({
        source: {
          type: "url",
          url: cit.url,
          ...(typeof cit.title === "string" ? { title: cit.title } : {}),
        },
        ...(typeof cit.cited_text === "string" ? { quotedText: cit.cited_text } : {}),
      });
    }
    return unsupportedCapability("url-citation-source");
  }
  if (cit.type === "char_location" || cit.type === "page_location" || cit.type === "content_block_location") {
    // These locator variants are response-side only here (request-side locators never route
    // through this parser), and the response side always carries file_id. A file_id citation is a
    // provider resource handle, and a locator without one is out of schema: neither can become an
    // IR citation without fabricating identity, so both fail closed on their own rows.
    if (typeof cit.file_id === "string" && cit.file_id.length > 0) {
      return unsupportedCapability("file-document-citation-source");
    }
    return unsupportedCapability("citation-document-location");
  }
  return unsupportedCapability("url-citation-source");
}

/**
 * Rejects request-side text block citations with their corresponding capability failure.
 *
 * @param path - Diagnostic path prefix for error attribution.
 * @param citations - Raw citations value to inspect.
 * @returns Normalized failure if citations are present, or undefined.
 */
export function messagesRequestCitationsFailure(path: string, citations: unknown): NormalizedFailure | undefined {
  if (citations === undefined || citations === null) return undefined;
  if (!Array.isArray(citations)) {
    return invalidRequestFailure(`${path} citations must be an array when present`);
  }
  const capability =
    (citations[0] as Record<string, unknown> | undefined)?.type === "web_search_result_location"
      ? "url-citation-source"
      : "file-document-citation-source";
  // The message names the row: client error envelopes surface the capability only through the
  // message text, matching the preflight citation gates.
  return unsupportedCapabilityFailure(
    capability,
    `${path}: request-side text citations are not translatable (${capability})`,
  );
}

/**
 * Parses a Messages `tool_use` block into an IR tool call structure.
 *
 * @param block - Decoded tool use block object.
 * @param context - Diagnostic path prefix for error attribution.
 * @returns Result containing the parsed IR tool call or normalized failure.
 */
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

/**
 * Parses a Messages `image` block into an IR input part.
 *
 * @param block - Decoded image block object.
 * @param context - Diagnostic path prefix for error attribution.
 * @returns Result containing the parsed IR image part or validation failure.
 */
export function parseMessagesImageBlock(
  block: Record<string, unknown>,
  context: string,
): Result<IrInputPart, NormalizedFailure> {
  const source = block.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return invalidRequest(`${context}: source must be an object`);
  }
  const srcObj = source as Record<string, unknown>;
  if (srcObj.type === "url") {
    if (typeof srcObj.url !== "string" || !validateHttpsUrl(srcObj.url)) {
      return invalidRequest(`${context}: image URL must be an absolute HTTPS URL`);
    }
    return ok({ type: "image", source: { type: "url", url: srcObj.url } });
  }
  if (srcObj.type === "base64") {
    // Messages pins its inline image media types to exactly this subset; anything else is outside
    // the closed-world schema and cannot be admitted even though a Chat or Responses data URI
    // would carry it onward.
    if (typeof srcObj.media_type !== "string" || !M_IMAGE_MEDIA_TYPES.has(srcObj.media_type)) {
      return invalidRequest(`${context}: image media_type must be one of jpeg, png, gif, webp`);
    }
    if (typeof srcObj.data !== "string" || srcObj.data.trim() === "") {
      return invalidRequest(`${context}: image data must be a non-empty base64 string`);
    }
    return ok({
      type: "image",
      source: { type: "bytes", mediaType: srcObj.media_type, base64: srcObj.data },
    });
  }
  return invalidRequest(`${context}: unsupported image source type '${String(srcObj.type)}'`);
}

/**
 * Parses a Messages `document` block into an IR input part.
 *
 * @param block - Decoded document block object.
 * @param context - Diagnostic path prefix for error attribution.
 * @returns Result containing the parsed IR document part or capability failure.
 */
export function parseMessagesDocumentBlock(
  block: Record<string, unknown>,
  context: string,
): Result<IrInputPart, NormalizedFailure> {
  if (block.context !== undefined) {
    return unsupportedCapability("document-context-title");
  }
  if (block.citations !== undefined) {
    return unsupportedCapability("file-document-citation-source");
  }
  const source = block.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return invalidRequest(`${context}: source must be an object`);
  }
  const srcObj = source as Record<string, unknown>;
  if (srcObj.type === "content") {
    return unsupportedCapability("document-inline-bytes");
  }
  const title = typeof block.title === "string" ? block.title : undefined;
  if (srcObj.type === "url") {
    if (typeof srcObj.url !== "string" || !validateHttpsUrl(srcObj.url)) {
      return invalidRequest(`${context}: document URL must be an absolute HTTPS URL`);
    }
    return ok({
      type: "document",
      documentId: randomUUID(),
      source: { type: "url", url: srcObj.url },
      ...(title !== undefined ? { name: title } : {}),
    });
  }
  if (srcObj.type === "text") {
    if (typeof srcObj.data !== "string") {
      return invalidRequest(`${context}: text document data must be a string`);
    }
    return ok({
      type: "document",
      documentId: randomUUID(),
      source: { type: "text", mediaType: "text/plain", text: srcObj.data },
      ...(title !== undefined ? { name: title } : {}),
    });
  }
  if (srcObj.type === "base64") {
    if (srcObj.media_type !== "application/pdf") {
      return unsupportedCapability("document-inline-bytes");
    }
    if (typeof srcObj.data !== "string" || srcObj.data.trim() === "") {
      return invalidRequest(`${context}: document data must be a non-empty base64 string`);
    }
    return ok({
      type: "document",
      documentId: randomUUID(),
      source: { type: "bytes", mediaType: "application/pdf", base64: srcObj.data },
      ...(title !== undefined ? { name: title } : {}),
    });
  }
  return invalidRequest(`${context}: unsupported document source type '${String(srcObj.type)}'`);
}

/**
 * Decodes a Messages user or assistant content array into normalized IR items.
 *
 * Groups consecutive text blocks, parses multimodal and tool blocks, and anchors
 * validated prompt cache breakpoints to their corresponding IR item and part positions.
 *
 * @param content - Raw message content array or string.
 * @param role - Role of the enclosing message (`user` or `assistant`).
 * @param messageIndex - Index of the message within the request.
 * @param items - Accumulator array for decoded IR items.
 * @param breakpoints - Accumulator array for captured prompt cache breakpoints.
 * @returns Result indicating success or a normalized decoding failure.
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
  let userParts: IrInputPart[] = [];
  let userMarkers: Array<{ partIndex: number; markerPath: string; marker: unknown }> = [];
  let assistantParts: IrAssistantPart[] = [];
  let assistantMarkers: Array<{ partIndex: number; markerPath: string; marker: unknown }> = [];
  const itemIndex = items.length;

  // Flushing moves the accumulated run into the IR item list and then validates the run's cache
  // markers, so a marker is only recorded once its part is guaranteed to exist. Each run records
  // the item index it will occupy before appending, because flushing changes the list length.
  const flushUserParts = (): Result<void, NormalizedFailure> => {
    if (userParts.length === 0) return ok(undefined);
    const runItemIndex = items.length;
    items.push({
      type: "message",
      role: "user",
      content: userParts as unknown as NonEmpty<IrInputPart>,
    });
    for (const m of userMarkers) {
      const markerResult = parseMessagesCacheControl(m.markerPath, m.marker);
      if (!markerResult.ok) return markerResult;
      breakpoints.push({ itemIndex: runItemIndex, partIndex: m.partIndex });
    }
    userParts = [];
    userMarkers = [];
    return ok(undefined);
  };

  const flushAssistantParts = (): Result<void, NormalizedFailure> => {
    if (assistantParts.length === 0) return ok(undefined);
    const runItemIndex = items.length;
    items.push({
      type: "message",
      role: "assistant",
      content: assistantParts as unknown as NonEmpty<IrAssistantPart>,
    });
    for (const m of assistantMarkers) {
      const markerResult = parseMessagesCacheControl(m.markerPath, m.marker);
      if (!markerResult.ok) return markerResult;
      breakpoints.push({ itemIndex: runItemIndex, partIndex: m.partIndex });
    }
    assistantParts = [];
    assistantMarkers = [];
    return ok(undefined);
  };

  for (let partIndex = 0; partIndex < content.length; partIndex++) {
    const block = content[partIndex] as Record<string, unknown>;
    const blockPath = `message [${messageIndex}] block [${partIndex}]`;

    if (block?.type === "text" && typeof block.text === "string") {
      const hosted = messagesHostedBlockFailure(block);
      if (hosted !== undefined) return failure(hosted);
      const citationsFailure = messagesRequestCitationsFailure(blockPath, block.citations);
      if (citationsFailure !== undefined) return failure(citationsFailure);
      if (role === "assistant" && block.signature !== undefined) {
        return unsupportedCapability("reasoning-signature");
      }
      if (role === "user") {
        userParts.push({ type: "text", text: block.text });
        if (block.cache_control !== undefined) {
          userMarkers.push({ partIndex: userParts.length - 1, markerPath: blockPath, marker: block.cache_control });
        }
      } else {
        assistantParts.push({ type: "text", text: block.text });
        if (block.cache_control !== undefined) {
          assistantMarkers.push({
            partIndex: assistantParts.length - 1,
            markerPath: blockPath,
            marker: block.cache_control,
          });
        }
      }
      continue;
    }

    // Tool-use input is client JSON, not a hosted result container: its own property names
    // (including `encrypted_content`) are ordinary tool data. Run hosted recognition on the block
    // before the generic assistant branches, but only after admitting this client-managed tool
    // surface.
    if (!(role === "assistant" && block?.type === "tool_use")) {
      const hosted = messagesHostedBlockFailure(block);
      if (hosted !== undefined) return failure(hosted);
    }

    if (role === "user") {
      if (block?.type === "image") {
        const imgRes = parseMessagesImageBlock(block, blockPath);
        if (!imgRes.ok) return imgRes;
        userParts.push(imgRes.value);
        if (block.cache_control !== undefined) {
          userMarkers.push({ partIndex: userParts.length - 1, markerPath: blockPath, marker: block.cache_control });
        }
        continue;
      }
      if (block?.type === "document") {
        const docRes = parseMessagesDocumentBlock(block, blockPath);
        if (!docRes.ok) return docRes;
        userParts.push(docRes.value);
        if (block.cache_control !== undefined) {
          userMarkers.push({ partIndex: userParts.length - 1, markerPath: blockPath, marker: block.cache_control });
        }
        continue;
      }
      if (block?.type === "tool_result") {
        // A tool result ends the running text part run, because the result becomes its own IR
        // item rather than a part of the user message.
        const flushResult = flushUserParts();
        if (!flushResult.ok) return flushResult;
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
          for (let eIdx = 0; eIdx < block.content.length; eIdx++) {
            const rawElement = block.content[eIdx];
            const element = rawElement as Record<string, unknown>;
            const elemPath = `${blockPath} content [${eIdx}]`;
            if (element?.type === "text" && typeof element.text === "string") {
              resultParts.push({ type: "text", text: element.text });
            } else if (element?.type === "image") {
              const imgRes = parseMessagesImageBlock(element, elemPath);
              if (!imgRes.ok) return imgRes;
              resultParts.push(imgRes.value);
            } else if (element?.type === "document") {
              const docRes = parseMessagesDocumentBlock(element, elemPath);
              if (!docRes.ok) return docRes;
              resultParts.push(docRes.value);
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
      // A tool call ends the running assistant text run, because the call becomes its own IR item.
      const flushResult = flushAssistantParts();
      if (!flushResult.ok) return flushResult;
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

  const finalFlush = role === "user" ? flushUserParts() : flushAssistantParts();
  if (!finalFlush.ok) return finalFlush;
  if (items.length === itemIndex) {
    return invalidRequest(`Messages ${role} message [${messageIndex}] has empty content`);
  }
  return ok(undefined);
}
