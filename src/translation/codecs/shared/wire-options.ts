import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { OutcomeWireOptions, PromptCacheBreakpoint, RequestWireOptions } from "../../contracts.ts";
import type { JsonObject, JsonValue } from "../../ir.ts";
import { invalidRequest, ok } from "../../result.ts";
import { firstUnknownKey, parseEnumLiteral } from "./controls.ts";

/**
 * Capture and projection of the wire-only sidecar.
 *
 * Wire-only facts ride beside the IR because the IR carries no field for them:
 * storage flags, prompt-cache controls, metadata, safety identity, moderation,
 * and service tier on the request side; moderation and the service-tier echo
 * on the outcome side. Both directions are defined here so the capture rules
 * and the egress projections cannot drift apart, and so no codec has to restate
 * what a sidecar field means. Only explicitly captured values are ever emitted —
 * never a fabricated default.
 */

/** C/R service-tier enum shared by Chat and Responses (request param and echo). */
const CHAT_RESPONSES_SERVICE_TIERS: ReadonlySet<string> = new Set([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "fast",
]);

/** Result payload of {@link parsePromptCacheOptions}. */
interface PromptCacheOptions {
  readonly mode?: "implicit" | "explicit";
  readonly ttl?: "30m";
}

/** Admitted `prompt_cache_options.mode` literals. */
const PROMPT_CACHE_MODES: ReadonlySet<"implicit" | "explicit"> = new Set(["implicit", "explicit"]);

/**
 * Parses a boolean wire flag (e.g. `store`). Absent passes through. The flag
 * is documented non-nullable on both Chat and Responses wires, so explicit
 * null fails closed like any other non-boolean value.
 */
function parseBooleanFlag(field: string, value: unknown): Result<boolean | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "boolean") {
    return invalidRequest(`${field} must be a boolean when present`);
  }
  return ok(value);
}

/**
 * Parses a string-or-null wire identifier (prompt cache key, safety identifier).
 * Absent passes through as undefined; explicit null passes through as null so
 * explicit values are preserved verbatim; any other type fails `invalid_request`.
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
 * Parses a C/R metadata kv object: every value must be a string when the field
 * is present. The Chat wire documents metadata as "object OR null", so explicit
 * null is treated as absent. Size/count subset limits (≤16 entries, key ≤64,
 * value ≤512) are enforced by preflight, not here — the decoder has no
 * direction.
 */
function parseMetadataRecord(value: unknown): Result<Record<string, string> | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("metadata must be an object of string values");
  }
  // Null prototype so client-supplied keys like "__proto__" survive as own
  // data properties: plain-object string assignment would silently drop them
  // through the inherited accessor, and egress spread projection relies on
  // own-key enumeration for faithful capture.
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
 * Parses the C/R `prompt_cache_options` request object: `{mode?, ttl?}` with
 * the admitted literals only (`implicit|explicit`, `"30m"`). Unrecognized
 * sub-fields fail closed rather than being silently ignored.
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
 * Captures the C/R-shared request wire-only fields from one request body:
 * storage flag, prompt-cache key/options, metadata, legacy user, safety
 * identifier, moderation param, and service tier. Both C/R ingress decoders
 * call this so capability shape rules live in exactly one place; breakpoint
 * markers are NOT handled here because they are anchored during item walking.
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
  // Explicit null is a valid C/R wire value and round-trips verbatim.
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
 * Validates one per-part prompt-cache breakpoint marker on a C/R content part:
 * the documented wire shape is exactly `{mode: "explicit"}`. Any other shape
 * fails `invalid_request`.
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
 * Validates one per-part prompt-cache marker and records its IR anchor on the
 * shared C/R breakpoint list. Instruction anchors omit `partIndex`: a system
 * message's parts concatenate into one instruction item and every C/R
 * re-anchor is item-granular.
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
 * Normalizes a moderation response-result side ({input, output} member) into
 * the singular-verdict normal form: a Chat `{type:"moderation_results", model,
 * results:[verdict]}` wrapper unwraps to its verdict; singular verdicts, error
 * variants, and any other shape pass through untouched. Both C and R hold one
 * verdict per side: a wrapper carrying zero or multiple verdicts fails closed
 * instead of truncating to the first entry or leaking the raw wrapper, and a
 * wrapper whose `results` field is absent or not an array fails closed too,
 * so the wrapper shape never leaks onto a Responses client.
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
 * Projects one normalized moderation result side onto the Chat client wire
 * shape: singular verdicts are wrapped as
 * `{type:"moderation_results", model, results:[verdict]}`; non-object sides
 * (including explicit null) pass through verbatim; already-wrapped or
 * error-shaped sides pass through unchanged (deterministic re-wrap only).
 */
function encodeChatModerationSide(side: JsonValue): JsonValue {
  if (typeof side !== "object" || side === null || Array.isArray(side)) {
    return side;
  }
  const record = side as JsonObject;
  // Already in wrapper form, or an error variant: nothing to re-wrap.
  if (record.type === "moderation_results" || record.type === "error") return record;
  // Absence is never fabricated: a verdict without a model string re-wraps
  // without one instead of synthesizing an empty-string placeholder.
  return {
    type: "moderation_results",
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    results: [record],
  };
}

/**
 * Copies a normalized `{input, output}` moderation result object, preserving
 * each side's presence exactly as the source carried it: an absent side stays
 * absent on the target wire instead of being fabricated as null (absence is
 * distinct from value everywhere in the translation layer). Any other top-level
 * key fails closed — unrecognized moderation facts are never silently dropped.
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
 * Captures the C/R-shared response-side wire-only facts from one outcome
 * record (or per-chunk stream record): the moderation result — normalized to
 * the unwrapped `{input, output}` form after its strict object-or-null shape
 * check — and the service-tier echo. Merges over any previously captured
 * options so per-chunk last-write-wins capture never drops an earlier fact.
 * Shared by both complete-path outcome decoders and both C/R provider stream
 * decoders so the envelope rules live in exactly one place.
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
 * Projects the response-side wire options onto Chat client fields: the
 * moderation result re-wrapped into the Chat verdict envelope per present side
 * (the `{input, output}` split is preserved; sides absent at capture stay
 * absent), plus the service-tier echo. Out-of-vocabulary tier echoes are
 * stripped by direction normalization before this projection runs. Shared by
 * the complete egress and the streaming client encoder.
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
 * Projects the response-side wire options onto Responses client fields: the
 * moderation result in its stored singular-verdict normal form plus the
 * service-tier echo. Shared by the complete egress and the streaming client
 * encoder so complete-vs-stream wire parity is structural.
 */
export function responsesOutcomeWireFields(options: OutcomeWireOptions | undefined): Record<string, JsonValue> {
  if (options === undefined) return {};
  return {
    ...(options.moderation !== undefined ? { moderation: options.moderation } : {}),
    ...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
  };
}

/**
 * Projects the C/R-shared request wire options onto their common top-level
 * field names (`store`, `prompt_cache_key`, `prompt_cache_options`, `metadata`,
 * `user`, `safety_identifier`, `moderation`, `service_tier`). Only explicitly
 * captured values are emitted — never a fabricated default.
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
