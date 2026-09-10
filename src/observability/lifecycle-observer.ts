/**
 * @fileoverview Telemetry observer: one `observe(moment)` channel over every routing,
 * HTTP, and system moment, fanned out to structured logs and Prometheus metrics.
 *
 * Producers across routing, HTTP, bootstrap, and the trace scheduler record each moment
 * exactly once as a typed {@link LifecycleEvent} carrying its full label facts. This
 * module owns the seam: {@link LifecycleObserver} is the thin one-method interface callers
 * depend on, {@link LifecycleEvent} is the moment vocabulary, and
 * {@link createLifecycleObserver} is the deep implementation that fans each moment out to
 * the log lines and metric series the labels map to. Telemetry errors are swallowed so
 * observability failures never break live traffic.
 */

import type { Logger } from "@logtape/logtape";
import type { JsonValue, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { MetricsRegistry } from "./metrics.ts";

/**
 * Bounded provider attempt result: `success`, one of the 13 canonical failure categories, or `client_cancelled`.
 */
export type AttemptResult = "success" | IrFailureCategory | "client_cancelled";

/**
 * An immutable telemetry moment recorded through the observer seam.
 *
 * Every variant carries the full label facts its log and metric sinks need — producers
 * report facts, never pre-digested log or metric shapes. The six request-lifecycle
 * moments (ingress, candidate skip, attempt start, retry, fallback, terminal) keep their
 * long-standing type tags; the remaining request, HTTP, and system moments round out the
 * vocabulary. `aptusRequestId` on every request-scoped variant joins the moment back to
 * its request; system moments (retention, shutdown, catalog, key-pool availability)
 * carry no request id.
 */
export type LifecycleEvent =
  | {
      /** Request admitted: in-flight gauge increment + `aptus.request.ingress` log. */
      readonly type: "request_ingress";
      readonly aptusRequestId: string;
      /** Ingress protocol spoken by the client. */
      readonly endpointProtocol: Protocol;
      /** Public endpoint label the request arrived on. */
      readonly endpoint: string;
      /** Whether the client requested streaming responses. */
      readonly stream: boolean;
    }
  | {
      /** `aptus.auth.result` log. */
      readonly type: "auth_result";
      readonly aptusRequestId: string;
      readonly scheme: string;
      readonly result: string;
    }
  | {
      /** `aptus.name.resolved` log. */
      readonly type: "name_resolved";
      readonly aptusRequestId: string;
      readonly canonicalPublicName: string;
      readonly kind: string;
    }
  | {
      /** `aptus.candidate.skipped` log + `aptus_candidate_skips_total`. */
      readonly type: "candidate_skipped";
      readonly aptusRequestId: string;
      readonly endpointProtocol: Protocol;
      readonly canonicalPublicName: string;
      readonly candidateIndex: number;
      readonly provider: string;
      readonly targetProtocol: Protocol;
      readonly category: IrFailureCategory;
      readonly capability?: string;
    }
  | {
      /** `aptus.fallback.selected` log + `aptus_fallbacks_total`. */
      readonly type: "fallback_selected";
      readonly aptusRequestId: string;
      readonly endpointProtocol: Protocol;
      /** Target protocol of the fallback provider. */
      readonly targetProtocol: Protocol;
      /** Canonical public route or model name requested. */
      readonly publicName: string;
      /** Route candidate index transitioning from. */
      readonly fromCandidateIndex: number;
      /** Route candidate index transitioning to. */
      readonly toCandidateIndex: number;
      /** Failure category that prompted the fallback transition. */
      readonly category: IrFailureCategory;
    }
  | {
      /** `aptus.key.selected` log. */
      readonly type: "key_selected";
      readonly aptusRequestId: string;
      readonly attemptNumber: number;
      readonly provider: string;
      readonly keyName: string;
      readonly strategy: string;
    }
  | {
      /** `aptus.attempt.started` log. */
      readonly type: "attempt_started";
      readonly aptusRequestId: string;
      readonly attemptNumber: number;
      readonly candidateIndex: number;
      readonly provider: string;
      readonly targetProtocol: Protocol;
      readonly stream: boolean;
    }
  | {
      /** `aptus.dispatch.completed` log + provider attempt counters. */
      readonly type: "attempt_completed";
      readonly aptusRequestId: string;
      readonly attemptNumber: number;
      readonly provider: string;
      readonly targetProtocol: Protocol;
      /** Upstream HTTP status code, or undefined for transport-level errors. */
      readonly status: number | undefined;
      readonly attemptResult: AttemptResult;
      readonly stream: boolean;
      /** Wall-clock duration of the attempt in milliseconds. */
      readonly durationMs: number;
    }
  | {
      /** `aptus.retry.scheduled` log + `aptus_retries_total`. */
      readonly type: "retry_scheduled";
      readonly aptusRequestId: string;
      /** Sequential attempt number being retried. */
      readonly attemptNumber: number;
      /** Provider identifier being retried. */
      readonly provider: string;
      /** Target protocol for the upstream attempt. */
      readonly targetProtocol: Protocol;
      /** Normalized failure category that triggered the retry. */
      readonly category: IrFailureCategory;
      /** Cooldown delay in milliseconds scheduled on the failed key before reuse. */
      readonly delayMs: number;
    }
  | {
      /** `aptus.request.cancelled` log. */
      readonly type: "cancelled";
      readonly aptusRequestId: string;
      readonly phase: string;
      readonly by: string;
    }
  | {
      /**
       * Request terminal: in-flight gauge decrement, accepted-request HTTP metrics,
       * the completion log when `emitCompleted`, and the first-byte log.
       *
       * `admissionStream` is the label the request was admitted under and the in-flight
       * gauge decrement must match; `stream` is the terminal stream label used for HTTP
       * metrics and the completion log. They can differ when a request admitted for one
       * mode terminates through the other.
       */
      readonly type: "request_terminal";
      readonly aptusRequestId: string;
      readonly endpointProtocol: Protocol;
      readonly admissionStream: boolean;
      readonly stream: boolean;
      /** High-level terminal outcome: `complete · failed · cancelled · dry_run`. */
      readonly result: "complete" | "failed" | "cancelled" | "dry_run";
      /** High-level terminal outcome category used by HTTP metrics and the completion log. */
      readonly outcomeCategory: "complete" | "failed" | "cancelled";
      /** Upstream target protocol reached, or "unknown" if terminated before dispatch. */
      readonly targetProtocol: Protocol | "unknown";
      /** Upstream provider used, or "unknown" if terminated before provider selection. */
      readonly provider: string;
      /** Canonical public model name requested. */
      readonly canonicalPublicName: string;
      /** Final HTTP response status code sent to the client. */
      readonly status: number;
      /** Total number of upstream dispatch attempts made. */
      readonly attempts: number;
      /** Total end-to-end request duration in milliseconds. */
      readonly durationMs: number;
      /** Time from ingress admission to first response byte sent, if observed. */
      readonly firstByteMs?: number;
      /** Parsed token usage statistics, if reported by the provider. */
      readonly usage?: JsonValue;
      /** Estimated request cost in USD formatted string, if pricing was calculated. */
      readonly estimatedCostUsd?: string;
      /** Whether the `aptus.request.completed` log is emitted (false for pre-gateway HTTP-only terminals). */
      readonly emitCompleted: boolean;
    }
  | {
      /** `models` catalog terminal HTTP observation (no in-flight/Trace session). */
      readonly type: "catalog_completed";
      readonly endpointProtocol: Protocol;
    }
  | {
      /** Sets `aptus_key_pool_available` for a provider pool. */
      readonly type: "key_pool_available";
      readonly provider: string;
      readonly targetProtocol: Protocol;
      readonly count: number;
    }
  | {
      /** `aptus.retention.run` log. */
      readonly type: "retention_run";
      readonly deletedForAge: number;
      readonly deletedForSize: number;
      readonly skipped: number;
      readonly remainingBytes: number;
      readonly incompleteBytes: number;
    }
  | {
      /** `aptus.trace.failure` log + `aptus_trace_write_failures_total`. */
      readonly type: "trace_failure";
      readonly aptusRequestId: string | undefined;
      readonly operation: string;
      readonly safeErrorCode: string;
    }
  | {
      /** `aptus.shutdown.started` log + `aptus_shutdown_active_requests`. */
      readonly type: "shutdown_started";
      readonly activeRequests: number;
      readonly drainMs: number;
    }
  | {
      /** `aptus.shutdown.completed` log. */
      readonly type: "shutdown_completed";
      readonly drained: number;
      readonly aborted: number;
      readonly durationMs: number;
    };

/**
 * The observer interface for recording telemetry moments in logs and metrics.
 *
 * Routing, HTTP, bootstrap, and the trace scheduler notify the observer as moments happen
 * by handing over a single typed {@link LifecycleEvent}; the production implementation
 * fans each moment out to metrics and structured logs. Observation never feeds back into
 * routing: the observer cannot change the candidate choice, delay, or outcome, and tests
 * substitute a recording stub to assert on the emitted sequence.
 */
export interface LifecycleObserver {
  /**
   * Receives an immutable telemetry moment.
   */
  observe(event: LifecycleEvent): void;
}

/**
 * Initialization options for the lifecycle observer.
 */
export interface LifecycleObserverOptions {
  /** The shared LogTape logger instance. */
  readonly logger: Logger;
  /** The single Prometheus metrics registry. */
  readonly metrics: MetricsRegistry;
  /** Whether structured logging is enabled. */
  readonly loggingEnabled: boolean;
  /** Whether metrics collection is enabled. */
  readonly metricsEnabled: boolean;
}

/**
 * Creates the lifecycle observer fanning telemetry moments out to logs and metrics.
 *
 * `observe` is synchronous and safe against exceptions: each moment's log and metric
 * writes are contained so telemetry failures never interrupt live request execution.
 *
 * @param options - Logger, metrics registry, and channel enablement configuration.
 * @returns A {@link LifecycleObserver} recording telemetry moments.
 */
export function createLifecycleObserver(options: LifecycleObserverOptions): LifecycleObserver {
  const { logger, metrics, loggingEnabled, metricsEnabled } = options;

  return {
    observe(event) {
      switch (event.type) {
        case "request_ingress": {
          try {
            if (metricsEnabled) metrics.inFlightInc(event.endpointProtocol, event.stream);
            if (loggingEnabled) {
              logger.info("aptus.request.ingress", {
                aptusRequestId: event.aptusRequestId,
                endpointProtocol: event.endpointProtocol,
                endpoint: event.endpoint,
                stream: event.stream,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "request_terminal": {
          try {
            if (metricsEnabled) metrics.inFlightDec(event.endpointProtocol, event.admissionStream);
            if (event.emitCompleted && loggingEnabled) {
              logger.info("aptus.request.completed", {
                aptusRequestId: event.aptusRequestId,
                canonicalPublicName: event.canonicalPublicName,
                outcomeCategory: event.outcomeCategory,
                status: event.status,
                attempts: event.attempts,
                stream: event.stream,
                durationMs: event.durationMs,
                ...(event.usage === undefined ? {} : { usage: event.usage }),
                ...(event.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: event.estimatedCostUsd }),
              });
            }
            recordHttpTerminal(event, metricsEnabled, metrics);
            if (event.firstByteMs !== undefined && event.attempts > 0 && loggingEnabled) {
              logger.info("aptus.response.first_byte", {
                aptusRequestId: event.aptusRequestId,
                attemptNumber: event.attempts,
                durationMs: event.firstByteMs,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "auth_result": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.auth.result", {
                aptusRequestId: event.aptusRequestId,
                scheme: event.scheme,
                result: event.result,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "name_resolved": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.name.resolved", {
                aptusRequestId: event.aptusRequestId,
                canonicalPublicName: event.canonicalPublicName,
                kind: event.kind,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "candidate_skipped": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.candidate.skipped", {
                aptusRequestId: event.aptusRequestId,
                canonicalPublicName: event.canonicalPublicName,
                candidateIndex: event.candidateIndex,
                provider: event.provider,
                targetProtocol: event.targetProtocol,
                category: event.category,
                capability: event.capability ?? null,
              });
            }
            if (metricsEnabled) {
              metrics.candidateSkips(
                event.endpointProtocol,
                event.targetProtocol,
                event.provider,
                event.canonicalPublicName,
                event.category,
              );
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "key_selected": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.key.selected", {
                aptusRequestId: event.aptusRequestId,
                attemptNumber: event.attemptNumber,
                provider: event.provider,
                keyName: event.keyName,
                strategy: event.strategy,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "attempt_started": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.attempt.started", {
                aptusRequestId: event.aptusRequestId,
                attemptNumber: event.attemptNumber,
                candidateIndex: event.candidateIndex,
                provider: event.provider,
                targetProtocol: event.targetProtocol,
                stream: event.stream,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "attempt_completed": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.dispatch.completed", {
                aptusRequestId: event.aptusRequestId,
                attemptNumber: event.attemptNumber,
                provider: event.provider,
                status: event.status ?? 0,
                attemptResult: event.attemptResult,
                durationMs: event.durationMs,
              });
            }
            if (metricsEnabled) {
              metrics.providerAttempt(event.targetProtocol, event.provider, event.attemptResult, event.stream);
              metrics.providerAttemptDuration(
                event.targetProtocol,
                event.provider,
                event.attemptResult,
                event.stream,
                event.durationMs / 1000,
              );
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "retry_scheduled": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.retry.scheduled", {
                aptusRequestId: event.aptusRequestId,
                attemptNumber: event.attemptNumber,
                provider: event.provider,
                category: event.category,
                delayMs: event.delayMs,
              });
            }
            if (metricsEnabled) {
              metrics.retries(event.targetProtocol, event.provider, event.category);
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "fallback_selected": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.fallback.selected", {
                aptusRequestId: event.aptusRequestId,
                fromCandidateIndex: event.fromCandidateIndex,
                toCandidateIndex: event.toCandidateIndex,
                category: event.category,
              });
            }
            if (metricsEnabled) {
              metrics.fallbacks(event.endpointProtocol, event.targetProtocol, event.publicName, event.category);
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "cancelled": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.request.cancelled", {
                aptusRequestId: event.aptusRequestId,
                phase: event.phase,
                by: event.by,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "catalog_completed": {
          try {
            if (metricsEnabled) metrics.httpRequest(event.endpointProtocol, "models", "complete", false);
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "key_pool_available": {
          try {
            if (metricsEnabled) metrics.keyPoolAvailable(event.targetProtocol, event.provider, event.count);
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "trace_failure": {
          try {
            if (loggingEnabled) {
              logger.warn("aptus.trace.failure", {
                aptusRequestId: event.aptusRequestId ?? "system",
                operation: event.operation,
                safeErrorCode: event.safeErrorCode,
              });
            }
            if (metricsEnabled) metrics.traceWriteFailures(event.operation);
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "retention_run": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.retention.run", {
                deletedForAge: event.deletedForAge,
                deletedForSize: event.deletedForSize,
                skipped: event.skipped,
                remainingBytes: event.remainingBytes,
                incompleteBytes: event.incompleteBytes,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "shutdown_started": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.shutdown.started", {
                activeRequests: event.activeRequests,
                drainMs: event.drainMs,
              });
            }
            if (metricsEnabled) {
              metrics.shutdownActiveRequests(event.activeRequests);
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }

        case "shutdown_completed": {
          try {
            if (loggingEnabled) {
              logger.info("aptus.shutdown.completed", {
                drained: event.drained,
                aborted: event.aborted,
                durationMs: event.durationMs,
              });
            }
          } catch {
            // Observability errors never fail traffic.
          }
          break;
        }
      }
    },
  };
}

/**
 * Records accepted-request HTTP metrics including count, duration, and time-to-first-byte.
 *
 * @param event - Terminal request moment.
 * @param metricsEnabled - Whether metric emission is enabled.
 * @param metrics - Metrics registry to update.
 */
function recordHttpTerminal(
  event: Extract<LifecycleEvent, { type: "request_terminal" }>,
  metricsEnabled: boolean,
  metrics: MetricsRegistry,
): void {
  // The endpoint label is derived from the client protocol because the
  // metrics domain is endpoint-shaped; the mapping matches the three create
  // endpoints defined in the client app.
  if (!metricsEnabled) return;
  const endpoint =
    event.endpointProtocol === "openai-chat"
      ? "chat_completions"
      : event.endpointProtocol === "openai-responses"
        ? "responses"
        : "messages";
  metrics.httpRequest(event.endpointProtocol, endpoint, event.outcomeCategory, event.stream);
  metrics.httpDuration(
    event.endpointProtocol,
    event.targetProtocol,
    event.provider,
    event.canonicalPublicName,
    event.outcomeCategory,
    event.stream,
    event.durationMs / 1000,
  );
  if (event.firstByteMs !== undefined) {
    metrics.httpFirstByte(
      event.endpointProtocol,
      event.targetProtocol,
      event.provider,
      event.canonicalPublicName,
      event.stream,
      event.firstByteMs / 1000,
    );
  }
}
