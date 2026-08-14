import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  IngressDecoder,
  OutcomeDecodeResult,
  OutcomeWireOptions,
  PromptCacheBreakpoint,
  RequestDecodeResult,
  RequestWireOptions,
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
  IrUsage,
  NonEmpty,
} from "../../ir.ts";
import {
  accumulateMessagesUsage,
  asNonEmptyStopSequences,
  collapseMessagesUsage,
  MESSAGES_SERVICE_TIERS,
  type MessagesUsageAccumulator,
  parseEnumLiteral,
  parseStopSequenceEntries,
  parseUnitIntervalControl,
} from "../shared.ts";

const RECOGNIZED_MESSAGES_REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
  "container",
  "metadata",
  "top_k",
  "output_config",
  "service_tier",
  "inference_geo",
  "cache_control",
]);

/** TTL literals admitted on Anthropic cache_control markers (declared loss in translation). */
const MESSAGES_CACHE_CONTROL_TTLS = new Set(["5m", "1h"]);

/**
 * Validates one Anthropic `cache_control` marker: exactly `{type: "ephemeral"}`
 * with an optional documented TTL (`5m|1h`). The TTL is accepted and then
 * deliberately dropped — cross-protocol mapping is marker-only with declared
 * TTL loss (`prompt-cache-breakpoint` row).
 */
function parseMessagesCacheControl(path: string, value: unknown): Result<void, NormalizedFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: invalidRequestFailure(`${path} cache_control must be an object`) };
  }
  const marker = value as Record<string, unknown>;
  for (const key of Object.keys(marker)) {
    if (key !== "type" && key !== "ttl") {
      return { ok: false, error: invalidRequestFailure(`${path} cache_control.${key} is not recognized`) };
    }
  }
  if (marker.type !== "ephemeral") {
    return { ok: false, error: invalidRequestFailure(`${path} cache_control.type must be 'ephemeral'`) };
  }
  if (marker.ttl !== undefined && (typeof marker.ttl !== "string" || !MESSAGES_CACHE_CONTROL_TTLS.has(marker.ttl))) {
    return { ok: false, error: invalidRequestFailure(`${path} cache_control.ttl must be '5m' or '1h'`) };
  }
  return { ok: true, value: undefined };
}

/**
 * Classifies the `thinking` request control into its matrix-row failure: a
 * `budget_tokens` sub-field is the `reasoning-budget` trigger; every other
 * shape (`display`, bare `{type}` objects such as `{type:"disabled"}`,
 * unrecognized sub-fields) is the `anthropic-thinking-display` trigger. The
 * control is never admitted, so this always yields a failure.
 */
function parseMessagesThinking(value: unknown): NormalizedFailure {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (raw.budget_tokens !== undefined) {
      return unsupportedCapabilityFailure("reasoning-budget");
    }
  }
  return unsupportedCapabilityFailure("anthropic-thinking-display");
}

/**
 * Classifies the `output_config` request control into its matrix-row failure:
 * `effort` is the M `reasoning-effort-common` trigger (same five shared
 * literals, blocked in every M direction); `format` stays the
 * `structured-json-schema` trigger. The check is key-order-independent, and an
 * object carrying neither sub-field is structurally invalid. The control is
 * never admitted, so this always yields a failure.
 */
function parseMessagesOutputConfig(value: unknown): NormalizedFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequestFailure("output_config must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "effort" && key !== "format") {
      return invalidRequestFailure(`output_config.${key} is not recognized`);
    }
  }
  if (raw.effort !== undefined) {
    return unsupportedCapabilityFailure("reasoning-effort-common");
  }
  if (raw.format !== undefined) {
    return unsupportedCapabilityFailure("structured-json-schema");
  }
  return invalidRequestFailure("output_config must carry 'effort' or 'format'");
}

/**
 * Parses a Messages request body shared verbatim by the complete ingress
 * decoder and the streaming request decoder. The cache-control, thinking,
 * and output_config rules also live here so both paths cannot drift.
 */
