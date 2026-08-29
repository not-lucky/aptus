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

import type { IrFinishReason, IrRequest, IrStreamEvent } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { parseFunctionArgumentsOnce } from "../shared/hosted-tools.ts";
import { buildMessagesRequestBody } from "../shared/messages-request.ts";
import { StreamToolArgumentsBudget } from "../shared/stream-limits.ts";
import { messagesStopReason } from "../shared/transcript.ts";
import {
  accumulateMessagesUsage,
  collapseMessagesUsage,
  type MessagesUsageAccumulator,
  messagesUsageBody,
} from "../shared/usage.ts";
import {
  messagesHostedBlockFailure,
  messagesServerToolUseFailure,
  messagesToolUseCallerFailure,
  parseMessagesCitation,
} from "./content.ts";
import { parseMessagesRequestBody } from "./ingress.ts";
/**
 * Decodes a streaming Anthropic Messages request.
 *
 * Capability rejections (including the thinking/output_config splits), wire-only
 * sidecar capture, transcript items, and generation controls are shared
 * verbatim with the complete-path ingress.
 */
export class MessagesStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(body: JsonObject): Result<StreamRequestDecodeResult, NormalizedFailure> {
    const parsed = parseMessagesRequestBody(body, "stream");
    if (!parsed.ok) return parsed;
    return ok({
      irRequest: parsed.value.irRequest,
      sourceWireOptions: {},
      requestWireOptions: parsed.value.requestWireOptions,
    });
  }
}

function parseContentBlockIndex(chunk: Record<string, unknown>): Result<number, NormalizedFailure> {
  if (typeof chunk.index !== "number" || !Number.isSafeInteger(chunk.index) || chunk.index < 0) {
    return invalidRequest("Messages stream event index must be a non-negative integer");
  }
  return ok(chunk.index);
}

/**
 * Encodes an {@link IrRequest} into target Anthropic Messages stream request
 * JSON, sharing body assembly, generation-control projection, sidecar
 * projection, and breakpoint re-anchoring with the complete-path encoder.
 */
export class MessagesStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    _wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject {
    return buildMessagesRequestBody(request, targetModel, true, requestWireOptions);
  }
}

/**
 * Decodes an upstream Anthropic Messages SSE stream into semantic IR stream events.
 *
 * Provider-owned reasoning blocks fail closed at discovery. The matched stop
 * sequence reported on `message_delta` is captured into
 * `response_end.finish.stopSequence` (echoed only by the M client encoder), and
 * cumulative usage collapses into `response_end.usage`.
 */
