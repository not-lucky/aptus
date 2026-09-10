/**
 * @fileoverview
 * Exactly-once terminal lifecycle coordination for admitted requests.
 *
 * Multiple code paths race to conclude a request (provider response delivery, client disconnect,
 * gateway failure, dry run, or internal error). This module provides a request-scoped coordinator
 * that guarantees the first path to finalize wins ownership, recording the terminal trace and
 * emitting lifecycle telemetry exactly once while remaining resilient to observer faults.
 */

import type { AptusRequestId, Protocol, TerminalCoordinator, TerminalFact, TraceSession } from "../domain/contracts.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import type { Redactor } from "../observability/trace/redaction.ts";
import { type Clock, systemClock } from "../routing/timing.ts";

/** Options for constructing a request-scoped terminal coordinator. */
export interface TerminalCoordinatorOptions {
  /** Unique request identifier assigned during admission. */
  readonly aptusRequestId: AptusRequestId;
  /** Ingress protocol spoken by the client endpoint. */
  readonly endpointProtocol: Protocol;
  /** Monotonic millisecond timestamp recorded when admission began. */
  readonly startedMs: number;
  /** Trace session recording lifecycle stages for the request. */
  readonly trace: TraceSession;
  /** Telemetry observer receiving completion events and metrics. */
  readonly observer: LifecycleObserver;
  /** Monotonic and wall clock source. */
  readonly clock?: Clock;
  /** Optional redactor for stripping sensitive tokens from recorded usage objects. */
  readonly redactor?: Redactor;
}

/**
 * Creates an exactly-once terminal coordinator for an admitted request.
 *
 * Tracks the admitted stream flag, first byte latency, provider dispatch attempts,
 * and coordinates terminal fact recording across competing completion paths.
 *
 * @param options - Request identity, protocol, clock, trace, and observer dependencies.
 * @returns Terminal coordinator instance.
 */
export function createTerminalCoordinator(options: TerminalCoordinatorOptions): TerminalCoordinator {
  const { aptusRequestId, endpointProtocol, startedMs, trace, observer, redactor } = options;
  const clock = options.clock ?? systemClock;

  let firstByteMs: number | undefined;
  let ingressEmitted = false;
  let ingressStream = false;
  let wonClaim = false;
  let currentAttempts = 0;

  let resolveFinalized!: () => void;
  const finalized = new Promise<void>((resolve) => {
    resolveFinalized = resolve;
  });

  return {
    /** Promise settling once the winning finalizer completes all telemetry writes. */
    finalized,

    /**
     * Marks that the request crossed the HTTP admission boundary.
     *
     * @param stream - Whether the incoming request payload requested streaming.
     */
    markIngress(stream: boolean): void {
      ingressEmitted = true;
      ingressStream = stream;
    },

    /** Records the client time-to-first-byte latency on the first call only. */
    markClientFirstByte(): void {
      if (firstByteMs === undefined) {
        firstByteMs = clock.nowMonotonicMs() - startedMs;
      }
    },

    /**
     * Records the highest provider attempt number initiated during routing.
     *
     * @param attemptNumber - One-based index of the initiated attempt.
     */
    recordAttempt(attemptNumber: number): void {
      if (attemptNumber > currentAttempts) {
        currentAttempts = attemptNumber;
      }
    },

    /** Returns the highest attempt number recorded, or 0 if no attempts began. */
    getAttempts(): number {
      return currentAttempts;
    },

    /**
     * Atomically claims terminal ownership and executes lifecycle completion side effects.
     *
     * The first caller to claim finalization emits trace finish, decrements in-flight gauges,
     * logs completed request metrics, and resolves the `finalized` drain promise.
     *
     * @param fact - Immutable terminal fact describing the final request outcome.
     * @returns Object indicating whether this caller won terminal claim ownership.
     */
    async finalize(fact: TerminalFact): Promise<{ won: boolean }> {
      if (wonClaim) {
        return { won: false };
      }
      wonClaim = true;

      const attempts = fact.attempts > 0 ? fact.attempts : currentAttempts;

      try {
        // Finish the trace terminal first, falling back to an incomplete abort record on shutdown failure.
        try {
          await trace.finish(fact.terminal);
        } catch {
          if (fact.terminal.kind === "cancelled" && fact.terminal.by === "shutdown") {
            await trace.finish({ kind: "incomplete", reason: "shutdown_abort" }).catch(() => undefined);
          }
        }

        // Emit terminal telemetry only if ingress was accepted, keeping rejected attempts silent.
        if (ingressEmitted) {
          // One terminal moment carries the facts every sink needs: the in-flight
          // gauge decrement (matched to the admitted stream label), the completion
          // log when requested, accepted-request HTTP metrics, and first-byte timing.
          try {
            const terminalResult =
              fact.terminal.kind === "incomplete"
                ? "failed"
                : fact.terminal.kind === "dry_run"
                  ? "dry_run"
                  : fact.outcomeCategory;
            const targetProtocol = fact.targetProtocol ?? "unknown";
            const provider = fact.provider ?? "unknown";
            const canonicalPublicName = fact.canonicalPublicName ?? "unknown";

            const redactedUsage =
              fact.usage !== undefined && redactor !== undefined ? redactor.redactJson(fact.usage) : fact.usage;

            observer.observe({
              type: "request_terminal",
              aptusRequestId,
              endpointProtocol,
              admissionStream: ingressStream,
              stream: fact.stream,
              result: terminalResult,
              outcomeCategory: fact.outcomeCategory,
              targetProtocol,
              provider,
              canonicalPublicName,
              status: fact.status,
              attempts,
              durationMs: fact.durationMs,
              firstByteMs,
              usage: redactedUsage,
              estimatedCostUsd: fact.estimatedCostUsd,
              emitCompleted: fact.emitCompleted !== false,
            });
          } catch {
            // Observer errors are caught to avoid disrupting response finalization.
          }
        }
      } finally {
        resolveFinalized();
      }

      return { won: true };
    },
  };
}
