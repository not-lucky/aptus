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
  NonEmpty,
} from "../../ir.ts";
import type { SseFrame } from "../../sse.ts";

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
 * Decodes a streaming OpenAI Responses request.
 */
export class ResponsesStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(
    body: JsonObject,
  ): Result<{ readonly irRequest: IrRequest; readonly sourceWireOptions: StreamWireOptions }, NormalizedFailure> {
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

    for (const key of Object.keys(body)) {
      if (!RECOGNIZED_RESPONSES_REQUEST_FIELDS.has(key)) {
        return { ok: false, error: unsupportedCapabilityFailure("unknown-request-field") };
      }
    }

    const items: IrItem[] = [];

    if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
      items.push({
        type: "instruction",
        authority: "system",
        separation: "advisory",
        text: body.instructions,
      });
    }

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
 * Encodes an {@link IrRequest} into target OpenAI Responses stream request JSON.
 */
export class ResponsesStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(request: IrRequest, targetModel: string, _wireOptions: StreamWireOptions): JsonObject {
    const input: JsonObject[] = [];

    for (const item of request.items) {
      if (item.type === "instruction") {
        input.push({
          role: item.authority,
          content: [
            {
              type: "input_text",
              text: item.text,
            },
          ],
        });
      } else if (item.type === "message") {
        if (item.role === "user") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          input.push({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text,
              },
            ],
          });
        } else if (item.role === "assistant") {
          let text = "";
          for (const part of item.content) {
            if (part.type === "text") {
              text += part.text;
            }
          }
          input.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text,
              },
            ],
          });
        }
      }
    }

    return {
      model: targetModel,
      input,
      stream: true,
    };
  }
}

/**
 * Decodes an upstream OpenAI Responses SSE stream into semantic IR stream events.
 */
