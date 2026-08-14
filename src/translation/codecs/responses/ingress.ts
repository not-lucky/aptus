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
  captureBreakpoint,
  captureOutcomeWireFacts,
  parseChatResponsesWireOptions,
  parsePositiveSafeInteger,
  parseReasoningEffort,
  parseResponsesUsage,
  parseUnitIntervalControl,
  parseVerbosity,
  responsesReasoningItemFailure,
} from "../shared.ts";

const RECOGNIZED_RESPONSES_REQUEST_FIELDS = new Set([
  "model",
  "input",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "instructions",
  "previous_response_id",
  "conversation",
  "background",
  "tools",
  "tool_choice",
  "max_tool_calls",
  "include",
  "reasoning",
  "store",
  "metadata",
  "safety_identifier",
  "moderation",
  "service_tier",
  "truncation",
  "prompt_cache_key",
  "prompt_cache_options",
  "user",
  "context_management",
  "prompt",
  "top_logprobs",
]);

/**
 * Parses the `reasoning` request object: `effort` is the only admitted
 * sub-field (common five-literal set); summary controls, style/context modes,
 * and unrecognized sub-fields fail closed with their exact matrix capability
 * IDs instead of a blanket rejection. Shared by the complete and stream
 * request decoders.
 */
function parseResponsesReasoning(
  value: unknown,
): Result<"low" | "medium" | "high" | "xhigh" | "max" | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: invalidRequestFailure("reasoning must be an object when present") };
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === "effort") continue;
    if (key === "summary" || key === "generate_summary") {
      // `generate_summary` is the deprecated boolean spelling of the same
      // summary control and is owned by the same row.
      return { ok: false, error: unsupportedCapabilityFailure("responses-reasoning-summary") };
    }
    if (key === "context" || key === "mode") {
      return { ok: false, error: unsupportedCapabilityFailure("reasoning-style-context-mode") };
    }
    return { ok: false, error: invalidRequestFailure(`reasoning.${key} is not recognized`) };
  }
  return parseReasoningEffort(raw.effort);
}

/**
 * Parses a Responses request body shared verbatim by the complete ingress
 * decoder and the streaming request decoder.
 */
