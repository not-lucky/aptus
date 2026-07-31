import type { JsonObject, JsonValue, Protocol } from "../domain/contracts.ts";
import type { Usage } from "../domain/usage.ts";

const decoder = new TextDecoder();
const usageEncoder = new TextEncoder();

/** Maximum nesting depth permitted for an observed raw usage object. */
const MAX_USAGE_DEPTH = 8;

/** Maximum number of object properties permitted for an observed raw usage object. */
const MAX_USAGE_PROPERTIES = 64;

/** Maximum serialized byte size permitted for an observed raw usage object. */
const MAX_USAGE_BYTES = 16 * 1024;

/**
 * Result of extracting token usage and framing markers from a provider response.
 */
export interface UsageExtractionResult {
  /** Bounded raw usage JSON object from provider. */
  readonly rawUsage?: JsonObject;
  /** Normalized Usage object for cost computation. */
  readonly normalizedUsage?: Usage;
  /** Whether the stream concluded with a valid protocol-mandated terminal marker. */
  readonly hasValidTerminal: boolean;
  /** Whether the stream concluded with a provider in-band error event. */
  readonly isProviderError: boolean;
}

/**
 * Incremental parser for tracking SSE chunk boundaries, stream terminals, and token usage.
 */
export interface StreamUsageCollector {
  /** Ingests one incoming stream chunk. */
  feed(chunk: Uint8Array): void;
  /** Finalizes parsing and produces usage and framing facts. */
  finish(): UsageExtractionResult;
}

/**
 * Extracts raw usage and normalized cost usage from a complete parsed JSON body.
 *
 * @param protocol - The provider protocol.
 * @param body - The complete parsed JSON response object.
 * @returns Extracted raw usage and normalized usage, if available.
 */
export function extractCompleteUsage(
  protocol: Protocol,
  body: JsonObject,
): { readonly rawUsage?: JsonObject; readonly normalizedUsage?: Usage } {
  const usageField = body.usage;
  if (usageField === null || typeof usageField !== "object" || Array.isArray(usageField)) {
    return {};
  }
  const rawUsage = usageField as JsonObject;
  if (!isBoundedUsage(rawUsage)) return {};
  return { rawUsage, normalizedUsage: normalizeUsage(protocol, rawUsage) };
}

/**
 * Creates an incremental SSE parser for capturing streaming token usage and verifying protocol termination.
 *
 * @param protocol - Target provider protocol.
 * @returns A {@link StreamUsageCollector}.
 */
export function createStreamUsageCollector(protocol: Protocol): StreamUsageCollector {
  let buffer = "";
  let currentEventName = "";
  let rawUsage: JsonObject | undefined;
  let hasValidTerminal = false;
  let isProviderError = false;

  // Anthropic cumulative usage tracking across message_start and message_delta
  let anthropicMessageStartUsage: JsonObject | undefined;
  let anthropicMessageDeltaUsage: JsonObject | undefined;

  function processLine(line: string): void {
    const trimmed = line.trimEnd();
    if (trimmed === "") {
      currentEventName = "";
      return;
    }

    if (trimmed.startsWith("event:")) {
      currentEventName = trimmed.slice(6).trim();
      if (protocol === "anthropic-messages" && currentEventName === "error") {
        isProviderError = true;
      }
      return;
    }

    if (!trimmed.startsWith("data:")) {
      return;
    }

    const dataStr = trimmed.slice(5).trim();

    if (protocol === "openai-chat") {
      if (dataStr === "[DONE]") {
        hasValidTerminal = true;
        return;
      }
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          parsed.usage !== null &&
          typeof parsed.usage === "object"
        ) {
          rawUsage = parsed.usage as JsonObject;
        }
      } catch {
        // Ignore unparseable SSE data chunk
      }
    } else if (protocol === "openai-responses") {
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        const type = parsed?.type ?? currentEventName;
        if (
          type === "response.completed" ||
          type === "response.failed" ||
          type === "response.incomplete" ||
          type === "error"
        ) {
          hasValidTerminal = true;
          if (type === "error") {
            isProviderError = true;
          }
          if (parsed !== null && typeof parsed === "object") {
            const resp = parsed.response as Record<string, unknown> | undefined;
            if (resp?.usage !== null && typeof resp?.usage === "object") {
              rawUsage = resp.usage as JsonObject;
            } else if (parsed.usage !== null && typeof parsed.usage === "object") {
              rawUsage = parsed.usage as JsonObject;
            }
          }
        }
      } catch {
        // Ignore unparseable SSE data chunk
      }
    } else if (protocol === "anthropic-messages") {
      if (currentEventName === "message_stop") {
        hasValidTerminal = true;
        return;
      }
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        const type = parsed?.type ?? currentEventName;
        if (type === "message_stop") {
          hasValidTerminal = true;
        } else if (type === "error") {
          isProviderError = true;
        } else if (type === "message_start") {
          const msg = parsed.message as Record<string, unknown> | undefined;
          if (msg?.usage !== null && typeof msg?.usage === "object") {
            anthropicMessageStartUsage = msg.usage as JsonObject;
          }
        } else if (type === "message_delta") {
          if (parsed.usage !== null && typeof parsed.usage === "object") {
            anthropicMessageDeltaUsage = parsed.usage as JsonObject;
          }
        }
      } catch {
        // Ignore unparseable SSE data chunk
      }
    }
  }

  return {
    feed(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      // Retain incomplete trailing line in buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },

    finish(): UsageExtractionResult {
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = "";
      }

      if (protocol === "anthropic-messages") {
        if (anthropicMessageStartUsage !== undefined || anthropicMessageDeltaUsage !== undefined) {
          rawUsage = {
            ...(anthropicMessageStartUsage ?? {}),
            ...(anthropicMessageDeltaUsage ?? {}),
          };
        }
      }

      if (rawUsage !== undefined && !isBoundedUsage(rawUsage)) {
        rawUsage = undefined;
      }

      const normalizedUsage = rawUsage !== undefined ? normalizeUsage(protocol, rawUsage) : undefined;

      return {
        rawUsage,
        normalizedUsage,
        hasValidTerminal,
        isProviderError,
      };
    },
  };
}

