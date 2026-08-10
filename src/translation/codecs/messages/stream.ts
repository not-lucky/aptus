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
  IrFinishReason,
  IrGenerationControls,
  IrInputPart,
  IrItem,
  IrRequest,
  IrStreamEvent,
  IrUsage,
  NonEmpty,
} from "../../ir.ts";
import type { SseFrame } from "../../sse.ts";

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
 * Decodes a streaming Anthropic Messages request.
 */
export class MessagesStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(
    body: JsonObject,
  ): Result<{ readonly irRequest: IrRequest; readonly sourceWireOptions: StreamWireOptions }, NormalizedFailure> {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure("Messages request missing required string property 'model'"),
      };
    }

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

    for (const key of Object.keys(body)) {
      if (!RECOGNIZED_MESSAGES_REQUEST_FIELDS.has(key)) {
        return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
      }
    }

    const items: IrItem[] = [];

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
      delivery: "stream",
      items,
      generation,
    };

    return {
      ok: true,
      value: {
        irRequest,
        sourceWireOptions: {},
      },
    };
  }
}

/**
 * Encodes an {@link IrRequest} into target Anthropic Messages stream request JSON.
 */
export class MessagesStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(request: IrRequest, targetModel: string, _wireOptions: StreamWireOptions): JsonObject {
    const systemBlocks: JsonObject[] = [];
    const messages: JsonObject[] = [];

    let scanningLeadingInstructions = true;

    for (const item of request.items) {
      if (item.type === "instruction" && scanningLeadingInstructions) {
        systemBlocks.push({
          type: "text",
          text: item.text,
        });
        continue;
      }

      scanningLeadingInstructions = false;

      if (item.type === "message") {
        const contentBlocks: JsonObject[] = [];
        for (const part of item.content) {
          if (part.type === "text") {
            contentBlocks.push({
              type: "text",
              text: part.text,
            });
          }
        }

        const lastMessage = messages[messages.length - 1];
        if (lastMessage !== undefined && lastMessage.role === item.role) {
          const existingContent = lastMessage.content as JsonObject[];
          existingContent.push(...contentBlocks);
        } else {
          messages.push({
            role: item.role,
            content: contentBlocks,
          });
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: targetModel,
      messages,
      stream: true,
    };

    if (systemBlocks.length > 0) {
      payload.system = systemBlocks;
    }

    return payload as JsonObject;
  }
}

/**
 * Decodes an upstream Anthropic Messages SSE stream into semantic IR stream events.
 */
export class MessagesProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "anthropic-messages" as const;
  private readonly session: StreamSession;
  private readonly partIndexMap = new Map<number, string>();
  private inputTokens = 0;
  private cacheReadInput = 0;
  private cacheWriteInput = 0;
  private outputTokens = 0;
  private sawUsage = false;
  private recordedFinish: IrFinishReason | undefined;
  private sawMessageStop = false;

