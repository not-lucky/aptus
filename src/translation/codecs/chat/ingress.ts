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
]);

/**
 * Ingress decoder for OpenAI Chat Completions requests and responses.
 */
export class ChatIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<IrRequest, NormalizedFailure> {
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

    // Decoder-level capability rejections for recognized non-admitted wire fields
    if (body.n !== undefined && body.n !== 1) {
      return { ok: false, error: unsupportedCapabilityFailure("multiple-candidates") };
    }
    if (body.store !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("responses-storage") };
    }
    if (body.metadata !== undefined || body.user !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("request-metadata") };
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
    if (body.moderation !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("moderation-policy-result") };
    }
    if (body.service_tier !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("service-tier") };
    }
    if (body.safety_identifier !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("safety-identifier") };
    }
    if (body.prediction !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("chat-predicted-outputs") };
    }
    if (body.stream_options !== undefined) {
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

      if (role === "system" || role === "developer") {
        let text = "";
        if (typeof rawMsg.content === "string") {
          text = rawMsg.content;
        } else if (Array.isArray(rawMsg.content)) {
          for (const rawPart of rawMsg.content) {
            const part = rawPart as Record<string, unknown>;
            if (part?.type === "text" && typeof part.text === "string") {
              text += part.text;
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

    // Decode generation controls for preflight evaluation
    let generation: IrGenerationControls | undefined;
    if (
      body.temperature !== undefined ||
      body.top_p !== undefined ||
      body.max_completion_tokens !== undefined ||
      body.stop !== undefined ||
      body.verbosity !== undefined ||
      body.reasoning_effort !== undefined
    ) {
      let stopSequences: NonEmpty<string> | undefined;
      if (typeof body.stop === "string") {
        stopSequences = [body.stop];
      } else if (Array.isArray(body.stop) && body.stop.length > 0) {
        stopSequences = body.stop as unknown as NonEmpty<string>;
      }

      generation = {
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        topP: typeof body.top_p === "number" ? body.top_p : undefined,
        maxOutputTokens: typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined,
        verbosity:
          typeof body.verbosity === "string" &&
          (body.verbosity === "low" || body.verbosity === "medium" || body.verbosity === "high")
            ? body.verbosity
            : undefined,
        stopSequences,
        reasoning:
          typeof body.reasoning_effort === "string"
            ? { effort: body.reasoning_effort as "low" | "medium" | "high" }
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

  decodeOutcome(_status: number, _headers: HeaderMap, body: JsonObject): Result<IrOutcome, NormalizedFailure> {
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

    const rawUsage = body.usage as Record<string, unknown> | undefined;
    const usage =
      rawUsage !== undefined
        ? {
            input: typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0,
            output: typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0,
            total: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
          }
        : undefined;

    const outcome: IrOutcome = {
      responseId: randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      usage,
    };

    return { ok: true, value: outcome };
  }
}
