import type { Result } from "../../domain/contracts.ts";
import type { NormalizedFailure } from "../../domain/operations.ts";
import type { OutcomeWireOptions, PromptCacheBreakpoint, RequestWireOptions } from "../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../failures.ts";
import type {
  IrFinish,
  IrFinishReason,
  IrGenerationControls,
  IrItem,
  IrRequest,
  IrUsage,
  JsonObject,
  JsonValue,
  NonEmpty,
} from "../ir.ts";
import { REASONING_EFFORT_VALUES, type ReasoningEffort, VERBOSITY_VALUES, type Verbosity } from "../ir.ts";

/**
 * Shared strict wire-parsing and egress-projection rules for the six protocol codecs.
 *
 * Every admitted generation control and wire-only sidecar field has exactly one
 * parsing rule, defined here once: presence is distinguishable from absence,
 * malformed values fail closed as `invalid_request`, out-of-IR-range values fail
 * closed with their matrix capability ID (never clamped), and valid-but-
 * non-admitted native literals fail closed with their own capability ID. The
 * per-protocol codecs stay thin projections over these helpers.
 */

/**
 * Valid C/R reasoning-effort literals the IR deliberately excludes. They fail
 * closed with `reasoning-effort-common` — never `invalid_request`, never a
 * silent drop — because they are native-only capabilities, not malformed input.
 */
const NATIVE_ONLY_EFFORT_LITERALS: ReadonlySet<string> = new Set(["none", "minimal"]);

/** C/R service-tier enum shared by Chat and Responses (request param and echo). */
const CHAT_RESPONSES_SERVICE_TIERS: ReadonlySet<string> = new Set([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "fast",
]);

/** M request service-tier enum (`standard|priority|batch` are response-only echoes). */
export const MESSAGES_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "standard_only"]);

/** Returns the value when it is a finite number; otherwise undefined. Never NaN/±Infinity. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireFiniteUsageCounter(value: unknown, field: string): Result<number, NormalizedFailure> {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return { ok: false, error: invalidRequestFailure(`${field} must be a finite number when usage is present`) };
  }
  return ok(parsed);
}

function optionalFiniteNumber(value: unknown, field: string): Result<number | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return { ok: false, error: invalidRequestFailure(`${field} must be a finite number when present`) };
  }
  return ok(parsed);
}

function ok<T>(value: T): Result<T, NormalizedFailure> {
  return { ok: true, value };
}

/**
 * Parses a generation control bounded to the IR range [0, 1].
 *
 * Absent passes through as undefined; a present but non-finite value (string,
 * null, NaN, ±Infinity) fails `invalid_request` — explicit null included,
 * because a sampling control has no meaningful null state and present-but-
 * unusable values must never be silently coerced to undefined; an out-of-range
 * value fails closed with the control's capability ID rather than ever being
 * clamped.
 */
export function parseUnitIntervalControl(
  field: string,
  value: unknown,
  capabilityId: string,
): Result<number | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return { ok: false, error: invalidRequestFailure(`${field} must be a finite number when present`) };
  }
  if (parsed < 0 || parsed > 1) {
    return {
      ok: false,
      error: unsupportedCapabilityFailure(capabilityId, `${field}=${parsed} is outside the admitted IR range [0, 1]`),
    };
  }
  return ok(parsed);
}

/**
 * Parses a positive safe integer control such as the output token limit.
 * Absent or explicit null passes through as undefined (the field is nullable on
 * its admitting schemas); any other non-integer value fails `invalid_request`.
 */
export function parsePositiveSafeInteger(field: string, value: unknown): Result<number | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: invalidRequestFailure(`${field} must be a positive safe integer when present`) };
  }
  return ok(value);
}

/** Parses the admitted `low|medium|high` verbosity literal; anything else fails `invalid_request`. */
export function parseVerbosity(value: unknown): Result<Verbosity | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value === "string" && (VERBOSITY_VALUES as readonly string[]).includes(value)) {
    return ok(value as Verbosity);
  }
  return { ok: false, error: invalidRequestFailure(`verbosity must be one of: ${VERBOSITY_VALUES.join("|")}`) };
}

