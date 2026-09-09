/**
 * @fileoverview Strict wire parsing rules for individual generation controls and sub-objects.
 *
 * Defines singular parsing rules for generation controls, enumerations, and tool fields across
 * incoming provider requests. Presence remains distinguishable from absence, malformed values fail
 * closed as `invalid_request`, and out-of-range values fail closed with matrix capability identifiers
 * rather than being clamped.
 *
 * Used primarily during ingress decoding across OpenAI Chat, OpenAI Responses, and Anthropic Messages
 * to normalize wire fields into provider-independent intermediate representations (IR).
 */

import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { NonEmpty } from "../../ir.ts";
import {
  GRAMMAR_SYNTAX_VALUES,
  type GrammarSyntax,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
  VERBOSITY_VALUES,
  type Verbosity,
} from "../../ir.ts";
import type { MatrixRowId } from "../../matrix.ts";
import { invalidRequest, ok, unsupportedCapability } from "../../result.ts";

/**
 * Native-only reasoning effort literals that the IR excludes.
 *
 * Chat and Responses document `none` and `minimal`, which fail closed under the
 * `reasoning-effort-common` capability ID rather than malformed request errors.
 */
const NATIVE_ONLY_EFFORT_LITERALS: ReadonlySet<string> = new Set(["none", "minimal"]);

/**
 * Messages request service tier literals admitted during ingress decoding.
 * Response-only echoes (`standard`, `priority`, `batch`) are deliberately excluded.
 */
export const MESSAGES_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "standard_only"]);

/** Grammar syntax literals shared by Chat and Responses custom tools. */
const GRAMMAR_SYNTAXES: ReadonlySet<GrammarSyntax> = new Set(GRAMMAR_SYNTAX_VALUES);

/** Regex enforcing Chat function tool name constraints (1-64 alphanumeric characters, underscores, or dashes). */
export const CHAT_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Narrows an unknown wire value to a finite number without coercion.
 *
 * @param value - The raw wire value to inspect.
 * @returns The finite numeric value, or `undefined` if non-numeric, infinite, or NaN.
 */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalizes custom tool call input into canonical JSON string text.
 * Strings pass through verbatim, while plain objects are compact-stringified.
 *
 * @param value - Raw input value from the tool call.
 * @param context - Contextual path for error reporting.
 * @returns The normalized JSON string, or an `invalid_request` failure.
 */
export function parseCustomCallInput(value: unknown, context: string): Result<string, NormalizedFailure> {
  if (typeof value === "string") return ok(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return ok(JSON.stringify(value));
  }
  return invalidRequest(`${context}: input must be a string or a JSON object`);
}

/**
 * Parses syntax and definition fields for custom tool grammars.
 *
 * @param syntax - Raw syntax identifier to validate against admitted grammars.
 * @param definition - Raw grammar definition string.
 * @param context - Contextual path for error reporting.
 * @returns Validated syntax and definition pair, or an `invalid_request` failure.
 */
export function parseGrammarFields(
  syntax: unknown,
  definition: unknown,
  context: string,
): Result<{ readonly syntax: GrammarSyntax; readonly definition: string }, NormalizedFailure> {
  const syntaxResult = parseEnumLiteral("syntax", syntax, GRAMMAR_SYNTAXES);
  if (!syntaxResult.ok) return syntaxResult;
  if (syntaxResult.value === undefined) {
    return invalidRequest(`${context}: grammar syntax is required`);
  }
  if (typeof definition !== "string" || definition === "") {
    return invalidRequest(`${context}: grammar definition must be a non-empty string`);
  }
  return ok({ syntax: syntaxResult.value, definition });
}

/**
 * Parses a tool's `allowed_callers` wire array against documented protocol literals.
 * Only `direct` callers are currently supported across providers; other documented callers
 * fail closed under the `allowed-callers` capability identifier.
 *
 * @param value - Raw `allowed_callers` value to validate.
 * @param documented - Set of valid caller literals for the source protocol.
 * @param context - Contextual path for error reporting.
 * @returns `true` if restricted to direct callers, `false` if absent, or a failure result.
 */
export function parseAllowedCallers(
  value: unknown,
  documented: ReadonlySet<string>,
  context: string,
): Result<boolean, NormalizedFailure> {
  if (value === undefined) return ok(false);
  if (!Array.isArray(value) || value.length === 0) {
    return invalidRequest(`${context}: allowed_callers must be a non-empty array`);
  }
  for (const caller of value) {
    if (typeof caller !== "string" || !documented.has(caller)) {
      return invalidRequest(`${context}: allowed_callers entry '${String(caller)}' is not documented`);
    }
  }
  if (value.some((caller) => caller !== "direct")) {
    return unsupportedCapability("allowed-callers");
  }
  return ok(true);
}

