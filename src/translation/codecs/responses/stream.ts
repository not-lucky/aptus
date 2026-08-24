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
import type { IrRequest, IrStreamEvent } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import type { SseFrame } from "../../sse.ts";
import { parseFunctionArgumentsOnce, responsesReasoningItemFailure } from "../shared/hosted-tools.ts";
import { responsesTextConfig } from "../shared/output-format.ts";
import { StreamToolArgumentsBudget } from "../shared/stream-limits.ts";
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
      ...responsesTextConfig(request.generation, request.output, requestWireOptions),
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
function scanTerminalOutput(
  resp: Record<string, unknown>,
  seenFunctionItemIds: ReadonlySet<string>,
  seenFunctionCallIds: ReadonlySet<string>,
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
      const recognized =
        (id !== undefined && seenFunctionItemIds.has(id)) || (callId !== undefined && seenFunctionCallIds.has(callId));
      if (!recognized) return invalidRequest("Unannounced function_call in terminal output");
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
  private readonly budget: StreamToolArgumentsBudget;
  private lastSequenceNumber = 0;
  private currentPartId: string | undefined;
  private partStarted = false;
  private completed = false;
  private readonly seenFunctionItemIds = new Set<string>();
  private readonly seenFunctionCallIds = new Set<string>();
  private readonly openFunctionItems = new Map<
    string,
    {
      partId: string;
      callId: string;
      name: string;
      outputIndex?: number;
      arguments: string;
      deltaCount: number;
    }
  >();
  private startedFunctionPartCount = 0;
  private outcomeWireOptions: OutcomeWireOptions = {};

  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.session = session;
    this.budget = new StreamToolArgumentsBudget(maxArgumentBytes);
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
        if (this.seenFunctionItemIds.has(item.id) || this.seenFunctionCallIds.has(item.call_id)) {
          return invalidRequest("output_item.added duplicate function_call id or call_id");
        }
        this.seenFunctionItemIds.add(item.id);
        this.seenFunctionCallIds.add(item.call_id);

        const partId = this.session.createPartId();
        const outputIndex =
          typeof chunk.output_index === "number" && Number.isSafeInteger(chunk.output_index) && chunk.output_index >= 0
            ? chunk.output_index
            : undefined;
        this.openFunctionItems.set(item.id, {
          partId,
          callId: item.call_id,
          name: item.name,
          outputIndex,
          arguments: "",
          deltaCount: 0,
        });
        this.startedFunctionPartCount++;
        return ok([
          {
            type: "part_start",
            responseId: this.session.responseId,
            partId,
            part: { type: "function_call", callId: item.call_id, name: item.name },
          },
        ]);
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
      if (part.type !== "output_text") {
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

    if (eventName === "response.function_call_arguments.delta") {
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof chunk.call_id === "string" ? chunk.call_id : undefined);
      const match = this.findFunctionItem(key, outputIndex);
      if (match === undefined) {
        return invalidRequest("function_call_arguments.delta received for unknown item");
      }
      if (typeof chunk.delta !== "string") {
        return invalidRequest("function_call_arguments.delta requires string delta");
      }
      const text = chunk.delta;
      const claimRes = this.budget.claim(text);
      if (!claimRes.ok) return claimRes;
      match.entry.arguments += text;
      match.entry.deltaCount++;
      return ok([
        {
          type: "tool_arguments_delta",
          responseId: this.session.responseId,
          partId: match.entry.partId,
          callId: match.entry.callId,
          text,
        },
      ]);
    }

    if (eventName === "response.function_call_arguments.done") {
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof chunk.call_id === "string" ? chunk.call_id : undefined);
      const match = this.findFunctionItem(key, outputIndex);
      if (match === undefined) {
        return invalidRequest("function_call_arguments.done received for unknown item");
      }
      if (chunk.arguments !== undefined && typeof chunk.arguments !== "string") {
        return invalidRequest("function_call_arguments.done arguments must be a string");
      }
      if (match.entry.deltaCount === 0 && typeof chunk.arguments === "string" && chunk.arguments.length > 0) {
        const claimRes = this.budget.claim(chunk.arguments);
        if (!claimRes.ok) return claimRes;
        match.entry.arguments += chunk.arguments;
        match.entry.deltaCount++;
        return ok([
          {
            type: "tool_arguments_delta",
            responseId: this.session.responseId,
            partId: match.entry.partId,
            callId: match.entry.callId,
            text: chunk.arguments,
          },
        ]);
      }
      return ok([]);
    }

    if (eventName === "response.custom_tool_call_input.delta" || eventName === "response.custom_tool_call_input.done") {
      return unsupportedCapability("custom-tool-streaming");
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
        return ok([]);
      }
      const outputIndex = typeof chunk.output_index === "number" ? chunk.output_index : undefined;
      const key =
        (typeof chunk.item_id === "string" ? chunk.item_id : undefined) ??
        (typeof item?.id === "string" ? item.id : undefined) ??
        (typeof item?.call_id === "string" ? item.call_id : undefined);
      const match = this.findFunctionItem(key, outputIndex);
      if (match !== undefined) {
        if (item !== undefined) {
          if (typeof item.call_id === "string" && item.call_id !== match.entry.callId) {
            return invalidRequest("output_item.done call_id does not match opened function item");
          }
          if (typeof item.name === "string" && item.name !== match.entry.name) {
            return invalidRequest("output_item.done name does not match opened function item");
          }
        }
        const events: IrStreamEvent[] = [];
        if (
          match.entry.deltaCount === 0 &&
          typeof item?.arguments === "string" &&
          item.arguments.length > 0 &&
          match.entry.arguments.length === 0
        ) {
          const claimRes = this.budget.claim(item.arguments);
          if (!claimRes.ok) return claimRes;
          match.entry.arguments += item.arguments;
          match.entry.deltaCount++;
          events.push({
            type: "tool_arguments_delta",
            responseId: this.session.responseId,
            partId: match.entry.partId,
            callId: match.entry.callId,
            text: item.arguments,
          });
        }
        const parsed = parseFunctionArgumentsOnce(match.entry.arguments);
        this.openFunctionItems.delete(match.key);
        events.push({
          type: "part_end",
          responseId: this.session.responseId,
          partId: match.entry.partId,
          partType: "function_call",
          ...(parsed !== undefined ? { arguments: parsed } : {}),
        });
        return ok(events);
      }
      if (item?.type === "function_call") {
        return invalidRequest("output_item.done received for unknown or closed function item");
      }
      return ok([]);
    }

    if (eventName === "response.completed") {
      if (chunk.response !== undefined && !isPlainObject(chunk.response)) {
        return invalidRequest("Responses completion requires response object");
      }
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutput(resp, this.seenFunctionItemIds, this.seenFunctionCallIds);
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
          finish: { reason: this.startedFunctionPartCount > 0 ? "tool_calls" : "stop" },
          ...(usageResult.value !== undefined ? { usage: usageResult.value } : {}),
        },
      ]);
    }

    if (eventName === "response.incomplete") {
      if (chunk.response !== undefined && !isPlainObject(chunk.response)) {
        return invalidRequest("Responses completion requires response object");
      }
      const resp = (chunk.response ?? {}) as Record<string, unknown>;
      // Defense-in-depth for items announced only in the terminal payload.
      const scanResult = scanTerminalOutput(resp, this.seenFunctionItemIds, this.seenFunctionCallIds);
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
          finish: { reason: this.startedFunctionPartCount > 0 ? "tool_calls" : "length" },
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

  private findFunctionItem(
    key: string | undefined,
    outputIndex?: number,
  ):
    | {
        entry: {
          partId: string;
          callId: string;
          name: string;
          outputIndex?: number;
          arguments: string;
          deltaCount: number;
        };
        key: string;
      }
    | undefined {
    if (key !== undefined) {
      let match:
        | {
            entry: {
              partId: string;
              callId: string;
              name: string;
              outputIndex?: number;
              arguments: string;
              deltaCount: number;
            };
            key: string;
          }
        | undefined;
      const direct = this.openFunctionItems.get(key);
      if (direct !== undefined) {
        match = { entry: direct, key };
      } else {
        for (const [k, v] of this.openFunctionItems) {
          if (v.callId === key || v.partId === key) {
            match = { entry: v, key: k };
            break;
          }
        }
      }
      if (match === undefined) return undefined;
      if (
        outputIndex !== undefined &&
        match.entry.outputIndex !== undefined &&
        match.entry.outputIndex !== outputIndex
      ) {
        return undefined;
      }
      return match;
    }
    if (outputIndex !== undefined) {
      for (const [k, v] of this.openFunctionItems) {
        if (v.outputIndex === outputIndex) {
          return { entry: v, key: k };
        }
      }
    }
    return undefined;
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
  private readonly budget: StreamToolArgumentsBudget;
  private sequenceNumber = 1;
  private outcomeWireOptions: OutcomeWireOptions = {};
  private readonly openFunctionParts = new Map<
    string,
    { itemId: string; callId: string; name: string; arguments: string }
  >();

  constructor(session: StreamSession, maxArgumentBytes?: number) {
    this.session = session;
    this.budget = new StreamToolArgumentsBudget(maxArgumentBytes);
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

    if (event.type === "part_end") {
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
