import type { JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  ClientStreamEncoder,
  OutcomeWireOptions,
  ProviderStreamDecoder,
  RequestWireOptions,
  StreamRequestDecodeResult,
  StreamRequestDecoder,
  StreamRequestEncoder,
  StreamSession,
  StreamWireOptions,
} from "../../contracts.ts";

import type { IrRequest, IrStreamEvent, IrUsage } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { chatToolFields } from "../shared/tool-fields.ts";
import { buildChatMessages, chatFinishReason, chatGenerationFields } from "../shared/transcript.ts";
import { chatUsageBody, parseChatUsage } from "../shared/usage.ts";
import { captureOutcomeWireFacts, chatOutcomeWireFields, chatResponsesRequestFields } from "../shared/wire-options.ts";
import { parseChatRequestBody } from "./ingress.ts";
/**
 * Decodes a streaming OpenAI Chat Completions request.
 *
 * Capability rejections, wire-only sidecar capture, transcript items, and
 * generation controls are shared verbatim with the complete-path ingress; this
 * decoder adds only the stream-specific `stream_options` handling.
 */
export class ChatStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(body: JsonObject): Result<StreamRequestDecodeResult, NormalizedFailure> {
    // The wire documents `stream_options` as object OR null: explicit null is
    // absence; any other non-object fails. `include_usage` is parsed strictly
    // in the same pass: absent or null means off, and any non-boolean value is
    // malformed Chat wire instead of a silent coercion.
    let includeUsage = false;
    if (body.stream_options !== undefined && body.stream_options !== null) {
      if (typeof body.stream_options !== "object") {
        return invalidRequest("Chat 'stream_options' must be an object");
      }
      const streamOptions = body.stream_options as Record<string, unknown>;
      // `include_obfuscation` is recognized but never propagated: obfuscation is a
      // wire-only OpenAI concern and the translated target always disables it.
      for (const key of Object.keys(streamOptions)) {
        if (key === "include_usage") {
          const rawIncludeUsage = streamOptions.include_usage;
          if (rawIncludeUsage !== undefined && rawIncludeUsage !== null) {
            if (typeof rawIncludeUsage !== "boolean") {
              return invalidRequest("stream_options.include_usage must be a boolean when present");
            }
            includeUsage = rawIncludeUsage;
          }
          continue;
        }
        if (key !== "include_obfuscation") {
          return unsupportedCapability("unknown-request-field");
        }
      }
    }

    const parsed = parseChatRequestBody(body, "stream");
    if (!parsed.ok) return parsed;

    return ok({
      irRequest: parsed.value.irRequest,
      sourceWireOptions: { includeUsage },
      requestWireOptions: parsed.value.requestWireOptions,
    });
  }
}

/**
 * Encodes an {@link IrRequest} into target OpenAI Chat stream request JSON,
 * projecting generation controls and the admitted wire-only sidecar fields
 * exactly like the complete-path encoder.
 */
export class ChatStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const messages = buildChatMessages(request.items, markedItems);

    return {
      model: targetModel,
      messages,
      stream: true,
      stream_options: {
        include_usage: wireOptions.includeUsage ?? false,
        include_obfuscation: false,
      },
      ...chatGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
      ...chatToolFields(request, requestWireOptions),
    };
  }
}

