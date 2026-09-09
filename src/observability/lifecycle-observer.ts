/**
 * @fileoverview Request lifecycle telemetry: structured logs and Prometheus metrics.
 *
 * Provides the central funnel for recording request events, routing decisions, and
 * terminal outcomes as structured JSON logs and bounded Prometheus metrics. Telemetry
 * errors are swallowed so observability failures never break live traffic.
 *
 * Implements a dual interface: the canonical {@link LifecycleObserver} event stream
 * for tests and minimal subscribers, and {@link GatewayObservability} named helpers
 * carrying rich metric-label context (provider, model, protocol) for production telemetry.
 */

import type { Logger } from "@logtape/logtape";
import type { JsonValue, LifecycleEvent, LifecycleObserver, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { MetricsRegistry } from "./metrics.ts";

/**
 * Bounded provider attempt result: `success`, one of the 13 canonical failure categories, or `client_cancelled`.
 */
export type AttemptResult = "success" | IrFailureCategory | "client_cancelled";

/**
 * Request-scoped telemetry helpers used by the gateway and bootstrap runners.
 *
 * Extends {@link LifecycleObserver} with full-context named helpers carrying label
 * facts (provider, public name, protocol) omitted by minimal event payloads.
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
 * Fields for recording a scheduled candidate retry.
 */
export interface RetryScheduledFields {
  /** Unique gateway request identifier. */
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

/**
 * Fields for recording a route candidate fallback transition.
 */
export interface FallbackSelectedFields {
  /** Unique gateway request identifier. */
  readonly aptusRequestId: string;
  /** Ingress protocol spoken by the client. */
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

/**
 * Fields for recording a candidate skipped during preflight routing checks.
 */
export interface CandidateSkipFields {
  /** Unique gateway request identifier. */
  readonly aptusRequestId: string;
  /** Ingress protocol spoken by the client. */
  readonly endpointProtocol: Protocol;
  /** Canonical public model name requested. */
  readonly canonicalPublicName: string;
  /** Route list index of the skipped candidate. */
  readonly candidateIndex: number;
  /** Provider identifier of the candidate. */
  readonly provider: string;
  /** Target protocol configured for this candidate. */
  readonly targetProtocol: Protocol;
  /** Failure category explaining why the candidate was skipped. */
  readonly category: IrFailureCategory;
  /** Optional capability name that was missing or unsupported. */
  readonly capability?: string;
}

/**
 * Fields for recording a completed provider attempt.
 */
export interface AttemptCompletedFields {
  /** Unique gateway request identifier. */
  readonly aptusRequestId: string;
  /** Sequential attempt number for this request. */
  readonly attemptNumber: number;
  /** Upstream provider identifier dispatched to. */
  readonly provider: string;
  /** Protocol used for the upstream attempt. */
  readonly targetProtocol: Protocol;
  /** Upstream HTTP status code, or undefined for transport-level errors. */
  readonly status: number | undefined;
  /** Bounded attempt outcome result. */
  readonly attemptResult: AttemptResult;
  /** Whether the request was dispatched in streaming mode. */
  readonly stream: boolean;
  /** Wall-clock duration of the attempt in milliseconds. */
  readonly durationMs: number;
}

/**
 * Terminal telemetry fields summarizing an entire client request lifecycle.
 */
export interface CompletedFields {
  /** Unique gateway request identifier. */
  readonly aptusRequestId: string;
  /** Ingress protocol spoken by the client. */
  readonly endpointProtocol: Protocol;
  /** Upstream target protocol reached, or "unknown" if terminated before dispatch. */
  readonly targetProtocol: Protocol | "unknown";
  /** Upstream provider used, or "none" if terminated before provider selection. */
  readonly provider: string;
  /** Canonical public model name requested. */
  readonly canonicalPublicName: string;
  /** High-level terminal outcome category. */
  readonly outcomeCategory: "complete" | "failed" | "cancelled";
  /** Final HTTP response status code sent to the client. */
  readonly status: number;
  /** Total number of upstream dispatch attempts made. */
  readonly attempts: number;
  /** Whether the client requested streaming responses. */
  readonly stream: boolean;
  /** Total end-to-end request duration in milliseconds. */
  readonly durationMs: number;
  /** Time from ingress admission to first response byte sent, if observed. */
  readonly firstByteMs?: number;
  /** Parsed token usage statistics, if reported by the provider. */
  readonly usage?: JsonValue;
  /** Estimated request cost in USD formatted string, if pricing was calculated. */
  readonly estimatedCostUsd?: string;
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
 * Creates a lifecycle observer combining canonical events and named telemetry helpers.
 *
 * All recording methods are synchronous and safe against exceptions, ensuring telemetry
 * failures never interrupt live request execution.
 *
 * @param options - Logger, metrics registry, and channel enablement configuration.
 * @returns Combined {@link LifecycleObserver} and {@link GatewayObservability} instance.
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
 * Records accepted-request HTTP metrics including count, duration, and time-to-first-byte.
 *
 * @param fields - Terminal completed fields for the request.
 * @param metricsEnabled - Whether metric emission is enabled.
 * @param metrics - Metrics registry to update.
 */
function recordHttpTerminal(fields: CompletedFields, metricsEnabled: boolean, metrics: MetricsRegistry): void {
  // The endpoint label is derived from the client protocol because the
  // metrics domain is endpoint-shaped; the mapping matches the three create
  // endpoints defined in the client app.
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
