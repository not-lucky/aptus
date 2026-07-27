import type {
  CanonicalChunk,
  ChunkAddress,
  CostMetrics,
  GatewayError,
  TokenUsage,
} from "../../domain/index.js";
import { createGatewayError, validateContentBlock } from "../../domain/index.js";
import type { ProviderDecodeContext } from "./types.js";

const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text", "refusal", "image_url", "image_base64", "generated_image",
  "audio_url", "audio_base64", "audio_output", "document_url",
  "document_base64", "file_reference", "search_result", "reasoning",
  "tool_call", "tool_result", "server_tool_call", "server_tool_result",
  "tool_approval_request", "tool_approval_response",
]);
const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop", "max_tokens", "stop_sequence", "tool_calls", "pause_turn",
  "refusal", "content_filter", "incomplete", "cancelled", "error",
]);
const RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "queued", "in_progress", "completed", "incomplete", "failed", "cancelled",
]);
const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "validation", "authentication", "authorization", "rate_limit", "upstream",
  "timeout", "routing", "internal",
]);

/** Strictly decodes one canonical-shaped provider event into a frozen chunk. */
export function decodeCanonicalEvent(
  event: unknown,
  context: ProviderDecodeContext,
): ReadonlyArray<CanonicalChunk> {
  if (!isRecord(event) || typeof event["type"] !== "string") malformed(context);
  const value = event;

  switch (value["type"]) {
    case "response_start":
      requireString(value["responseId"], context);
      requireString(value["model"], context);
      requireString(value["createdAt"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "content_block_start": {
      address(value["address"], context);
      const block = value["block"];
      if (!isRecord(block) || !BLOCK_TYPES.has(stringValue(block["type"]))) {
        malformed(context);
      }
      optionalString(block["id"], context);
      optionalString(block["name"], context);
      optionalString(block["toolKind"], context);
      optionalString(block["serverName"], context);
      sequence(value["sequenceNumber"], context);
      break;
    }
    case "text_delta":
    case "refusal_delta":
      address(value["address"], context);
      requireString(value["text"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "reasoning_delta":
      address(value["address"], context);
      optionalString(value["text"], context);
      optionalString(value["signatureDelta"], context);
      optionalString(value["redactedDataDelta"], context);
      optionalString(value["encryptedContentDelta"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "audio_delta":
      address(value["address"], context);
      optionalString(value["audioBase64"], context);
      optionalString(value["transcriptDelta"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "tool_call_delta":
      address(value["address"], context);
      optionalString(value["id"], context);
      optionalString(value["name"], context);
      optionalString(value["argumentsDelta"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "citation_added":
      address(value["address"], context);
      if (!validCitation(value["citation"])) malformed(context);
      sequence(value["sequenceNumber"], context);
      break;
    case "content_block_stop":
      address(value["address"], context);
      if (
        value["block"] !== undefined &&
        !validateContentBlock(value["block"], "chunk.block").valid
      ) {
        malformed(context);
      }
      sequence(value["sequenceNumber"], context);
      break;
    case "usage":
      if (!validUsage(value["usage"])) malformed(context);
      if (value["cost"] !== undefined && !validCost(value["cost"])) {
        malformed(context);
      }
      sequence(value["sequenceNumber"], context);
      break;
    case "choice_end":
      optionalIndex(value["choiceIndex"], context);
      if (!FINISH_REASONS.has(stringValue(value["finishReason"]))) {
        malformed(context);
      }
      optionalString(value["stopSequence"], context);
      sequence(value["sequenceNumber"], context);
      break;
    case "response_end":
      if (!RESPONSE_STATUSES.has(stringValue(value["status"]))) malformed(context);
      sequence(value["sequenceNumber"], context);
      break;
    case "ping":
      break;
    case "error":
      if (
        !validGatewayError(value["error"]) ||
        value["error"].requestId !== context.requestId
      ) {
        malformed(context);
      }
      sequence(value["sequenceNumber"], context);
      break;
    default:
      malformed(context);
  }

  const copy = deepFreeze(structuredClone(value)) as CanonicalChunk;
  return Object.freeze([copy]);
}

function malformed(context: ProviderDecodeContext): never {
  throw createGatewayError({
    category: "upstream",
    code: "upstream_event_malformed",
    message: "The upstream provider event is malformed.",
    requestId: context.requestId,
    retryable: false,
    status: 502,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireString(value: unknown, context: ProviderDecodeContext): void {
  if (typeof value !== "string") malformed(context);
}

function optionalString(value: unknown, context: ProviderDecodeContext): void {
  if (value !== undefined && typeof value !== "string") malformed(context);
}

function optionalIndex(value: unknown, context: ProviderDecodeContext): void {
  if (value !== undefined && !validIndex(value)) malformed(context);
}

function validIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sequence(value: unknown, context: ProviderDecodeContext): void {
  if (value !== undefined && !validIndex(value)) malformed(context);
}

function address(
  value: unknown,
  context: ProviderDecodeContext,
): asserts value is ChunkAddress {
  if (
    !isRecord(value) ||
    !validIndex(value["outputIndex"]) ||
    (value["choiceIndex"] !== undefined && !validIndex(value["choiceIndex"])) ||
    (value["contentIndex"] !== undefined && !validIndex(value["contentIndex"]))
  ) {
    malformed(context);
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validUsage(value: unknown): value is TokenUsage {
  if (
    !isRecord(value) ||
    !safeNonNegativeInteger(value["inputTokens"]) ||
    !safeNonNegativeInteger(value["outputTokens"]) ||
    !safeNonNegativeInteger(value["totalTokens"])
  ) {
    return false;
  }
  for (const key of [
    "reasoningTokens", "audioInputTokens", "audioOutputTokens",
    "cachedInputTokens", "acceptedPredictionTokens", "rejectedPredictionTokens",
  ]) {
    if (value[key] !== undefined && !safeNonNegativeInteger(value[key])) return false;
  }
  const breakdown = value["cacheWriteBreakdown"];
  if (
    breakdown !== undefined &&
    (!Array.isArray(breakdown) ||
      breakdown.some(
        (entry) =>
          !isRecord(entry) ||
          !safeNonNegativeInteger(entry["ttlSeconds"]) ||
          !safeNonNegativeInteger(entry["tokens"]),
      ))
  ) {
    return false;
  }
  const tools = value["serverToolUsage"];
  return (
    tools === undefined ||
    (isRecord(tools) && Object.values(tools).every(safeNonNegativeInteger))
  );
}

function validCost(value: unknown): value is CostMetrics {
  return (
    isRecord(value) &&
    finiteNonNegative(value["inputUsd"]) &&
    finiteNonNegative(value["outputUsd"]) &&
    finiteNonNegative(value["cacheReadUsd"]) &&
    finiteNonNegative(value["cacheWriteUsd"]) &&
    finiteNonNegative(value["totalUsd"]) &&
    value["currency"] === "USD"
  );
}

function validCitation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = stringValue(value["kind"]);
  if (!new Set([
    "char_span", "page_span", "block_span", "search_result_span", "url", "file",
  ]).has(kind)) return false;
  for (const key of ["sourceId", "sourceTitle", "citedText", "url"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  for (const key of ["startIndex", "endIndex", "pageStart", "pageEnd"]) {
    if (value[key] !== undefined && !safeNonNegativeInteger(value[key])) return false;
  }
  return value["raw"] === undefined || validJsonValue(value["raw"]);
}

function validGatewayError(value: unknown): value is GatewayError {
  return (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    ERROR_CATEGORIES.has(stringValue(value["category"])) &&
    typeof value["retryable"] === "boolean" &&
    Number.isSafeInteger(value["status"]) &&
    (value["status"] as number) >= 100 &&
    (value["status"] as number) <= 599 &&
    typeof value["requestId"] === "string" &&
    (value["retryAfterMs"] === undefined || safeNonNegativeInteger(value["retryAfterMs"])) &&
    (value["providerId"] === undefined || typeof value["providerId"] === "string") &&
    (value["credentialId"] === undefined || typeof value["credentialId"] === "string") &&
    (value["details"] === undefined || isRecord(value["details"]))
  );
}

function validJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJsonValue);
  return isRecord(value) && Object.values(value).every(validJsonValue);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