  constructor(session: StreamSession) {
    this.session = session;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (frame.event === undefined || frame.event.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure("Messages stream frame missing named 'event'"),
      };
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: invalidRequestFailure(
          `Messages stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    const eventName = frame.event;

    if (eventName === "ping") {
      // Wire-only activity / keepalive
      return { ok: true, value: [] };
    }

    if (eventName === "message_start") {
      const msg = (chunk.message ?? {}) as Record<string, unknown>;
      const rawUsage = msg.usage as Record<string, unknown> | undefined;
      if (rawUsage !== undefined) {
        this.sawUsage = true;
        this.inputTokens = typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0;
        this.cacheReadInput =
          typeof rawUsage.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0;
        this.cacheWriteInput =
          typeof rawUsage.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0;
        this.outputTokens = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
      }

      return {
        ok: true,
        value: [
          {
            type: "response_start",
            responseId: this.session.responseId,
            model: this.session.model,
          },
        ],
      };
    }

    if (eventName === "content_block_start") {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      const block = chunk.content_block as Record<string, unknown> | undefined;
      if (block?.type !== "text") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure(
            block?.type === "tool_use" ? "function-tool-definition" : "unknown-content-item",
          ),
        };
      }

      const partId = this.session.createPartId();
      this.partIndexMap.set(index, partId);

      return {
        ok: true,
        value: [
          {
            type: "part_start",
            responseId: this.session.responseId,
            partId,
            part: { type: "text" },
          },
        ],
      };
    }

    if (eventName === "content_block_delta") {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      const partId = this.partIndexMap.get(index);
      if (partId === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure(`content_block_delta received for unknown index '${index}'`),
        };
      }

      const delta = chunk.delta as Record<string, unknown> | undefined;
      if (delta?.type !== "text_delta") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure("unknown-stream-event"),
        };
      }

      const text = typeof delta.text === "string" ? delta.text : "";
      return {
        ok: true,
        value: [
          {
            type: "text_delta",
            responseId: this.session.responseId,
            partId,
            text,
          },
        ],
      };
    }

    if (eventName === "content_block_stop") {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      const partId = this.partIndexMap.get(index);
      if (partId === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure(`content_block_stop received for unknown index '${index}'`),
        };
      }

      this.partIndexMap.delete(index);
      return {
        ok: true,
        value: [
          {
            type: "part_end",
            responseId: this.session.responseId,
            partId,
            partType: "text",
          },
        ],
      };
    }

    if (eventName === "message_delta") {
      const delta = (chunk.delta ?? {}) as Record<string, unknown>;
      const stopReason = delta.stop_reason;

      if (delta.stop_sequence !== null && delta.stop_sequence !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("matched-stop-sequence") };
      }

      if (stopReason === "end_turn") {
        this.recordedFinish = "stop";
      } else if (stopReason === "max_tokens") {
        this.recordedFinish = "length";
      } else if (stopReason === "tool_use") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-tool-calls") };
      } else if (stopReason === "refusal") {
        return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
      } else if (stopReason === "model_context_window_exceeded") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-context-limit") };
      } else if (stopReason === "pause_turn") {
        return { ok: false, error: unsupportedCapabilityFailure("anthropic-pause-turn") };
      } else if (stopReason !== null && stopReason !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("finish-other-unknown") };
      } else {
        this.recordedFinish = "stop";
      }

      const rawUsage = chunk.usage as Record<string, unknown> | undefined;
      if (rawUsage !== undefined) {
        // Anthropic message_delta usage is cumulative: each present field is the
        // latest total, so overwrite rather than sum. Collapse to the final value.
        this.sawUsage = true;
        if (typeof rawUsage.output_tokens === "number") this.outputTokens = rawUsage.output_tokens;
        if (typeof rawUsage.input_tokens === "number") this.inputTokens = rawUsage.input_tokens;
        if (typeof rawUsage.cache_read_input_tokens === "number") {
          this.cacheReadInput = rawUsage.cache_read_input_tokens;
        }
        if (typeof rawUsage.cache_creation_input_tokens === "number") {
          this.cacheWriteInput = rawUsage.cache_creation_input_tokens;
        }
      }

      return { ok: true, value: [] };
    }

    if (eventName === "message_stop") {
      this.sawMessageStop = true;
      const usage: IrUsage | undefined = this.sawUsage
        ? {
            input: this.inputTokens + this.cacheReadInput + this.cacheWriteInput,
            output: this.outputTokens,
          }
        : undefined;
      return {
        ok: true,
        value: [
          {
            type: "response_end",
            responseId: this.session.responseId,
            finish: { reason: this.recordedFinish ?? "stop" },
            usage,
          },
        ],
      };
    }

    if (eventName === "error") {
      const err = (chunk.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : "Messages provider stream error",
          code: typeof err.type === "string" ? err.type : undefined,
          retryable: false,
        },
      };
    }

    return {
      ok: false,
      error: unsupportedCapabilityFailure("unknown-stream-event"),
    };
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.sawMessageStop) {
      return {
        ok: false,
        error: {
          category: "stream_interrupted",
          message: "Messages stream ended unexpectedly before message_stop",
          retryable: false,
        },
      };
    }
    return { ok: true, value: [] };
  }
}

/**
 * Encodes semantic IR stream events into client-native Anthropic Messages SSE frames.
 */
export class MessagesClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "anthropic-messages" as const;
  private readonly session: StreamSession;
  private readonly partIndices = new Map<string, number>();
  private nextPartIndex = 0;

  constructor(session: StreamSession) {
    this.session = session;
  }

  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure> {
    const id = this.session.responseId.startsWith("msg_") ? this.session.responseId : `msg_${this.session.responseId}`;
    const frames: SseFrame[] = [];

    if (event.type === "response_start") {
      frames.push({
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            content: [],
            model: this.session.model,
            stop_reason: null,
            stop_sequence: null,
          },
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "part_start") {
      const index = this.nextPartIndex++;
      this.partIndices.set(event.partId, index);
      frames.push({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "text_delta") {
      const index = this.partIndices.get(event.partId) ?? 0;
      frames.push({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: event.text },
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "part_end") {
      const index = this.partIndices.get(event.partId) ?? 0;
      this.partIndices.delete(event.partId);
      frames.push({
        event: "content_block_stop",
        data: JSON.stringify({
          type: "content_block_stop",
          index,
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "response_end") {
      const stopReason = event.finish.reason === "length" ? "max_tokens" : "end_turn";
      const usage =
        event.usage !== undefined
          ? {
              input_tokens: event.usage.input,
              output_tokens: event.usage.output,
            }
          : undefined;

      frames.push({
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          ...(usage !== undefined ? { usage } : {}),
        }),
      });
      frames.push({
        event: "message_stop",
        data: JSON.stringify({
          type: "message_stop",
        }),
      });
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
