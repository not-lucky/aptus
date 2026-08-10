import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "./failures.ts";
import type { IrStreamEvent } from "./ir.ts";
import { validateUsage } from "./validate.ts";

/**
 * Options for configuring an {@link IrStreamStateMachine}.
 */
export interface IrStreamStateMachineOptions {
  /** Expected coordinator-owned response ID. */
  readonly expectedResponseId?: string;
  /** Expected logical model ID. */
  readonly expectedModel?: string;
}

/**
 * Validates the normative stream lifecycle and invariants for Private IR stream events.
 *
 * Lifecycle:
 * `response_start -> (part_start -> text_delta* -> part_end)* -> response_end`
 *
 * Invariants:
 * - Exactly one `response_start` first.
 * - Every `part_start` uses the stream `responseId` and an unused `partId`.
 * - In the plain-text streaming profile, only `{ type: "text" }` parts and `text_delta`s are admitted.
 * - All open parts must be closed before `response_end`.
 * - Clean terminal is `response_end(stop|length)`.
 * - `error` is terminal and excludes `response_end`.
 * - No events permitted after terminal state.
 */
export class IrStreamStateMachine {
  private phase: "awaiting_start" | "streaming" | "terminal" = "awaiting_start";
  private responseId: string | undefined;
  private readonly expectedResponseId: string | undefined;
  private readonly expectedModel: string | undefined;

  private readonly seenPartIds = new Set<string>();
  private readonly openParts = new Map<string, string>(); // partId -> partType

  constructor(options?: IrStreamStateMachineOptions) {
    this.expectedResponseId = options?.expectedResponseId;
    this.expectedModel = options?.expectedModel;
  }

  isTerminal(): boolean {
    return this.phase === "terminal";
  }

  getOpenPartIds(): ReadonlySet<string> {
    return new Set(this.openParts.keys());
  }

  feed(event: IrStreamEvent): Result<void, NormalizedFailure> {
    if (this.phase === "terminal") {
      return {
        ok: false,
        error: invalidRequestFailure("IrStreamEvent received after terminal state"),
      };
    }

    if (event.type === "error") {
      if (this.responseId !== undefined && event.responseId !== this.responseId) {
        return {
          ok: false,
          error: invalidRequestFailure(
            `Error event responseId '${event.responseId}' does not match stream session '${this.responseId}'`,
          ),
        };
      }
      this.phase = "terminal";
      return { ok: true, value: undefined };
    }

    if (this.phase === "awaiting_start") {
      if (event.type !== "response_start") {
        return {
          ok: false,
          error: invalidRequestFailure(`Expected 'response_start' as first stream event, received '${event.type}'`),
        };
      }

      if (typeof event.responseId !== "string" || event.responseId.trim() === "") {
        return {
          ok: false,
          error: invalidRequestFailure("response_start must have a non-empty responseId"),
        };
      }

      if (this.expectedResponseId !== undefined && event.responseId !== this.expectedResponseId) {
        return {
          ok: false,
          error: invalidRequestFailure(
            `response_start responseId '${event.responseId}' does not match expected '${this.expectedResponseId}'`,
          ),
        };
      }

      if (typeof event.model !== "string" || event.model.trim() === "") {
        return {
          ok: false,
          error: invalidRequestFailure("response_start must have a non-empty model"),
        };
      }

      if (this.expectedModel !== undefined && event.model !== this.expectedModel) {
        return {
          ok: false,
          error: invalidRequestFailure(
            `response_start model '${event.model}' does not match expected '${this.expectedModel}'`,
          ),
        };
      }

      this.responseId = event.responseId;
      this.phase = "streaming";
      return { ok: true, value: undefined };
    }

    // Phase is "streaming"
    if (event.type === "response_start") {
      return {
        ok: false,
        error: invalidRequestFailure("Duplicate 'response_start' received during active stream"),
      };
    }

    if (event.responseId !== this.responseId) {
      return {
        ok: false,
        error: invalidRequestFailure(
          `Stream event responseId '${event.responseId}' does not match active stream '${this.responseId}'`,
        ),
      };
    }

    if (event.type === "part_start") {
      if (typeof event.partId !== "string" || event.partId.trim() === "") {
        return {
          ok: false,
          error: invalidRequestFailure("part_start must have a non-empty partId"),
        };
      }

      if (this.seenPartIds.has(event.partId)) {
        return {
          ok: false,
          error: invalidRequestFailure(`Duplicate partId '${event.partId}' in part_start`),
        };
      }

      // Plain-text streaming profile gating
      if (event.part.type === "refusal") {
        return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
      }
      if (event.part.type === "function_call") {
        return { ok: false, error: unsupportedCapabilityFailure("function-tool-definition") };
      }
      if (event.part.type === "custom_call") {
        return { ok: false, error: unsupportedCapabilityFailure("custom-tool-streaming") };
      }

      if (event.part.type !== "text") {
        return {
          ok: false,
          error: invalidRequestFailure(
            `Unsupported part descriptor type: '${String((event.part as { type?: unknown }).type)}'`,
          ),
        };
      }

      this.seenPartIds.add(event.partId);
      this.openParts.set(event.partId, event.part.type);
      return { ok: true, value: undefined };
    }

    if (event.type === "text_delta") {
      const partType = this.openParts.get(event.partId);
      if (partType === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure(`text_delta received for non-open or unknown partId '${event.partId}'`),
        };
      }

      if (partType !== "text") {
        return {
          ok: false,
          error: invalidRequestFailure(`text_delta received for partId '${event.partId}' of type '${partType}'`),
        };
      }

      if (typeof event.text !== "string") {
        return {
          ok: false,
          error: invalidRequestFailure("text_delta.text must be a string"),
        };
      }

      return { ok: true, value: undefined };
    }