/**
 * Parses the common reasoning-effort literal. Admitted IR values pass through;
 * the C/R-native `none|minimal` literals fail closed with the
 * `reasoning-effort-common` capability; every other value (non-admitted string
 * or non-string) fails `invalid_request`.
 */
export function parseReasoningEffort(value: unknown): Result<ReasoningEffort | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value === "string") {
    if ((REASONING_EFFORT_VALUES as readonly string[]).includes(value)) return ok(value as ReasoningEffort);
    if (NATIVE_ONLY_EFFORT_LITERALS.has(value)) {
      return {
        ok: false,
        error: unsupportedCapabilityFailure(
          "reasoning-effort-common",
          `reasoning effort '${value}' is a native-only literal outside the admitted common set`,
        ),
      };
    }
  }
  return {
    ok: false,
    error: invalidRequestFailure(
      `reasoning effort must be one of: ${REASONING_EFFORT_VALUES.join("|")} (or the native-only none|minimal)`,
    ),
  };
}

/**
 * Parses stop-sequence entries shared by the Chat `stop` array and Messages
 * `stop_sequences`. Every entry must be a non-empty string; empty entries fail
 * `invalid_request`. Callers decide protocol-specific count limits.
 */
export function parseStopSequenceEntries(
  field: string,
  entries: readonly unknown[],
): Result<string[], NormalizedFailure> {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, error: invalidRequestFailure(`${field}[${i}] must be a non-empty string`) };
    }
  }
  return ok([...entries] as string[]);
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
    return { ok: false, error: invalidRequestFailure("metadata must be an object of string values") };
  }
  // Null prototype so client-supplied keys like "__proto__" survive as own
  // data properties: plain-object string assignment would silently drop them
  // through the inherited accessor, and egress spread projection relies on
  // own-key enumeration for faithful capture.
  const record: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      return { ok: false, error: invalidRequestFailure(`metadata['${key}'] must be a string`) };
    }
    record[key] = entry;
  }
  return ok(record);
}

/**
 * Parses a boolean wire flag (e.g. `store`). Absent passes through. The flag
 * is documented non-nullable on both Chat and Responses wires, so explicit
 * null fails closed like any other non-boolean value.
 */
function parseBooleanFlag(field: string, value: unknown): Result<boolean | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "boolean") {
    return { ok: false, error: invalidRequestFailure(`${field} must be a boolean when present`) };
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
    return { ok: false, error: invalidRequestFailure(`${field} must be a string or null when present`) };
  }
  return ok(value);
}

/**
 * Parses a plain-string wire field against a closed literal set.
 * Absent passes through; membership violations fail `invalid_request`.
 * Generic over the literal type so callers get narrowed values back
 * without re-assertions.
 */
export function parseEnumLiteral<T extends string>(
  field: string,
  value: unknown,
  allowed: ReadonlySet<T>,
): Result<T | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string" || !allowed.has(value as T)) {
    return { ok: false, error: invalidRequestFailure(`${field} must be one of: ${[...allowed].sort().join("|")}`) };
  }
  return ok(value as T);
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
    return { ok: false, error: invalidRequestFailure("moderation_results wrapper must carry exactly one verdict") };
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
  for (const key of Object.keys(moderation)) {
    if (key !== "input" && key !== "output") {
      return { ok: false, error: invalidRequestFailure("moderation result supports only 'input' and 'output' fields") };
    }
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
    return { ok: false, error: invalidRequestFailure("user must be a non-empty string when present") };
  }
  if (body.moderation !== undefined && body.moderation !== null) {
    if (typeof body.moderation !== "object" || Array.isArray(body.moderation)) {
      return { ok: false, error: invalidRequestFailure("moderation must be an object or null when present") };
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
    return { ok: false, error: invalidRequestFailure(`${partPath} prompt_cache_breakpoint must be an object`) };
  }
  const record = marker as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || record.mode !== "explicit") {
    return {
      ok: false,
      error: invalidRequestFailure(`${partPath} prompt_cache_breakpoint must be {mode: "explicit"}`),
    };
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
  breakpoints: PromptCacheBreakpoint[],
  path: string,
  marker: unknown,
  itemIndex: number,
  partIndex?: number,
): Result<void, NormalizedFailure> {
  const markerResult = parseBreakpointMarker(path, marker);
  if (!markerResult.ok) return markerResult;
  breakpoints.push({ itemIndex, ...(partIndex !== undefined ? { partIndex } : {}) });
  return { ok: true, value: undefined };
}

