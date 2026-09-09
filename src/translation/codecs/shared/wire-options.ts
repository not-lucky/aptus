/**
 * @fileoverview Capture and egress projection of wire-only sidecar options.
 *
 * Preserves protocol facts excluded from provider-independent semantic representations:
 * store flags, prompt cache options, metadata, moderation results, safety identifiers, and service tiers.
 * Guarantees that unstated source facts remain absent rather than defaulting silently.
 *
 * Shared across OpenAI Chat and OpenAI Responses ingress decoders and egress/stream encoders.
 */

import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { OutcomeWireOptions, PromptCacheBreakpoint, RequestWireOptions } from "../../contracts.ts";
import type { JsonObject, JsonValue } from "../../ir.ts";
import { invalidRequest, ok } from "../../result.ts";
import { firstUnknownKey, parseEnumLiteral } from "./controls.ts";

/** Service tier literals supported across OpenAI Chat and Responses formats. */
const CHAT_RESPONSES_SERVICE_TIERS: ReadonlySet<string> = new Set([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "fast",
]);

/** Internal container for parsed prompt cache configuration options. */
interface PromptCacheOptions {
  /** Prompt cache management mode (`implicit` or `explicit`), if declared. */
  readonly mode?: "implicit" | "explicit";

  /** Cache entry time-to-live string (e.g. '30m'), if declared. */
  readonly ttl?: "30m";
}

/** Supported prompt cache mode literals (`implicit`, `explicit`). */
const PROMPT_CACHE_MODES: ReadonlySet<"implicit" | "explicit"> = new Set(["implicit", "explicit"]);

/**
 * Parses an optional boolean wire flag (e.g. `store`).
 *
 * @param field - Field name for error attribution.
 * @param value - Raw wire value to validate.
 * @returns Parsed boolean, `undefined` if absent, or an `invalid_request` failure.
 */
function parseBooleanFlag(field: string, value: unknown): Result<boolean | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "boolean") {
    return invalidRequest(`${field} must be a boolean when present`);
  }
  return ok(value);
}

/**
 * Parses an optional string-or-null wire field (e.g. `safety_identifier`).
 *
 * @param field - Field name for error attribution.
 * @param value - Raw wire value to validate.
 * @returns Parsed string, `null`, `undefined` if absent, or an `invalid_request` failure.
 */
function parseStringOrNull(field: string, value: unknown): Result<string | null | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (value === null) return ok(null);
  if (typeof value !== "string") {
    return invalidRequest(`${field} must be a string or null when present`);
  }
  return ok(value);
}

/**
 * Parses a metadata key-value record where all values must be strings.
 *
 * @param value - Raw metadata object.
 * @returns Parsed string record, `undefined` if absent/null, or an `invalid_request` failure.
 */
function parseMetadataRecord(value: unknown): Result<Record<string, string> | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("metadata must be an object of string values");
  }
  // Null prototype preserves client keys like __proto__ as own properties.
  const record: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      return invalidRequest(`metadata['${key}'] must be a string`);
    }
    record[key] = entry;
  }
  return ok(record);
}

/**
 * Parses a `prompt_cache_options` object containing optional `mode` and `ttl`.
 *
 * @param value - Raw prompt cache options value.
 * @returns Parsed PromptCacheOptions, or an `invalid_request` failure.
 */
function parsePromptCacheOptions(value: unknown): Result<PromptCacheOptions, NormalizedFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest("prompt_cache_options must be an object");
  }
  const raw = value as Record<string, unknown>;
  const extra = firstUnknownKey(raw, ["mode", "ttl"]);
  if (extra !== undefined) return invalidRequest(`prompt_cache_options.${extra} is not recognized`);
  const modeResult = parseEnumLiteral("prompt_cache_options.mode", raw.mode, PROMPT_CACHE_MODES);
  if (!modeResult.ok) return modeResult;
  if (raw.ttl !== undefined && raw.ttl !== "30m") {
    return invalidRequest("prompt_cache_options.ttl supports only '30m'");
  }
  return ok({
    ...(modeResult.value !== undefined ? { mode: modeResult.value } : {}),
    ...(raw.ttl !== undefined ? { ttl: "30m" as const } : {}),
  });
}

/**
 * Captures request-side wire options from an OpenAI Chat or Responses request body.
 * Extracts `store`, `metadata`, `prompt_cache_key`, `service_tier`, etc.
 *
 * @param body - Decoded source request body JSON object.
 * @returns Populated RequestWireOptions sidecar, or an `invalid_request` failure.
 */