export function parseResponsesRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("Responses request missing required string property 'model'"),
    };
  }

  if (body.input === undefined || body.input === null) {
    return {
      ok: false,
      error: invalidRequestFailure("Responses request missing required property 'input'"),
    };
  }

  // Decoder-level capability rejections for recognized native-only facts.
  if (body.previous_response_id !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-previous-id") };
  }
  if (body.conversation !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-conversation") };
  }
  if (body.background !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-background") };
  }
  if (body.context_management !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-compaction") };
  }
  if (body.prompt !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-reusable-prompt") };
  }
  if (body.top_logprobs !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("token-logprobs") };
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
  if (body.max_tool_calls !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-max-tool-calls") };
  }
  if (body.include !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("responses-include") };
  }
  if (body.truncation !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("truncation-policy") };
  }

  const textConfig = body.text as Record<string, unknown> | undefined;
  if (textConfig !== undefined) {
    if (typeof textConfig !== "object" || textConfig === null || Array.isArray(textConfig)) {
      return { ok: false, error: invalidRequestFailure("text must be an object when present") };
    }
    for (const key of Object.keys(textConfig)) {
      if (key !== "format" && key !== "verbosity") {
        return { ok: false, error: invalidRequestFailure(`text.${key} is not recognized`) };
      }
    }
    if (textConfig.format !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("structured-json-schema") };
    }
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_RESPONSES_REQUEST_FIELDS.has(key)) {
      return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
    }
  }

  // ---- Wire-only sidecar capture (admitted fields, verbatim) ----
  const breakpoints: PromptCacheBreakpoint[] = [];
  const sidecarResult = parseChatResponsesWireOptions(body);
  if (!sidecarResult.ok) return sidecarResult;
  let wireOptions = sidecarResult.value;

  const items: IrItem[] = [];

  // Optional top-level instructions parameter
  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    items.push({
      type: "instruction",
      authority: "system",
      separation: "advisory",
      text: body.instructions,
    });
  }

  // Decode input
  if (typeof body.input === "string") {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "text", text: body.input }],
    });
  } else if (Array.isArray(body.input)) {
    if (body.input.length === 0 && items.length === 0) {
      return {
        ok: false,
        error: invalidRequestFailure("Responses input array is empty"),
      };
    }

    for (let i = 0; i < body.input.length; i++) {
      const rawItem = body.input[i];
      if (typeof rawItem !== "object" || rawItem === null) {
        if (typeof rawItem === "string") {
          items.push({
            type: "message",
            role: "user",
            content: [{ type: "text", text: rawItem }],
          });
          continue;
        }
        return {
          ok: false,
          error: invalidRequestFailure(`Responses input item [${i}] must be an object or string`),
        };
      }

      const itemObj = rawItem as Record<string, unknown>;

      // A transcript-replay `reasoning` input item is provider-owned reasoning
      // state (readable text or encrypted content) and fails closed. The
      // reasoning-handle rows own the whole item including its status field,
      // so this re-ID must run before the generic phase/status check.
      if (itemObj.type === "reasoning") {
        return { ok: false, error: responsesReasoningItemFailure(itemObj) };
      }
      if (itemObj.phase !== undefined || itemObj.status !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("responses-message-phase") };
      }
      if (itemObj.previous_response_id !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("responses-previous-id") };
      }
      if (itemObj.type === "item_reference") {
        return { ok: false, error: unsupportedCapabilityFailure("responses-item-reference") };
      }
      if (itemObj.type === "input_image") {
        return { ok: false, error: unsupportedCapabilityFailure("image-url") };
      }
      if (itemObj.type === "input_file") {
        return { ok: false, error: unsupportedCapabilityFailure("document-inline-bytes") };
      }

      // Item index this input item's IR item will occupy.
      const itemIndex = items.length;

      const role = itemObj.role;
      if (role === "system" || role === "developer") {
        let text = "";
        if (typeof itemObj.content === "string") {
          text = itemObj.content;
        } else if (Array.isArray(itemObj.content)) {
          for (const part of itemObj.content) {
            const p = part as Record<string, unknown>;
            if (p?.type === "input_text" && typeof p.text === "string") {
              text += p.text;
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(
                  breakpoints,
                  `input item [${i}] part`,
                  p.prompt_cache_breakpoint,
                  itemIndex,
                );
                if (!markerResult.ok) return markerResult;
              }
            }
          }
        }
        items.push({
          type: "instruction",
          authority: role,
          separation: "advisory",
          text,
        });
        continue;
      }

      if (role === "user" || (itemObj.type === "message" && (role === undefined || role === "user"))) {
        const parts: IrInputPart[] = [];
        if (typeof itemObj.content === "string") {
          parts.push({ type: "text", text: itemObj.content });
        } else if (Array.isArray(itemObj.content)) {
          for (let pIdx = 0; pIdx < itemObj.content.length; pIdx++) {
            const p = itemObj.content[pIdx] as Record<string, unknown>;
            if (p?.type === "input_text" && typeof p.text === "string") {
              parts.push({ type: "text", text: p.text });
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(
                  breakpoints,
                  `input item [${i}] part [${pIdx}]`,
                  p.prompt_cache_breakpoint,
                  itemIndex,
                  pIdx,
                );
                if (!markerResult.ok) return markerResult;
              }
            } else if (p?.type === "input_image") {
              return { ok: false, error: unsupportedCapabilityFailure("image-url") };
            } else if (p?.type === "input_file") {
              return { ok: false, error: unsupportedCapabilityFailure("document-inline-bytes") };
            } else {
              return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
            }
          }
        }
        if (parts.length === 0) {
          return { ok: false, error: invalidRequestFailure(`Responses input item [${i}] has empty content`) };
        }
        items.push({
          type: "message",
          role: "user",
          content: parts as unknown as NonEmpty<IrInputPart>,
        });
        continue;
      }

      if (role === "assistant") {
        const parts: IrAssistantPart[] = [];
        if (typeof itemObj.content === "string") {
          parts.push({ type: "text", text: itemObj.content });
        } else if (Array.isArray(itemObj.content)) {
          for (let pIdx = 0; pIdx < itemObj.content.length; pIdx++) {
            const p = itemObj.content[pIdx] as Record<string, unknown>;
            if (p?.type === "output_text" && typeof p.text === "string") {
              parts.push({ type: "text", text: p.text });
              // The R wire documents breakpoints only on input_text/input_image/
              // input_file blocks; the provider 400s a marker on output_text,
              // so the decode rejects the unsupported placement fail-closed.
              if (p.prompt_cache_breakpoint !== undefined) {
                return {
                  ok: false,
                  error: invalidRequestFailure(
                    `input item [${i}] part [${pIdx}] prompt_cache_breakpoint is not supported on output_text blocks`,
                  ),
                };
              }
            } else if (p?.type === "refusal") {
              return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
            } else {
              return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
            }
          }
        }
        if (parts.length === 0) {
          return { ok: false, error: invalidRequestFailure(`Responses input item [${i}] has empty content`) };
        }
        items.push({
          type: "message",
          role: "assistant",
          content: parts as unknown as NonEmpty<IrAssistantPart>,
        });
        continue;
      }

      if (itemObj.type === "function_call" || itemObj.type === "function_call_output") {
        return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
      }

      return {
        ok: false,
        error: invalidRequestFailure(`Responses input item [${i}] has unrecognized structure`),
      };
    }
  } else {
    return {
      ok: false,
      error: invalidRequestFailure("Responses input must be a string or array"),
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
  const maxTokensResult = parsePositiveSafeInteger("max_output_tokens", body.max_output_tokens);
  if (!maxTokensResult.ok) return maxTokensResult;
  const verbosityResult = parseVerbosity(textConfig?.verbosity);
  if (!verbosityResult.ok) return verbosityResult;
  const effortResult = parseResponsesReasoning(body.reasoning);
  if (!effortResult.ok) return effortResult;

  const generation: IrGenerationControls | undefined =
    temperatureResult.value !== undefined ||
    topPResult.value !== undefined ||
    maxTokensResult.value !== undefined ||
    verbosityResult.value !== undefined ||
    effortResult.value !== undefined
      ? {
          ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
          ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
          ...(maxTokensResult.value !== undefined ? { maxOutputTokens: maxTokensResult.value } : {}),
          ...(verbosityResult.value !== undefined ? { verbosity: verbosityResult.value } : {}),
          ...(effortResult.value !== undefined ? { reasoning: { effort: effortResult.value } } : {}),
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
 * Ingress decoder for OpenAI Responses requests and responses.
 *
 * Request decoding delegates to {@link parseResponsesRequestBody}, which
 * projects admitted generation controls (including the `reasoning.effort`
 * sub-field) into the IR and captures matrix-admitted wire-only fields into
 * the request wire-options sidecar; native-only state and diagnostic facts
 * fail closed with their exact matrix capability ID.
 */
export class ResponsesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseResponsesRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(status: number, _headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure> {
    if (typeof body !== "object" || body === null) {
      return {
        ok: false,
        error: invalidRequestFailure("Responses response body must be an object"),
      };
    }

    if (body.status === "failed") {
      const err = (body.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : "Responses provider returned failed status",
          code: typeof err.code === "string" ? err.code : undefined,
          retryable: false,
        },
      };
    }

    if (status >= 400) {
      const err = (body.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : `Responses provider error HTTP ${status}`,
          code: typeof err.code === "string" ? err.code : undefined,
          retryable: false,
        },
      };
    }

    const parts: IrOutputPart[] = [];
    if (Array.isArray(body.output)) {
      for (const item of body.output) {
        const itemObj = item as Record<string, unknown>;
        // Provider-owned reasoning output items fail closed: readable reasoning
        // text or encrypted content is never translated or fabricated.
        if (itemObj?.type === "reasoning") {
          return { ok: false, error: responsesReasoningItemFailure(itemObj) };
        }
        if (itemObj?.type === "message" && Array.isArray(itemObj.content)) {
          for (const contentPart of itemObj.content) {
            const cp = contentPart as Record<string, unknown>;
            if (cp?.type === "output_text") {
              parts.push({
                type: "text",
                partId: randomUUID(),
                text: typeof cp.text === "string" ? cp.text : "",
              });
            } else if (cp?.type === "refusal") {
              parts.push({
                type: "refusal",
                partId: randomUUID(),
                text: typeof cp.text === "string" ? cp.text : undefined,
              });
            } else {
              // Unknown inner content parts never vanish behind a success
              // terminator; parity with the stream decoder's rejection.
              return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
            }
          }
        } else if (itemObj?.type === "function_call") {
          parts.push({
            type: "tool_call",
            partId: randomUUID(),
            call: {
              type: "function",
              callId: String(itemObj.call_id ?? randomUUID()),
              name: String(itemObj.name ?? ""),
              argumentsText: String(itemObj.arguments ?? "{}"),
            },
          });
        } else {
          // Unknown output items never vanish behind a success terminator;
          // parity with the stream decoder's unknown-item rejection.
          return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
        }
      }
    }

    let finishReason: IrFinishReason = "stop";
    if (body.status === "incomplete") {
      const details = (body.incomplete_details ?? {}) as Record<string, unknown>;
      if (details.reason === "max_output_tokens") {
        finishReason = "length";
      } else if (details.reason === "content_filter") {
        finishReason = "content_filter";
      } else {
        finishReason = "other";
      }
    } else if (body.status === "completed") {
      finishReason = "stop";
    }

    // Usage counters plus the cache/reasoning subdivisions; parsed once in
    // shared.ts so the complete and stream paths cannot drift. Subdivisions are
    // observations and never re-added to totals.
    const usageResult = parseResponsesUsage(body.usage);
    if (!usageResult.ok) return usageResult;
    const usage = usageResult.value;

    // Response-side wire-only facts: the moderation result (stored in normal,
    // unwrapped form — Responses already carries singular verdicts) and the
    // effective service-tier echo.
    const factsResult = captureOutcomeWireFacts(body, {}, "Responses");
    if (!factsResult.ok) return factsResult;

    const outcome: IrOutcome = {
      responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      ...(usage !== undefined ? { usage } : {}),
    };

    return { ok: true, value: { irOutcome: outcome, outcomeWireOptions: factsResult.value } };
  }
}