/** Result payload of {@link parsePromptCacheOptions}. */
interface PromptCacheOptions {
  readonly mode?: "implicit" | "explicit";
  readonly ttl?: "30m";
}

/** Admitted `prompt_cache_options.mode` literals. */
const PROMPT_CACHE_MODES: ReadonlySet<"implicit" | "explicit"> = new Set(["implicit", "explicit"]);

/**
 * Parses the C/R `prompt_cache_options` request object: `{mode?, ttl?}` with
 * the admitted literals only (`implicit|explicit`, `"30m"`). Unrecognized
 * sub-fields fail closed rather than being silently ignored.
 */
function parsePromptCacheOptions(value: unknown): Result<PromptCacheOptions, NormalizedFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: invalidRequestFailure("prompt_cache_options must be an object") };
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "ttl") {
      return { ok: false, error: invalidRequestFailure(`prompt_cache_options.${key} is not recognized`) };
    }
  }
  const modeResult = parseEnumLiteral("prompt_cache_options.mode", raw.mode, PROMPT_CACHE_MODES);
  if (!modeResult.ok) return modeResult;
  if (raw.ttl !== undefined && raw.ttl !== "30m") {
    return { ok: false, error: invalidRequestFailure("prompt_cache_options.ttl supports only '30m'") };
  }
  return {
    ok: true,
    value: {
      ...(modeResult.value !== undefined ? { mode: modeResult.value } : {}),
      ...(raw.ttl !== undefined ? { ttl: "30m" as const } : {}),
    },
  };
}

/**
 * Builds the canonical Chat/Responses per-part prompt-cache breakpoint marker.
 */
function chatBreakpointMarker(): JsonObject {
  return { mode: "explicit" };
}

/**
 * Failure for a provider-owned Responses reasoning output item: encrypted
 * content maps to `encrypted-reasoning`, readable reasoning parts to
 * `readable-reasoning`. Shared by every R discovery site (request input item,
 * complete outcome output item, stream item events, terminal response scan).
 */
export function responsesReasoningItemFailure(item: Record<string, unknown>): NormalizedFailure {
  return unsupportedCapabilityFailure(
    item.encrypted_content !== undefined ? "encrypted-reasoning" : "readable-reasoning",
  );
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
      return {
        ok: false,
        error: invalidRequestFailure(`${label} 'moderation' must be an object when present`),
      };
    }
    const moderationResult = copyModerationResult(record.moderation as JsonObject);
    if (!moderationResult.ok) return moderationResult;
    merged = { ...merged, moderation: moderationResult.value };
  }
  return { ok: true, value: merged };
}

/**
 * Parses one usage subdivision wrapper (`*_tokens_details`): absent or explicit
 * null stays absent (documented provider variance); any other non-object value
 * fails `invalid_request`.
 */
function parseUsageDetailsObject(
  rawUsage: Record<string, unknown>,
  field: string,
): Result<Record<string, unknown> | undefined, NormalizedFailure> {
  const value = rawUsage[field];
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: invalidRequestFailure(`usage.${field} must be an object when present`) };
  }
  return ok(value as Record<string, unknown>);
}

/**
 * The OpenAI usage wire vocabulary. Chat and Responses carry identical
 * counters and subdivisions under different field names; one key map drives
 * both parsing and egress reconstruction so each vocabulary lives in exactly
 * one place.
 */
interface OpenAiUsageKeys {
  readonly input: string;
  readonly output: string;
  readonly inputDetails: string;
  readonly outputDetails: string;
}