export function parseChatResponsesWireOptions(body: JsonObject): Result<RequestWireOptions, NormalizedFailure> {
  const storeResult = parseBooleanFlag("store", body.store);
  if (!storeResult.ok) return storeResult;
  const cacheKeyResult = parseStringOrNull("prompt_cache_key", body.prompt_cache_key);
  if (!cacheKeyResult.ok) return cacheKeyResult;
  const safetyResult = parseStringOrNull("safety_identifier", body.safety_identifier);
  if (!safetyResult.ok) return safetyResult;
  const metadataResult = parseMetadataRecord(body.metadata);
  if (!metadataResult.ok) return metadataResult;
  if (body.user !== undefined && (typeof body.user !== "string" || body.user === "")) {
    return invalidRequest("user must be a non-empty string when present");
  }
  if (body.moderation !== undefined && body.moderation !== null) {
    if (typeof body.moderation !== "object" || Array.isArray(body.moderation)) {
      return invalidRequest("moderation must be an object or null when present");
    }
  }
  let tierValue: string | null | undefined;
  if (body.service_tier === null) {
    tierValue = null;
  } else {
    const tierResult = parseEnumLiteral("service_tier", body.service_tier, CHAT_RESPONSES_SERVICE_TIERS);
    if (!tierResult.ok) return tierResult;
    tierValue = tierResult.value;
  }

  let promptCacheOptions: PromptCacheOptions | undefined;
  if (body.prompt_cache_options !== undefined) {
    const optionsResult = parsePromptCacheOptions(body.prompt_cache_options);
    if (!optionsResult.ok) return optionsResult;
    promptCacheOptions = optionsResult.value;
  }

  return ok({
    ...(storeResult.value !== undefined ? { store: storeResult.value } : {}),
    ...(cacheKeyResult.value !== undefined ? { promptCacheKey: cacheKeyResult.value } : {}),
    ...(promptCacheOptions?.mode !== undefined ? { promptCacheMode: promptCacheOptions.mode } : {}),
    ...(promptCacheOptions?.ttl !== undefined ? { promptCacheTtl: promptCacheOptions.ttl } : {}),
    ...(metadataResult.value !== undefined ? { metadata: metadataResult.value } : {}),
    ...(body.user !== undefined ? { user: body.user } : {}),
    ...(safetyResult.value !== undefined ? { safetyIdentifier: safetyResult.value } : {}),
    ...(body.moderation !== undefined ? { moderation: body.moderation as JsonObject | null } : {}),
    ...(tierValue !== undefined ? { serviceTier: tierValue } : {}),
  });
}

/**
 * Validates a prompt cache breakpoint marker on a content part (`{mode: "explicit"}`).
 *
 * @param partPath - Content part path for error formatting.
 * @param marker - Raw breakpoint marker value.
 * @returns Success if valid, or an `invalid_request` failure.
 */
function parseBreakpointMarker(partPath: string, marker: unknown): Result<void, NormalizedFailure> {
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return invalidRequest(`${partPath} prompt_cache_breakpoint must be an object`);
  }
  const record = marker as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || record.mode !== "explicit") {
    return invalidRequest(`${partPath} prompt_cache_breakpoint must be {mode: "explicit"}`);
  }
  return ok(undefined);
}

/**
 * Validates a prompt cache breakpoint marker and constructs an IR anchor.
 *
 * @param path - Content part path for error formatting.
 * @param marker - Raw breakpoint marker value.
 * @param itemIndex - Index of the parent IR item.
 * @param partIndex - Optional index of the content part within the item.
 * @returns PromptCacheBreakpoint anchor, or an `invalid_request` failure.
 */
export function captureBreakpoint(
  path: string,
  marker: unknown,
  itemIndex: number,
  partIndex?: number,
): Result<PromptCacheBreakpoint, NormalizedFailure> {
  const markerResult = parseBreakpointMarker(path, marker);
  if (!markerResult.ok) return markerResult;
  return ok({ itemIndex, ...(partIndex !== undefined ? { partIndex } : {}) });
}

/**
 * Normalizes one side of a moderation result into a bare singular verdict.
 *
 * @param side - Input or output moderation payload.
 * @returns Normalized verdict value, or an `invalid_request` failure.
 */
function normalizeModerationSide(side: JsonValue): Result<JsonValue, NormalizedFailure> {
  if (typeof side !== "object" || side === null || Array.isArray(side)) return ok(side);
  const record = side as JsonObject;
  if (record.type !== "moderation_results") return ok(side);
  if (!Array.isArray(record.results) || record.results.length !== 1 || record.results[0] === undefined) {
    return invalidRequest("moderation_results wrapper must carry exactly one verdict");
  }
  return ok(record.results[0]);
}

/**
 * Wraps a normalized moderation verdict into the Chat `moderation_results` envelope.
 *
 * @param side - Normalized moderation verdict.
 * @returns Wrapped Chat moderation results object.
 */
function encodeChatModerationSide(side: JsonValue): JsonValue {
  if (typeof side !== "object" || side === null || Array.isArray(side)) {
    return side;
  }
  const record = side as JsonObject;
  if (record.type === "moderation_results" || record.type === "error") return record;
  return {
    type: "moderation_results",
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    results: [record],
  };
}