/**
 * Dispatches raw usage normalization to the protocol-specific projection.
 */
function normalizeUsage(protocol: Protocol, raw: JsonObject): Usage | undefined {
  if (protocol === "anthropic-messages") return normalizeAnthropicUsage(raw);
  if (protocol === "openai-responses") return normalizeResponsesUsage(raw);
  return normalizeOpenAiUsage(raw);
}

/**
 * Normalizes OpenAI Chat Completions token counts into non-overlapping billing counters.
 */
function normalizeOpenAiUsage(raw: JsonObject): Usage | undefined {
  const promptTokens = raw.prompt_tokens;
  const completionTokens = raw.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || (promptTokens as number) < 0) return undefined;
  if (!Number.isSafeInteger(completionTokens) || (completionTokens as number) < 0) return undefined;

  let cacheRead = 0;
  const cacheWrite = 0;
  if (raw.prompt_tokens_details !== null && typeof raw.prompt_tokens_details === "object") {
    const details = raw.prompt_tokens_details as Record<string, unknown>;
    if (Number.isSafeInteger(details.cached_tokens) && (details.cached_tokens as number) >= 0) {
      cacheRead = details.cached_tokens as number;
    }
  }

  const uncachedInput = (promptTokens as number) - (cacheRead + cacheWrite);
  if (uncachedInput < 0 || !Number.isSafeInteger(uncachedInput)) return undefined;

  return {
    input: uncachedInput,
    output: completionTokens as number,
    total:
      typeof raw.total_tokens === "number" ? raw.total_tokens : (promptTokens as number) + (completionTokens as number),
    cacheReadInput: cacheRead > 0 ? cacheRead : undefined,
    cacheWriteInput: cacheWrite > 0 ? cacheWrite : undefined,
  };
}

/**
 * Normalizes OpenAI Responses token counts into non-overlapping billing counters.
 *
 * The Responses API reports `input_tokens`/`output_tokens` (unlike Chat's
 * `prompt_tokens`/`completion_tokens`) with cache details nested under
 * `input_tokens_details` (`cached_tokens`, `cache_write_tokens`).
 */
function normalizeResponsesUsage(raw: JsonObject): Usage | undefined {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) return undefined;
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) return undefined;

  let cacheRead = 0;
  let cacheWrite = 0;
  if (raw.input_tokens_details !== null && typeof raw.input_tokens_details === "object") {
    const details = raw.input_tokens_details as Record<string, unknown>;
    if (Number.isSafeInteger(details.cached_tokens) && (details.cached_tokens as number) >= 0) {
      cacheRead = details.cached_tokens as number;
    }
    if (Number.isSafeInteger(details.cache_write_tokens) && (details.cache_write_tokens as number) >= 0) {
      cacheWrite = details.cache_write_tokens as number;
    }
  }

  const uncachedInput = (inputTokens as number) - (cacheRead + cacheWrite);
  if (uncachedInput < 0 || !Number.isSafeInteger(uncachedInput)) return undefined;

  return {
    input: uncachedInput,
    output: outputTokens as number,
    total: typeof raw.total_tokens === "number" ? raw.total_tokens : (inputTokens as number) + (outputTokens as number),
    cacheReadInput: cacheRead > 0 ? cacheRead : undefined,
    cacheWriteInput: cacheWrite > 0 ? cacheWrite : undefined,
  };
}

/**
 * Normalizes Anthropic Messages token counts into non-overlapping billing counters.
 */
function normalizeAnthropicUsage(raw: JsonObject): Usage | undefined {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) return undefined;
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) return undefined;

  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  if (Number.isSafeInteger(raw.cache_read_input_tokens) && (raw.cache_read_input_tokens as number) >= 0) {
    cacheRead = raw.cache_read_input_tokens as number;
  }
  if (Number.isSafeInteger(raw.cache_creation_input_tokens) && (raw.cache_creation_input_tokens as number) >= 0) {
    cacheWrite = raw.cache_creation_input_tokens as number;
  }

  return {
    input: inputTokens as number,
    output: outputTokens as number,
    total: (inputTokens as number) + (outputTokens as number) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    cacheReadInput: cacheRead,
    cacheWriteInput: cacheWrite,
  };
}

/**
 * `true` when a raw usage object stays within the explicit depth, property, and
 * byte limits. Oversized or deeply nested provider usage is omitted from logs
 * and terminal output and suppresses cost rather than failing or resizing the
 * request path.
 */
function isBoundedUsage(raw: JsonObject): boolean {
  let properties = 0;
  let bytes = 0;

  function walk(value: JsonValue, depth: number): boolean {
    if (depth > MAX_USAGE_DEPTH) return false;
    if (typeof value === "string") {
      bytes += usageEncoder.encode(value).length;
      return bytes <= MAX_USAGE_BYTES;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (!walk(child, depth + 1)) return false;
      }
      return true;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      properties += entries.length;
      if (properties > MAX_USAGE_PROPERTIES) return false;
      for (const [, child] of entries) {
        if (!walk(child, depth + 1)) return false;
      }
    }
    return true;
  }

  return walk(raw, 0);
}
