import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  IngressDecoder,
  OutcomeDecodeResult,
  PromptCacheBreakpoint,
  RequestDecodeResult,
} from "../../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../../failures.ts";
import type {
  IrAssistantPart,
  IrFinishReason,
  IrGenerationControls,
  IrInputPart,
  IrItem,
  IrOutcome,
  IrOutputPart,
  IrRequest,
  NonEmpty,
} from "../../ir.ts";
import {
  asNonEmptyStopSequences,
  captureBreakpoint,
  captureOutcomeWireFacts,
  parseChatResponsesWireOptions,
  parseChatUsage,
  parsePositiveSafeInteger,
  parseReasoningEffort,
  parseStopSequenceEntries,
  parseUnitIntervalControl,
  parseVerbosity,
} from "../shared.ts";

const RECOGNIZED_CHAT_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_completion_tokens",
  "max_tokens",
  "stop",
  "verbosity",
  "reasoning_effort",
  "parallel_tool_calls",
  "n",
  "store",
  "metadata",
  "user",
  "seed",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "frequency_penalty",
  "presence_penalty",
  "moderation",
  "service_tier",
  "safety_identifier",
  "prediction",
  "stream_options",
  "functions",
  "function_call",
  "tools",
  "tool_choice",
  "response_format",
  "audio",
  "modalities",
  "prompt_cache_key",
  "prompt_cache_options",
]);

/**
 * Parses a Chat request body shared verbatim by the complete ingress decoder
 * and the streaming request decoder: capability rejections, sidecar capture,
 * transcript items, and generation controls are defined exactly once.
 */
