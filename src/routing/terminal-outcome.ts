/**
 * @fileoverview
 * Terminal outcome vocabulary shared by every request-ending path in the gateway.
 *
 * A request can end in many places: a relay finalizing a delivered response, the stream
 * engine classifying an abort or interrupted EOF, the gateway reporting a terminal failure
 * or internal fault, the HTTP controller settling a deadline or disconnect, admission
 * rejecting before dispatch, and the dry-run path. Each of those paths used to hand-build
 * the same ten-field {@link TerminalFact} while re-deriving the same status and outcome
 * category invariants, and the mapping drifted between sites (for example admission wrote
 * `canonicalPublicName: "unknown"` where relays wrote the resolved name).
 *
 * This module is the single vocabulary beneath those callers: every ending path supplies a
 * tiny {@link TerminalOutcome} spec plus the request-scoped {@link TerminalFactContext}, and
 * {@link buildTerminalFact} derives the full fact — `status`, `outcomeCategory`, the trace
 * {@link TraceTerminal}, and the shared identity/bookkeeping fields — in one place. The
 * {@link TerminalCoordinator} keeps its exactly-once finalization role; callers that have
 * the client-end duration in hand use {@link finalizeTerminal}, while callers that must
 * defer finalization until after bytes reach Express build the duration-free fact eagerly
 * and spread `durationMs` later, exactly as they did with hand-built facts.
 *
 * The mapping invariants centralized here are the ones the architecture review names:
 * `cancelled` → 499, `failed` with a timeout category → 504, `failed` with an interrupted
 * stream → 502, `fault` → 500, `dry_run` → 200, and `complete` carries whatever status the
 * caller actually delivered. A `failed` outcome derives its status from the failure
 * category through {@link statusFromCategory} unless the caller supplies an explicit status
 * (the native complete relay relays an upstream error body verbatim, so it must report the
 * upstream status it actually delivered).
 */

import type { JsonObject, Protocol, TerminalCoordinator, TerminalFact } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { statusFromCategory } from "./failures.ts";

/**
 * Request-scoped identity and bookkeeping fields merged into every terminal fact.
 *
 * This interface carries the fields every {@link TerminalFact} shares regardless of how the
 * request ended: the attempt and stream labels, the client protocol used to derive failure
 * statuses, and the optional resolved identities that callers know at terminal time. Values
 * are copied into the produced fact only when defined, so telemetry never carries stray
 * `undefined` fields. Every request-ending path has these facts at hand — relays and the
 * stream engine from their relay context, the gateway from the admitted request, and the
 * HTTP layer from the coordinator — so building a context is always cheap and local.
 */
export interface TerminalFactContext {
  /** The total number of provider attempts executed for the request. */
  readonly attempts: number;

  /** Whether streaming mode was admitted for the request. */
  readonly stream: boolean;

  /**
   * The client ingress protocol owning the downstream response.
   *
   * `failed` outcomes without an explicit status derive their HTTP status from the failure
   * category through this protocol, which is how the Anthropic messages protocol receives
   * 529 for `unavailable` while the OpenAI protocols receive 503.
   */
  readonly clientProtocol: Protocol;

  /** The target candidate provider protocol, or `"unknown"` when none was selected. */
  readonly targetProtocol?: Protocol | "unknown";

  /** The selected candidate provider name, or `"unknown"` when none was selected. */
  readonly provider?: string;

  /** The canonical public model or route name, or `"unknown"` when resolution failed. */
  readonly canonicalPublicName?: string;

  /** When `false`, finalization still records counters and timing but skips the completion log. */
  readonly emitCompleted?: boolean;
}

/**
 * A tiny terminal outcome spec that a request-ending path hands to the vocabulary.
 *
 * This union is the whole vocabulary of how a request can end, mirroring the trace terminal
 * taxonomy in {@link TraceTerminal} plus the internal-fault marker: a successful delivery
 * (`complete`, with optional usage and cost), an expected domain failure (`failed`, whose
 * category derives the status unless overridden), a cancellation (`cancelled`, by client or
 * shutdown), an unexpected internal fault (`fault`), or a dry-run inspection (`dry_run`).
 * Callers never assemble {@link TerminalFact} fields themselves; they name one of these
 * variants and let {@link buildTerminalFact} derive everything else.
 */
