/**
 * @fileoverview Lifecycle validator for private intermediate representation stream events.
 *
 * Enforces normative event ordering for streaming translations: exactly one opening
 * `response_start`, zero or more fully closed parts (`part_start` / `part_end`), and
 * exactly one terminal event (`response_end` or `error`). Rejects out-of-order,
 * duplicate, or capability-incompatible stream events fail-closed.
 */

import type { Result } from "../domain/contracts.ts";
import { isPlainObject } from "../domain/json.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction } from "./contracts.ts";
import type { IrStreamEvent } from "./ir.ts";
import { directionFacts, refusalFinishCapability } from "./preflight.ts";
import { invalidRequest, ok, unsupportedCapability } from "./result.ts";
import { validateUsage } from "./validate.ts";

/**
 * Configuration options for the stream lifecycle validator.
 */
export interface IrStreamStateMachineOptions {
  /** Expected coordinator-assigned response identifier. */
  readonly expectedResponseId?: string;

  /** Expected logical model name. */
  readonly expectedModel?: string;

  /** Directed translation path for capability-gated checks. */
  readonly direction?: Direction;

  /** Whether translation stays within OpenAI Chat <-> Responses profile. */
  readonly isChatResponses?: boolean;
}

/**
 * Stateful validator tracking stream lifecycle boundaries, active parts, and terminal invariants.
 */
export class IrStreamStateMachine {
  /** Current lifecycle phase of the active stream. */
  private phase: "awaiting_start" | "streaming" | "terminal" = "awaiting_start";

  /** Bound response identifier from the opening event. */
  private responseId: string | undefined;

  /** Expected response identifier configured at construction. */
  private readonly expectedResponseId: string | undefined;

  /** Expected model name configured at construction. */
  private readonly expectedModel: string | undefined;

  /** Directed translation path for terminal capability gating. */
  private readonly direction: Direction | undefined;

  /** Flag indicating OpenAI-only stream capability profile. */
  private readonly isChatResponses: boolean;

  /** Set of all part IDs opened during the stream to detect duplicates. */
  private readonly seenPartIds = new Set<string>();

  /** Set of all function call IDs opened during the stream to ensure uniqueness. */
  private readonly seenCallIds = new Set<string>();

  /** Map of currently active unclosed parts tracking type and call binding. */
  private readonly openParts = new Map<string, { partType: string; callId?: string }>();

  /** Count of successfully closed function call parts for tool finish validation. */
  private closedFunctionPartCount = 0;

  /** Tracks whether a refusal part was opened during the stream. */
  private sawRefusalPart = false;

  /**
   * Initializes a new stream lifecycle state machine.
   *
   * @param options - Optional stream expectations and translation direction.
   */
  constructor(options?: IrStreamStateMachineOptions) {
    this.expectedResponseId = options?.expectedResponseId;
    this.expectedModel = options?.expectedModel;
    this.direction = options?.direction;
    this.isChatResponses =
      options?.isChatResponses ??
      (options?.direction !== undefined ? directionFacts(options.direction).isChatResponses : false);
  }

  /**
   * Checks whether the machine has reached a terminal outcome state.
   *
   * @returns True if stream reached terminal completion or error.
   */
  isTerminal(): boolean {
    return this.phase === "terminal";
  }

  /**
   * Returns a snapshot of identifiers for all currently active unclosed parts.
   *
   * @returns Readonly set of active part identifiers.
   */
  getOpenPartIds(): ReadonlySet<string> {
    return new Set(this.openParts.keys());
  }

  /**
   * Validates an incoming stream event against lifecycle ordering and invariant rules.
   *
   * @param event - Semantic IR stream event to validate.
   * @returns Ok if event transition is valid; otherwise normalized failure.
   */
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
 * Creates an initialized {@link IrStreamStateMachine} for validating an IR event stream.
 *
 * @param options - Optional stream expectations and translation direction.
 * @returns Initialized stream state machine.
 */
export function createIrStreamStateMachine(options?: IrStreamStateMachineOptions): IrStreamStateMachine {
  return new IrStreamStateMachine(options);
}
