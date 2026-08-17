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
import type { IrRequest, IrStreamEvent } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { responsesReasoningItemFailure } from "../shared/hosted-tools.ts";
import { responsesToolFields } from "../shared/tool-fields.ts";
import { buildResponsesInput, responsesFinishStatus, responsesGenerationFields } from "../shared/transcript.ts";
import { parseResponsesUsage, responsesUsageBody } from "../shared/usage.ts";
import {
  captureOutcomeWireFacts,
  chatResponsesRequestFields,
  responsesOutcomeWireFields,
} from "../shared/wire-options.ts";
import { parseResponsesRequestBody } from "./ingress.ts";
/**
 * Decodes a streaming OpenAI Responses request.
 *
 * Capability rejections, wire-only sidecar capture, transcript items, and
 * generation controls are shared verbatim with the complete-path ingress.
 */
export class ResponsesStreamRequestDecoder implements StreamRequestDecoder {
  decodeRequest(body: JsonObject): Result<StreamRequestDecodeResult, NormalizedFailure> {
    const parsed = parseResponsesRequestBody(body, "stream");
    if (!parsed.ok) return parsed;
    return ok({
      irRequest: parsed.value.irRequest,
      sourceWireOptions: {},
      requestWireOptions: parsed.value.requestWireOptions,
    });
  }
}

/**
 * Encodes an {@link IrRequest} into target OpenAI Responses stream request
 * JSON, projecting generation controls and the admitted wire-only sidecar
 * fields exactly like the complete-path encoder.
 */
export class ResponsesStreamRequestEncoder implements StreamRequestEncoder {
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    _wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const input = buildResponsesInput(request.items, markedItems);

    return {
      model: targetModel,
      input,
      stream: true,
      ...responsesGenerationFields(request.generation),
      ...chatResponsesRequestFields(requestWireOptions),
      ...responsesToolFields(request, requestWireOptions),
    };
  }
}

/**
 * Scans one terminal response object's output array for provider-owned
 * reasoning items. The `output_item.added` events normally carry every item,
 * but a terminal payload that includes an unannounced reasoning item must fail
 * closed too instead of silently vanishing behind a success terminator.
 */
function scanTerminalOutputForReasoning(resp: Record<string, unknown>): Result<void, NormalizedFailure> {
  if (!Array.isArray(resp.output)) return ok(undefined);
  for (const item of resp.output) {
    const itemObj = item as Record<string, unknown>;
    if (itemObj?.type === "reasoning") {
      return failure(responsesReasoningItemFailure(itemObj));
    }
  }
  return ok(undefined);
}

/**
 * Decodes an upstream OpenAI Responses SSE stream into semantic IR stream events.
 *
 * Provider-owned reasoning output items fail closed at discovery
 * (`encrypted-reasoning` when carrying `encrypted_content`, else
 * `readable-reasoning`). The terminal completion event collapses usage with its
 * subdivisions into `response_end.usage` and captures the service-tier echo and
 * moderation result for the outcome wire-options sidecar.
 */