export type TerminalOutcome =
  | {
      /** Successful request completion with the delivered status and optional usage/cost. */
      readonly kind: "complete";
      /** The final HTTP status actually delivered to the client. */
      readonly status: number;
      /** The redacted raw token usage record to attach to the fact and trace terminal. */
      readonly usage?: JsonObject;
      /** The exact decimal United States dollar cost estimate to attach to the fact and trace terminal. */
      readonly estimatedCostUsd?: string;
    }
  | {
      /** Request terminated with an expected normalized domain failure. */
      readonly kind: "failed";
      /** The classified failure; its category derives the fact status when no override is given. */
      readonly failure: NormalizedFailure;
      /**
       * Optional explicit status used when the caller relays an upstream response verbatim
       * (the native complete relay) or when admission pins a fixed status for a failure kind
       * that is a 4xx by construction.
       */
      readonly status?: number;
    }
  | {
      /** Request cancelled by client disconnect or graceful server shutdown. */
      readonly kind: "cancelled";
      /** Who cancelled the request: the client or the server shutdown drain. */
      readonly by: "client" | "shutdown";
    }
  | {
      /** Unexpected internal fault, mapped to a 500 incomplete terminal. */
      readonly kind: "fault";
    }
  | {
      /** Dry-run inspection completed without any upstream dispatch. */
      readonly kind: "dry_run";
    };

/**
 * Derives the duration-free terminal fact for an outcome spec and request context.
 *
 * This is the single place where the terminal vocabulary lives: the `outcomeCategory`, the
 * fact `status`, and the trace {@link TraceTerminal} are all derived from the spec variant,
 * and the shared {@link TerminalFactContext} fields are merged in. `complete` outcomes carry
 * optional usage and cost into both the fact and the trace terminal; `failed` outcomes
 * derive their status from the failure category through {@link statusFromCategory} unless
 * the spec pins an explicit status; `cancelled`, `fault`, and `dry_run` map to their fixed
 * status/category invariants (499, 500, and 200 respectively).
 *
 * The returned fact deliberately omits `durationMs`: relay paths finalize only after the
 * client write completes, so callers capture the derived fact eagerly and spread the actual
 * delivery duration at finalize time. Callers that already know the duration should prefer
 * {@link finalizeTerminal}.
 *
 * @param context - Request-scoped identity, attempt, stream, and protocol fields.
 * @param outcome - The tiny outcome spec describing how the request ended.
 * @returns The full terminal fact except for `durationMs`, ready for finalization.
 */
export function buildTerminalFact(
  context: TerminalFactContext,
  outcome: TerminalOutcome,
): Omit<TerminalFact, "durationMs"> {
  const common = {
    attempts: context.attempts,
    stream: context.stream,
    ...(context.targetProtocol !== undefined ? { targetProtocol: context.targetProtocol } : {}),
    ...(context.provider !== undefined ? { provider: context.provider } : {}),
    ...(context.canonicalPublicName !== undefined ? { canonicalPublicName: context.canonicalPublicName } : {}),
    ...(context.emitCompleted !== undefined ? { emitCompleted: context.emitCompleted } : {}),
  };

  switch (outcome.kind) {
    case "complete": {
      const usageFields = {
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.estimatedCostUsd !== undefined ? { estimatedCostUsd: outcome.estimatedCostUsd } : {}),
      };
      return {
        terminal: { kind: "complete", status: outcome.status, ...usageFields },
        outcomeCategory: "complete",
        status: outcome.status,
        ...usageFields,
        ...common,
      };
    }
    case "failed": {
      const status = outcome.status ?? statusFromCategory(outcome.failure.category, context.clientProtocol);
      return {
        terminal: { kind: "failed", failure: outcome.failure },
        outcomeCategory: "failed",
        status,
        ...common,
      };
    }
    case "cancelled":
      return {
        terminal: { kind: "cancelled", by: outcome.by },
        outcomeCategory: "cancelled",
        status: 499,
        ...common,
      };
    case "fault":
      return {
        terminal: { kind: "incomplete", reason: "internal_fault" },
        outcomeCategory: "failed",
        status: 500,
        ...common,
      };
    case "dry_run":
      return {
        terminal: { kind: "dry_run" },
        outcomeCategory: "complete",
        status: 200,
        ...common,
      };
  }
}

/**
 * Builds the terminal fact for an outcome spec and finalizes it through the coordinator.
 *
 * Convenience over {@link buildTerminalFact} for paths that already know the client-end
 * duration (admission, the gateway's cancellation handler, and the HTTP controller): it
 * derives the full fact including `durationMs` and hands it to the coordinator's exactly-once
 * {@link TerminalCoordinator.finalize}. Deferred paths (relay `onDelivered` closures) keep
 * using {@link buildTerminalFact} directly and spread `durationMs` at delivery time.
 *
 * @param coordinator - The request-scoped exactly-once terminal coordinator.
 * @param context - Request-scoped identity, attempt, stream, and protocol fields.
 * @param outcome - The tiny outcome spec describing how the request ended.
 * @param durationMs - The monotonic request duration from admission to delivery.
 * @returns Whether this call won terminal ownership, as reported by the coordinator.
 */
export async function finalizeTerminal(
  coordinator: TerminalCoordinator,
  context: TerminalFactContext,
  outcome: TerminalOutcome,
  durationMs: number,
): Promise<{ readonly won: boolean }> {
  return coordinator.finalize({ ...buildTerminalFact(context, outcome), durationMs });
}
