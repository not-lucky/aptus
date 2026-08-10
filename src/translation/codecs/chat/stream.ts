import type { JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  ClientStreamEncoder,
  ProviderStreamDecoder,
  StreamRequestDecoder,
  StreamRequestEncoder,
  StreamSession,
  StreamWireOptions,
} from "../../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../../failures.ts";
import type {
  IrAssistantPart,
  IrGenerationControls,
  IrInputPart,
  IrItem,
  IrRequest,
  IrStreamEvent,
  IrUsage,
  NonEmpty,
} from "../../ir.ts";
import type { SseFrame } from "../../sse.ts";

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
 * Decodes a streaming OpenAI Chat Completions request.
 */
export class ChatStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(
    body: JsonObject,
  ): Result<{ readonly irRequest: IrRequest; readonly sourceWireOptions: StreamWireOptions }, NormalizedFailure> {
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

    let includeUsage = false;

    if (body.stream_options !== undefined) {
      if (typeof body.stream_options !== "object" || body.stream_options === null) {
        return { ok: false, error: invalidRequestFailure("Chat 'stream_options' must be an object") };
      }
      const streamOptions = body.stream_options as Record<string, unknown>;
      // `include_obfuscation` is recognized but never propagated: obfuscation is a
      // wire-only OpenAI concern and the translated target always disables it.
      for (const key of Object.keys(streamOptions)) {
        if (key === "include_usage") {
          includeUsage = streamOptions.include_usage === true;
        } else if (key !== "include_obfuscation") {
          return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
        }
      }
    }

    for (const key of Object.keys(body)) {
      if (!RECOGNIZED_CHAT_REQUEST_FIELDS.has(key)) {
        return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
      }
    }

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
      delivery: "stream",
      items,
      generation,
    };

    return {
      ok: true,
      value: {
        irRequest,
        sourceWireOptions: {
          includeUsage,
        },
      },
    };
  }
}

/**
 * Encodes an {@link IrRequest} into target OpenAI Chat stream request JSON.
 */
export class ChatStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(request: IrRequest, targetModel: string, wireOptions: StreamWireOptions): JsonObject {
    const messages: JsonObject[] = [];

    for (const item of request.items) {
      if (item.type === "instruction") {
        messages.push({
          role: item.authority,
          content: item.text,
        });
      } else if (item.type === "message") {
        if (item.role === "user") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          messages.push({
            role: "user",
            content: text,
          });
        } else if (item.role === "assistant") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          messages.push({
            role: "assistant",
            content: text,
          });
        }
      }
    }

    return {
      model: targetModel,
      messages,
      stream: true,
      stream_options: {
        include_usage: wireOptions.includeUsage ?? false,
        include_obfuscation: false,
      },
    };
  }
}

/**
 * Decodes an upstream OpenAI Chat SSE stream into semantic IR stream events.
 */
