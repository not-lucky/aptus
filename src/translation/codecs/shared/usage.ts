import type { JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { IrUsage } from "../../ir.ts";
import { invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { asFiniteNumber } from "./controls.ts";

/**
 * Usage accounting across the three provider vocabularies.
 *
 * Wire counters are parsed, accumulated, and rebuilt here so the complete and
 * streaming paths of a protocol cannot drift. Absence is distinct from zero
 * everywhere: a missing usage object stays absent and is never fabricated as
 * zeros, and a present but malformed counter fails closed instead of being
 * zero-filled. Subdivision counters are observations and are never re-added to
 * the totals.
 */

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
    return invalidRequest(`usage.${field} must be an object when present`);
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

function requireFiniteUsageCounter(value: unknown, field: string): Result<number, NormalizedFailure> {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return invalidRequest(`${field} must be a finite number when usage is present`);
  }
  return ok(parsed);
}

function optionalFiniteNumber(value: unknown, field: string): Result<number | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return invalidRequest(`${field} must be a finite number when present`);
  }
  return ok(parsed);
}

/**
 * Extracts OpenAI usage counters plus cache/reasoning subdivisions from one
 * raw usage value, parameterized by the protocol's field vocabulary. Shared
 * verbatim by the complete outcome decoders and the provider stream decoders
 * so the two paths cannot drift. Absence or explicit null of the whole usage
 * value stays absence (OpenAI streaming chunks documentarily carry
 * `usage: null`; never fabricated as zeros); a present non-object usage value
 * fails closed, a present usage object must carry finite totals, and present
 * subdivision fields must be finite numbers.
 */
function parseOpenAiUsage(rawUsage: unknown, keys: OpenAiUsageKeys): Result<IrUsage | undefined, NormalizedFailure> {
  if (rawUsage === undefined || rawUsage === null) return ok(undefined);
  if (typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return invalidRequest("usage must be an object when present");
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
    return unsupportedCapability("inference-geography");
  }
  if (rawUsage.server_tool_use !== undefined) {
    return unsupportedCapability("usage-server-tools");
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
      return invalidRequest(`usage.${field} must be a finite number when present`);
    }
    state[stateField] = parsed;
  }
  const outputDetailsResult = parseUsageDetailsObject(rawUsage, "output_tokens_details");
  if (!outputDetailsResult.ok) return outputDetailsResult;
  const rawThinkingTokens = outputDetailsResult.value?.thinking_tokens;
  if (rawThinkingTokens !== undefined && asFiniteNumber(rawThinkingTokens) === undefined) {
    return invalidRequest("usage.output_tokens_details.thinking_tokens must be a finite number when present");
  }
  const thinkingTokens = asFiniteNumber(rawThinkingTokens);
  if (thinkingTokens !== undefined) state.thinkingTokens = thinkingTokens;
  return ok(undefined);
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
