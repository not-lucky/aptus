/**
 * @fileoverview OpenAI Responses streaming codec: request decoding and encoding,
 * provider stream decoding, and client stream encoding.
 *
 * Handles named-event SSE frames (`response.created`, `response.output_item.added`,
 * `response.output_text.delta`, `response.function_call_arguments.*`, `response.completed`,
 * `response.failed`). Enforces sequence-number ordering and reasoning detection, while
 * delegating cross-protocol stream shape tracking to {@link StreamShapeTracker}.
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
import type { IrFinishReason, IrRequest, IrStreamEvent } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { responsesReasoningItemFailure } from "../shared/hosted-tools.ts";
import { responsesTextConfig } from "../shared/output-format.ts";
import { StreamToolArgumentsBudget } from "../shared/stream-limits.ts";
import { StreamShapeTracker } from "../shared/stream-shape.ts";
import { responsesToolFields } from "../shared/tool-fields.ts";
import { buildResponsesInput, responsesFinishStatus, responsesGenerationFields } from "../shared/transcript.ts";
import { parseResponsesUsage, responsesUsageBody } from "../shared/usage.ts";
import {
  captureOutcomeWireFacts,
  chatResponsesRequestFields,
  responsesOutcomeWireFields,
} from "../shared/wire-options.ts";
import { parseResponsesAnnotation, parseResponsesRequestBody } from "./ingress.ts";

/**
 * Decodes streaming OpenAI Responses requests into IR requests.
 *
 * Delegates request body parsing to {@link parseResponsesRequestBody} with no stream-only options.
 */
export class ResponsesStreamRequestDecoder implements StreamRequestDecoder {
  /**
   * Decodes a streaming Responses request body into an {@link IrRequest}.
   *
   * @param body - Raw request body JSON object.
   * @returns Decoded IR request with request wire options, or normalized failure.
   */
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
 * Encodes an {@link IrRequest} into an OpenAI Responses streaming request body.
 */
export class ResponsesStreamRequestEncoder implements StreamRequestEncoder {
  /**
   * Encodes an IR request into an OpenAI Responses streaming request body.
   *
   * @param request - The IR request to encode.
   * @param targetModel - Provider model name for the target.
   * @param _wireOptions - Unused; Responses defines no stream-only request options.
   * @param requestWireOptions - Optional request-side sidecar options captured at ingress.
   * @returns The encoded request body JSON object.
   */
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    _wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject {
    const markedItems = new Set(
      (requestWireOptions?.promptCacheBreakpoints ?? []).map((breakpoint) => breakpoint.itemIndex),
    );
    const input = buildResponsesInput(request.items, markedItems, requestWireOptions);

    return {
      model: targetModel,
      input,
      stream: true,
      ...responsesGenerationFields(request.generation),
      ...responsesTextConfig(request.generation, request.output, requestWireOptions),
      ...chatResponsesRequestFields(requestWireOptions),
      ...responsesToolFields(request, requestWireOptions),
    };
  }
}

/**
 * Scans a terminal response object's output array for unannounced reasoning or unsupported items.
 *
 * @param resp - Decoded terminal response object.
 * @param hasIdentity - Predicate checking whether an item or call identifier was announced.
 * @returns Ok on valid output, or normalized failure if invalid items are present.
 */
function scanTerminalOutput(
  resp: Record<string, unknown>,
  hasIdentity: (identity: string) => boolean,
): Result<void, NormalizedFailure> {
  if (!Array.isArray(resp.output)) return ok(undefined);
  for (const item of resp.output) {
    if (!isPlainObject(item)) continue;
    const itemObj = item as Record<string, unknown>;
    if (itemObj.type === "reasoning") {
      return failure(responsesReasoningItemFailure(itemObj));
    }
    if (itemObj.type === "custom_tool_call" || itemObj.type === "program" || itemObj.type === "program_output") {
      return unsupportedCapability("custom-tool-streaming");
    }
    if (itemObj.type === "namespace" || itemObj.namespace !== undefined) {
      return unsupportedCapability("tool-namespaces");
    }
    if (itemObj.caller !== undefined) {
      return unsupportedCapability("programmatic-tools");
    }
    if (itemObj.type === "function_call") {
      const id = typeof itemObj.id === "string" ? itemObj.id : undefined;
      const callId = typeof itemObj.call_id === "string" ? itemObj.call_id : undefined;
      const recognized = (id !== undefined && hasIdentity(id)) || (callId !== undefined && hasIdentity(callId));
      if (!recognized) return invalidRequest("Unannounced function_call in terminal output");
    }
  }
  return ok(undefined);
}

/**
 * Decodes an upstream OpenAI Responses SSE stream into semantic IR stream events.
 *
 * Handles event matching, strictly increasing sequence-number validation, item routing,
 * and completion status derivation. Delegates part shape and budget to {@link StreamShapeTracker}.
 */
export class ResponsesProviderStreamDecoder implements ProviderStreamDecoder {
  readonly protocol = "openai-responses" as const;
  /** Shared shape bookkeeping for this session. */
  private readonly tracker: StreamShapeTracker;
  /** Highest sequence number accepted so far; out-of-order events fail closed. */
  private lastSequenceNumber = 0;
  /** Last-write-wins capture of response-side sidecar facts. */
  private outcomeWireOptions: OutcomeWireOptions = {};