const CHAT_USAGE_KEYS: OpenAiUsageKeys = {
  input: "prompt_tokens",
  output: "completion_tokens",
  inputDetails: "prompt_tokens_details",
  outputDetails: "completion_tokens_details",
};

const RESPONSES_USAGE_KEYS: OpenAiUsageKeys = {
  input: "input_tokens",
  output: "output_tokens",
  inputDetails: "input_tokens_details",
  outputDetails: "output_tokens_details",
};

/**
 * Extracts OpenAI usage counters plus cache/reasoning subdivisions from one
 * raw usage value, parameterized by the protocol's field vocabulary. Shared
 * verbatim by the complete outcome decoders and the provider stream decoders
 * so the two paths cannot drift. Absence or explicit null of the whole usage
 * value stays absence (OpenAI streaming chunks documentarily carry
 * `usage: null`; never fabricated as zeros); a present non-object usage value
 * fails closed, a present usage object must carry finite totals, and present
 * subdivision fields must be finite numbers — malformed counters fail closed
 * instead of being zero-filled.
 */
function parseOpenAiUsage(rawUsage: unknown, keys: OpenAiUsageKeys): Result<IrUsage | undefined, NormalizedFailure> {
  if (rawUsage === undefined || rawUsage === null) return ok(undefined);
  if (typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return { ok: false, error: invalidRequestFailure("usage must be an object when present") };
  }
  const usage = rawUsage as Record<string, unknown>;
  const input = requireFiniteUsageCounter(usage[keys.input], `usage.${keys.input}`);
  if (!input.ok) return input;
  const output = requireFiniteUsageCounter(usage[keys.output], `usage.${keys.output}`);
  if (!output.ok) return output;
  const total = optionalFiniteNumber(usage.total_tokens, "usage.total_tokens");
  if (!total.ok) return total;
  const inputDetailsResult = parseUsageDetailsObject(usage, keys.inputDetails);
  if (!inputDetailsResult.ok) return inputDetailsResult;
  const outputDetailsResult = parseUsageDetailsObject(usage, keys.outputDetails);
  if (!outputDetailsResult.ok) return outputDetailsResult;
  const inputDetails = inputDetailsResult.value;
  const outputDetails = outputDetailsResult.value;
  const cacheRead = optionalFiniteNumber(inputDetails?.cached_tokens, `usage.${keys.inputDetails}.cached_tokens`);
  if (!cacheRead.ok) return cacheRead;
  const cacheWrite = optionalFiniteNumber(
    inputDetails?.cache_write_tokens,
    `usage.${keys.inputDetails}.cache_write_tokens`,
  );
  if (!cacheWrite.ok) return cacheWrite;
  const reasoning = optionalFiniteNumber(
    outputDetails?.reasoning_tokens,
    `usage.${keys.outputDetails}.reasoning_tokens`,
  );
  if (!reasoning.ok) return reasoning;
  return ok({
    input: input.value,
    output: output.value,
    ...(total.value !== undefined ? { total: total.value } : {}),
    ...(cacheRead.value !== undefined ? { cacheReadInput: cacheRead.value } : {}),
    ...(cacheWrite.value !== undefined ? { cacheWriteInput: cacheWrite.value } : {}),
    ...(reasoning.value !== undefined ? { reasoningOutput: reasoning.value } : {}),
  });
}

/** Parses one OpenAI Chat usage value; see {@link parseOpenAiUsage}. */
export function parseChatUsage(rawUsage: unknown): Result<IrUsage | undefined, NormalizedFailure> {
  return parseOpenAiUsage(rawUsage, CHAT_USAGE_KEYS);
}

/** Parses one OpenAI Responses usage value; see {@link parseOpenAiUsage}. */
export function parseResponsesUsage(rawUsage: unknown): Result<IrUsage | undefined, NormalizedFailure> {
  return parseOpenAiUsage(rawUsage, RESPONSES_USAGE_KEYS);
}

/**
 * Accumulated Anthropic Messages usage counters across one response's usage
 * records (the complete body's `usage` object, or the stream's `message_start`
 * / `message_delta` payloads). Subdivision fields stay undefined until a valid
 * value arrives — an explicitly reported zero is preserved, because absence is
 * distinct from zero everywhere in the IR.
 */