export function parseChatRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("Chat request missing required string property 'model'"),
    };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      ok: false,
      error: invalidRequestFailure("Chat request missing required non-empty array property 'messages'"),
    };
  }

  // Decoder-level capability rejections for recognized non-admitted wire facts.
  // Admitted wire-only fields (store, metadata/user, moderation, service_tier,
  // safety_identifier, prompt-cache controls) are captured into the sidecar
  // below instead of rejected — the decoder has no direction, so it must not
  // decide T1 vs T2 vs T3.
  if (body.n !== undefined && body.n !== 1) {
    return { ok: false, error: unsupportedCapabilityFailure("multiple-candidates") };
  }
  if (body.seed !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("seed-determinism") };
  }
  if (body.logit_bias !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("token-logit-bias") };
  }
  if (body.logprobs !== undefined || body.top_logprobs !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("token-logprobs") };
  }
  if (body.frequency_penalty !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("frequency-penalty") };
  }
  if (body.presence_penalty !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("presence-penalty") };
  }
  if (body.prediction !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("chat-predicted-outputs") };
  }
  // Complete-path requests reject the stream usage carrier outright
  // (`stream-final-usage` row); the streaming request decoder parses
  // `stream_options.include_usage` instead.
  if (delivery === "complete" && body.stream_options !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("stream-final-usage") };
  }
  if (body.functions !== undefined || body.function_call !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("chat-legacy-functions") };
  }
  if (body.max_tokens !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("chat-legacy-max-tokens") };
  }
  if (body.tools !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
  }
  if (body.tool_choice !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("tool-choice-none-auto-required") };
  }
  if (body.parallel_tool_calls !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("parallel-tool-calls") };
  }
  if (body.response_format !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("structured-json-schema") };
  }
  if (body.audio !== undefined || body.modalities !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("audio-input") };
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_CHAT_REQUEST_FIELDS.has(key)) {
      return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
    }
  }

  // ---- Wire-only sidecar capture (admitted fields, verbatim) ----
  const breakpoints: PromptCacheBreakpoint[] = [];
  const sidecarResult = parseChatResponsesWireOptions(body);
  if (!sidecarResult.ok) return sidecarResult;
  let wireOptions = sidecarResult.value;

  // Decode messages
  const items: IrItem[] = [];
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (typeof msg !== "object" || msg === null) {
      return {
        ok: false,
        error: invalidRequestFailure(`Chat message [${i}] must be an object`),
      };
    }
    const rawMsg = msg as Record<string, unknown>;
    const role = rawMsg.role;

    if (rawMsg.name !== undefined && rawMsg.name !== null && String(rawMsg.name).trim() !== "") {
      return { ok: false, error: unsupportedCapabilityFailure("message-name") };
    }

    // Item index this message's IR item will occupy; breakpoint anchors on
    // its content parts refer to this position.
    const itemIndex = items.length;

    if (role === "system" || role === "developer") {
      let text = "";
      if (typeof rawMsg.content === "string") {
        text = rawMsg.content;
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const part = rawMsg.content[pIdx] as Record<string, unknown>;
          if (part?.type === "text" && typeof part.text === "string") {
            text += part.text;
            if (part.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                breakpoints,
                `message [${i}] part [${pIdx}]`,
                part.prompt_cache_breakpoint,
                itemIndex,
              );
              if (!markerResult.ok) return markerResult;
            }
          } else {
            return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
          }
        }
      } else {
        return {
          ok: false,
          error: invalidRequestFailure(`Instruction message [${i}] missing string or array content`),
        };
      }
      items.push({
        type: "instruction",
        authority: role,
        separation: "advisory",
        text,
      });
      continue;
    }

    if (role === "user") {
      const parts: IrInputPart[] = [];
      if (typeof rawMsg.content === "string") {
        parts.push({ type: "text", text: rawMsg.content });
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const rawPart = rawMsg.content[pIdx] as Record<string, unknown>;
          if (rawPart?.type === "text" && typeof rawPart.text === "string") {
            parts.push({ type: "text", text: rawPart.text });
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                breakpoints,
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
            }
          } else if (rawPart?.type === "image_url") {
            return { ok: false, error: unsupportedCapabilityFailure("image-url") };
          } else if (rawPart?.type === "input_audio") {
            return { ok: false, error: unsupportedCapabilityFailure("audio-input") };
          } else {
            return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
          }
        }
      } else {
        return {
          ok: false,
          error: invalidRequestFailure(`User message [${i}] missing string or array content`),
        };
      }
      if (parts.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`User message [${i}] has empty content`),
        };
      }
      items.push({
        type: "message",
        role: "user",
        content: parts as unknown as NonEmpty<IrInputPart>,
      });
      continue;
    }

    if (role === "assistant") {
      if (rawMsg.tool_calls !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
      }
      if (rawMsg.audio !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("audio-output") };
      }

      const parts: IrAssistantPart[] = [];
      if (typeof rawMsg.content === "string") {
        parts.push({ type: "text", text: rawMsg.content });
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const rawPart = rawMsg.content[pIdx] as Record<string, unknown>;
          if (rawPart?.type === "text" && typeof rawPart.text === "string") {
            parts.push({ type: "text", text: rawPart.text });
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                breakpoints,
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
            }
          } else if (rawPart?.type === "refusal") {
            return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
          } else {
            return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
          }
        }
      } else if (rawMsg.refusal !== undefined && rawMsg.refusal !== null) {
        return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
      } else {
        return {
          ok: false,
          error: invalidRequestFailure(`Assistant message [${i}] missing string or array content`),
        };
      }
      if (parts.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`Assistant message [${i}] has empty content`),
        };
      }
      items.push({
        type: "message",
        role: "assistant",
        content: parts as unknown as NonEmpty<IrAssistantPart>,
      });
      continue;
    }

    if (role === "function") {
      return { ok: false, error: unsupportedCapabilityFailure("chat-legacy-function-role") };
    }
    if (role === "tool") {
      return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
    }

    return {
      ok: false,
      error: invalidRequestFailure(`Unknown role '${String(role)}' in Chat message [${i}]`),
    };
  }

  if (breakpoints.length > 0) {
    wireOptions = { ...wireOptions, promptCacheBreakpoints: breakpoints };
  }

  // ---- Generation controls (strict bounds; never clamped, never dropped) ----
  const temperatureResult = parseUnitIntervalControl("temperature", body.temperature, "temperature-0-1");
  if (!temperatureResult.ok) return temperatureResult;
  const topPResult = parseUnitIntervalControl("top_p", body.top_p, "top-p-0-1");
  if (!topPResult.ok) return topPResult;
  const maxTokensResult = parsePositiveSafeInteger("max_completion_tokens", body.max_completion_tokens);
  if (!maxTokensResult.ok) return maxTokensResult;
  const verbosityResult = parseVerbosity(body.verbosity);
  if (!verbosityResult.ok) return verbosityResult;
  const effortResult = parseReasoningEffort(body.reasoning_effort);
  if (!effortResult.ok) return effortResult;

  let stopSequences: NonEmpty<string> | undefined;
  if (typeof body.stop === "string") {
    if (body.stop.length === 0) {
      return { ok: false, error: invalidRequestFailure("stop must be a non-empty string or non-empty array") };
    }
    stopSequences = [body.stop];
  } else if (Array.isArray(body.stop)) {
    // The Chat schema admits 1-4 entries; larger sets are invalid Chat wire.
    // (The >4 stop-sequence-request rejection applies to M-origin sets only.)
    if (body.stop.length === 0 || body.stop.length > 4) {
      return { ok: false, error: invalidRequestFailure("stop must contain between 1 and 4 entries") };
    }
    const entriesResult = parseStopSequenceEntries("stop", body.stop);
    if (!entriesResult.ok) return entriesResult;
    stopSequences = asNonEmptyStopSequences(entriesResult.value);
  } else if (body.stop !== undefined && body.stop !== null) {
    return { ok: false, error: invalidRequestFailure("stop must be a string or an array of strings") };
  }

  const generation: IrGenerationControls | undefined =
    temperatureResult.value !== undefined ||
    topPResult.value !== undefined ||
    maxTokensResult.value !== undefined ||
    verbosityResult.value !== undefined ||
    effortResult.value !== undefined ||
    stopSequences !== undefined
      ? {
          ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
          ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
          ...(maxTokensResult.value !== undefined ? { maxOutputTokens: maxTokensResult.value } : {}),
          ...(verbosityResult.value !== undefined ? { verbosity: verbosityResult.value } : {}),
          ...(effortResult.value !== undefined ? { reasoning: { effort: effortResult.value } } : {}),
          ...(stopSequences !== undefined ? { stopSequences } : {}),
        }
      : undefined;

  const irRequest: IrRequest = {
    model: body.model,
    delivery,
    items,
    ...(generation !== undefined ? { generation } : {}),
  };

  return { ok: true, value: { irRequest, requestWireOptions: wireOptions } };
}