/**
 * Returns the first key in a decoded object not present in the allowed list, or `undefined`.
 * Used across strict wire decoders to reject undocumented fields.
 *
 * @param obj - Object to scan for unrecognized keys.
 * @param allowed - List of documented keys permitted on the object.
 * @returns The first unrecognized key found, or `undefined` if all keys are permitted.
 */
export function firstUnknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(obj).find((key) => !allowed.includes(key));
}

/**
 * Parses a generation control bounded to the interval [0, 1].
 * Absent values pass through as `undefined`. Values outside [0, 1] fail closed with
 * the control's capability ID rather than being clamped.
 *
 * @param field - Field name for error attribution.
 * @param value - Raw wire value to validate.
 * @param capabilityId - Capability ID associated with out-of-range rejections.
 * @returns The parsed number, `undefined` if absent, or a failure result.
 */
export function parseUnitIntervalControl(
  field: string,
  value: unknown,
  capabilityId: MatrixRowId,
): Result<number | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return invalidRequest(`${field} must be a finite number when present`);
  }
  if (parsed < 0 || parsed > 1) {
    return unsupportedCapability(capabilityId, `${field}=${parsed} is outside the admitted IR range [0, 1]`);
  }
  return ok(parsed);
}

/**
 * Parses a positive safe integer control, such as max output tokens.
 * Absent and explicit null values pass through as `undefined`.
 *
 * @param field - Field name for error attribution.
 * @param value - Raw wire value to validate.
 * @returns The parsed positive integer, `undefined` if absent/null, or an `invalid_request` failure.
 */
export function parsePositiveSafeInteger(field: string, value: unknown): Result<number | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidRequest(`${field} must be a positive safe integer when present`);
  }
  return ok(value);
}

/**
 * Parses the admitted `low | medium | high` verbosity literal.
 *
 * @param value - Raw wire value to validate.
 * @returns The parsed Verbosity, `undefined` if absent/null, or an `invalid_request` failure.
 */
export function parseVerbosity(value: unknown): Result<Verbosity | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value === "string" && (VERBOSITY_VALUES as readonly string[]).includes(value)) {
    return ok(value as Verbosity);
  }
  return invalidRequest(`verbosity must be one of: ${VERBOSITY_VALUES.join("|")}`);
}

/**
 * Parses the common reasoning-effort literal.
 * Admitted IR values pass through; native-only `none | minimal` literals fail closed
 * under `reasoning-effort-common`; other values fail as `invalid_request`.
 *
 * @param value - Raw wire value to validate.
 * @returns Parsed ReasoningEffort, `undefined` if absent/null, or a failure result.
 */
export function parseReasoningEffort(value: unknown): Result<ReasoningEffort | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value === "string") {
    if ((REASONING_EFFORT_VALUES as readonly string[]).includes(value)) return ok(value as ReasoningEffort);
    if (NATIVE_ONLY_EFFORT_LITERALS.has(value)) {
      return unsupportedCapability(
        "reasoning-effort-common",
        `reasoning effort '${value}' is a native-only literal outside the admitted common set`,
      );
    }
  }
  return invalidRequest(
    `reasoning effort must be one of: ${REASONING_EFFORT_VALUES.join("|")} (or the native-only none|minimal)`,
  );
}

/**
 * Parses stop sequence entries shared between Chat and Messages requests.
 * Each entry must be a non-empty string.
 *
 * @param field - Field name for error attribution.
 * @param entries - Raw stop sequence array.
 * @returns Parsed array of stop strings, or an `invalid_request` failure.
 */
export function parseStopSequenceEntries(
  field: string,
  entries: readonly unknown[],
): Result<string[], NormalizedFailure> {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "string" || entry.length === 0) {
      return invalidRequest(`${field}[${i}] must be a non-empty string`);
    }
  }
  return ok([...entries] as string[]);
}

/**
 * Parses a string wire field against an allowed literal set.
 * Absent values pass through as `undefined`.
 *
 * @param field - Field name for error attribution.
 * @param value - Raw wire value to validate.
 * @param allowed - Set of admitted literal strings.
 * @returns The narrowed literal, `undefined` if absent, or an `invalid_request` failure.
 */
export function parseEnumLiteral<T extends string>(
  field: string,
  value: unknown,
  allowed: ReadonlySet<T>,
): Result<T | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string" || !allowed.has(value as T)) {
    return invalidRequest(`${field} must be one of: ${[...allowed].sort().join("|")}`);
  }
  return ok(value as T);
}

/**
 * Narrows a validated stop sequence array into the IR NonEmpty<string> shape.
 *
 * @param stops - Array of stop sequence strings.
 * @returns NonEmpty stop array, or `undefined` if empty.
 */
export function asNonEmptyStopSequences(stops: readonly string[]): NonEmpty<string> | undefined {
  return stops.length > 0 ? (stops as unknown as NonEmpty<string>) : undefined;
}