export interface MessagesUsageAccumulator {
  sawUsage: boolean;
  inputTokens?: number;
  cacheReadInput?: number;
  cacheWriteInput?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

/**
 * Validates and accumulates one raw Anthropic usage record. Output-side
 * discovery of the `inference_geo` echo fails closed first. Cumulative counters
 * overwrite rather than sum (each reported value is the latest total); every
 * present counter must be a finite number — malformed counters fail closed
 * instead of being zero-filled, and the `output_tokens_details` wrapper must
 * be an object when present (explicit null is absence). Shared verbatim by the
 * complete outcome decoder and the provider stream decoder so the two paths
 * cannot drift.
 */
export function accumulateMessagesUsage(
  state: MessagesUsageAccumulator,
  rawUsage: Record<string, unknown>,
): Result<void, NormalizedFailure> {
  if (rawUsage.inference_geo !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("inference-geography") };
  }
  state.sawUsage = true;
  const counterFields = [
    ["input_tokens", "inputTokens"],
    ["cache_read_input_tokens", "cacheReadInput"],
    ["cache_creation_input_tokens", "cacheWriteInput"],
    ["output_tokens", "outputTokens"],
  ] as const;
  for (const [field, stateField] of counterFields) {
    const value = rawUsage[field];
    if (value === undefined) continue;
    const parsed = asFiniteNumber(value);
    if (parsed === undefined) {
      return { ok: false, error: invalidRequestFailure(`usage.${field} must be a finite number when present`) };
    }
    state[stateField] = parsed;
  }
  const outputDetailsResult = parseUsageDetailsObject(rawUsage, "output_tokens_details");
  if (!outputDetailsResult.ok) return outputDetailsResult;
  const rawThinkingTokens = outputDetailsResult.value?.thinking_tokens;
  if (rawThinkingTokens !== undefined && asFiniteNumber(rawThinkingTokens) === undefined) {
    return {
      ok: false,
      error: invalidRequestFailure("usage.output_tokens_details.thinking_tokens must be a finite number when present"),
    };
  }
  const thinkingTokens = asFiniteNumber(rawThinkingTokens);
  if (thinkingTokens !== undefined) state.thinkingTokens = thinkingTokens;
  return { ok: true, value: undefined };
}

/**
 * Collapses accumulated Anthropic usage into the semantic IR shape: the input
 * total sums the post-breakpoint base plus both cache subdivisions
 * (`usage-input-output-total`), subdivisions ride as observations and are never
 * re-added, `total` is never fabricated for M-origin outcomes, and subdivision
 * counters stay absent when never reported. Billing totals are NOT defaulted:
 * once `sawUsage` is set, callers must have verified both totals were reported
 * (the complete decoder and the stream `message_stop` handler enforce this)
 * so a partial usage record fails closed instead of fabricating zeros.
 */
export function collapseMessagesUsage(state: MessagesUsageAccumulator): IrUsage | undefined {
  if (!state.sawUsage) return undefined;
  return {
    input: (state.inputTokens ?? 0) + (state.cacheReadInput ?? 0) + (state.cacheWriteInput ?? 0),
    output: state.outputTokens ?? 0,
    ...(state.cacheReadInput !== undefined ? { cacheReadInput: state.cacheReadInput } : {}),
    ...(state.cacheWriteInput !== undefined ? { cacheWriteInput: state.cacheWriteInput } : {}),
    ...(state.thinkingTokens !== undefined ? { reasoningOutput: state.thinkingTokens } : {}),
  };
}

/**
 * Re-anchors prompt-cache breakpoints onto reconstructed OpenAI Chat messages.
 * A marker on any part of an IR item lands on that item's reconstructed message
 * part (plain-text translation emits exactly one text part per message),
 * switching the content to array form because the scalar spelling cannot carry
 * markers. Positions come from the build's recorded `indexByItem` mapping.
 * Absent or empty breakpoint lists no-op.
 * Shared by the complete egress and the stream request encoder.
 */
