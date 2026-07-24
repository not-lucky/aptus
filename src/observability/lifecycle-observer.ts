import type { Logger } from "@logtape/logtape";
import type { JsonValue, LifecycleEvent, LifecycleObserver, Protocol } from "../domain/contracts.js";
import type { IrFailureCategory } from "../domain/operations.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * A bounded provider attempt result: `success`, one of the 13 canonical
 * failure categories, or `client_cancelled`.
 */
export type AttemptResult = "success" | IrFailureCategory | "client_cancelled";

/**
 * Request-scoped telemetry helpers used by the Gateway (and bootstrap) in
 * addition to the canonical {@link LifecycleObserver}.
 *
 * This is the single observability seam into the Gateway. Each helper emits a
 * documented LogTape event and/or updates one Prometheus metric. The Gateway
 * declares a structurally identical local interface so that `routing` never
 * imports `observability`.
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

  /** `aptus.request.completed` log + duration and TTFF histograms. */
  completed(fields: CompletedFields): void;

  /** `aptus.request.cancelled` log. */
  cancelled(fields: { aptusRequestId: string; phase: string; by: string }): void;

  /** Sets `aptus_key_pool_available` for a provider pool. */
  setKeyPoolAvailable(provider: string, targetProtocol: Protocol, count: number): void;

  /** `aptus.trace.failure` log + `aptus_trace_write_failures_total`. */
  traceFailure(fields: { aptusRequestId: string | undefined; operation: string; safeErrorCode: string }): void;
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
  readonly targetProtocol: Protocol;
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
    observe(event: LifecycleEvent): void {
      // The canonical routing events are carried with full context through the
      // named helpers below. `retry_scheduled` and `fallback_selected` are
      // logged here because they carry all of their documented fields.
      switch (event.type) {
        case "retry_scheduled":
          if (loggingEnabled) {
            logger.info("aptus.retry.scheduled", {
              aptusRequestId: event.aptusRequestId,
              attemptNumber: event.attemptNumber,
              category: event.category,
              delayMs: event.delayMs,
            });
          }
          break;
        case "fallback_selected":
          if (loggingEnabled) {
            logger.info("aptus.fallback.selected", {
              aptusRequestId: event.aptusRequestId,
              fromCandidateIndex: event.fromCandidateIndex,
              toCandidateIndex: event.toCandidateIndex,
              category: event.category,
            });
          }
          break;
        default:
          break;
      }
    },

    requestIngress(fields) {
      if (metricsEnabled) metrics.inFlightInc(fields.endpointProtocol, fields.stream);
      if (loggingEnabled) {
        logger.info("aptus.request.ingress", {
          aptusRequestId: fields.aptusRequestId,
          endpointProtocol: fields.endpointProtocol,
          endpoint: fields.endpoint,
          stream: fields.stream,
        });
      }
    },

    requestTerminal(fields) {
      if (metricsEnabled) metrics.inFlightDec(fields.endpointProtocol, fields.stream);
    },

    authResult(fields) {
      if (loggingEnabled) {
        logger.info("aptus.auth.result", {
          aptusRequestId: fields.aptusRequestId,
          scheme: fields.scheme,
          result: fields.result,
        });
      }
    },

    nameResolved(fields) {
      if (loggingEnabled) {
        logger.info("aptus.name.resolved", {
          aptusRequestId: fields.aptusRequestId,
          canonicalPublicName: fields.canonicalPublicName,
          kind: fields.kind,
        });
      }
    },

    candidateSkipped(fields) {
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
    },

    keySelected(fields) {
      if (loggingEnabled) {
        logger.info("aptus.key.selected", {
          aptusRequestId: fields.aptusRequestId,
          attemptNumber: fields.attemptNumber,
          provider: fields.provider,
          keyName: fields.keyName,
          strategy: fields.strategy,
        });
      }
    },

    attemptStarted(fields) {
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
    },

    attemptCompleted(fields) {
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
    },

    firstByte(fields) {
      if (loggingEnabled) {
        logger.info("aptus.response.first_byte", {
          aptusRequestId: fields.aptusRequestId,
          attemptNumber: fields.attemptNumber,
          durationMs: fields.durationMs,
        });
      }
    },

    completed(fields) {
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
      if (metricsEnabled) {
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
    },

    cancelled(fields) {
      if (loggingEnabled) {
        logger.info("aptus.request.cancelled", {
          aptusRequestId: fields.aptusRequestId,
          phase: fields.phase,
          by: fields.by,
        });
      }
    },

    setKeyPoolAvailable(provider, targetProtocol, count) {
      if (metricsEnabled) metrics.keyPoolAvailable(targetProtocol, provider, count);
    },

    traceFailure(fields) {
      if (loggingEnabled) {
        logger.warn("aptus.trace.failure", {
          aptusRequestId: fields.aptusRequestId ?? "",
          operation: fields.operation,
          safeErrorCode: fields.safeErrorCode,
        });
      }
      if (metricsEnabled) metrics.traceWriteFailures(fields.operation);
    },
  };
}