export function parseMessagesRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("Messages request missing required string property 'model'"),
    };
  }

  // Anthropic Messages wire format requires max_tokens as a positive integer
  if (typeof body.max_tokens !== "number" || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) {
    return {
      ok: false,
      error: invalidRequestFailure("Messages request missing required positive safe integer property 'max_tokens'"),
    };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      ok: false,
      error: invalidRequestFailure("Messages request missing required non-empty array property 'messages'"),
    };
  }

  // Decoder-level capability rejections for recognized native-only facts.
  if (body.tools !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
  }
  if (body.tool_choice !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("tool-choice-none-auto-required") };
  }
  // The top-level `container` reuse param is the anthropic-container-reuse
  // row; the hosted code-execution resource (container_upload block) is the
  // separate provider-container row owned by client tools.
  if (body.container !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("anthropic-container-reuse") };
  }
  if (body.inference_geo !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("inference-geography") };
  }
  if (body.top_k !== undefined) {
    return { ok: false, error: unsupportedCapabilityFailure("top-k") };
  }
  if (body.thinking !== undefined) {
    return { ok: false, error: parseMessagesThinking(body.thinking) };
  }
  if (body.output_config !== undefined) {
    return { ok: false, error: parseMessagesOutputConfig(body.output_config) };
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_MESSAGES_REQUEST_FIELDS.has(key)) {
      return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
    }
  }

  // ---- Wire-only sidecar capture (T2-admitted fields) ----
  const breakpoints: PromptCacheBreakpoint[] = [];

  // Validates one per-block cache_control marker and records its IR anchor.
  const captureBreakpoint = (
    path: string,
    marker: unknown,
    anchor: PromptCacheBreakpoint,
  ): Result<void, NormalizedFailure> => {
    const markerResult = parseMessagesCacheControl(path, marker);
    if (!markerResult.ok) return markerResult;
    breakpoints.push(anchor);
    return { ok: true, value: undefined };
  };

  // metadata accepts only the user_id kv entry. The M wire documents no
  // other key, so a foreign key is malformed M wire (`invalid_request`) —
  // not a capability rejection, because the `request-metadata` row itself is
  // T2-admitted in every M direction.
  let metadata: Record<string, string> | undefined;
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)) {
      return { ok: false, error: invalidRequestFailure("metadata must be an object when present") };
    }
    const rawMetadata = body.metadata as Record<string, unknown>;
    for (const key of Object.keys(rawMetadata)) {
      if (key !== "user_id") {
        return {
          ok: false,
          error: invalidRequestFailure(`metadata supports only the 'user_id' key on the Messages wire, got '${key}'`),
        };
      }
    }
    const userId = rawMetadata.user_id;
    if (userId !== undefined) {
      if (typeof userId !== "string") {
        return { ok: false, error: invalidRequestFailure("metadata.user_id must be a string") };
      }
      metadata = { user_id: userId };
    }
  }

  // service_tier admits auto|standard_only; only `auto` ever maps across.
  const tierResult = parseEnumLiteral("service_tier", body.service_tier, MESSAGES_SERVICE_TIERS);
  if (!tierResult.ok) return tierResult;

  // Top-level cache_control auto-marker: a sentinel breakpoint anchored to
  // the final content block of the request (resolved once items are decoded).
  let hasTopLevelMarker = false;
  if (body.cache_control !== undefined) {
    const markerResult = parseMessagesCacheControl("request", body.cache_control);
    if (!markerResult.ok) return markerResult;
    hasTopLevelMarker = true;
  }

  const items: IrItem[] = [];

  // System instruction blocks
  if (typeof body.system === "string" && body.system.trim() !== "") {
    items.push({
      type: "instruction",
      authority: "system",
      separation: "advisory",
      text: body.system,
    });
  } else if (Array.isArray(body.system)) {
    for (let bIdx = 0; bIdx < body.system.length; bIdx++) {
      const block = body.system[bIdx];
      if (typeof block === "string") {
        items.push({
          type: "instruction",
          authority: "system",
          separation: "advisory",
          text: block,
        });
      } else if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          items.push({
            type: "instruction",
            authority: "system",
            separation: "advisory",
            text: b.text,
          });
          if (b.cache_control !== undefined) {
            const markerResult = captureBreakpoint(`system block [${bIdx}]`, b.cache_control, {
              itemIndex: items.length - 1,
            });
            if (!markerResult.ok) return markerResult;
          }
        } else {
          return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
        }
      } else {
        return { ok: false, error: invalidRequestFailure(`system block [${bIdx}] must be a string or object`) };
      }
    }
  }

  // Decode messages
  for (let i = 0; i < body.messages.length; i++) {
    const rawMsg = body.messages[i];
    if (typeof rawMsg !== "object" || rawMsg === null) {
      return {
        ok: false,
        error: invalidRequestFailure(`Messages message [${i}] must be an object`),
      };
    }
    const msgObj = rawMsg as Record<string, unknown>;
    const role = msgObj.role;

    // M schema accepts `mid_conv_system`, but official prose prohibits a
    // system message role: the `mid-conversation-instruction` Blocked
    // Capability applies to every M direction (protocol-ir.md).
    if (role === "mid_conv_system") {
      return { ok: false, error: unsupportedCapabilityFailure("mid-conversation-instruction") };
    }

    // Item index this message's IR item will occupy.
    const itemIndex = items.length;

    if (role === "user") {
      const parts: IrInputPart[] = [];
      if (typeof msgObj.content === "string") {
        parts.push({ type: "text", text: msgObj.content });
      } else if (Array.isArray(msgObj.content)) {
        for (let pIdx = 0; pIdx < msgObj.content.length; pIdx++) {
          const block = msgObj.content[pIdx] as Record<string, unknown>;
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push({ type: "text", text: block.text });
            if (block.cache_control !== undefined) {
              const markerResult = captureBreakpoint(`message [${i}] block [${pIdx}]`, block.cache_control, {
                itemIndex,
                partIndex: pIdx,
              });
              if (!markerResult.ok) return markerResult;
            }
          } else if (block?.type === "image") {
            return { ok: false, error: unsupportedCapabilityFailure("image-url") };
          } else if (block?.type === "document") {
            return { ok: false, error: unsupportedCapabilityFailure("document-inline-bytes") };
          } else if (block?.type === "tool_result") {
            return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
          } else {
            return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
          }
        }
      } else {
        return {
          ok: false,
          error: invalidRequestFailure(`Messages user message [${i}] missing string or array content`),
        };
      }
      if (parts.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`Messages user message [${i}] has empty content`),
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
      const parts: IrAssistantPart[] = [];
      if (typeof msgObj.content === "string") {
        parts.push({ type: "text", text: msgObj.content });
      } else if (Array.isArray(msgObj.content)) {
        for (let pIdx = 0; pIdx < msgObj.content.length; pIdx++) {
          const block = msgObj.content[pIdx] as Record<string, unknown>;
          if (block?.type === "text" && typeof block.text === "string") {
            // A signature outside a thinking block is still a provider-owned
            // reasoning continuation handle; fail closed before any capture.
            if (block.signature !== undefined) {
              return { ok: false, error: unsupportedCapabilityFailure("reasoning-signature") };
            }
            parts.push({ type: "text", text: block.text });
            if (block.cache_control !== undefined) {
              const markerResult = captureBreakpoint(`message [${i}] block [${pIdx}]`, block.cache_control, {
                itemIndex,
                partIndex: pIdx,
              });
              if (!markerResult.ok) return markerResult;
            }
          } else if (block?.type === "tool_use") {
            return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
          } else if (block?.type === "thinking") {
            // Provider-owned readable reasoning with continuation semantics.
            return { ok: false, error: unsupportedCapabilityFailure("readable-reasoning") };
          } else if (block?.type === "redacted_thinking") {
            // Provider-redacted reasoning payload; never synthesized.
            return { ok: false, error: unsupportedCapabilityFailure("redacted-reasoning") };
          } else {
            return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
          }
        }
      } else {
        return {
          ok: false,
          error: invalidRequestFailure(`Messages assistant message [${i}] missing string or array content`),
        };
      }
      if (parts.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`Messages assistant message [${i}] has empty content`),
        };
      }
      items.push({
        type: "message",
        role: "assistant",
        content: parts as unknown as NonEmpty<IrAssistantPart>,
      });
      continue;
    }

    return {
      ok: false,
      error: invalidRequestFailure(`Messages message [${i}] has unrecognized role '${String(role)}'`),
    };
  }

  // Anchor the top-level auto-marker sentinel to the final content block.
  if (hasTopLevelMarker) {
    const lastIndex = items.length - 1;
    // The last item is provably a message: body.messages is validated non-empty
    // and every decoded message pushes exactly one message item.
    const lastItem = items[lastIndex] as Extract<IrItem, { type: "message" }>;
    breakpoints.push({ itemIndex: lastIndex, partIndex: lastItem.content.length - 1 });
  }

  const wireOptions: RequestWireOptions = {
    ...(metadata !== undefined ? { metadata } : {}),
    ...(tierResult.value !== undefined ? { serviceTier: tierResult.value } : {}),
    ...(breakpoints.length > 0 ? { promptCacheBreakpoints: breakpoints } : {}),
  };

  // ---- Generation controls (strict bounds; never clamped, never dropped) ----
  const temperatureResult = parseUnitIntervalControl("temperature", body.temperature, "temperature-0-1");
  if (!temperatureResult.ok) return temperatureResult;
  const topPResult = parseUnitIntervalControl("top_p", body.top_p, "top-p-0-1");
  if (!topPResult.ok) return topPResult;

  let stopSequences: NonEmpty<string> | undefined;
  if (body.stop_sequences !== undefined && body.stop_sequences !== null) {
    if (!Array.isArray(body.stop_sequences)) {
      return { ok: false, error: invalidRequestFailure("stop_sequences must be an array of strings") };
    }
    // The IR admits stop sequences only as a non-empty set (protocol-ir.md),
    // so an empty array is invalid M wire rather than absence.
    if (body.stop_sequences.length === 0) {
      return { ok: false, error: invalidRequestFailure("stop_sequences must contain at least one entry when present") };
    }
    const entriesResult = parseStopSequenceEntries("stop_sequences", body.stop_sequences);
    if (!entriesResult.ok) return entriesResult;
    stopSequences = asNonEmptyStopSequences(entriesResult.value);
  }

  // M requires max_tokens, so the resolved output limit always exists for an
  // M source; M→C/R translation preserves the caller's limit through the IR.
  const generation: IrGenerationControls = {
    ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
    ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
    maxOutputTokens: body.max_tokens,
    ...(stopSequences !== undefined ? { stopSequences } : {}),
  };

  const irRequest: IrRequest = {
    model: body.model,
    delivery,
    items,
    generation,
  };

  return { ok: true, value: { irRequest, requestWireOptions: wireOptions } };
}

