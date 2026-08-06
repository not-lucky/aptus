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
]);

/**
 * Ingress decoder for OpenAI Responses requests and responses.
 */
export class ResponsesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<IrRequest, NormalizedFailure> {
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

    // Decoder-level capability rejections for recognized non-admitted wire fields
    if (body.previous_response_id !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("responses-previous-id") };
    }
    if (body.conversation !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("responses-conversation") };
    }
    if (body.background !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("responses-background") };
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
    if (body.reasoning !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("reasoning-effort-common") };
    }
    if (body.store !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("responses-storage") };
    }
    if (body.metadata !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("request-metadata") };
    }
    if (body.safety_identifier !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("safety-identifier") };
    }
    if (body.moderation !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("moderation-policy-result") };
    }
    if (body.service_tier !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("service-tier") };
    }
    if (body.truncation !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("truncation-policy") };
    }
    if (body.prompt_cache_key !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("prompt-cache-key") };
    }

    const textConfig = body.text as Record<string, unknown> | undefined;
    if (textConfig?.format !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("structured-json-schema") };
    }

    // Check for unknown request fields outside recognized schema
    for (const key of Object.keys(body)) {
      if (!RECOGNIZED_RESPONSES_REQUEST_FIELDS.has(key)) {
        return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
      }
    }

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

        if (itemObj.phase !== undefined || itemObj.status !== undefined) {
          return { ok: false, error: unsupportedCapabilityFailure("responses-message-phase") };
        }
        if (itemObj.previous_response_id !== undefined) {
          return { ok: false, error: unsupportedCapabilityFailure("responses-previous-id") };
        }
        if (itemObj.type === "input_image") {
          return { ok: false, error: unsupportedCapabilityFailure("image-url") };
        }
        if (itemObj.type === "input_file") {
          return { ok: false, error: unsupportedCapabilityFailure("document-inline-bytes") };
        }

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
              } else if (p?.type === "input_image") {
                return { ok: false, error: unsupportedCapabilityFailure("image-url") };
              } else if (p?.type === "input_file") {
                return { ok: false, error: unsupportedCapabilityFailure("document-inline-bytes") };
              } else {
                return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
              }
            }
          }
          if (parts.length > 0) {
            items.push({
              type: "message",
              role: "user",
              content: parts as unknown as NonEmpty<IrInputPart>,
            });
          }
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
              } else if (p?.type === "refusal") {
                return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
              } else {
                return { ok: false, error: unsupportedCapabilityFailure("unknown-content-item") };
              }
            }
          }
          if (parts.length > 0) {
            items.push({
              type: "message",
              role: "assistant",
              content: parts as unknown as NonEmpty<IrAssistantPart>,
            });
          }
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

    let generation: IrGenerationControls | undefined;
    if (
      body.temperature !== undefined ||
      body.top_p !== undefined ||
      body.max_output_tokens !== undefined ||
      textConfig?.verbosity !== undefined
    ) {
      generation = {
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        topP: typeof body.top_p === "number" ? body.top_p : undefined,
        maxOutputTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
        verbosity:
          typeof textConfig?.verbosity === "string" &&
          (textConfig.verbosity === "low" || textConfig.verbosity === "medium" || textConfig.verbosity === "high")
            ? textConfig.verbosity
            : undefined,
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

    const rawUsage = body.usage as Record<string, unknown> | undefined;
    const usage =
      rawUsage !== undefined
        ? {
            input: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0,
            output: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0,
            total: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
          }
        : undefined;

    const outcome: IrOutcome = {
      responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      usage,
    };

    return { ok: true, value: outcome };
  }
}