export function reanchorChatBreakpoints(
  build: IndexedBuild<JsonObject>,
  breakpoints: readonly PromptCacheBreakpoint[] | undefined,
): void {
  if (breakpoints === undefined || breakpoints.length === 0) return;
  for (let itemIndex = 0; itemIndex < build.indexByItem.length; itemIndex++) {
    const entryIndex = build.indexByItem[itemIndex];
    if (entryIndex === undefined) continue;
    // Scoped mutable view: marker attachment rewrites only the content field.
    const message = build.entries[entryIndex] as unknown as { content: unknown };
    if (message !== undefined && isBreakpointAtItem(breakpoints, itemIndex)) {
      message.content = [
        {
          type: "text",
          text: message.content,
          prompt_cache_breakpoint: chatBreakpointMarker(),
        },
      ];
    }
  }
}

/**
 * Re-anchors prompt-cache breakpoints onto reconstructed OpenAI Responses input
 * entries: the marker lands on the first content part of the anchored item's
 * entry (same 1:1 item/wire-entry mapping as {@link reanchorChatBreakpoints}).
 * Positions come from the build's recorded `indexByItem` mapping.
 * Absent or empty breakpoint lists no-op.
 */
export function reanchorResponsesBreakpoints(
  build: IndexedBuild<JsonObject>,
  breakpoints: readonly PromptCacheBreakpoint[] | undefined,
): void {
  if (breakpoints === undefined || breakpoints.length === 0) return;
  for (let itemIndex = 0; itemIndex < build.indexByItem.length; itemIndex++) {
    const entryIndex = build.indexByItem[itemIndex];
    if (entryIndex === undefined) continue;
    const entry = build.entries[entryIndex];
    if (entry === undefined || !isBreakpointAtItem(breakpoints, itemIndex)) continue;
    const content = (entry as { content?: unknown }).content as Array<Record<string, unknown>> | undefined;
    if (content !== undefined && content.length > 0 && content[0] !== undefined) {
      content[0].prompt_cache_breakpoint = chatBreakpointMarker();
    }
  }
}

/** Narrows a validated stop list into the IR `NonEmpty<string>` shape. */
export function asNonEmptyStopSequences(stops: readonly string[]): NonEmpty<string> | undefined {
  return stops.length > 0 ? (stops as unknown as NonEmpty<string>) : undefined;
}

// ---- Egress projection helpers (shared by complete and stream encoders) ----

/**
 * Build result pairing the emitted wire entries with the IR item index each
 * entry was emitted from (`undefined` for item types plain-text translation
 * skips), so breakpoint re-anchoring consumes recorded positions instead of
 * replaying the builder's filtering rules — the positional contract between
 * builder and re-anchoring is structural, not duplicated.
 */
export interface IndexedBuild<T> {
  readonly entries: T[];
  readonly indexByItem: ReadonlyArray<number | undefined>;
}

/**
 * Builds the OpenAI Chat `messages` array from IR items: instructions keep
 * their authority role and user/assistant text parts concatenate per message.
 * Plain-text translation only — other item types never reach the egress.
 */
export function buildChatMessages(items: readonly IrItem[]): IndexedBuild<JsonObject> {
  const messages: JsonObject[] = [];
  const indexByItem: Array<number | undefined> = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (item === undefined) {
      indexByItem.push(undefined);
      continue;
    }
    if (item.type === "instruction") {
      indexByItem.push(messages.length);
      messages.push({ role: item.authority, content: item.text });
    } else if (item.type === "message") {
      let text = "";
      for (const part of item.content) {
        if (part.type === "text") {
          text += part.text;
        }
      }
      indexByItem.push(messages.length);
      messages.push({ role: item.role, content: text });
    } else {
      indexByItem.push(undefined);
    }
  }
  return { entries: messages, indexByItem };
}

/**
 * Builds the OpenAI Responses `input` array from IR items (instructions keep
 * their authority role; user parts become `input_text`, assistant parts
 * `output_text`).
 */