export class ResponsesProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "openai-responses" as const;
  private readonly session: StreamSession;
  private lastSequenceNumber = 0;
  private currentPartId: string | undefined;
  private partStarted = false;
  private completed = false;
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(session: StreamSession) {
    this.session = session;
  }

  getOutcomeWireOptions(): OutcomeWireOptions {
    return this.outcomeWireOptions;
  }

  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    // The success terminator already went out on the terminal event; any later
    // event is a misbehaving provider stream and fails closed instead of
    // re-emitting a second terminal event.
    if (this.completed) {
      return invalidRequest("Responses stream received an event after the terminal completion event");
    }

    if (frame.event === undefined || frame.event.trim() === "") {
      return invalidRequest("Responses stream frame missing required named 'event'");
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (err) {
      return invalidRequest(
        `Responses stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (chunk.type !== frame.event) {
      return invalidRequest(`Responses frame event '${frame.event}' does not match JSON type '${String(chunk.type)}'`);
    }

    if (typeof chunk.sequence_number === "number") {
      if (!Number.isSafeInteger(chunk.sequence_number) || chunk.sequence_number <= this.lastSequenceNumber) {
        return invalidRequest(
          `Responses stream sequence_number must be strictly increasing (expected > ${this.lastSequenceNumber}, got ${chunk.sequence_number})`,
        );
      }
      this.lastSequenceNumber = chunk.sequence_number;
    }

    const eventName = frame.event;

    if (eventName === "response.created") {
      return ok([
        {
          type: "response_start",
          responseId: this.session.responseId,
          model: this.session.model,
        },
      ]);
    }

    if (eventName === "response.in_progress") {
      return ok([]);
    }

    if (eventName === "response.output_item.added") {
      const item = chunk.item as Record<string, unknown> | undefined;
      // Provider-owned reasoning output items fail closed instead of vanishing.
      if (item?.type === "reasoning") {
        return failure(responsesReasoningItemFailure(item));
      }
      if (item?.type !== "message") {
        return unsupportedCapability(
          item?.type === "function_call" ? "function-tool-definition" : "unknown-content-item",
        );
      }
      return ok([]);
    }

    if (eventName === "response.content_part.added") {
      const part = chunk.part as Record<string, unknown> | undefined;
      if (part?.type !== "output_text") {
        return unsupportedCapability(part?.type === "refusal" ? "refusal-content" : "unknown-content-item");
      }
      this.currentPartId = this.session.createPartId();
      this.partStarted = true;
      return ok([
        {
          type: "part_start",
          responseId: this.session.responseId,
          partId: this.currentPartId,
          part: { type: "text" },
        },
      ]);
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
      return ok(events);
    }

    if (eventName === "response.output_text.done") {
      if (!this.partStarted || this.currentPartId === undefined) {
        return ok([]);
      }
      const partId = this.currentPartId;
      this.partStarted = false;
      return ok([
        {
          type: "part_end",
          responseId: this.session.responseId,
          partId,
          partType: "text",
        },
      ]);
    }

    if (eventName === "response.content_part.done" || eventName === "response.output_item.done") {
      return ok([]);
    }

    if (eventName === "response.completed") {
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutputForReasoning(resp);
      if (!scanResult.ok) return scanResult;
      this.completed = true;
      const factsResult = captureOutcomeWireFacts(resp, this.outcomeWireOptions, "Responses");
      if (!factsResult.ok) return factsResult;
      this.outcomeWireOptions = factsResult.value;
      const usageResult = parseResponsesUsage(resp.usage);
      if (!usageResult.ok) return usageResult;
      return ok([
        {
          type: "response_end",
          responseId: this.session.responseId,
          finish: { reason: "stop" },
          ...(usageResult.value !== undefined ? { usage: usageResult.value } : {}),
        },
      ]);
    }

    if (eventName === "response.incomplete") {
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutputForReasoning(resp);
      if (!scanResult.ok) return scanResult;
      const details = (resp.incomplete_details ?? {}) as Record<string, unknown>;
      if (details.reason !== "max_output_tokens") {
        return unsupportedCapability(
          details.reason === "content_filter" ? "finish-content-filter" : "finish-other-unknown",
        );
      }

      this.completed = true;
      const factsResult = captureOutcomeWireFacts(resp, this.outcomeWireOptions, "Responses");
      if (!factsResult.ok) return factsResult;
      this.outcomeWireOptions = factsResult.value;
      const usageResult = parseResponsesUsage(resp.usage);
      if (!usageResult.ok) return usageResult;
      return ok([
        {
          type: "response_end",
          responseId: this.session.responseId,
          finish: { reason: "length" },
          ...(usageResult.value !== undefined ? { usage: usageResult.value } : {}),
        },
      ]);
    }

    if (eventName === "response.failed" || eventName === "error") {
      const err = (chunk.error ?? (chunk.response as Record<string, unknown>)?.error ?? {}) as Record<string, unknown>;
      return failure({
        category: "provider",
        message: typeof err.message === "string" ? err.message : "Responses provider stream error",
        code: typeof err.code === "string" ? err.code : undefined,
        retryable: false,
      });
    }

    // Unmapped non-semantic wire event (ignored)
    return ok([]);
  }

  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.completed) {
      return failure({
        category: "stream_interrupted",
        message: "Responses stream ended unexpectedly before completion event",
        retryable: false,
      });
    }
    return ok([]);
  }
}

/**
 * Encodes semantic IR stream events into client-native OpenAI Responses SSE frames.
 *
 * The terminal completion event carries detailed usage subdivisions plus the
 * effective service-tier echo and moderation result when one was captured for
 * this direction.
 */
export class ResponsesClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "openai-responses" as const;
  private readonly session: StreamSession;
  private sequenceNumber = 1;
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(session: StreamSession) {
    this.session = session;
  }

  setOutcomeWireOptions(options: OutcomeWireOptions): void {
    this.outcomeWireOptions = options;
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
      return ok(frames);
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
      return ok(frames);
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
      return ok(frames);
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
      return ok(frames);
    }

    if (event.type === "response_end") {
      const usage = event.usage !== undefined ? responsesUsageBody(event.usage) : undefined;

      const responseExtras: Record<string, unknown> = {
        ...(usage !== undefined ? { usage } : {}),
        // Sidecar facts project through the same helper the complete-path
        // egress uses.
        ...responsesOutcomeWireFields(this.outcomeWireOptions),
      };

      // Every terminal outcome produces a success terminator: the length
      // reason maps to response.incomplete, every other admitted reason to
      // response.completed — the shared narrowing rule keeps a client stream
      // from ever hanging without a terminator.
      if (responsesFinishStatus(event.finish.reason) === "incomplete") {
        frames.push({
          event: "response.incomplete",
          data: JSON.stringify({
            type: "response.incomplete",
            response: {
              id,
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              ...responseExtras,
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
      } else {
        frames.push({
          event: "response.completed",
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id,
              status: "completed",
              ...responseExtras,
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
      }
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