  /**
   * Creates a decoder bound to one stream session.
   *
   * @param session - Stream session providing response and part identifiers.
   * @param maxArgumentBytes - Optional override for streamed tool argument budget.
   */
  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.tracker = new StreamShapeTracker({ session, maxArgumentBytes, wireLabel: "Responses" });
  }

  /**
   * Returns response-side sidecar facts captured from completion events.
   */
  getOutcomeWireOptions(): OutcomeWireOptions {
    return this.outcomeWireOptions;
  }

  /**
   * Processes a single Responses SSE frame into zero or more IR stream events.
   *
   * Validates sequence-number monotonicity and maps named events to IR events.
   *
   * @param frame - Incoming server-sent events frame.
   * @returns Array of decoded IR events, or a normalized failure.
   */
  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure> {
    // The success terminator already went out on the terminal event; any later
    // event is a misbehaving provider stream and fails closed instead of
    // re-emitting a second terminal event.
    const guard = this.tracker.guardFrame();
    if (!guard.ok) return guard;

    if (frame.event === undefined || frame.event.trim() === "") {
      return invalidRequest("Responses stream frame missing required named 'event'");
    }

    let rawChunk: unknown;
    try {
      rawChunk = JSON.parse(frame.data);
    } catch (err) {
      return invalidRequest(
        `Responses stream chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isPlainObject(rawChunk)) {
      return invalidRequest("Responses stream chunk must be a JSON object");
    }
    const chunk = rawChunk as Record<string, unknown>;

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
      const events: IrStreamEvent[] = [];
      const startRes = this.tracker.start(events);
      if (!startRes.ok) return startRes;
      return ok(events);
    }

    if (eventName === "response.in_progress") {
      return ok([]);
    }

    if (eventName === "response.output_item.added") {
      const rawItem = chunk.item;
      if (!isPlainObject(rawItem)) {
        return invalidRequest("output_item.added requires item object");
      }
      const item = rawItem as Record<string, unknown>;
      // Provider-owned reasoning output items fail closed instead of vanishing.
      if (item.type === "reasoning") {
        return failure(responsesReasoningItemFailure(item));
      }
      if (item.type === "custom_tool_call" || item.type === "program" || item.type === "program_output") {
        return unsupportedCapability("custom-tool-streaming");
      }
      if (item.type === "namespace" || item.namespace !== undefined) {
        return unsupportedCapability("tool-namespaces");
      }
      if (item.caller !== undefined) {
        return unsupportedCapability("programmatic-tools");
      }
      if (item.type === "function_call") {
        if (typeof item.id !== "string" || item.id.trim() === "") {
          return invalidRequest("output_item.added function_call id must be a non-empty string");
        }
        if (typeof item.call_id !== "string" || item.call_id.trim() === "") {
          return invalidRequest("output_item.added function_call call_id must be a non-empty string");
        }
        if (typeof item.name !== "string" || item.name.trim() === "") {
          return invalidRequest("output_item.added function_call name must be a non-empty string");
        }
        const claimItemRes = this.tracker.claimIdentity(item.id);
        if (!claimItemRes.ok) return claimItemRes;
        const claimCallRes = this.tracker.claimIdentity(item.call_id);
        if (!claimCallRes.ok) return claimCallRes;

        const outputIndex =
          typeof chunk.output_index === "number" && Number.isSafeInteger(chunk.output_index) && chunk.output_index >= 0
            ? chunk.output_index
            : undefined;
        const events: IrStreamEvent[] = [];
        const openRes = this.tracker.openFunctionPart(events, item.id, item.call_id, item.name, { outputIndex });
        if (!openRes.ok) return openRes;
        return ok(events);
      }
      if (item.type !== "message") {
        return unsupportedCapability("unknown-content-item");
      }
      return ok([]);
    }

    if (eventName === "response.content_part.added") {
      const rawPart = chunk.part;
      if (!isPlainObject(rawPart)) {
        return invalidRequest("content_part.added requires part object");
      }
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "output_text" && part.type !== "refusal") {
        return unsupportedCapability("unknown-content-item");
      }
      const events: IrStreamEvent[] = [];
      if (part.type === "refusal") {
        this.tracker.openRefusalPart(events, "current", "force-new");
      } else {
        this.tracker.openTextPart(events, "current", "force-new");
      }
      return ok(events);
    }

    if (eventName === "response.output_text.delta") {
      const text = chunk.delta;
      // A present-but-malformed delta fabricates nothing: only a string
      // carries text, anything else fails closed.
      if (typeof text !== "string") {
        return invalidRequest("response.output_text.delta: delta must be a string");
      }
      const events: IrStreamEvent[] = [];
      const textRes = this.tracker.textDelta(events, "current", text, { lazy: true });
      if (!textRes.ok) return textRes;
      return ok(events);
    }

    if (eventName === "response.refusal.delta") {
      const text = chunk.delta;
      // A present-but-malformed refusal delta fabricates nothing: only a
      // string carries refusal text, anything else fails closed.
      if (typeof text !== "string") {
        return invalidRequest("response.refusal.delta: delta must be a string");
      }
      const events: IrStreamEvent[] = [];
      const refusalRes = this.tracker.refusalDelta(events, "current", text);
      if (!refusalRes.ok) return refusalRes;
      return ok(events);
    }

    if (eventName === "response.refusal.done") {
      // A refusal completion without an open refusal part is malformed
      // provider output; silently absorbing it would hide the violation.
      if (this.tracker.partTypeOf("current") !== "refusal") {
        return invalidRequest("response.refusal.done received without an open refusal part");
      }
      const events: IrStreamEvent[] = [];
      const closeRes = this.tracker.closePart(events, "current", "refusal");
      if (!closeRes.ok) return closeRes;
      return ok(events);
    }

    if (eventName === "response.output_text.annotation.added") {
      const annot = chunk.annotation as Record<string, unknown> | undefined;
      if (!annot || typeof annot !== "object") {
        return invalidRequest("response.output_text.annotation.added missing annotation object");
      }
      if (annot.type === "container_file_citation") {
        return unsupportedCapability("provider-container");
      }
      if (this.tracker.partIdOf("current") === undefined) {
        return invalidRequest("annotation.added received before open output_text part");
      }
      const parsed = parseResponsesAnnotation(annot);
      if (!parsed.ok) return parsed;
      const events: IrStreamEvent[] = [];
      const citationRes = this.tracker.citation(events, "current", parsed.value);
      if (!citationRes.ok) return citationRes;
      return ok(events);
    }

    if (eventName === "response.function_call_arguments.delta") {
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof chunk.call_id === "string" ? chunk.call_id : undefined);
      const match = this.tracker.findFunctionPart(key, outputIndex);
      if (match === undefined) {
        return invalidRequest("function_call_arguments.delta received for unknown item");
      }
      if (typeof chunk.delta !== "string") {
        return invalidRequest("function_call_arguments.delta requires string delta");
      }
      const events: IrStreamEvent[] = [];
      const deltaRes = this.tracker.toolArgumentsDelta(events, match.slot, chunk.delta);
      if (!deltaRes.ok) return deltaRes;
      return ok(events);
    }

    if (eventName === "response.function_call_arguments.done") {
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof chunk.call_id === "string" ? chunk.call_id : undefined);
      const match = this.tracker.findFunctionPart(key, outputIndex);
      if (match === undefined) {
        return invalidRequest("function_call_arguments.done received for unknown item");
      }
      if (chunk.arguments !== undefined && typeof chunk.arguments !== "string") {
        return invalidRequest("function_call_arguments.done arguments must be a string");
      }
      const events: IrStreamEvent[] = [];
      if (
        this.tracker.argumentDeltaCount(match.slot) === 0 &&
        typeof chunk.arguments === "string" &&
        chunk.arguments.length > 0
      ) {
        const deltaRes = this.tracker.toolArgumentsDelta(events, match.slot, chunk.arguments);
        if (!deltaRes.ok) return deltaRes;
      }
      return ok(events);
    }

    if (eventName === "response.custom_tool_call_input.delta" || eventName === "response.custom_tool_call_input.done") {
      return unsupportedCapability("custom-tool-streaming");
    }

    if (eventName === "response.output_text.done") {
      if (this.tracker.partTypeOf("current") !== "text") {
        return invalidRequest("response.output_text.done received without an open text part");
      }
      const events: IrStreamEvent[] = [];
      const closeRes = this.tracker.closePart(events, "current", "text");
      if (!closeRes.ok) return closeRes;
      return ok(events);
    }

    if (eventName === "response.content_part.done") {
      return ok([]);
    }

    if (eventName === "response.output_item.done") {
      const rawItem = chunk.item;
      if (rawItem !== undefined && !isPlainObject(rawItem)) {
        return invalidRequest("output_item.done item must be an object");
      }
      const item = rawItem as Record<string, unknown> | undefined;
      if (item !== undefined && item.type !== undefined && item.type !== "function_call") {
        if (item.type !== "message") {
          return unsupportedCapability("unknown-content-item");
        }
        return ok([]);
      }
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof item?.id === "string" ? item.id : undefined) ??
        (typeof item?.call_id === "string" ? item.call_id : undefined);
      const match = this.tracker.findFunctionPart(key, outputIndex);
      if (match !== undefined) {
        if (item !== undefined) {
          if (typeof item.call_id === "string" && item.call_id !== match.callId) {
            return invalidRequest("output_item.done call_id does not match opened function item");
          }
          if (typeof item.name === "string" && item.name !== match.name) {
            return invalidRequest("output_item.done name does not match opened function item");
          }
        }
        const events: IrStreamEvent[] = [];
        if (
          this.tracker.argumentDeltaCount(match.slot) === 0 &&
          typeof item?.arguments === "string" &&
          item.arguments.length > 0
        ) {
          const deltaRes = this.tracker.toolArgumentsDelta(events, match.slot, item.arguments);
          if (!deltaRes.ok) return deltaRes;
        }
        const closeRes = this.tracker.closePart(events, match.slot, "function_call");
        if (!closeRes.ok) return closeRes;
        return ok(events);
      }
      if (item?.type === "function_call") {
        return invalidRequest("output_item.done received for unknown or closed function item");
      }
      if (item?.type !== undefined && item.type !== "message") {
        return unsupportedCapability("unknown-content-item");
      }
      return ok([]);
    }

    if (eventName === "response.completed") {
      if (chunk.response !== undefined && !isPlainObject(chunk.response)) {
        return invalidRequest("Responses completion requires response object");
      }
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutput(resp, (identity) => this.tracker.hasIdentity(identity));
      if (!scanResult.ok) return scanResult;
      if (this.tracker.sawRefusal() && this.tracker.startedFunctionPartCount() > 0) {
        return invalidRequest("Responses stream encountered both refusal and tool_calls");
      }
      this.tracker.markTerminal();
      const factsResult = captureOutcomeWireFacts(resp, this.outcomeWireOptions, "Responses");
      if (!factsResult.ok) return factsResult;
      this.outcomeWireOptions = factsResult.value;
      const usageResult = parseResponsesUsage(resp.usage);
      if (!usageResult.ok) return usageResult;
      const events: IrStreamEvent[] = [];
      this.tracker.responseEnd(
        events,
        {
          reason: this.tracker.sawRefusal()
            ? "refusal"
            : this.tracker.startedFunctionPartCount() > 0
              ? "tool_calls"
              : "stop",
        },
        usageResult.value,
      );
      return ok(events);
    }

    if (eventName === "response.incomplete") {
      if (chunk.response !== undefined && !isPlainObject(chunk.response)) {
        return invalidRequest("Responses completion requires response object");
      }
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutput(resp, (identity) => this.tracker.hasIdentity(identity));
      if (!scanResult.ok) return scanResult;
      const details = (resp.incomplete_details ?? {}) as Record<string, unknown>;
      let finishReason: IrFinishReason;
      if (details.reason === "max_output_tokens") {
        finishReason = this.tracker.startedFunctionPartCount() > 0 ? "tool_calls" : "length";
      } else if (details.reason === "content_filter") {
        finishReason = "content_filter";
      } else {
        return unsupportedCapability("finish-other-unknown");
      }

      this.tracker.markTerminal();
      const factsResult = captureOutcomeWireFacts(resp, this.outcomeWireOptions, "Responses");
      if (!factsResult.ok) return factsResult;
      this.outcomeWireOptions = factsResult.value;
      const usageResult = parseResponsesUsage(resp.usage);
      if (!usageResult.ok) return usageResult;
      const events: IrStreamEvent[] = [];
      this.tracker.responseEnd(events, { reason: finishReason }, usageResult.value);
      return ok(events);
    }

    if (eventName === "response.failed" || eventName === "error") {
      const err = (chunk.error ?? (chunk.response as Record<string, unknown>)?.error ?? chunk) as Record<
        string,
        unknown
      >;
      this.tracker.markTerminal();
      // Upstream message/code strings are diagnostic-only and bounded; the
      // full bytes remain in Trace.
      const message = typeof err.message === "string" ? err.message : "Responses provider stream error";
      const code = typeof err.code === "string" ? err.code : undefined;
      const requestId =
        typeof err.request_id === "string"
          ? err.request_id
          : typeof (chunk.response as Record<string, unknown>)?.id === "string"
            ? ((chunk.response as Record<string, unknown>).id as string)
            : undefined;
      const events: IrStreamEvent[] = [];
      this.tracker.error(events, {
        category: "provider",
        message: truncateProviderErrorString(message),
        code: code !== undefined ? truncateProviderErrorString(code) : undefined,
        retryable: false,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return ok(events);
    }

    // Unmapped wire event fails closed as an unknown stream event
    return unsupportedCapability("unknown-stream-event");
  }

  /**
   * Validates that the stream terminated cleanly with a completion or failure event.
   *
   * @returns Empty array on clean finish, or `stream_interrupted` failure if closed prematurely.
   */
  finish(): Result<readonly IrStreamEvent[], NormalizedFailure> {
    if (!this.tracker.isTerminal()) {
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
 * Emits strictly increasing sequence numbers, lifecycle events, and reconstructed usage.
 */
export class ResponsesClientStreamEncoder implements ClientStreamEncoder {
  readonly protocol = "openai-responses" as const;
  /** Stream session providing response ID stamped into event identifiers. */
  private readonly session: StreamSession;
  /** Budget guarding re-serialized tool arguments emitted at function-part close. */
  private readonly budget: StreamToolArgumentsBudget;
  /** Next sequence number to stamp; requires strict monotonicity. */
  private sequenceNumber = 1;
  /** Whether lifecycle-opening frames have been emitted. */
  private emittedLifecycleOpening = false;
  /** Response-side sidecar facts injected before the terminal event. */
  private outcomeWireOptions: OutcomeWireOptions = {};
  /** Open function parts accumulated until close emits the full item. */
  private readonly openFunctionParts = new Map<
    string,
    { itemId: string; callId: string; name: string; arguments: string }
  >();

  /**
   * Creates an encoder bound to one stream session.
   *
   * @param session - Stream session providing response ID and model name.
   * @param maxArgumentBytes - Optional override for tool-call argument budget.
   */
  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.session = session;
    this.budget = new StreamToolArgumentsBudget(maxArgumentBytes);
  }

  /**
   * Stores response-side sidecar facts to emit with the terminal completion event.
   *
   * @param options - Captured facts from provider outcome wire options.
   */
  setOutcomeWireOptions(options: OutcomeWireOptions): void {
    this.outcomeWireOptions = options;
  }

  /**
   * Encodes an IR stream event into one or more Responses SSE frames.
   *
   * @param event - The IR stream event to encode.
   * @returns Array of encoded SSE frames, or a normalized failure.
   */
  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure> {
    const id = `resp_${this.session.responseId}`;
    const frames: SseFrame[] = [];

    if (event.type === "response_start") {
      this.lifecycleOpeningFrames(id, frames);
      return ok(frames);
    }

    if (event.type === "part_start") {
      if (event.part.type === "refusal") {
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
            part: { type: "refusal", refusal: "" },
            sequence_number: this.sequenceNumber++,
          }),
        });
        return ok(frames);
      }
      if (event.part.type === "function_call") {
        const itemId = `fc_${event.partId}`;
        this.openFunctionParts.set(event.partId, {
          itemId,
          callId: event.part.callId,
          name: event.part.name,
          arguments: "",
        });
        frames.push({
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: itemId,
              call_id: event.part.callId,
              name: event.part.name,
              arguments: "",
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
        return ok(frames);
      }

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

    if (event.type === "refusal_delta") {
      frames.push({
        event: "response.refusal.delta",
        data: JSON.stringify({
          type: "response.refusal.delta",
          delta: event.text,
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

    if (event.type === "tool_arguments_delta") {
      const entry = this.openFunctionParts.get(event.partId);
      if (entry === undefined) {
        return invalidRequest(`tool_arguments_delta received for unknown partId '${event.partId}'`);
      }
      const claimRes = this.budget.claim(event.text);
      if (!claimRes.ok) return claimRes;
      entry.arguments += event.text;
      frames.push({
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: entry.itemId,
          delta: event.text,
          sequence_number: this.sequenceNumber++,
        }),
      });
      return ok(frames);
    }

    if (event.type === "citation") {
      return unsupportedCapability("citation-output-span");
    }

    if (event.type === "part_end") {
      if (event.partType === "refusal") {
        frames.push({
          event: "response.refusal.done",
          data: JSON.stringify({
            type: "response.refusal.done",
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
      if (event.partType === "function_call") {
        const entry = this.openFunctionParts.get(event.partId);
        if (entry === undefined) {
          return invalidRequest(`part_end received for unknown function partId '${event.partId}'`);
        }
        const argsText = entry.arguments;
        frames.push({
          event: "response.function_call_arguments.done",
          data: JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: entry.itemId,
            arguments: argsText,
            sequence_number: this.sequenceNumber++,
          }),
        });
        frames.push({
          event: "response.output_item.done",
          data: JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: entry.itemId,
              call_id: entry.callId,
              name: entry.name,
              arguments: argsText,
            },
            sequence_number: this.sequenceNumber++,
          }),
        });
        this.openFunctionParts.delete(event.partId);
        return ok(frames);
      }

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
        const incompleteReason = event.finish.reason === "content_filter" ? "content_filter" : "max_output_tokens";
        frames.push({
          event: "response.incomplete",
          data: JSON.stringify({
            type: "response.incomplete",
            response: {
              id,
              status: "incomplete",
              incomplete_details: { reason: incompleteReason },
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
      // A provider that fails before opening the response lifecycle must
      // still yield a client stream that opens the lifecycle it then fails:
      // the R wire has no legal stream shape whose first frame is `error`.
      if (!this.emittedLifecycleOpening) {
        this.lifecycleOpeningFrames(id, frames);
      }
      frames.push({
        event: "error",
        data: JSON.stringify({
          type: "error",
          code: event.failure.code ?? "server_error",
          message: event.failure.message,
          param: null,
          sequence_number: this.sequenceNumber++,
        }),
      });
      return ok(frames);
    }

    return unsupportedCapability("unknown-stream-event");
  }

  /**
   * Concludes the client stream.
   *
   * @returns Empty array; stream termination is handled by `response_end`.
   */
  finish(): Result<readonly SseFrame[], NormalizedFailure> {
    return ok([]);
  }

  /**
   * Emits lifecycle-opening frames (`response.created`, `response.in_progress`).
   *
   * @param id - Prefixed response identifier.
   * @param frames - Target frame array to append lifecycle frames to.
   */
  private lifecycleOpeningFrames(id: string, frames: SseFrame[]): void {
    this.emittedLifecycleOpening = true;
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
  }
}