export class MessagesProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "anthropic-messages" as const;
  private readonly session: StreamSession;
  private readonly budget: StreamToolArgumentsBudget;
  private readonly partIndexMap = new Map<number, string>();
  private readonly openToolBlocks = new Map<
    number,
    { partId: string; callId: string; name: string; arguments: string }
  >();
  private readonly seenIndices = new Set<number>();
  private readonly usageState: MessagesUsageAccumulator = { sawUsage: false };
  private recordedFinish: IrFinishReason | undefined;
  private recordedStopSequence: string | undefined;
  private sawMessageStop = false;
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.session = session;
    this.budget = new StreamToolArgumentsBudget(maxArgumentBytes);
  }

  getOutcomeWireOptions(): OutcomeWireOptions {
    return this.outcomeWireOptions;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    // The success terminator already went out on message_stop; any later frame
    // is a misbehaving provider stream and fails closed instead of re-emitting
    // a second terminal event.
    if (this.sawMessageStop) {
      return invalidRequest("Messages stream received an event after message_stop");
    }

    if (frame.event === undefined || frame.event.trim() === "") {
      return invalidRequest("Messages stream frame missing named 'event'");
    }

    let rawChunk: unknown;
    try {
      rawChunk = JSON.parse(frame.data);
    } catch (err) {
      return invalidRequest(
        `Messages stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isPlainObject(rawChunk)) {
      return invalidRequest("Messages stream chunk must be a JSON object");
    }
    const chunk = rawChunk as Record<string, unknown>;

    const eventName = frame.event;

    if (eventName === "ping") {
      // Wire-only activity / keepalive
      return ok([]);
    }

    if (eventName === "message_start") {
      const rawMsg = chunk.message;
      if (rawMsg !== undefined && !isPlainObject(rawMsg)) {
        return invalidRequest("message_start requires message object");
      }
      const msg = (rawMsg ?? {}) as Record<string, unknown>;
      // Explicit null is treated as a missing usage record (absence), never
      // a crash and never a fabricated zero.
      const rawUsage = msg.usage as Record<string, unknown> | null | undefined;
      if (rawUsage !== undefined && rawUsage !== null) {
        const usageResult = accumulateMessagesUsage(this.usageState, rawUsage);
        if (!usageResult.ok) return usageResult;
        if (typeof rawUsage.service_tier === "string") {
          this.outcomeWireOptions = { ...this.outcomeWireOptions, serviceTier: rawUsage.service_tier };
        }
      }

      return ok([
        {
          type: "response_start",
          responseId: this.session.responseId,
          model: this.session.model,
        },
      ]);
    }

    if (eventName === "content_block_start") {
      const indexRes = parseContentBlockIndex(chunk);
      if (!indexRes.ok) return indexRes;
      const index = indexRes.value;
      if (this.seenIndices.has(index)) {
        return invalidRequest(`Messages stream content_block index '${index}' reused`);
      }
      this.seenIndices.add(index);
      const rawBlock = chunk.content_block;
      if (!isPlainObject(rawBlock)) {
        return invalidRequest("content_block_start requires content_block object");
      }
      const block = rawBlock as Record<string, unknown>;

      // Provider-owned reasoning blocks fail closed at discovery.
      if (block?.type === "thinking") {
        return unsupportedCapability("readable-reasoning");
      }
      if (block?.type === "redacted_thinking") {
        return unsupportedCapability("redacted-reasoning");
      }
      if (block?.type === "tool_use") {
        const callerFailure = messagesToolUseCallerFailure(block.caller);
        if (callerFailure !== undefined) return failure(callerFailure);
        if (typeof block.id !== "string" || block.id.trim() === "") {
          return invalidRequest("tool_use id must be a non-empty string");
        }
        if (typeof block.name !== "string" || block.name.trim() === "") {
          return invalidRequest("tool_use name must be a non-empty string");
        }
        if (block.input !== undefined && !isPlainObject(block.input)) {
          return invalidRequest("tool_use input must be an object");
        }
        const partId = this.session.createPartId();
        this.openToolBlocks.set(index, { partId, callId: block.id, name: block.name, arguments: "" });
        this.partIndexMap.set(index, partId);
        return ok([
          {
            type: "part_start",
            responseId: this.session.responseId,
            partId,
            part: { type: "function_call", callId: block.id, name: block.name },
          },
        ]);
      }
      if (block?.type === "server_tool_use") return failure(messagesServerToolUseFailure(block));
      const hosted = messagesHostedBlockFailure(block);
      if (hosted !== undefined) return failure(hosted);
      if (block?.type !== "text") {
        return unsupportedCapability("unknown-content-item");
      }
      if (block.signature !== undefined) {
        return unsupportedCapability("reasoning-signature");
      }

      const partId = this.session.createPartId();
      this.partIndexMap.set(index, partId);

      return ok([
        {
          type: "part_start",
          responseId: this.session.responseId,
          partId,
          part: { type: "text" },
        },
      ]);
    }

    if (eventName === "content_block_delta") {
      const indexRes = parseContentBlockIndex(chunk);
      if (!indexRes.ok) return indexRes;
      const index = indexRes.value;
      const rawDelta = chunk.delta;
      if (!isPlainObject(rawDelta)) {
        return invalidRequest("content_block_delta requires delta object");
      }
      const delta = rawDelta as Record<string, unknown>;
      if (delta?.type === "input_json_delta") {
        const tool = this.openToolBlocks.get(index);
        if (tool === undefined) {
          return invalidRequest("input_json_delta received for unknown or non-tool index");
        }
        if (typeof delta.partial_json !== "string") {
          return invalidRequest("input_json_delta partial_json must be a string");
        }
        const claimRes = this.budget.claim(delta.partial_json);
        if (!claimRes.ok) return claimRes;
        tool.arguments += delta.partial_json;
        return ok([
          {
            type: "tool_arguments_delta",
            responseId: this.session.responseId,
            partId: tool.partId,
            callId: tool.callId,
            text: delta.partial_json,
          },
        ]);
      }

      const partId = this.partIndexMap.get(index);
      if (partId === undefined) {
        return invalidRequest(`content_block_delta received for unknown index '${index}'`);
      }

      if (delta?.type === "citations_delta") {
        const cit = delta.citation as Record<string, unknown> | undefined;
        if (!cit || typeof cit !== "object") {
          return invalidRequest("citations_delta missing citation object");
        }
        const parsed = parseMessagesCitation(cit);
        if (!parsed.ok) return parsed;
        return ok([
          {
            type: "citation",
            responseId: this.session.responseId,
            partId,
            citation: parsed.value,
          },
        ]);
      }

      if (delta?.type !== "text_delta") {
        return unsupportedCapability("unknown-stream-event");
      }

      const text = typeof delta.text === "string" ? delta.text : "";
      return ok([
        {
          type: "text_delta",
          responseId: this.session.responseId,
          partId,
          text,
        },
      ]);
    }

    if (eventName === "content_block_stop") {
      const indexRes = parseContentBlockIndex(chunk);
      if (!indexRes.ok) return indexRes;
      const index = indexRes.value;
      const tool = this.openToolBlocks.get(index);
      if (tool !== undefined) {
        const parsed = parseFunctionArgumentsOnce(tool.arguments);
        this.openToolBlocks.delete(index);
        this.partIndexMap.delete(index);
        return ok([
          {
            type: "part_end",
            responseId: this.session.responseId,
            partId: tool.partId,
            partType: "function_call",
            ...(parsed !== undefined ? { arguments: parsed } : {}),
          },
        ]);
      }

      const partId = this.partIndexMap.get(index);
      if (partId === undefined) {
        return invalidRequest(`content_block_stop received for unknown index '${index}'`);
      }

      this.partIndexMap.delete(index);
      return ok([
        {
          type: "part_end",
          responseId: this.session.responseId,
          partId,
          partType: "text",
        },
      ]);
    }

    if (eventName === "message_delta") {
      const rawDelta = chunk.delta;
      if (rawDelta !== undefined && !isPlainObject(rawDelta)) {
        return invalidRequest("message_delta delta must be an object");
      }
      const delta = (rawDelta ?? {}) as Record<string, unknown>;
      const stopReason = delta.stop_reason;

      if (stopReason === "end_turn") {
        this.recordedFinish = "stop";
      } else if (stopReason === "max_tokens") {
        this.recordedFinish = "length";
      } else if (stopReason === "stop_sequence") {
        this.recordedFinish = "stop";
      } else if (stopReason === "tool_use") {
        this.recordedFinish = "tool_calls";
      } else if (stopReason === "refusal") {
        return unsupportedCapability("refusal-content");
      } else if (stopReason === "model_context_window_exceeded") {
        return unsupportedCapability("finish-context-limit");
      } else if (stopReason === "pause_turn") {
        return unsupportedCapability("anthropic-pause-turn");
      } else if (stopReason !== null && stopReason !== undefined) {
        return unsupportedCapability("finish-other-unknown");
      } else {
        this.recordedFinish = "stop";
      }

      // The matched stop string is only meaningful with the `stop_sequence`
      // stop reason: capture it for the M-client echo only in that pairing
      // (C/R clients map to their natural stop with the string omitted), and
      // fail closed on a stray string beside any other reason.
      const rawStopSequence = delta.stop_sequence;
      if (rawStopSequence !== undefined && rawStopSequence !== null) {
        if (typeof rawStopSequence !== "string") {
          return invalidRequest("delta.stop_sequence must be a string when present");
        }
        if (stopReason !== "stop_sequence") {
          return invalidRequest("delta.stop_sequence is only valid with stop_reason 'stop_sequence'");
        }
        this.recordedStopSequence = rawStopSequence;
      }

      // Explicit null is treated as a missing usage record (absence), never
      // a crash and never a fabricated zero.
      const rawUsage = chunk.usage as Record<string, unknown> | null | undefined;
      if (rawUsage !== undefined && rawUsage !== null) {
        // Anthropic message_delta usage is cumulative: each present field is the
        // latest total, so the shared accumulator overwrites rather than sums.
        const usageResult = accumulateMessagesUsage(this.usageState, rawUsage);
        if (!usageResult.ok) return usageResult;
        if (typeof rawUsage.service_tier === "string") {
          this.outcomeWireOptions = { ...this.outcomeWireOptions, serviceTier: rawUsage.service_tier };
        }
      }

      return ok([]);
    }

    if (eventName === "message_stop") {
      this.sawMessageStop = true;
      // Presence parity with the complete path: once any usage record was seen,
      // both billing totals must have been reported. Collapsing a partial record
      // would fabricate zero totals, violating absence-vs-zero non-fabrication.
      if (this.usageState.sawUsage && this.usageState.inputTokens === undefined) {
        return invalidRequest("usage.input_tokens must be a finite number when usage is present");
      }
      if (this.usageState.sawUsage && this.usageState.outputTokens === undefined) {
        return invalidRequest("usage.output_tokens must be a finite number when usage is present");
      }
      const usage = collapseMessagesUsage(this.usageState);
      return ok([
        {
          type: "response_end",
          responseId: this.session.responseId,
          finish: {
            reason: this.recordedFinish ?? "stop",
            ...(this.recordedStopSequence !== undefined ? { stopSequence: this.recordedStopSequence } : {}),
          },
          ...(usage !== undefined ? { usage } : {}),
        },
      ]);
    }

    if (eventName === "error") {
      const err = (chunk.error ?? {}) as Record<string, unknown>;
      return failure({
        category: "provider",
        message: typeof err.message === "string" ? err.message : "Messages provider stream error",
        code: typeof err.type === "string" ? err.type : undefined,
        retryable: false,
      });
    }

    return unsupportedCapability("unknown-stream-event");
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.sawMessageStop) {
      return failure({
        category: "stream_interrupted",
        message: "Messages stream ended unexpectedly before message_stop",
        retryable: false,
      });
    }
    return ok([]);
  }
}

/**
 * Encodes semantic IR stream events into client-native Anthropic Messages SSE frames.
 *
 * The terminal `message_delta` reconstructs M usage accounting from the IR
 * totals (`input_tokens = input - cacheRead - cacheWrite`) with the cache
 * subdivisions and thinking breakdown, and echoes a matched stop sequence with
 * the `stop_sequence` stop reason.
 */
export class MessagesClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "anthropic-messages" as const;
  private readonly session: StreamSession;
  private readonly budget: StreamToolArgumentsBudget;
  private readonly deferredFunctionParts = new Map<string, { callId: string; name: string }>();
  private readonly partIndices = new Map<string, number>();
  private nextPartIndex = 0;

  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.session = session;
    this.budget = new StreamToolArgumentsBudget(maxArgumentBytes);
  }

  /**
   * No-op by contract: the M wire has no outcome-side sidecar surface.
   * Moderation results destined for an M client fail closed before encoding,
   * and M-touching service-tier echoes are stripped as declared loss during
   * normalization, so the pump never delivers non-empty options here.
   */
  setOutcomeWireOptions(_options: OutcomeWireOptions): void {
    // Intentionally empty — see doc comment above.
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
      return ok(frames);
    }

    if (event.type === "part_start") {
      if (event.part.type === "function_call") {
        this.deferredFunctionParts.set(event.partId, {
          callId: event.part.callId,
          name: event.part.name,
        });
        return ok([]);
      }
      if (event.part.type === "text") {
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
        return ok(frames);
      }
      return unsupportedCapability("unknown-stream-event");
    }

    if (event.type === "tool_arguments_delta") {
      return ok([]);
    }

    if (event.type === "text_delta") {
      const index = this.partIndices.get(event.partId);
      if (index === undefined) {
        return invalidRequest(`text_delta received for unknown partId '${event.partId}'`);
      }
      frames.push({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: event.text },
        }),
      });
      return ok(frames);
    }

    if (event.type === "citation") {
      if (event.citation.source.type === "url") {
        return unsupportedCapability("url-citation-source");
      }
      return unsupportedCapability("citation-document-location");
    }

    if (event.type === "part_end") {
      if (event.partType === "function_call") {
        if (event.arguments === undefined) {
          return invalidRequest("Streamed function call arguments did not parse to a valid JSON object");
        }
        const meta = this.deferredFunctionParts.get(event.partId);
        if (meta === undefined) {
          return invalidRequest(`part_end received for unknown function partId '${event.partId}'`);
        }
        const jsonStr = JSON.stringify(event.arguments);
        const claimRes = this.budget.claim(jsonStr);
        if (!claimRes.ok) return claimRes;
        const index = this.nextPartIndex++;
        this.partIndices.set(event.partId, index);
        frames.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: meta.callId,
              name: meta.name,
              input: {},
            },
          }),
        });
        frames.push({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: jsonStr,
            },
          }),
        });
        frames.push({
          event: "content_block_stop",
          data: JSON.stringify({
            type: "content_block_stop",
            index,
          }),
        });
        this.deferredFunctionParts.delete(event.partId);
        this.partIndices.delete(event.partId);
        return ok(frames);
      }

      const index = this.partIndices.get(event.partId);
      if (index === undefined) {
        return invalidRequest(`part_end received for unknown text partId '${event.partId}'`);
      }
      this.partIndices.delete(event.partId);
      frames.push({
        event: "content_block_stop",
        data: JSON.stringify({
          type: "content_block_stop",
          index,
        }),
      });
      return ok(frames);
    }

    if (event.type === "response_end") {
      const matchedStop = event.finish.stopSequence;
      const stopReason = messagesStopReason(event.finish);

      let usage: JsonObject | undefined;
      if (event.usage !== undefined) {
        usage = messagesUsageBody(event.usage);
      }

      frames.push({
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          // The M wire pairs a non-null stop_sequence with its own stop
          // reason and nothing else.
          delta: { stop_reason: stopReason, stop_sequence: stopReason === "stop_sequence" ? matchedStop : null },
          ...(usage !== undefined ? { usage } : {}),
        }),
      });
      frames.push({
        event: "message_stop",
        data: JSON.stringify({
          type: "message_stop",
        }),
      });
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
