import type { Result } from "../domain/contracts.ts";
import { isPlainObject } from "../domain/json.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction } from "./contracts.ts";
import type { IrStreamEvent } from "./ir.ts";
import { directionFacts, refusalFinishCapability } from "./preflight.ts";
import { invalidRequest, ok, unsupportedCapability } from "./result.ts";
import { validateUsage } from "./validate.ts";
/**
 * Options for configuring an {@link IrStreamStateMachine}.
 */
export interface IrStreamStateMachineOptions {
  /** Expected coordinator-owned response ID. */
  readonly expectedResponseId?: string;
  /** Expected logical model ID. */
  readonly expectedModel?: string;
  /** Translation direction if active cross-protocol attempt. */
  readonly direction?: Direction;
  /** Whether the direction stays between OpenAI Chat and Responses. */
  readonly isChatResponses?: boolean;
}

/**
 * Validates the normative stream lifecycle and invariants for Private IR stream events.
 *
 * Lifecycle:
 * `response_start -> (part_start -> (text_delta | tool_arguments_delta)* -> part_end)* -> response_end`
 *
 * Invariants:
 * - Exactly one `response_start` first.
 * - Every `part_start` uses the stream `responseId` and an unused `partId`.
 * - Admitted parts include text (`{ type: "text" }`) and function tools (`{ type: "function_call", callId, name }`).
 * - All open parts must be closed before `response_end`.
 * - Clean terminal is `response_end(stop|length|tool_calls)` on directions that
 *   admit the finish reason; refusal and content-filter terminals are gated by
 *   the shared refusal/content-filter capability (C/R directions admit them,
 *   Messages-involving directions reject fail-closed).
 * - `error` is terminal and excludes `response_end`.
 * - No events permitted after terminal state.
 */
export class IrStreamStateMachine {
  private phase: "awaiting_start" | "streaming" | "terminal" = "awaiting_start";
  private responseId: string | undefined;
  private readonly expectedResponseId: string | undefined;
  private readonly expectedModel: string | undefined;
  private readonly direction: Direction | undefined;
  private readonly isChatResponses: boolean;

  private readonly seenPartIds = new Set<string>();
  private readonly seenCallIds = new Set<string>();
  private readonly openParts = new Map<string, { partType: string; callId?: string }>();
  private closedFunctionPartCount = 0;
  private sawRefusalPart = false;

  constructor(options?: IrStreamStateMachineOptions) {
    this.expectedResponseId = options?.expectedResponseId;
    this.expectedModel = options?.expectedModel;
    this.direction = options?.direction;
    this.isChatResponses =
      options?.isChatResponses ??
      (options?.direction !== undefined ? directionFacts(options.direction).isChatResponses : false);
  }

  isTerminal(): boolean {
    return this.phase === "terminal";
  }

  getOpenPartIds(): ReadonlySet<string> {
    return new Set(this.openParts.keys());
  }