/**
 * Deep-copies and normalizes an `{input, output}` moderation result object.
 *
 * @param moderation - Raw moderation result object.
 * @returns Normalized moderation object, or an `invalid_request` failure.
 */
function copyModerationResult(moderation: JsonObject): Result<JsonObject, NormalizedFailure> {
  if (firstUnknownKey(moderation, ["input", "output"]) !== undefined) {
    return invalidRequest("moderation result supports only 'input' and 'output' fields");
  }
  let normalizedInput: JsonValue | undefined;
  if (moderation.input !== undefined) {
    const inputResult = normalizeModerationSide(moderation.input);
    if (!inputResult.ok) return inputResult;
    normalizedInput = inputResult.value;
  }
  let normalizedOutput: JsonValue | undefined;
  if (moderation.output !== undefined) {
    const outputResult = normalizeModerationSide(moderation.output);
    if (!outputResult.ok) return outputResult;
    normalizedOutput = outputResult.value;
  }
  return ok({
    ...(normalizedInput !== undefined ? { input: normalizedInput } : {}),
    ...(normalizedOutput !== undefined ? { output: normalizedOutput } : {}),
  });
}

/**
 * Captures outcome wire facts (`service_tier`, `moderation`) from response bodies or stream chunks.
 *
 * @param record - Decoded outcome wire record or stream frame.
 * @param existing - Accumulator of previously captured outcome wire options.
 * @param label - Protocol label for error reporting.
 * @returns Merged OutcomeWireOptions, or an `invalid_request` failure.
 */
export function captureOutcomeWireFacts(
  record: Record<string, unknown>,
  existing: OutcomeWireOptions,
  label: string,
): Result<OutcomeWireOptions, NormalizedFailure> {
  let merged = existing;
  if (typeof record.service_tier === "string") {
    merged = { ...merged, serviceTier: record.service_tier };
  }
  if (record.moderation !== undefined && record.moderation !== null) {
    if (typeof record.moderation !== "object" || Array.isArray(record.moderation)) {
      return invalidRequest(`${label} 'moderation' must be an object when present`);
    }
    const moderationResult = copyModerationResult(record.moderation as JsonObject);
    if (!moderationResult.ok) return moderationResult;
    merged = { ...merged, moderation: moderationResult.value };
  }
  return ok(merged);
}

/**
 * Projects outcome wire options onto Chat response envelope fields (`moderation`, `service_tier`).
 *
 * @param options - Captured outcome wire options.
 * @returns Record of Chat response wire fields.
 */
export function chatOutcomeWireFields(options: OutcomeWireOptions | undefined): Record<string, JsonValue> {
  if (options === undefined) return {};
  const moderation = options.moderation;
  return {
    ...(moderation !== undefined
      ? {
          moderation: {
            ...(moderation.input !== undefined ? { input: encodeChatModerationSide(moderation.input) } : {}),
            ...(moderation.output !== undefined ? { output: encodeChatModerationSide(moderation.output) } : {}),
          },
        }
      : {}),
    ...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
  };
}

/**
 * Projects outcome wire options onto Responses envelope fields (`moderation`, `service_tier`).
 *
 * @param options - Captured outcome wire options.
 * @returns Record of Responses response wire fields.
 */
export function responsesOutcomeWireFields(options: OutcomeWireOptions | undefined): Record<string, JsonValue> {
  if (options === undefined) return {};
  return {
    ...(options.moderation !== undefined ? { moderation: options.moderation } : {}),
    ...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
  };
}

/**
 * Projects request wire options onto common Chat/Responses request fields (`store`, `metadata`, etc.).
 *
 * @param options - Captured request wire options.
 * @returns Record of wire request fields.
 */
export function chatResponsesRequestFields(options: RequestWireOptions | undefined): Record<string, JsonValue> {
  if (options === undefined) return {};
  const fields: Record<string, JsonValue> = {};
  if (options.store !== undefined) fields.store = options.store;
  if (options.promptCacheKey !== undefined) fields.prompt_cache_key = options.promptCacheKey;
  if (options.promptCacheMode !== undefined || options.promptCacheTtl !== undefined) {
    const cacheOptions: Record<string, JsonValue> = {};
    if (options.promptCacheMode !== undefined) cacheOptions.mode = options.promptCacheMode;
    if (options.promptCacheTtl !== undefined) cacheOptions.ttl = options.promptCacheTtl;
    fields.prompt_cache_options = cacheOptions;
  }
  if (options.metadata !== undefined) fields.metadata = { ...options.metadata };
  if (options.user !== undefined) fields.user = options.user;
  if (options.safetyIdentifier !== undefined) fields.safety_identifier = options.safetyIdentifier;
  if (options.moderation !== undefined) fields.moderation = options.moderation;
  if (options.serviceTier !== undefined) fields.service_tier = options.serviceTier;
  return fields;
}