export class ResponsesProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "openai-responses" as const;
  private readonly session: StreamSession;
  private lastSequenceNumber = 0;
  private currentPartId: string | undefined;
  private partStarted = false;
  private completed = false;

  constructor(session: StreamSession) {
    this.session = session;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (frame.event === undefined || frame.event.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure("Responses stream frame missing required named 'event'"),
      };
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: invalidRequestFailure(
          `Responses stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    if (chunk.type !== frame.event) {
      return {
        ok: false,
        error: invalidRequestFailure(
          `Responses frame event '${frame.event}' does not match JSON type '${String(chunk.type)}'`,
        ),
      };
    }

    if (typeof chunk.sequence_number === "number") {
      if (!Number.isSafeInteger(chunk.sequence_number) || chunk.sequence_number <= this.lastSequenceNumber) {
        return {
          ok: false,
          error: invalidRequestFailure(
            `Responses stream sequence_number must be strictly increasing (expected > ${this.lastSequenceNumber}, got ${chunk.sequence_number})`,
          ),
        };
      }
      this.lastSequenceNumber = chunk.sequence_number;
    }

    const eventName = frame.event;

    if (eventName === "response.created") {
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

    if (eventName === "response.in_progress") {
      return { ok: true, value: [] };
    }

    if (eventName === "response.output_item.added") {
      const item = chunk.item as Record<string, unknown> | undefined;
      if (item?.type !== "message") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure(
            item?.type === "function_call" ? "function-tool-definition" : "unknown-content-item",
          ),
        };
      }
      return { ok: true, value: [] };
    }

    if (eventName === "response.content_part.added") {
      const part = chunk.part as Record<string, unknown> | undefined;
      if (part?.type !== "output_text") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure(part?.type === "refusal" ? "refusal-content" : "unknown-content-item"),
        };
      }
      this.currentPartId = this.session.createPartId();
      this.partStarted = true;
      return {
        ok: true,
        value: [
          {
            type: "part_start",
            responseId: this.session.responseId,
            partId: this.currentPartId,
            part: { type: "text" },
          },
        ],
      };
    }

    if (eventName === "response.output_text.delta") {
      const events: IrStreamEvent[] = [];
      if (!this.partStarted || this.currentPartId === undefined) {
        this.currentPartId = this.session.createPartId();
        this.partStarted = true;
        events.push({
          type: "part_start",
          responseId: this.session.responseId,
          partId: this.currentPartId,
          part: { type: "text" },
        });
      }
      const text = typeof chunk.delta === "string" ? chunk.delta : "";
      events.push({
        type: "text_delta",
        responseId: this.session.responseId,
        partId: this.currentPartId,
        text,
      });
      return {
        ok: true,
        value: events,
      };
    }

    if (eventName === "response.output_text.done") {
      if (!this.partStarted || this.currentPartId === undefined) {
        return { ok: true, value: [] };
      }
      const partId = this.currentPartId;
      this.partStarted = false;
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

    if (eventName === "response.content_part.done" || eventName === "response.output_item.done") {
      return { ok: true, value: [] };
    }

    if (eventName === "response.completed") {
      this.completed = true;
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      const rawUsage = resp.usage as Record<string, unknown> | undefined;
      const usage =
        rawUsage !== undefined
          ? {
              input: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0,
              output: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0,
              total: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
            }
          : undefined;

      return {
        ok: true,
        value: [
          {
            type: "response_end",
            responseId: this.session.responseId,
            finish: { reason: "stop" },
            usage,
          },
        ],
      };
    }

    if (eventName === "response.incomplete") {
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      const details = (resp.incomplete_details ?? {}) as Record<string, unknown>;
      if (details.reason !== "max_output_tokens") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure(
            details.reason === "content_filter" ? "finish-content-filter" : "finish-other-unknown",
          ),
        };
      }

      this.completed = true;
      const rawUsage = resp.usage as Record<string, unknown> | undefined;
      const usage =
        rawUsage !== undefined
          ? {
              input: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0,
              output: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0,
              total: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
            }
          : undefined;

      return {
        ok: true,
        value: [
          {
            type: "response_end",
            responseId: this.session.responseId,
            finish: { reason: "length" },
            usage,
          },
        ],
      };
    }

    if (eventName === "response.failed" || eventName === "error") {
      const err = (chunk.error ?? (chunk.response as Record<string, unknown>)?.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          category: "provider",
          message: typeof err.message === "string" ? err.message : "Responses provider stream error",
          code: typeof err.code === "string" ? err.code : undefined,
          retryable: false,
        },
      };
    }

    // Unmapped non-semantic wire event (ignored)
    return { ok: true, value: [] };
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.completed) {
      return {
        ok: false,
        error: {
          category: "stream_interrupted",
          message: "Responses stream ended unexpectedly before completion event",
          retryable: false,
        },
      };
    }
    return { ok: true, value: [] };
  }
}

/**
 * Encodes semantic IR stream events into client-native OpenAI Responses SSE frames.
 */
export class ResponsesClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "openai-responses" as const;
  private readonly session: StreamSession;
  private sequenceNumber = 1;

  constructor(session: StreamSession) {
    this.session = session;
  }

  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure> {
    const id = `resp_${this.session.responseId}`;
    const frames: SseFrame[] = [];

    if (event.type === "response_start") {
      frames.push({
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          response: { id, status: "in_progress" },
          sequence_number: this.sequenceNumber++,
        }),
      });
      frames.push({
        event: "response.in_progress",
        data: JSON.stringify({
          type: "response.in_progress",
          sequence_number: this.sequenceNumber++,
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "part_start") {
      const msgId = `msg_${event.partId}`;
      frames.push({
        event: "response.output_item.added",
        data: JSON.stringify({
          type: "response.output_item.added",
          item: { type: "message", id: msgId },
          sequence_number: this.sequenceNumber++,
        }),
      });
      frames.push({
        event: "response.content_part.added",
        data: JSON.stringify({
          type: "response.content_part.added",
          part: { type: "output_text", text: "" },
          sequence_number: this.sequenceNumber++,
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "text_delta") {
      frames.push({
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          delta: event.text,
          sequence_number: this.sequenceNumber++,
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "part_end") {
      frames.push({
        event: "response.output_text.done",
        data: JSON.stringify({
          type: "response.output_text.done",
          sequence_number: this.sequenceNumber++,
        }),
      });
      frames.push({
        event: "response.content_part.done",
        data: JSON.stringify({
          type: "response.content_part.done",
          sequence_number: this.sequenceNumber++,
        }),
      });
      frames.push({
        event: "response.output_item.done",
        data: JSON.stringify({
          type: "response.output_item.done",
          sequence_number: this.sequenceNumber++,
        }),
      });
      return { ok: true, value: frames };
    }

    if (event.type === "response_end") {
      const usage =
        event.usage !== undefined
          ? {
              input_tokens: event.usage.input,
              output_tokens: event.usage.output,
              ...(event.usage.total !== undefined ? { total_tokens: event.usage.total } : {}),
            }
          : undefined;

      if (event.finish.reason === "stop") {
        frames.push({
          event: "response.completed",
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id,
              status: "completed",
              ...(usage !== undefined ? { usage } : {}),
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
      } else if (event.finish.reason === "length") {
        frames.push({
          event: "response.incomplete",
          data: JSON.stringify({
            type: "response.incomplete",
            response: {
              id,
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              ...(usage !== undefined ? { usage } : {}),
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
      }
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