export function buildResponsesInput(items: readonly IrItem[]): IndexedBuild<JsonObject> {
  const input: JsonObject[] = [];
  const indexByItem: Array<number | undefined> = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (item === undefined) {
      indexByItem.push(undefined);
      continue;
    }
    if (item.type === "instruction") {
      indexByItem.push(input.length);
      input.push({
        role: item.authority,
        content: [{ type: "input_text", text: item.text }],
      });
    } else if (item.type === "message") {
      let text = "";
      for (const part of item.content) {
        if (part.type === "text") {
          text += part.text;
        }
      }
      indexByItem.push(input.length);
      input.push({
        type: "message",
        role: item.role,
        content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text }],
      });
    } else {
      indexByItem.push(undefined);
    }
  }
  return { entries: input, indexByItem };
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

/**
 * Returns true when any breakpoint anchors anywhere within the given IR item.
 * C/R egress reconstruction merges an item's text parts into one content
 * string, so a marker on any source part lands on the single reconstructed
 * part — the closest faithful placement without multi-part emission.
 */
function isBreakpointAtItem(breakpoints: readonly PromptCacheBreakpoint[], itemIndex: number): boolean {
  return breakpoints.some((anchor) => anchor.itemIndex === itemIndex);
}

/**
 * Narrows an admitted IR finish reason onto the Chat `finish_reason` wire:
 * token-limit keeps its own spelling and every other admitted reason is the
 * natural stop. Shared verbatim by the complete egress and the client stream
 * encoder so complete-vs-stream parity is structural.
 */
export function chatFinishReason(reason: IrFinishReason): "length" | "stop" {
  return reason === "length" ? "length" : "stop";
}

/**
 * Builds the OpenAI usage object from one IR usage value: totals plus the
 * conditional `*_tokens_details` subdivision objects, parameterized by the
 * protocol's field vocabulary. Shared verbatim by the complete egress and the
 * streaming client encoder so complete-vs-stream wire parity is structural.
 * Subdivisions are never re-added to totals.
 */
function openAiUsageBody(usage: IrUsage, keys: OpenAiUsageKeys): JsonObject {
  const inputDetails: JsonObject = {
    ...(usage.cacheReadInput !== undefined ? { cached_tokens: usage.cacheReadInput } : {}),
    ...(usage.cacheWriteInput !== undefined ? { cache_write_tokens: usage.cacheWriteInput } : {}),
  };
  const outputDetails: JsonObject =
    usage.reasoningOutput !== undefined ? { reasoning_tokens: usage.reasoningOutput } : {};
  return {
    [keys.input]: usage.input,
    [keys.output]: usage.output,
    ...(usage.total !== undefined ? { total_tokens: usage.total } : {}),
    ...(Object.keys(inputDetails).length > 0 ? { [keys.inputDetails]: inputDetails } : {}),
    ...(Object.keys(outputDetails).length > 0 ? { [keys.outputDetails]: outputDetails } : {}),
  };
}

/** Builds the OpenAI Chat usage object; see {@link openAiUsageBody}. */
export function chatUsageBody(usage: IrUsage): JsonObject {
  return openAiUsageBody(usage, CHAT_USAGE_KEYS);
}