    if (event.type === "refusal_delta") {
      return { ok: false, error: unsupportedCapabilityFailure("refusal-stream-delta") };
    }

    if (event.type === "tool_arguments_delta") {
      return { ok: false, error: unsupportedCapabilityFailure("tool-stream-delta") };
    }

    if (event.type === "citation") {
      return { ok: false, error: unsupportedCapabilityFailure("citation-stream-timing") };
    }

    if (event.type === "part_end") {
      const partType = this.openParts.get(event.partId);
      if (partType === undefined) {
        return {
          ok: false,
          error: invalidRequestFailure(`part_end received for non-open partId '${event.partId}'`),
        };
      }

      if (partType !== event.partType) {
        return {
          ok: false,
          error: invalidRequestFailure(
            `part_end partType '${event.partType}' does not match open part type '${partType}'`,
          ),
        };
      }

      this.openParts.delete(event.partId);
      return { ok: true, value: undefined };
    }

    if (event.type === "response_end") {
      if (this.openParts.size > 0) {
        const remaining = [...this.openParts.keys()].join(", ");
        return {
          ok: false,
          error: invalidRequestFailure(`response_end received while parts [${remaining}] remain open`),
        };
      }

      // Finish reason gating
      const reason = event.finish.reason;
      if (reason === "tool_calls") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-tool-calls") };
      }
      if (reason === "refusal") {
        return { ok: false, error: unsupportedCapabilityFailure("refusal-content") };
      }
      if (reason === "content_filter") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-content-filter") };
      }
      if (reason === "context_limit") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-context-limit") };
      }
      if (reason === "other") {
        return { ok: false, error: unsupportedCapabilityFailure("finish-other-unknown") };
      }
      if (reason !== "stop" && reason !== "length") {
        return {
          ok: false,
          error: invalidRequestFailure(`Unrecognized finish reason '${String(reason)}'`),
        };
      }

      if (event.usage !== undefined) {
        const usageValidation = validateUsage(event.usage);
        if (!usageValidation.ok) {
          return usageValidation;
        }
      }

      this.phase = "terminal";
      return { ok: true, value: undefined };
    }

    return {
      ok: false,
      error: invalidRequestFailure(`Unrecognized stream event type '${String((event as { type?: unknown }).type)}'`),
    };
  }
}

/**
 * Creates an {@link IrStreamStateMachine} instance.
 */
export function createIrStreamStateMachine(options?: IrStreamStateMachineOptions): IrStreamStateMachine {
  return new IrStreamStateMachine(options);
}
