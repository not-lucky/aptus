import type { AptusRequestId, Protocol, TerminalCoordinator, TerminalFact, TraceSession } from "../domain/contracts.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import type { Redactor } from "../observability/trace/redaction.ts";
import { type Clock, systemClock } from "../routing/timing.ts";

/**
 * Initialization options for constructing a {@link TerminalCoordinator}.
 */
export interface TerminalCoordinatorOptions {
  readonly aptusRequestId: AptusRequestId;
  readonly endpointProtocol: Protocol;
  readonly startedMs: number;
  readonly trace: TraceSession;
  readonly observer: GatewayObservability;
  readonly clock?: Clock;
  readonly redactor?: Redactor;
}

/**
 * Creates the single request-scoped terminal and delivery coordinator.
 *
 * Enforces atomic terminal finalization across competing outcomes (provider response,
 * HTTP client disconnect, Gateway failure, dry run, internal fault).
 *
 * @param options - Request identity, protocol, timing, trace session, and telemetry observer.
 * @returns A {@link TerminalCoordinator} instance.
 */
export function createTerminalCoordinator(options: TerminalCoordinatorOptions): TerminalCoordinator {
  const { aptusRequestId, endpointProtocol, startedMs, trace, observer, redactor } = options;
  const clock = options.clock ?? systemClock;

  let firstByteMs: number | undefined;
  let ingressEmitted = false;
  let ingressStream = false;
  let wonClaim = false;

  let resolveFinalized!: () => void;
  const finalized = new Promise<void>((resolve) => {
    resolveFinalized = resolve;
  });

  return {
    finalized,

    markIngress(stream: boolean): void {
      ingressEmitted = true;
      ingressStream = stream;
    },

    markClientFirstByte(): void {
      if (firstByteMs === undefined) {
        firstByteMs = clock.nowMonotonicMs() - startedMs;
      }
    },

    async finalize(fact: TerminalFact): Promise<{ won: boolean }> {
      if (wonClaim) {
        return { won: false };
      }
      wonClaim = true;

      try {
        // 1. Finish Trace terminal
        await trace.finish(fact.terminal).catch(() => undefined);

        // 2-4. Accepted-request telemetry (in-flight decrement, request_terminal
        // fact, and aptus.request.completed) only fires after HTTP ingress
        // admission. Authentication, limiter, and body-admission failures that
        // never reached the admission boundary must not decrement the gauge or
        // emit an accepted-request counter observation.
        if (ingressEmitted) {
          // 2. Decrement in-flight gauge using the admitted stream label so
          // the increment/decrement pair always balances.
          try {
            observer.requestTerminal({
              aptusRequestId,
              endpointProtocol,
              stream: ingressStream,
            });
          } catch {
            // Swallow observer error
          }

          // 3. Emit canonical request_terminal lifecycle event
          try {
            const terminalResult =
              fact.terminal.kind === "incomplete"
                ? "failed"
                : fact.terminal.kind === "dry_run"
                  ? "dry_run"
                  : fact.outcomeCategory;
            observer.observe({
              type: "request_terminal",
              aptusRequestId,
              result: terminalResult,
            });
          } catch {
            // Swallow observer error
          }

          // 4. Emit duration/TTFF histograms plus either the
          // `aptus.request.completed` log (Gateway-admitted requests) or the
          // accepted-request counter/duration only (pre-Gateway failures).
          try {
            const targetProtocol = fact.targetProtocol ?? "unknown";
            const provider = fact.provider ?? "unknown";
            const canonicalPublicName = fact.canonicalPublicName ?? "unknown";

            const redactedUsage =
              fact.usage !== undefined && redactor !== undefined ? redactor.redactJson(fact.usage) : fact.usage;

            const completedFields = {
              aptusRequestId,
              endpointProtocol,
              targetProtocol,
              provider,
              canonicalPublicName,
              outcomeCategory: fact.outcomeCategory,
              status: fact.status,
              attempts: fact.attempts,
              stream: fact.stream,
              durationMs: fact.durationMs,
              firstByteMs,
              usage: redactedUsage,
              estimatedCostUsd: fact.estimatedCostUsd,
            };

            if (fact.emitCompleted === false) {
              observer.httpTerminal(completedFields);
            } else {
              observer.completed(completedFields);
            }
          } catch {
            // Swallow observer error
          }

          // 5. Emit `aptus.response.first_byte` once first-byte timing is known
          // and at least one provider attempt actually produced the response.
          if (firstByteMs !== undefined && fact.attempts > 0) {
            try {
              observer.firstByte({
                aptusRequestId,
                attemptNumber: fact.attempts,
                durationMs: firstByteMs,
              });
            } catch {
              // Swallow observer error
            }
          }
        }
      } finally {
        resolveFinalized();
      }

      return { won: true };
    },
  };
}