/** Builds the OpenAI Responses usage object; see {@link openAiUsageBody}. */
export function responsesUsageBody(usage: IrUsage): JsonObject {
  return openAiUsageBody(usage, RESPONSES_USAGE_KEYS);
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
 * matched stop sequence echoes with the `stop_sequence` reason so the M framing
 * stays valid, token-limit keeps its own spelling, and every other admitted
 * reason maps to the natural end-of-turn. Shared verbatim by the complete
 * egress and the client stream encoder so complete-vs-stream parity is
 * structural.
 */
export function messagesStopReason(finish: IrFinish): string {
  return finish.reason === "length"
    ? "max_tokens"
    : finish.stopSequence !== undefined && finish.reason === "stop"
      ? "stop_sequence"
      : "end_turn";
}

/**
 * Builds the Anthropic Messages request body shared by the complete egress and
 * the streaming request encoder: system/message assembly, turn merging,
 * generation-control projection, sidecar projection, and breakpoint
 * re-anchoring are defined exactly once.
 */
export function buildMessagesRequestBody(
  request: IrRequest,
  targetModel: string,
  stream: boolean,
  requestWireOptions?: RequestWireOptions,
): JsonObject {
  const systemBlocks: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];

  // Emitted content blocks by IR position, recorded while building the wire
  // body: `${itemIndex}` for instruction system blocks and
  // `${itemIndex}:${partIndex}` for message content blocks. Turn merging
  // moves block objects between arrays but never copies them, so the recorded
  // references stay valid for marker attachment after assembly.
  const blocksByAnchor = new Map<string, Record<string, unknown>>();

  let scanningLeadingInstructions = true;

  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex++) {
    const item = request.items[itemIndex];
    if (item === undefined) continue;
    if (item.type === "instruction" && scanningLeadingInstructions) {
      const block: Record<string, unknown> = {
        type: "text",
        text: item.text,
      };
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
        const block: Record<string, unknown> = {
          type: "text",
          text: part.text,
        };
        contentBlocks.push(block);
        blocksByAnchor.set(`${itemIndex}:${partIndex}`, block);
      }

      // T2: Turn merging for consecutive same-role turns into Messages
      const lastMessage = messages[messages.length - 1] as { role: unknown; content: unknown } | undefined;
      if (lastMessage !== undefined && lastMessage.role === item.role) {
        (lastMessage.content as Array<Record<string, unknown>>).push(...contentBlocks);
      } else {
        messages.push({
          role: item.role,
          content: contentBlocks,
        });
      }
    }
  }

  // Attach cache-control markers from breakpoints (marker-only, declared TTL
  // loss). Message anchors use their exact part; instruction anchors may carry
  // a vestigial partIndex from the source wire — fall back to the item-level
  // system block.
  const breakpoints = requestWireOptions?.promptCacheBreakpoints;
  if (breakpoints !== undefined) {
    for (const anchor of breakpoints) {
      const block =
        (anchor.partIndex !== undefined ? blocksByAnchor.get(`${anchor.itemIndex}:${anchor.partIndex}`) : undefined) ??
        blocksByAnchor.get(`${anchor.itemIndex}`);
      if (block !== undefined) {
        block.cache_control = { type: "ephemeral" };
      }
    }
  }

  const payload: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream,
    ...messagesGenerationFields(request.generation),
    ...messagesWireOptionFields(requestWireOptions),
  };

  if (systemBlocks.length > 0) {
    payload.system = systemBlocks;
  }

  return payload as JsonObject;
}

/**
 * Projects IR generation controls onto Messages wire fields: temperature /
 * top_p / stop_sequences. `max_tokens` is coordinator-resolved and deliberately
 * omitted here so the resolution rule lives in exactly one place.
 */
function messagesGenerationFields(generation: IrRequest["generation"]): Record<string, JsonValue> {
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
function messagesWireOptionFields(options: RequestWireOptions | undefined): Record<string, JsonValue> {
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
 * Reconstructs the Anthropic Messages usage object from one IR usage value:
 * `input_tokens = input - cacheReadInput - cacheWriteInput` plus the flat cache
 * counters and the nested `output_tokens_details.thinking_tokens` breakdown.
 * Shared verbatim by the complete egress and the streaming client encoder so
 * complete-vs-stream parity is structural. Subdivisions are never re-added.
 */
export function messagesUsageBody(usage: IrUsage): JsonObject {
  const outputDetails: JsonObject =
    usage.reasoningOutput !== undefined ? { thinking_tokens: usage.reasoningOutput } : {};
  return {
    input_tokens: usage.input - (usage.cacheReadInput ?? 0) - (usage.cacheWriteInput ?? 0),
    output_tokens: usage.output,
    ...(usage.cacheReadInput !== undefined ? { cache_read_input_tokens: usage.cacheReadInput } : {}),
    ...(usage.cacheWriteInput !== undefined ? { cache_creation_input_tokens: usage.cacheWriteInput } : {}),
    ...(Object.keys(outputDetails).length > 0 ? { output_tokens_details: outputDetails } : {}),
  };
}