export class ChatProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "openai-chat" as const;
  private readonly session: StreamSession;
  private responseStartEmitted = false;
  private partStartEmitted = false;
  private partEndEmitted = false;
  private currentPartId: string | undefined;
  private sawDone = false;
  private finishReason: "stop" | "length" | undefined;
  private pendingUsage: IrUsage | undefined;

  constructor(session: StreamSession) {
    this.session = session;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    const trimmedData = frame.data.trim();
    if (trimmedData === "[DONE]") {
      this.sawDone = true;
      const events: IrStreamEvent[] = [];
      if (this.finishReason !== undefined) {
        events.push({
          type: "response_end",
          responseId: this.session.responseId,
          finish: { reason: this.finishReason },
          usage: this.pendingUsage,
        });
      }
      return { ok: true, value: events };
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: invalidRequestFailure(
          `Chat stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    if (chunk.error !== undefined && chunk.error !== null) {
      const err = chunk.error as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : "Chat provider stream in-band error",
          code: typeof err.code === "string" ? err.code : undefined,
          retryable: false,
        },
      };
    }

    if (chunk.object !== "chat.completion.chunk") {
      return {
        ok: false,
        error: invalidRequestFailure("Chat stream chunk missing expected object 'chat.completion.chunk'"),
      };
    }

    if (!Array.isArray(chunk.choices)) {
      return {
        ok: false,
        error: invalidRequestFailure("Chat stream chunk missing choices array"),
      };
    }

    const events: IrStreamEvent[] = [];

    // Final usage chunk (empty choices array)
    if (chunk.choices.length === 0) {
      if (chunk.usage !== undefined && chunk.usage !== null && typeof chunk.usage === "object") {
        const rawUsage = chunk.usage as Record<string, unknown>;
        this.pendingUsage = {
          input: typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0,
          output: typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0,
          total: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
        };
      }
      return { ok: true, value: [] };
    }

    const choice = chunk.choices[0] as Record<string, unknown>;
    if (choice.index !== 0) {
      return { ok: false, error: unsupportedCapabilityFailure("multiple-candidates") };
    }

    if (!this.responseStartEmitted) {
      events.push({
        type: "response_start",
        responseId: this.session.responseId,
        model: this.session.model,
      });
      this.responseStartEmitted = true;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta !== undefined && delta !== null) {
      if (delta.tool_calls !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
      }
      if (delta.refusal !== undefined && delta.refusal !== null) {
        return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
      }

      if (delta.role === "assistant" && !this.partStartEmitted) {
        this.currentPartId = this.session.createPartId();
        events.push({
          type: "part_start",
          responseId: this.session.responseId,
          partId: this.currentPartId,
          part: { type: "text" },
        });
        this.partStartEmitted = true;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!this.partStartEmitted || this.currentPartId === undefined) {
          this.currentPartId = this.session.createPartId();
          events.push({
            type: "part_start",
            responseId: this.session.responseId,
            partId: this.currentPartId,
            part: { type: "text" },
          });
          this.partStartEmitted = true;
        }

        const partId = this.currentPartId;
        events.push({
          type: "text_delta",
          responseId: this.session.responseId,
          partId,
          text: delta.content,
        });
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (choice.finish_reason === "stop") {
        this.finishReason = "stop";
      } else if (choice.finish_reason === "length") {
        this.finishReason = "length";
      } else if (choice.finish_reason === "tool_calls") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-tool-calls") };
      } else if (choice.finish_reason === "content_filter") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-content-filter") };
      } else {
        return { ok: false, error: unsupportedCapabilityFailure("finish-other-unknown") };
      }

      if (this.partStartEmitted && !this.partEndEmitted && this.currentPartId !== undefined) {
        const partId = this.currentPartId;
        events.push({
          type: "part_end",
          responseId: this.session.responseId,
          partId,
          partType: "text",
        });
        this.partEndEmitted = true;
      }
    }

    return { ok: true, value: events };
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.sawDone) {
      return {
        ok: false,
        error: {
          category: "stream_interrupted",
          message: "Chat stream ended unexpectedly before receiving [DONE] sentinel",
          retryable: false,
        },
      };
    }
    return { ok: true, value: [] };
  }
}

/**
 * Encodes semantic IR stream events into client-native OpenAI Chat SSE frames.
 */
export class ChatClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "openai-chat" as const;
  private readonly session: StreamSession;
  private readonly wireOptions: StreamWireOptions;
  private readonly created: number;

  constructor(
    session: StreamSession,
    wireOptions: StreamWireOptions = {},
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.session = session;
    this.wireOptions = wireOptions;
    this.created = now();
  }

  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure> {
    const id = `chatcmpl-${this.session.responseId}`;
    const model = this.session.model;
    const created = this.created;

    if (event.type === "response_start") {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      };
      return { ok: true, value: [{ data: JSON.stringify(chunk) }] };
    }

    if (event.type === "text_delta") {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: event.text },
            finish_reason: null,
          },
        ],
      };
      return { ok: true, value: [{ data: JSON.stringify(chunk) }] };
    }

    if (event.type === "part_start" || event.type === "part_end") {
      return { ok: true, value: [] };
    }

    if (event.type === "response_end") {
      const frames: SseFrame[] = [];

      // Terminal finish chunk
      const terminalChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: event.finish.reason,
          },
        ],
      };
      frames.push({ data: JSON.stringify(terminalChunk) });

      // Optional final usage chunk
      if (this.wireOptions.includeUsage === true && event.usage !== undefined) {
        const usageChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: event.usage.input,
            completion_tokens: event.usage.output,
            ...(event.usage.total !== undefined ? { total_tokens: event.usage.total } : {}),
          },
        };
        frames.push({ data: JSON.stringify(usageChunk) });
      }

      // Final [DONE] sentinel
      frames.push({ data: "[DONE]" });

      return { ok: true, value: frames };
    }

    if (event.type === "error") {
      return { ok: true, value: [] };
    }

    return {
      ok: false,
      error: unsupportedCapabilityFailure("unknown-stream-event"),
    };
  }

  finish(): Result<readonly SseFrame[], NormalizedFailure> {
    return { ok: true, value: [] };
  }
}