  feed(event: IrStreamEvent): Result<void, NormalizedFailure> {
    if (this.phase === "terminal") {
      return invalidRequest("IrStreamEvent received after terminal state");
    }

    if (event.type === "error") {
      if (this.responseId !== undefined && event.responseId !== this.responseId) {
        return invalidRequest(
          `Error event responseId '${event.responseId}' does not match stream session '${this.responseId}'`,
        );
      }
      this.phase = "terminal";
      return ok(undefined);
    }

    if (this.phase === "awaiting_start") {
      if (event.type !== "response_start") {
        return invalidRequest(`Expected 'response_start' as first stream event, received '${event.type}'`);
      }

      if (typeof event.responseId !== "string" || event.responseId.trim() === "") {
        return invalidRequest("response_start must have a non-empty responseId");
      }

      if (this.expectedResponseId !== undefined && event.responseId !== this.expectedResponseId) {
        return invalidRequest(
          `response_start responseId '${event.responseId}' does not match expected '${this.expectedResponseId}'`,
        );
      }

      if (typeof event.model !== "string" || event.model.trim() === "") {
        return invalidRequest("response_start must have a non-empty model");
      }

      if (this.expectedModel !== undefined && event.model !== this.expectedModel) {
        return invalidRequest(`response_start model '${event.model}' does not match expected '${this.expectedModel}'`);
      }

      this.responseId = event.responseId;
      this.phase = "streaming";
      return ok(undefined);
    }

    // Phase is "streaming"
    if (event.type === "response_start") {
      return invalidRequest("Duplicate 'response_start' received during active stream");
    }

    if (event.responseId !== this.responseId) {
      return invalidRequest(
        `Stream event responseId '${event.responseId}' does not match active stream '${this.responseId}'`,
      );
    }

    if (event.type === "part_start") {
      if (typeof event.partId !== "string" || event.partId.trim() === "") {
        return invalidRequest("part_start must have a non-empty partId");
      }

      if (this.seenPartIds.has(event.partId)) {
        return invalidRequest(`Duplicate partId '${event.partId}' in part_start`);
      }

      // Plain-text streaming profile gating
      if (event.part.type === "refusal") {
        if (!this.isChatResponses) {
          return unsupportedCapability("refusal-content");
        }
        this.sawRefusalPart = true;
        this.seenPartIds.add(event.partId);
        this.openParts.set(event.partId, { partType: "refusal" });
        return ok(undefined);
      }
      if (event.part.type === "function_call") {
        if (typeof event.part.callId !== "string" || event.part.callId.trim() === "") {
          return invalidRequest("part_start function_call must have a non-empty callId");
        }
        if (typeof event.part.name !== "string" || event.part.name.trim() === "") {
          return invalidRequest("part_start function_call must have a non-empty name");
        }
        if (this.seenCallIds.has(event.part.callId)) {
          return invalidRequest(`Duplicate callId '${event.part.callId}' across stream`);
        }
        this.seenPartIds.add(event.partId);
        this.seenCallIds.add(event.part.callId);
        this.openParts.set(event.partId, { partType: "function_call", callId: event.part.callId });
        return ok(undefined);
      }
      if (event.part.type === "custom_call") {
        return unsupportedCapability("custom-tool-streaming");
      }

      if (event.part.type !== "text") {
        return invalidRequest(`Unsupported part descriptor type: '${String((event.part as { type?: unknown }).type)}'`);
      }

      this.seenPartIds.add(event.partId);
      this.openParts.set(event.partId, { partType: "text" });
      return ok(undefined);
    }

    if (event.type === "text_delta") {
      const open = this.openParts.get(event.partId);
      if (open === undefined) {
        return invalidRequest(`text_delta received for non-open or unknown partId '${event.partId}'`);
      }

      if (open.partType !== "text") {
        return invalidRequest(`text_delta received for partId '${event.partId}' of type '${open.partType}'`);
      }

      if (typeof event.text !== "string") {
        return invalidRequest("text_delta.text must be a string");
      }

      return ok(undefined);
    }

    if (event.type === "refusal_delta") {
      if (!this.isChatResponses) {
        return unsupportedCapability("refusal-stream-delta");
      }
      const open = this.openParts.get(event.partId);
      if (open === undefined) {
        return invalidRequest(`refusal_delta received for non-open or unknown partId '${event.partId}'`);
      }
      if (open.partType !== "refusal") {
        return invalidRequest(`refusal_delta received for non-refusal partId '${event.partId}'`);
      }
      if (typeof event.text !== "string") {
        return invalidRequest("refusal_delta text must be a string");
      }
      return ok(undefined);
    }

    if (event.type === "tool_arguments_delta") {
      const open = this.openParts.get(event.partId);
      if (open === undefined) {
        return invalidRequest(`tool_arguments_delta received for non-open or unknown partId '${event.partId}'`);
      }

      if (open.partType !== "function_call") {
        return invalidRequest(`tool_arguments_delta received for non-function partId '${event.partId}'`);
      }

      if (event.callId !== open.callId) {
        return invalidRequest(
          `tool_arguments_delta callId '${event.callId}' does not match open part callId '${open.callId}'`,
        );
      }

      if (typeof event.text !== "string") {
        return invalidRequest("tool_arguments_delta text must be a string");
      }

      return ok(undefined);
    }

    if (event.type === "citation") {
      if (event.responseId !== this.responseId) {
        return invalidRequest(
          `citation responseId '${event.responseId}' does not match stream responseId '${this.responseId}'`,
        );
      }
      const open = this.openParts.get(event.partId);
      if (open === undefined) {
        return invalidRequest(`citation received for non-open or unknown partId '${event.partId}'`);
      }
      if (open.partType !== "text") {
        return invalidRequest(`citation received for partId '${event.partId}' of type '${open.partType}'`);
      }
      if (!event.citation || typeof event.citation !== "object") {
        return invalidRequest("citation event must contain a citation object");
      }
      return ok(undefined);
    }

    if (event.type === "part_end") {
      const open = this.openParts.get(event.partId);
      if (open === undefined) {
        return invalidRequest(`part_end received for non-open partId '${event.partId}'`);
      }

      if (open.partType !== event.partType) {
        return invalidRequest(`part_end partType '${event.partType}' does not match open part type '${open.partType}'`);
      }

      if (event.partType === "function_call") {
        if (event.arguments !== undefined && !isPlainObject(event.arguments)) {
          return invalidRequest("part_end function_call arguments must be a JSON object when present");
        }
        this.closedFunctionPartCount++;
      }

      this.openParts.delete(event.partId);
      return ok(undefined);
    }

    if (event.type === "response_end") {
      if (this.openParts.size > 0) {
        const remaining = [...this.openParts.keys()].join(", ");
        return invalidRequest(`response_end received while parts [${remaining}] remain open`);
      }

      // Finish reason gating
      const reason = event.finish.reason;
      if (this.sawRefusalPart && reason !== "refusal") {
        return invalidRequest("response_end saw a refusal part but finish reason is not refusal");
      }
      if (reason === "tool_calls") {
        if (this.closedFunctionPartCount === 0) {
          return invalidRequest(
            "response_end with tool_calls finish reason requires at least one completed function call part",
          );
        }
      } else if (reason === "refusal") {
        if (this.direction !== undefined) {
          const refusalCapability = refusalFinishCapability(this.direction, this.sawRefusalPart);
          if (refusalCapability !== undefined) {
            return unsupportedCapability(refusalCapability);
          }
        } else if (!this.sawRefusalPart) {
          return unsupportedCapability("refusal-terminal-reason");
        } else if (!this.isChatResponses) {
          return unsupportedCapability("refusal-content");
        }
      } else if (reason === "content_filter") {
        if (!this.isChatResponses) {
          return unsupportedCapability("finish-content-filter");
        }
      } else if (reason === "context_limit") {
        return unsupportedCapability("finish-context-limit");
      }
      if (
        reason !== "stop" &&
        reason !== "length" &&
        reason !== "tool_calls" &&
        reason !== "refusal" &&
        reason !== "content_filter"
      ) {
        // Unreachable through the closed IrFinishReason union today, but an
        // unknown finish reason must fail closed as an unknown finish, never
        // as a generic invalid request.
        return unsupportedCapability("finish-other-unknown");
      }

      if (event.usage !== undefined) {
        const usageValidation = validateUsage(event.usage);
        if (!usageValidation.ok) {
          return usageValidation;
        }
      }

      this.phase = "terminal";
      return ok(undefined);
    }

    return invalidRequest(`Unrecognized stream event type '${String((event as { type?: unknown }).type)}'`);
  }
}

/**
 * Creates an {@link IrStreamStateMachine} instance.
 */
export function createIrStreamStateMachine(options?: IrStreamStateMachineOptions): IrStreamStateMachine {
  return new IrStreamStateMachine(options);
}
