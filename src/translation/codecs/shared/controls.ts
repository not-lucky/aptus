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
 * Strict wire-parsing rules for individual values and wire sub-objects.
 *
 * Every admitted generation control has exactly one parsing rule, defined
 * here once: presence is distinguishable from absence, malformed values fail
 * closed as `invalid_request`, out-of-IR-range values fail closed with their
 * matrix capability ID (never clamped), and valid-but-non-admitted native
 * literals fail closed with their own capability ID. The per-protocol codecs
 * stay thin projections over these helpers.
 */

/**
 * Valid C/R reasoning-effort literals the IR deliberately excludes. They fail
 * closed with `reasoning-effort-common` — never `invalid_request`, never a
 * silent drop — because they are native-only capabilities, not malformed input.
 */
const NATIVE_ONLY_EFFORT_LITERALS: ReadonlySet<string> = new Set(["none", "minimal"]);

/** M request service-tier enum (`standard|priority|batch` are response-only echoes). */
export const MESSAGES_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "standard_only"]);

/** Custom-tool grammar syntax literals shared by the Chat and Responses wires. */
const GRAMMAR_SYNTAXES: ReadonlySet<GrammarSyntax> = new Set(GRAMMAR_SYNTAX_VALUES);

/** Chat wire constraint on function tool names (decode and C-target preflight, also structured output). */
export const CHAT_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/** Returns the value when it is a finite number; otherwise undefined. Never NaN/±Infinity. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalizes a custom tool call's wire input onto the IR `inputText` string:
 * strings pass through verbatim and plain objects compact-stringify once;
 * anything else is malformed wire.
 */
export function parseCustomCallInput(value: unknown, context: string): Result<string, NormalizedFailure> {
  if (typeof value === "string") return ok(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return ok(JSON.stringify(value));
  }
  return invalidRequest(`${context}: input must be a string or a JSON object`);
}

/**
 * Parses the two wire grammar fields shared by the Chat and Responses custom
 * tool formats: `syntax` must be a documented literal and `definition` a
 * non-empty string. The wires differ only in how they nest the pair — Chat
 * nests it under `grammar`, Responses keeps it flat.
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
 * Parses one tool's `allowed_callers` wire array against the source
 * protocol's documented caller literals: `ok(false)` when the field is absent,
 * `ok(true)` when it is a non-empty array of `"direct"` entries.
 *
 * An undocumented literal is malformed wire (`invalid_request`); any other
 * documented caller is the `allowed-callers` row. "direct" is the only caller
 * any target wire can carry, so every other caller fails closed here instead
 * of riding the sidecar into a direction gate that would reject it anyway.
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
 * The first key of a decoded wire object that is not in the documented field
 * set; `undefined` when every key is documented.
 *
 * Undocumented fields never vanish silently, so every strict wire sub-object
 * runs this and fails `invalid_request` naming the field it rejected.
 */
export function firstUnknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(obj).find((key) => !allowed.includes(key));
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
 * Parses a positive safe integer control such as the output token limit.
 * Absent or explicit null passes through as undefined (the field is nullable on
 * its admitting schemas); any other non-integer value fails `invalid_request`.
 */
export function parsePositiveSafeInteger(field: string, value: unknown): Result<number | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidRequest(`${field} must be a positive safe integer when present`);
  }
  return ok(value);
}

/** Parses the admitted `low|medium|high` verbosity literal; anything else fails `invalid_request`. */
export function parseVerbosity(value: unknown): Result<Verbosity | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value === "string" && (VERBOSITY_VALUES as readonly string[]).includes(value)) {
    return ok(value as Verbosity);
  }
  return invalidRequest(`verbosity must be one of: ${VERBOSITY_VALUES.join("|")}`);
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
      return invalidRequest(`${field}[${i}] must be a non-empty string`);
    }
  }
  return ok([...entries] as string[]);
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
    return invalidRequest(`${field} must be one of: ${[...allowed].sort().join("|")}`);
  }
  return ok(value as T);
}

/** Narrows a validated stop list into the IR `NonEmpty<string>` shape. */
export function asNonEmptyStopSequences(stops: readonly string[]): NonEmpty<string> | undefined {
  return stops.length > 0 ? (stops as unknown as NonEmpty<string>) : undefined;
}
