/**
 * @fileoverview Streaming codec for the OpenAI Chat Completions protocol.
 *
 * Provides request decoding/encoding, provider SSE stream decoding, and client SSE stream
 * encoding for `openai-chat`. Decodes incoming SSE chunks into semantic IR stream events
 * and serializes IR events back into Chat chunk frames, including `include_usage` synthesis.
 *
 * Reuses complete-path request parsing through {@link parseChatRequestBody} for semantic parity.
 * Delegates part lifecycle, chunk correlation, and argument buffering to {@link StreamShapeTracker}.
 */

import type { JsonObject, Result } from "../../../domain/contracts.ts";
import { isPlainObject } from "../../../domain/json.ts";
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
import { truncateProviderErrorString } from "../../failures.ts";
import type { IrFinishReason, IrRequest, IrStreamEvent, IrUsage } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { firstUnknownKey } from "../shared/controls.ts";
import { chatOutputFormatFields } from "../shared/output-format.ts";
import { StreamShapeTracker } from "../shared/stream-shape.ts";
import { chatToolFields } from "../shared/tool-fields.ts";
import { buildChatMessages, chatFinishReason, chatGenerationFields } from "../shared/transcript.ts";
import { chatUsageBody, parseChatUsage } from "../shared/usage.ts";
import { captureOutcomeWireFacts, chatOutcomeWireFields, chatResponsesRequestFields } from "../shared/wire-options.ts";
import { parseChatRequestBody } from "./ingress.ts";
/**
 * Decodes streaming OpenAI Chat Completions requests into IR requests and stream options.
 *
 * Extends the shared Chat request grammar with stream-specific `stream_options` validation.
 */
export class ChatStreamRequestDecoder implements StreamRequestDecoder {
  /**
   * Decodes a streaming Chat request body into an IR request and stream wire options.
   *
   * @param body - Client request body to decode.
   * @returns Result containing decoded IR request, stream options, and request wire sidecar.
   */
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
 * Encodes an IR request into a target OpenAI Chat streaming request body.
 *
 * Sets `stream: true` and configures `stream_options` while projecting generation and tool parameters.
 */
export class ChatStreamRequestEncoder implements StreamRequestEncoder {
  /**
   * Encodes an IR request into a target Chat streaming request body.
   *
   * @param request - Preflight-validated IR request to encode.
   * @param targetModel - Provider-facing model name.
   * @param wireOptions - Stream wire options specifying usage preference.
   * @param requestWireOptions - Optional request-side wire options.
   * @returns Serialized Chat streaming request JSON body.
   */
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const messages = buildChatMessages(request.items, markedItems, requestWireOptions);

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
      ...chatOutputFormatFields(request.output, requestWireOptions),
    };
  }
}

/**
 * Decodes an upstream OpenAI Chat SSE stream into semantic IR stream events.
 *
 * Dispatches chunks on structure, validates error envelopes, handles usage and finish deltas,
 * and tracks part lifecycles via {@link StreamShapeTracker}.
 */
export class ChatProviderStreamDecoder implements ProviderStreamDecoder {
  /** Protocol identifier for this decoder. */
  readonly protocol = "openai-chat" as const;
  /** Shared shape bookkeeping for this session. */
  private readonly tracker: StreamShapeTracker;
  /** Recorded finish reason emitted with the terminal event. */
  private finishReason: IrFinishReason | undefined;
  /** Usage parsed from the final empty-choices chunk. */
  private pendingUsage: IrUsage | undefined;
  /** Captured response-side wire options recorded last-write-wins. */
  private outcomeWireOptions: OutcomeWireOptions = {};