/**
 * Ingress decoder for Anthropic Messages requests and responses.
 *
 * Request decoding delegates to {@link parseMessagesRequestBody}, which
 * projects admitted generation controls (including the required `max_tokens`
 * output limit) into the IR and captures the T2 wire-only facts
 * (metadata.user_id subset, service tier, cache-control breakpoints) into the
 * request wire-options sidecar; native-only state fails closed with its exact
 * matrix capability ID.
 */
export class MessagesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseMessagesRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(status: number, _headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure> {
    if (typeof body !== "object" || body === null) {
      return {
        ok: false,
        error: invalidRequestFailure("Messages response body must be an object"),
      };
    }

    if (body.type === "error" || status >= 400) {
      const err = (body.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : `Messages provider error HTTP ${status}`,
          code: typeof err.type === "string" ? err.type : undefined,
          retryable: false,
        },
      };
    }

    if (body.type !== "message") {
      return {
        ok: false,
        error: invalidRequestFailure("Messages response body must have type 'message'"),
      };
    }

    const parts: IrOutputPart[] = [];
    if (Array.isArray(body.content)) {
      for (const block of body.content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text") {
          parts.push({
            type: "text",
            partId: randomUUID(),
            text: typeof b.text === "string" ? b.text : "",
          });
          // A signature on a non-reasoning text block is still a provider-owned
          // reasoning continuation handle.
          if (b.signature !== undefined) {
            return { ok: false, error: unsupportedCapabilityFailure("reasoning-signature") };
          }
        } else if (b?.type === "tool_use") {
          parts.push({
            type: "tool_call",
            partId: randomUUID(),
            call: {
              type: "function",
              callId: String(b.id ?? randomUUID()),
              name: String(b.name ?? ""),
              argumentsText: JSON.stringify(b.input ?? {}),
            },
          });
        } else if (b?.type === "thinking") {
          // Provider-owned readable reasoning discovered on the outcome fails
          // closed instead of vanishing.
          return { ok: false, error: unsupportedCapabilityFailure("readable-reasoning") };
        } else if (b?.type === "redacted_thinking") {
          return { ok: false, error: unsupportedCapabilityFailure("redacted-reasoning") };
        } else {
          // Unknown content blocks never vanish behind a success terminator;
          // parity with the stream decoder's unknown-block rejection.
          return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
        }
      }
    }

    let finishReason: IrFinishReason = "stop";
    const rawStopReason = body.stop_reason;
    if (rawStopReason === "end_turn") {
      finishReason = "stop";
    } else if (rawStopReason === "max_tokens") {
      finishReason = "length";
    } else if (rawStopReason === "stop_sequence") {
      finishReason = "stop";
    } else if (rawStopReason === "refusal") {
      finishReason = "refusal";
    } else if (rawStopReason === "tool_use") {
      finishReason = "tool_calls";
    } else if (rawStopReason === "model_context_window_exceeded") {
      finishReason = "context_limit";
    } else if (rawStopReason === "pause_turn") {
      return { ok: false, error: unsupportedCapabilityFailure("anthropic-pause-turn") };
    } else if (rawStopReason !== null && rawStopReason !== undefined) {
      finishReason = "other";
    }

    // Explicit null is treated as a missing usage record (absence), never
    // a crash and never a fabricated zero.
    const rawUsage = body.usage as Record<string, unknown> | null | undefined;

    // Output-side discovery of the inference geography echo fails closed; the
    // foreign detail stays on the provider wire (trace), never in the IR.
    if (rawUsage?.inference_geo !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("inference-geography") };
    }

    // Usage counters parse through the same shared accumulator the provider
    // stream decoder uses: every present counter must be a finite number, an
    // explicitly reported zero is preserved (absence is distinct from zero),
    // the M input formula sums the cache subdivisions, and `total` is never
    // fabricated. A complete M response must additionally report both billing
    // totals.
    let usage: IrUsage | undefined;
    if (rawUsage !== undefined && rawUsage !== null) {
      const accumulator: MessagesUsageAccumulator = { sawUsage: false };
      const accumulateResult = accumulateMessagesUsage(accumulator, rawUsage);
      if (!accumulateResult.ok) return accumulateResult;
      if (accumulator.inputTokens === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure("usage.input_tokens must be a finite number when usage is present"),
        };
      }
      if (accumulator.outputTokens === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure("usage.output_tokens must be a finite number when usage is present"),
        };
      }
      usage = collapseMessagesUsage(accumulator);
    }

    // Response-side wire-only fact: the effective serving-tier echo
    // (standard|priority|batch). Out-of-M it is declared loss and never
    // fabricated into a C/R tier.
    let outcomeWireOptions: OutcomeWireOptions = {};
    if (typeof rawUsage?.service_tier === "string") {
      outcomeWireOptions = { serviceTier: rawUsage.service_tier };
    }

    // The matched stop string is only meaningful with the `stop_sequence`
    // stop reason: a stray value paired with any other reason is malformed M
    // wire, and the capture is gated so the M-client echo pairing stays valid.
    const rawStopSequence = body.stop_sequence;
    if (rawStopSequence !== undefined && rawStopSequence !== null) {
      if (typeof rawStopSequence !== "string") {
        return { ok: false, error: invalidRequestFailure("stop_sequence must be a string when present") };
      }
      if (rawStopReason !== "stop_sequence") {
        return {
          ok: false,
          error: invalidRequestFailure("stop_sequence is only valid with stop_reason 'stop_sequence'"),
        };
      }
    }

    const outcome: IrOutcome = {
      responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : `msg_${randomUUID()}`,
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: {
        reason: finishReason,
        ...(rawStopReason === "stop_sequence" && typeof rawStopSequence === "string"
          ? { stopSequence: rawStopSequence }
          : {}),
      },
      ...(usage !== undefined ? { usage } : {}),
    };

    return { ok: true, value: { irOutcome: outcome, outcomeWireOptions } };
  }
}
