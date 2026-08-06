import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { IngressDecoder } from "../../contracts.ts";
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
]);

/**
 * Ingress decoder for Anthropic Messages requests and responses.
 */
export class MessagesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<IrRequest, NormalizedFailure> {
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

    // Decoder-level capability rejections for recognized non-admitted wire fields
    if (body.tools !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
    }
    if (body.tool_choice !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("tool-choice-none-auto-required") };
    }
    if (body.thinking !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("reasoning-effort-common") };
    }
    if (body.container !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("provider-container") };
    }
    if (body.metadata !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("request-metadata") };
    }
    if (body.top_k !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("top-k") };
    }
    if (body.output_config !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("structured-json-schema") };
    }

    // Check for unknown request fields outside recognized schema
    for (const key of Object.keys(body)) {
      if (!RECOGNIZED_MESSAGES_REQUEST_FIELDS.has(key)) {
        return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
      }
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
      for (const block of body.system) {
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
          }
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

      if (role === "user") {
        const parts: IrInputPart[] = [];
        if (typeof msgObj.content === "string") {
          parts.push({ type: "text", text: msgObj.content });
        } else if (Array.isArray(msgObj.content)) {
          for (let pIdx = 0; pIdx < msgObj.content.length; pIdx++) {
            const block = msgObj.content[pIdx] as Record<string, unknown>;
            if (block?.type === "text" && typeof block.text === "string") {
              parts.push({ type: "text", text: block.text });
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
              parts.push({ type: "text", text: block.text });
            } else if (block?.type === "tool_use") {
              return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
            } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
              return { ok: false, error: unsupportedCapabilityFailure("reasoning-effort-common") };
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

    let generation: IrGenerationControls | undefined;
    if (body.temperature !== undefined || body.top_p !== undefined || body.stop_sequences !== undefined) {
      let stopSequences: NonEmpty<string> | undefined;
      if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
        stopSequences = body.stop_sequences as unknown as NonEmpty<string>;
      }

      generation = {
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        topP: typeof body.top_p === "number" ? body.top_p : undefined,
        stopSequences,
      };
    }

    const irRequest: IrRequest = {
      model: body.model,
      delivery: body.stream === true ? "stream" : "complete",
      items,
      generation,
    };

    return { ok: true, value: irRequest };
  }

  decodeOutcome(status: number, _headers: HeaderMap, body: JsonObject): Result<IrOutcome, NormalizedFailure> {
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

    const rawUsage = body.usage as Record<string, unknown> | undefined;
    let usage: import("../../ir.ts").IrUsage | undefined;
    if (rawUsage !== undefined) {
      const inputTokens = typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0;
      const cacheRead = typeof rawUsage.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0;
      const cacheCreation =
        typeof rawUsage.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0;
      const outputTokens = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;

      usage = {
        input: inputTokens + cacheRead + cacheCreation,
        output: outputTokens,
        ...(cacheRead > 0 ? { cacheReadInput: cacheRead } : {}),
        ...(cacheCreation > 0 ? { cacheWriteInput: cacheCreation } : {}),
      };
    }

    const outcome: IrOutcome = {
      responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : `msg_${randomUUID()}`,
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: {
        reason: finishReason,
        stopSequence: typeof body.stop_sequence === "string" ? body.stop_sequence : undefined,
      },
      usage,
    };

    return { ok: true, value: outcome };
  }
}