/**
 * Ingress decoder for OpenAI Chat Completions requests and responses.
 *
 * Request decoding delegates to {@link parseChatRequestBody}, which projects
 * admitted generation controls into the IR and captures matrix-admitted
 * wire-only fields (storage, prompt-cache controls, metadata, safety identity,
 * moderation, service tier) into the request wire-options sidecar; direction
 * feasibility for those fields is decided later by preflight, not here.
 * Recognized native-only facts fail closed immediately with their exact matrix
 * capability ID.
 */
export class ChatIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseChatRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(
    _status: number,
    _headers: HeaderMap,
    body: JsonObject,
  ): Result<OutcomeDecodeResult, NormalizedFailure> {
    if (typeof body !== "object" || body === null) {
      return {
        ok: false,
        error: invalidRequestFailure("Chat response body must be an object"),
      };
    }

    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      return {
        ok: false,
        error: invalidRequestFailure("Chat response missing choices array"),
      };
    }

    const choice = body.choices[0] as Record<string, unknown>;
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const partId = randomUUID();
    const parts: IrOutputPart[] = [];

    if (message.refusal !== undefined && message.refusal !== null) {
      parts.push({
        type: "refusal",
        partId,
        text: String(message.refusal),
      });
    } else if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const tc = message.tool_calls[0] as Record<string, unknown>;
      const fn = (tc?.function ?? {}) as Record<string, unknown>;
      parts.push({
        type: "tool_call",
        partId,
        call: {
          type: "function",
          callId: String(tc?.id ?? randomUUID()),
          name: String(fn?.name ?? ""),
          argumentsText: String(fn?.arguments ?? "{}"),
        },
      });
    } else {
      parts.push({
        type: "text",
        partId,
        text: typeof message.content === "string" ? message.content : "",
      });
    }

    let finishReason: IrFinishReason = "stop";
    const rawReason = choice?.finish_reason;
    if (rawReason === "stop") {
      finishReason = "stop";
    } else if (rawReason === "length") {
      finishReason = "length";
    } else if (rawReason === "tool_calls") {
      finishReason = "tool_calls";
    } else if (rawReason === "content_filter") {
      finishReason = "content_filter";
    } else if (rawReason !== null && rawReason !== undefined) {
      finishReason = "other";
    }

    // Usage counters plus the cache/reasoning subdivisions (`usage-cache-read`,
    // `usage-cache-write`, `usage-reasoning`), parsed once in shared.ts so the
    // complete and stream paths cannot drift. Subdivisions are observations and
    // are never re-added to totals; absence of the whole usage object stays
    // absence (never fabricated as zeros).
    const usageResult = parseChatUsage(body.usage);
    if (!usageResult.ok) return usageResult;
    const usage = usageResult.value;

    // Response-side wire-only facts: the moderation result (stored in normal,
    // unwrapped form) and the effective service-tier echo.
    const factsResult = captureOutcomeWireFacts(body, {}, "Chat response");
    if (!factsResult.ok) return factsResult;

    const outcome: IrOutcome = {
      responseId: randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      ...(usage !== undefined ? { usage } : {}),
    };

    return { ok: true, value: { irOutcome: outcome, outcomeWireOptions: factsResult.value } };
  }
}