/**
 * Decodes an upstream OpenAI Chat SSE stream into semantic IR stream events.
 *
 * The final usage chunk collapses into `response_end.usage` with its
 * cache/reasoning subdivisions (`usage-stream-timing`). The service-tier echo
 * and moderation result are documented optional fields on every chunk and are
 * captured last-write-wins for the outcome wire-options sidecar.
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
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(session: StreamSession) {
    this.session = session;
  }

  getOutcomeWireOptions(): OutcomeWireOptions {
    return this.outcomeWireOptions;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    // The success terminator already went out on [DONE]; any later frame is a
    // misbehaving provider stream and fails closed instead of re-emitting a
    // second terminal event.
    if (this.sawDone) {
      return invalidRequest("Chat stream received frame after the [DONE] sentinel");
    }

    const trimmedData = frame.data.trim();
    if (trimmedData === "[DONE]") {
      this.sawDone = true;
      const events: IrStreamEvent[] = [];
      if (this.finishReason !== undefined) {
        events.push({
          type: "response_end",
          responseId: this.session.responseId,
          finish: { reason: this.finishReason },
          ...(this.pendingUsage !== undefined ? { usage: this.pendingUsage } : {}),
        });
      }
      return ok(events);
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (err) {
      return invalidRequest(`Chat stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (chunk.error !== undefined && chunk.error !== null) {
      const err = chunk.error as Record<string, unknown>;
      return failure({
        category: "provider",
        message: typeof err.message === "string" ? err.message : "Chat provider stream in-band error",
        code: typeof err.code === "string" ? err.code : undefined,
        retryable: false,
      });
    }

    if (chunk.object !== "chat.completion.chunk") {
      return invalidRequest("Chat stream chunk missing expected object 'chat.completion.chunk'");
    }

    if (!Array.isArray(chunk.choices)) {
      return invalidRequest("Chat stream chunk missing choices array");
    }

    // Per-chunk wire-only sidecar capture (last-write-wins): both fields are
    // documented optional on every chunk, not only the terminal usage chunk.
    const factsResult = captureOutcomeWireFacts(chunk, this.outcomeWireOptions, "Chat stream chunk");
    if (!factsResult.ok) return factsResult;
    this.outcomeWireOptions = factsResult.value;

    const events: IrStreamEvent[] = [];

    // Final usage chunk (empty choices array)
    if (chunk.choices.length === 0) {
      // The usage shape rules (null is absence, non-object fails closed) live
      // in parseChatUsage so the complete and stream paths cannot drift.
      const usageResult = parseChatUsage(chunk.usage);
      if (!usageResult.ok) return usageResult;
      this.pendingUsage = usageResult.value;
      return ok([]);
    }

    // Multiple candidates in one chunk evade the request-side `n` check; the
    // streaming wire carries exactly one choice per chunk.
    if (chunk.choices.length > 1) {
      return unsupportedCapability("multiple-candidates");
    }

    const choice = chunk.choices[0] as Record<string, unknown>;
    if (choice.index !== 0) {
      return unsupportedCapability("multiple-candidates");
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
        return unsupportedCapability("function-tool-definition");
      }
      if (delta.refusal !== undefined && delta.refusal !== null) {
        return unsupportedCapability("refusal-content");
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
        return unsupportedCapability("finish-tool-calls");
      } else if (choice.finish_reason === "content_filter") {
        return unsupportedCapability("finish-content-filter");
      } else {
        return unsupportedCapability("finish-other-unknown");
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

    return ok(events);
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.sawDone) {
      return failure({
        category: "stream_interrupted",
        message: "Chat stream ended unexpectedly before receiving [DONE] sentinel",
        retryable: false,
      });
    }
    return ok([]);
  }
}

/**
 * Encodes semantic IR stream events into client-native OpenAI Chat SSE frames.
 *
 * When the client asked for usage (`include_usage`), the final usage chunk is
 * synthesized with totals plus cache/reasoning subdivisions. The effective
 * service-tier echo and the moderation result (re-wrapped into the Chat verdict
 * envelope per side, preserving the `{input, output}` split) ride on that usage
 * chunk when present, otherwise on the terminal finish chunk — neither is lost
 * when `include_usage` was not requested.
 */
export class ChatClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "openai-chat" as const;
  private readonly session: StreamSession;
  private readonly wireOptions: StreamWireOptions;
  private readonly created: number;
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(
    session: StreamSession,
    wireOptions: StreamWireOptions = {},
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.session = session;
    this.wireOptions = wireOptions;
    this.created = now();
  }

  setOutcomeWireOptions(options: OutcomeWireOptions): void {
    this.outcomeWireOptions = options;
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
      return ok([{ data: JSON.stringify(chunk) }]);
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
      return ok([{ data: JSON.stringify(chunk) }]);
    }

    if (event.type === "part_start" || event.type === "part_end") {
      return ok([]);
    }

    if (event.type === "response_end") {
      const frames: SseFrame[] = [];

      const emitUsageChunk = this.wireOptions.includeUsage === true && event.usage !== undefined;
      // Outcome sidecar facts re-wrapped to the Chat client wire shape by the
      // same projection the complete-path egress uses.
      const sidecarExtras: Record<string, unknown> = chatOutcomeWireFields(this.outcomeWireOptions);

      // Terminal finish chunk. C/R never report a matched stop string, so a
      // captured IrFinish.stopSequence maps to the natural stop reason via the
      // shared narrowing rule.
      const terminalChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: chatFinishReason(event.finish.reason),
          },
        ],
        ...(!emitUsageChunk ? sidecarExtras : {}),
      };
      frames.push({ data: JSON.stringify(terminalChunk) });

      // Optional final usage chunk with detailed subdivisions.
      if (emitUsageChunk) {
        const usageChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: chatUsageBody(event.usage),
          ...sidecarExtras,
        };
        frames.push({ data: JSON.stringify(usageChunk) });
      }

      // Final [DONE] sentinel
      frames.push({ data: "[DONE]" });

      return ok(frames);
    }

    if (event.type === "error") {
      return ok([]);
    }

    return unsupportedCapability("unknown-stream-event");
  }

  finish(): Result<readonly SseFrame[], NormalizedFailure> {
    return ok([]);
  }
}
