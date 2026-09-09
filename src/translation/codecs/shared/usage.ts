/**
 * @fileoverview Usage accounting across provider token reporting vocabularies.
 *
 * Normalizes provider token counters into semantic `IrUsage` representations and reconstructs
 * wire-format usage objects across OpenAI Chat, OpenAI Responses, and Anthropic Messages.
 * Maintains distinctions between zero and absent metrics and prevents silent fabrication of counters.
 *
 * Shared between complete outcomes and streaming decoders/encoders to maintain invariant token accounting.
 */

import type { JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { IrUsage } from "../../ir.ts";
import { invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { asFiniteNumber } from "./controls.ts";

/**
 * Parses and validates an optional usage details sub-object (`*_tokens_details`).
 *
 * @param rawUsage - Enclosing raw usage record.
 * @param field - Field name of the details sub-object to extract.
 * @returns Parsed record, `undefined` if absent/null, or an `invalid_request` failure.
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

/** Wire field name vocabulary for OpenAI-family usage objects. */
interface OpenAiUsageKeys {
  /** Wire field name for input token counts (e.g. `prompt_tokens` or `input_tokens`). */
  readonly input: string;

  /** Wire field name for output token counts (e.g. `completion_tokens` or `output_tokens`). */
  readonly output: string;

  /** Wire field name for input token details object. */
  readonly inputDetails: string;

  /** Wire field name for output token details object. */
  readonly outputDetails: string;
}

/** Wire field keys for OpenAI Chat completions usage reporting. */
const CHAT_USAGE_KEYS: OpenAiUsageKeys = {
  input: "prompt_tokens",
  output: "completion_tokens",
  inputDetails: "prompt_tokens_details",
  outputDetails: "completion_tokens_details",
};

/** Wire field keys for OpenAI Responses usage reporting. */
const RESPONSES_USAGE_KEYS: OpenAiUsageKeys = {
  input: "input_tokens",
  output: "output_tokens",
  inputDetails: "input_tokens_details",
  outputDetails: "output_tokens_details",
};

/**
 * Validates that a required usage counter is present and a finite number.
 *
 * @param value - Raw counter value to validate.
 * @param field - Field name for error attribution.
 * @returns Parsed finite number, or an `invalid_request` failure.
 */
function requireFiniteUsageCounter(value: unknown, field: string): Result<number, NormalizedFailure> {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return invalidRequest(`${field} must be a finite number when usage is present`);
  }
  return ok(parsed);
}

/**
 * Validates that an optional usage counter is a finite number when present.
 *
 * @param value - Raw counter value to validate.
 * @param field - Field name for error attribution.
 * @returns Parsed finite number, `undefined` if absent, or an `invalid_request` failure.
 */
function optionalFiniteNumber(value: unknown, field: string): Result<number | undefined, NormalizedFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return invalidRequest(`${field} must be a finite number when present`);
  }
  return ok(parsed);
}

/**
 * Extracts normalized IR usage counters from an OpenAI-family usage record.
 *
 * @param rawUsage - Raw usage value from wire payload.
 * @param keys - Protocol-specific usage key mapping.
 * @returns Normalized `IrUsage`, `undefined` if absent/null, or a failure result.
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

/**
 * Parses an OpenAI Chat completion usage object into normalized IR usage.
 *
 * @param rawUsage - Raw `usage` payload from Chat response.
 * @returns Normalized `IrUsage`, `undefined` if absent/null, or an `invalid_request` failure.
 */
export function parseChatUsage(rawUsage: unknown): Result<IrUsage | undefined, NormalizedFailure> {
  return parseOpenAiUsage(rawUsage, CHAT_USAGE_KEYS);
}

/**
 * Parses an OpenAI Responses usage object into normalized IR usage.
 *
 * @param rawUsage - Raw `usage` payload from Responses response.
 * @returns Normalized `IrUsage`, `undefined` if absent/null, or an `invalid_request` failure.
 */
export function parseResponsesUsage(rawUsage: unknown): Result<IrUsage | undefined, NormalizedFailure> {
  return parseOpenAiUsage(rawUsage, RESPONSES_USAGE_KEYS);
}

/**
 * Accumulates Anthropic Messages token usage across multiple response frames or payloads.
 * Tracks presence explicitly to distinguish unobserved counters from explicit zeros.
 */
export interface MessagesUsageAccumulator {
  /** Whether any usage payload has been observed in the response stream. */
  sawUsage: boolean;

  /** Base input tokens before prompt caching, when reported. */
  inputTokens?: number;

  /** Cache read input tokens, when reported. */
  cacheReadInput?: number;

  /** Cache creation input tokens, when reported. */
  cacheWriteInput?: number;

  /** Total output tokens generated, when reported. */
  outputTokens?: number;

  /** Reasoning/thinking tokens reported in output details. */
  thinkingTokens?: number;
}

/**
 * Accumulates raw Anthropic Messages usage frames into accumulator state.
 * Validates numeric fields and rejects unsupported server tool or geography capabilities.
 *
 * @param state - Mutable usage accumulator state to update.
 * @param rawUsage - Raw usage payload from Messages response frame.
 * @returns Success if accumulated, or a normalized failure.
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
 * Collapses accumulated Messages usage into normalized IR usage.
 * Combines base input and cache tokens into overall input counter.
 *
 * @param state - Populated Messages usage accumulator.
 * @returns Normalized `IrUsage`, or `undefined` if no usage was observed.
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
 * Serializes an IR usage record into an OpenAI-family usage JSON object.
 *
 * @param usage - Normalized IR usage record.
 * @param keys - Protocol-specific usage key mapping.
 * @returns Serialized wire usage JSON object.
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

/**
 * Serializes an IR usage record into an OpenAI Chat usage JSON object.
 *
 * @param usage - Normalized IR usage record.
 * @returns Serialized Chat wire usage object.
 */
export function chatUsageBody(usage: IrUsage): JsonObject {
  return openAiUsageBody(usage, CHAT_USAGE_KEYS);
}

/**
 * Serializes an IR usage record into an OpenAI Responses usage JSON object.
 *
 * @param usage - Normalized IR usage record.
 * @returns Serialized Responses wire usage object.
 */
export function responsesUsageBody(usage: IrUsage): JsonObject {
  return openAiUsageBody(usage, RESPONSES_USAGE_KEYS);
}

/**
 * Serializes an IR usage record into an Anthropic Messages usage JSON object.
 *
 * @param usage - Normalized IR usage record.
 * @returns Serialized Messages wire usage object.
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
