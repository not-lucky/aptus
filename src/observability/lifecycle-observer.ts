import type { Logger } from "@logtape/logtape";
import type { JsonValue, LifecycleEvent, LifecycleObserver, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { MetricsRegistry } from "./metrics.ts";

/**
 * A bounded provider attempt result: `success`, one of the 13 canonical
 * failure categories, or `client_cancelled`.
 */
export type AttemptResult = "success" | IrFailureCategory | "client_cancelled";

/**
 * Request-scoped telemetry helpers used by the Gateway (and bootstrap) in
 * addition to the canonical {@link LifecycleObserver}.
 *
 * The Gateway emits every documented {@link LifecycleEvent} through
 * {@link LifecycleObserver.observe}, and additionally calls one full-context
 * named helper per event. The named helpers carry the metric-label facts the
 * minimal event payloads omit (provider, public name, target protocol), so
 * this production observer records every log and metric through them and
 * leaves `observe` as a no-op. The canonical `observe` stream remains the
 * documented routing-fact contract for tests and future observers; the two
 * channels are two views of the same transitions, never two emission points.
 */
export interface GatewayObservability extends LifecycleObserver {
  /** Request admitted: in-flight gauge + `aptus.request.ingress`. */
  requestIngress(fields: {
    aptusRequestId: string;
    endpointProtocol: Protocol;
    endpoint: string;
    stream: boolean;
  }): void;

  /** Request finished (any terminal outcome): in-flight gauge decrement. */
  requestTerminal(fields: { aptusRequestId: string; endpointProtocol: Protocol; stream: boolean }): void;

  /** `aptus.auth.result` log. */
  authResult(fields: { aptusRequestId: string; scheme: string; result: string }): void;

  /** `aptus.name.resolved` log. */
  nameResolved(fields: { aptusRequestId: string; canonicalPublicName: string; kind: string }): void;

  /** `aptus.candidate.skipped` log + `aptus_candidate_skips_total`. */
  candidateSkipped(fields: CandidateSkipFields): void;

  /** `aptus.key.selected` log. */
  keySelected(fields: {
    aptusRequestId: string;
    attemptNumber: number;
    provider: string;
    keyName: string;
    strategy: string;
  }): void;

  /** `aptus.attempt.started` log. */
  attemptStarted(fields: {
    aptusRequestId: string;
    attemptNumber: number;
    candidateIndex: number;
    provider: string;
    targetProtocol: Protocol;
    stream: boolean;
  }): void;

  /** `aptus.dispatch.completed` log + provider attempt counters. */
  attemptCompleted(fields: AttemptCompletedFields): void;

  /** `aptus.response.first_byte` log. */
  firstByte(fields: { aptusRequestId: string; attemptNumber: number; durationMs: number }): void;

  /** `aptus.retry.scheduled` log + `aptus_retries_total`. */
  retryScheduled(fields: RetryScheduledFields): void;

  /** `aptus.fallback.selected` log + `aptus_fallbacks_total`. */
  fallbackSelected(fields: FallbackSelectedFields): void;

  /** `aptus.request.completed` log + duration and TTFF histograms. */
  completed(fields: CompletedFields): void;

  /** Accepted-request HTTP counter + duration/TTFF without the completion log. */
  httpTerminal(fields: CompletedFields): void;

  /** `models` catalog terminal HTTP observation (no in-flight/Trace session). */
  catalogCompleted(fields: { endpointProtocol: Protocol }): void;

  /** `aptus.request.cancelled` log. */
  cancelled(fields: { aptusRequestId: string; phase: string; by: string }): void;

  /** Sets `aptus_key_pool_available` for a provider pool. */
  setKeyPoolAvailable(provider: string, targetProtocol: Protocol, count: number): void;

  /** `aptus.trace.failure` log + `aptus_trace_write_failures_total`. */
  traceFailure(fields: { aptusRequestId: string | undefined; operation: string; safeErrorCode: string }): void;

  /** `aptus.retention.run` log. */
  retentionRun(fields: {
    deletedForAge: number;
    deletedForSize: number;
    skipped: number;
    remainingBytes: number;
    incompleteBytes: number;
  }): void;

  /** `aptus.shutdown.started` log + `aptus_shutdown_active_requests`. */
  shutdownStarted(fields: { activeRequests: number; drainMs: number }): void;

  /** `aptus.shutdown.completed` log. */
  shutdownCompleted(fields: { drained: number; aborted: number; durationMs: number }): void;
}

/**
 * Fields for a scheduled retry.
 */
export interface RetryScheduledFields {
  readonly aptusRequestId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly targetProtocol: Protocol;
  readonly category: IrFailureCategory;
  /**
   * Cooldown scheduled on the failed key (base + jitter, capped). This equals
   * the actual wait only when no other enabled key is available to rotate to;
   * with key rotation the retry proceeds immediately despite a non-zero value.
   */
  readonly delayMs: number;
}

/**
 * Fields for a selected candidate fallback.
 */
export interface FallbackSelectedFields {
  readonly aptusRequestId: string;
  readonly endpointProtocol: Protocol;
  readonly targetProtocol: Protocol;
  readonly publicName: string;
  readonly fromCandidateIndex: number;
  readonly toCandidateIndex: number;
  readonly category: IrFailureCategory;
}

/**
 * Fields for a candidate preflight skip.
 */
export interface CandidateSkipFields {
  readonly aptusRequestId: string;
  readonly endpointProtocol: Protocol;
  readonly canonicalPublicName: string;
  readonly candidateIndex: number;
  readonly provider: string;
  readonly targetProtocol: Protocol;
  readonly category: IrFailureCategory;
  readonly capability?: string;
}

/**
 * Fields for a completed provider attempt (response head or transport failure).
 */
export interface AttemptCompletedFields {
  readonly aptusRequestId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly targetProtocol: Protocol;
  readonly status: number | undefined;
  readonly attemptResult: AttemptResult;
  readonly stream: boolean;
  readonly durationMs: number;
}

/**
 * Fields for a completed request (any terminal outcome).
 */
export interface CompletedFields {
  readonly aptusRequestId: string;
  readonly endpointProtocol: Protocol;
  readonly targetProtocol: Protocol | "unknown";
  readonly provider: string;
  readonly canonicalPublicName: string;
  readonly outcomeCategory: "complete" | "failed" | "cancelled";
  readonly status: number;
  readonly attempts: number;
  readonly stream: boolean;
  readonly durationMs: number;
  readonly firstByteMs?: number;
  readonly usage?: JsonValue;
  readonly estimatedCostUsd?: string;
}

/**
 * Initialization options for the lifecycle observer.
 */
export interface LifecycleObserverOptions {
  /** The shared `"aptus"` LogTape logger. */
  readonly logger: Logger;
  /** The single Prometheus metrics registry. */
  readonly metrics: MetricsRegistry;
  /** Whether structured logging is enabled. */
  readonly loggingEnabled: boolean;
  /** Whether metrics collection is enabled. */
  readonly metricsEnabled: boolean;
}

/**
 * Creates the {@link LifecycleObserver} plus the request-scoped
 * {@link GatewayObservability} helpers.
 *
 * The observer never imports `src/config` or `src/http` and cannot affect
 * routing decisions. It only emits logs and metric updates.
 *
 * @param options - Logger, metrics registry, and enablement flags.
 * @returns The combined telemetry observer.
 */
export function createLifecycleObserver(options: LifecycleObserverOptions): LifecycleObserver & GatewayObservability {
  const { logger, metrics, loggingEnabled, metricsEnabled } = options;

  return {
    observe(_event: LifecycleEvent): void {
      // Canonical routing facts only. Logs and metrics are recorded by the
      // named helpers above, which carry the full label context the minimal
      // event payloads omit; `observe` intentionally does not double-emit.
    },

    requestIngress(fields) {
      try {
        if (metricsEnabled) metrics.inFlightInc(fields.endpointProtocol, fields.stream);
        if (loggingEnabled) {
          logger.info("aptus.request.ingress", {
            aptusRequestId: fields.aptusRequestId,
            endpointProtocol: fields.endpointProtocol,
            endpoint: fields.endpoint,
            stream: fields.stream,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    requestTerminal(fields) {
      try {
        if (metricsEnabled) metrics.inFlightDec(fields.endpointProtocol, fields.stream);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    authResult(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.auth.result", {
            aptusRequestId: fields.aptusRequestId,
            scheme: fields.scheme,
            result: fields.result,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    nameResolved(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.name.resolved", {
            aptusRequestId: fields.aptusRequestId,
            canonicalPublicName: fields.canonicalPublicName,
            kind: fields.kind,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    candidateSkipped(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.candidate.skipped", {
            aptusRequestId: fields.aptusRequestId,
            canonicalPublicName: fields.canonicalPublicName,
            candidateIndex: fields.candidateIndex,
            provider: fields.provider,
            targetProtocol: fields.targetProtocol,
            category: fields.category,
            capability: fields.capability ?? null,
          });
        }
        if (metricsEnabled) {
          metrics.candidateSkips(
            fields.endpointProtocol,
            fields.targetProtocol,
            fields.provider,
            fields.canonicalPublicName,
            fields.category,
          );
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    keySelected(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.key.selected", {
            aptusRequestId: fields.aptusRequestId,
            attemptNumber: fields.attemptNumber,
            provider: fields.provider,
            keyName: fields.keyName,
            strategy: fields.strategy,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    attemptStarted(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.attempt.started", {
            aptusRequestId: fields.aptusRequestId,
            attemptNumber: fields.attemptNumber,
            candidateIndex: fields.candidateIndex,
            provider: fields.provider,
            targetProtocol: fields.targetProtocol,
            stream: fields.stream,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    attemptCompleted(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.dispatch.completed", {
            aptusRequestId: fields.aptusRequestId,
            attemptNumber: fields.attemptNumber,
            provider: fields.provider,
            status: fields.status ?? 0,
            attemptResult: fields.attemptResult,
            durationMs: fields.durationMs,
          });
        }
        if (metricsEnabled) {
          metrics.providerAttempt(fields.targetProtocol, fields.provider, fields.attemptResult, fields.stream);
          metrics.providerAttemptDuration(
            fields.targetProtocol,
            fields.provider,
            fields.attemptResult,
            fields.stream,
            fields.durationMs / 1000,
          );
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    firstByte(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.response.first_byte", {
            aptusRequestId: fields.aptusRequestId,
            attemptNumber: fields.attemptNumber,
            durationMs: fields.durationMs,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    retryScheduled(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.retry.scheduled", {
            aptusRequestId: fields.aptusRequestId,
            attemptNumber: fields.attemptNumber,
            provider: fields.provider,
            category: fields.category,
            delayMs: fields.delayMs,
          });
        }
        if (metricsEnabled) {
          metrics.retries(fields.targetProtocol, fields.provider, fields.category);
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    fallbackSelected(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.fallback.selected", {
            aptusRequestId: fields.aptusRequestId,
            fromCandidateIndex: fields.fromCandidateIndex,
            toCandidateIndex: fields.toCandidateIndex,
            category: fields.category,
          });
        }
        if (metricsEnabled) {
          metrics.fallbacks(fields.endpointProtocol, fields.targetProtocol, fields.publicName, fields.category);
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    catalogCompleted(fields) {
      try {
        if (metricsEnabled) metrics.httpRequest(fields.endpointProtocol, "models", "complete", false);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    completed(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.request.completed", {
            aptusRequestId: fields.aptusRequestId,
            canonicalPublicName: fields.canonicalPublicName,
            outcomeCategory: fields.outcomeCategory,
            status: fields.status,
            attempts: fields.attempts,
            stream: fields.stream,
            durationMs: fields.durationMs,
            ...(fields.usage === undefined ? {} : { usage: fields.usage }),
            ...(fields.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: fields.estimatedCostUsd }),
          });
        }
        recordHttpTerminal(fields, metricsEnabled, metrics);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    httpTerminal(fields) {
      try {
        recordHttpTerminal(fields, metricsEnabled, metrics);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    cancelled(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.request.cancelled", {
            aptusRequestId: fields.aptusRequestId,
            phase: fields.phase,
            by: fields.by,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    setKeyPoolAvailable(provider, targetProtocol, count) {
      try {
        if (metricsEnabled) metrics.keyPoolAvailable(targetProtocol, provider, count);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    traceFailure(fields) {
      try {
        if (loggingEnabled) {
          logger.warn("aptus.trace.failure", {
            aptusRequestId: fields.aptusRequestId ?? "system",
            operation: fields.operation,
            safeErrorCode: fields.safeErrorCode,
          });
        }
        if (metricsEnabled) metrics.traceWriteFailures(fields.operation);
      } catch {
        // Observability errors never fail traffic.
      }
    },

    retentionRun(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.retention.run", {
            deletedForAge: fields.deletedForAge,
            deletedForSize: fields.deletedForSize,
            skipped: fields.skipped,
            remainingBytes: fields.remainingBytes,
            incompleteBytes: fields.incompleteBytes,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    shutdownStarted(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.shutdown.started", {
            activeRequests: fields.activeRequests,
            drainMs: fields.drainMs,
          });
        }
        if (metricsEnabled) {
          metrics.shutdownActiveRequests(fields.activeRequests);
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },

    shutdownCompleted(fields) {
      try {
        if (loggingEnabled) {
          logger.info("aptus.shutdown.completed", {
            drained: fields.drained,
            aborted: fields.aborted,
            durationMs: fields.durationMs,
          });
        }
      } catch {
        // Observability errors never fail traffic.
      }
    },
  };
}

/**
 * Records the accepted-request HTTP counter plus the duration and TTFF
 * histograms. Shared by `completed` (which additionally logs
 * `aptus.request.completed`) and `httpTerminal` (pre-Gateway failures that
 * must not emit the completion log).
 */
function recordHttpTerminal(fields: CompletedFields, metricsEnabled: boolean, metrics: MetricsRegistry): void {
  if (!metricsEnabled) return;
  const endpoint =
    fields.endpointProtocol === "openai-chat"
      ? "chat_completions"
      : fields.endpointProtocol === "openai-responses"
        ? "responses"
        : "messages";
  metrics.httpRequest(fields.endpointProtocol, endpoint, fields.outcomeCategory, fields.stream);
  metrics.httpDuration(
    fields.endpointProtocol,
    fields.targetProtocol,
    fields.provider,
    fields.canonicalPublicName,
    fields.outcomeCategory,
    fields.stream,
    fields.durationMs / 1000,
  );
  if (fields.firstByteMs !== undefined) {
    metrics.httpFirstByte(
      fields.endpointProtocol,
      fields.targetProtocol,
      fields.provider,
      fields.canonicalPublicName,
      fields.stream,
      fields.firstByteMs / 1000,
    );
  }
}