  /**
   * Creates a Chat provider stream decoder bound to a stream session.
   *
   * @param session - Stream session providing response and part identifiers.
   * @param maxArgumentBytes - Optional byte limit for streamed tool arguments.
   */
  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.tracker = new StreamShapeTracker({ session, maxArgumentBytes, wireLabel: "Chat" });
  }

  /**
   * Returns response-side wire options captured from streamed chunks.
   *
   * @returns Captured wire options such as service tier and moderation facts.
   */
  getOutcomeWireOptions(): OutcomeWireOptions {
    return this.outcomeWireOptions;
  }

  /**
   * Processes one SSE frame from the provider and returns emitted IR stream events.
   *
   * @param frame - Server-sent events frame from the provider stream.
   * @returns Result containing emitted IR events or normalized failure.
   */
  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    // The success terminator already went out on [DONE]; any later frame is a
    // misbehaving provider stream and fails closed instead of re-emitting a
    // second terminal event.
    const guard = this.tracker.guardFrame();
    if (!guard.ok) return guard;

    const trimmedData = frame.data.trim();
    if (trimmedData === "[DONE]") {
      this.tracker.markTerminal();
      const doneEvents: IrStreamEvent[] = [];
      if (this.finishReason !== undefined) {
        this.tracker.responseEnd(doneEvents, { reason: this.finishReason }, this.pendingUsage);
      }
      return ok(doneEvents);
    }

    let rawChunk: unknown;
    try {
      rawChunk = JSON.parse(frame.data);
    } catch (err) {
      return invalidRequest(`Chat stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(rawChunk)) {
      return invalidRequest("Chat stream chunk must be a JSON object");
    }
    const chunk = rawChunk as Record<string, unknown>;

    if (chunk.error !== undefined && chunk.error !== null) {
      if (!isPlainObject(chunk.error)) {
        return invalidRequest("Chat stream in-band error must be a JSON object");
      }
      const err = chunk.error as Record<string, unknown>;
      // Upstream message/code strings are diagnostic-only and bounded; the
      // full bytes remain in Trace.
      const message = typeof err.message === "string" ? err.message : "Chat provider stream in-band error";
      const code = typeof err.code === "string" ? err.code : undefined;
      // The chatcmpl chunk `id` is a response object id, not a request id;
      // only an explicit error-body request id is an observed request id.
      const requestId = typeof err.request_id === "string" ? err.request_id : undefined;
      return failure({
        category: "provider",
        message: truncateProviderErrorString(message),
        code: code !== undefined ? truncateProviderErrorString(code) : undefined,
        retryable: false,
        ...(requestId !== undefined ? { requestId } : {}),
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

    const rawChoice = chunk.choices[0];
    if (!isPlainObject(rawChoice)) {
      return invalidRequest("Chat stream choices[0] must be an object");
    }
    const choice = rawChoice as Record<string, unknown>;
    if (choice.index !== 0) {
      return unsupportedCapability("multiple-candidates");
    }

    this.tracker.ensureStarted(events);

    const rawDelta = choice.delta;
    if (rawDelta !== undefined && rawDelta !== null) {
      if (!isPlainObject(rawDelta)) {
        return invalidRequest("Chat stream choice.delta must be an object");
      }
      const delta = rawDelta as Record<string, unknown>;
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) {
          return invalidRequest("delta.tool_calls must be an array");
        }
        for (const rawToolCall of delta.tool_calls) {
          if (!isPlainObject(rawToolCall)) {
            return invalidRequest("delta.tool_calls element must be an object");
          }
          const toolCall = rawToolCall as Record<string, unknown>;
          const extraToolKey = firstUnknownKey(toolCall, ["index", "id", "type", "function"]);
          if (extraToolKey !== undefined) {
            return invalidRequest(`delta.tool_calls has unrecognized key '${extraToolKey}'`);
          }
          if (typeof toolCall.index !== "number" || !Number.isSafeInteger(toolCall.index) || toolCall.index < 0) {
            return invalidRequest("delta.tool_calls index must be a non-negative integer");
          }
          if (toolCall.type === "custom") {
            return unsupportedCapability("custom-tool-streaming");
          }
          if (toolCall.type !== undefined && toolCall.type !== "function") {
            return invalidRequest("delta.tool_calls type must be 'function' when present");
          }

          const slot = `tool:${toolCall.index}`;
          const existing = this.tracker.openFunctionPartInfo(slot);
          if (existing !== undefined) {
            if (typeof toolCall.id === "string" && toolCall.id !== existing.callId) {
              return invalidRequest("delta.tool_calls id cannot change on existing index");
            }
            const rawFnObj = toolCall.function;
            if (rawFnObj !== undefined && !isPlainObject(rawFnObj)) {
              return invalidRequest("delta.tool_calls function must be an object");
            }
            const fnObj = rawFnObj as Record<string, unknown> | undefined;
            if (fnObj !== undefined) {
              const extraFnKey = firstUnknownKey(fnObj, ["name", "arguments"]);
              if (extraFnKey !== undefined) {
                return invalidRequest(`delta.tool_calls function has unrecognized key '${extraFnKey}'`);
              }
            }
            if (typeof fnObj?.name === "string" && fnObj.name !== existing.name) {
              return invalidRequest("delta.tool_calls name cannot change on existing index");
            }
            if (typeof fnObj?.arguments === "string" && fnObj.arguments.length > 0) {
              const deltaRes = this.tracker.toolArgumentsDelta(
                events,
                slot,
                fnObj.arguments,
                typeof toolCall.id === "string" ? toolCall.id : undefined,
              );
              if (!deltaRes.ok) return deltaRes;
            } else if (fnObj?.arguments !== undefined && typeof fnObj.arguments !== "string") {
              return invalidRequest("delta.tool_calls function.arguments must be a string");
            }
          } else {
            if (typeof toolCall.id !== "string" || toolCall.id.trim() === "") {
              return invalidRequest("tool_calls id must be a non-empty string");
            }
            const rawFnObj = toolCall.function;
            if (!isPlainObject(rawFnObj)) {
              return invalidRequest("tool_calls function must be an object");
            }
            const fnObj = rawFnObj as Record<string, unknown>;
            const extraFnKey = firstUnknownKey(fnObj, ["name", "arguments"]);
            if (extraFnKey !== undefined) {
              return invalidRequest(`tool_calls function has unrecognized key '${extraFnKey}'`);
            }
            if (typeof fnObj?.name !== "string" || fnObj.name.trim() === "") {
              return invalidRequest("tool_calls function.name must be a non-empty string");
            }
            const openRes = this.tracker.openFunctionPart(events, slot, toolCall.id, fnObj.name, {
              dedupCallId: true,
            });
            if (!openRes.ok) return openRes;
            if (typeof fnObj.arguments === "string" && fnObj.arguments.length > 0) {
              const deltaRes = this.tracker.toolArgumentsDelta(events, slot, fnObj.arguments);
              if (!deltaRes.ok) return deltaRes;
            } else if (fnObj.arguments !== undefined && typeof fnObj.arguments !== "string") {
              return invalidRequest("tool_calls function.arguments must be a string");
            }
          }
        }
      }
      if (delta.refusal !== undefined && delta.refusal !== null) {
        // A present-but-malformed refusal delta fabricates nothing: only a
        // string carries refusal text, anything else fails closed.
        if (typeof delta.refusal !== "string") {
          return invalidRequest("delta.refusal must be a string when present");
        }
        const refusalRes = this.tracker.refusalDelta(events, "refusal", delta.refusal);
        if (!refusalRes.ok) return refusalRes;
      }

      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") {
          return invalidRequest("delta.content must be a string when present");
        }
        if (delta.content.length > 0) {
          const textRes = this.tracker.textDelta(events, "text", delta.content, { lazy: true });
          if (!textRes.ok) return textRes;
        }
      } else if (delta.role === "assistant" && this.tracker.partIdOf("text") === undefined) {
        this.tracker.openTextPart(events, "text", "reuse-typed");
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (choice.finish_reason === "stop") {
        this.finishReason = this.tracker.sawRefusal() ? "refusal" : "stop";
      } else if (choice.finish_reason === "length") {
        this.finishReason = "length";
      } else if (choice.finish_reason === "tool_calls") {
        if (this.tracker.sawRefusal()) {
          return invalidRequest("Chat stream encountered both refusal and tool_calls");
        }
        this.finishReason = "tool_calls";
      } else if (choice.finish_reason === "content_filter") {
        this.finishReason = "content_filter";
      } else {
        return unsupportedCapability("finish-other-unknown");
      }

      const textPartId = this.tracker.partIdOf("text");
      if (textPartId !== undefined) {
        const closeRes = this.tracker.closePart(events, "text", "text");
        if (!closeRes.ok) return closeRes;
      }
      const refusalPartId = this.tracker.partIdOf("refusal");
      if (refusalPartId !== undefined) {
        const closeRes = this.tracker.closePart(events, "refusal", "refusal");
        if (!closeRes.ok) return closeRes;
      }
      this.tracker.closeAllFunctionParts(events);
    }

    return ok(events);
  }

  /**
   * Reports whether the stream ended through its documented terminator.
   *
   * The stream pump calls this after the provider connection closes. A Chat stream is complete
   * only when the `[DONE]` sentinel arrived and marked the tracker terminal; any earlier close is
   * an interruption that routing treats as a retryable-at-the-routing-layer failure of the
   * candidate.
   *
   * @returns A successful empty result when the stream terminated cleanly. Returns a failed result
   *   with the `stream_interrupted` category when the connection closed before `[DONE]`.
   */
  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.tracker.isTerminal()) {
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
 * Handles chunk construction for deltas, tool calls, finish reasons, and synthesized usage chunks.
 */
export class ChatClientStreamEncoder implements ClientStreamEncoder {
  /** Protocol identifier for this encoder. */
  readonly protocol = "openai-chat" as const;
  /** Stream session providing response identifier and model name. */
  private readonly session: StreamSession;
  /** Stream options captured from the client request. */
  private readonly wireOptions: StreamWireOptions;
  /** Unix epoch seconds timestamp stamped on each chunk. */
  private readonly created: number;
  /** Response-side wire options emitted on terminal or usage chunks. */
  private outcomeWireOptions: OutcomeWireOptions = {};
  /** Mapping of IR part IDs to allocated tool call indices and metadata. */
  private readonly partIndices = new Map<string, { toolIndex: number; callId: string; name: string }>();
  /** Counter allocating consecutive tool indices. */
  private nextToolIndex = 0;

  /**
   * Creates an encoder bound to a client stream session.
   *
   * @param session - Stream session providing response ID and model name.
   * @param wireOptions - Client stream options including usage request flags.
   * @param now - Clock providing Unix epoch seconds.
   */
  constructor(
    session: StreamSession,
    wireOptions: StreamWireOptions = {},
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.session = session;
    this.wireOptions = wireOptions;
    this.created = now();
  }

  /**
   * Injects outcome wire options to emit with the terminal or usage chunk.
   *
   * @param options - Response-side wire options from the provider stream.
   */
  setOutcomeWireOptions(options: OutcomeWireOptions): void {
    this.outcomeWireOptions = options;
  }

  /**
   * Encodes an IR stream event into one or more Chat SSE frames.
   *
   * @param event - IR stream event to serialize.
   * @returns Result containing serialized SSE frames or normalized failure.
   */
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

    if (event.type === "refusal_delta") {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { refusal: event.text },
            finish_reason: null,
          },
        ],
      };
      return ok([{ data: JSON.stringify(chunk) }]);
    }

    if (event.type === "part_start") {
      if (event.part.type === "function_call") {
        const toolIndex = this.nextToolIndex++;
        this.partIndices.set(event.partId, {
          toolIndex,
          callId: event.part.callId,
          name: event.part.name,
        });
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: event.part.callId,
                    type: "function",
                    function: { name: event.part.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        return ok([{ data: JSON.stringify(chunk) }]);
      }
      return ok([]);
    }

    if (event.type === "tool_arguments_delta") {
      const entry = this.partIndices.get(event.partId);
      if (entry === undefined) {
        return invalidRequest(`tool_arguments_delta received for unknown partId '${event.partId}'`);
      }
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: entry.toolIndex,
                  function: { arguments: event.text },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      return ok([{ data: JSON.stringify(chunk) }]);
    }

    if (event.type === "citation") {
      return unsupportedCapability("citation-stream-event");
    }

    if (event.type === "part_end") {
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

  /**
   * Completes the client stream session.
   *
   * @returns Always returns an empty array as terminal frames are emitted on `response_end`.
   */
  finish(): Result<readonly SseFrame[], NormalizedFailure> {
    return ok([]);
  }
}
