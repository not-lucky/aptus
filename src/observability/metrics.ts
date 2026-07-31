import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Shared duration histogram boundaries for request, attempt, and TTFF timing
 * (seconds).
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

/** Valid protocol identifiers. */
const VALID_PROTOCOLS: ReadonlySet<string> = new Set(["openai-chat", "openai-responses", "anthropic-messages"]);

/** Valid target protocol metric labels (protocols plus "unknown"). */
const VALID_TARGET_PROTOCOLS: ReadonlySet<string> = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "unknown",
]);

/** Valid HTTP endpoint metric labels. */
const VALID_HTTP_ENDPOINTS: ReadonlySet<string> = new Set(["chat_completions", "responses", "messages", "models"]);

/** Valid HTTP outcome categories. */
const VALID_HTTP_OUTCOMES: ReadonlySet<string> = new Set(["complete", "failed", "cancelled"]);

/** The canonical 13 failure categories. */
const VALID_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "invalid_request",
  "authentication",
  "permission",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limit",
  "quota",
  "timeout",
  "unavailable",
  "provider",
  "unsupported_capability",
  "stream_interrupted",
]);

/** Valid attempt results ("success", 13 categories, "client_cancelled"). */
const VALID_ATTEMPT_RESULTS: ReadonlySet<string> = new Set([
  ...VALID_FAILURE_CATEGORIES,
  "success",
  "client_cancelled",
]);

/** Valid retention cleanup reasons. */
const VALID_CLEANUP_REASONS: ReadonlySet<string> = new Set(["age", "size"]);

/** Valid trace failure operations. */
const VALID_TRACE_OPERATIONS: ReadonlySet<string> = new Set([
  "trace_start",
  "trace_write",
  "trace_finish",
  "retention",
]);

/** Valid operations listener endpoints. */
const VALID_OPERATIONS_ENDPOINTS: ReadonlySet<string> = new Set(["metrics", "health_live", "health_ready"]);

/**
 * Options for configuring bounded metric label validation domains.
 */
export interface MetricsRegistryOptions {
  /** Configured provider names for bounded label validation. */
  readonly providers?: ReadonlySet<string>;
  /** Configured canonical public model/route names for bounded label validation. */
  readonly publicNames?: ReadonlySet<string>;
}

/**
 * The single process-local Prometheus registry surface.
 *
 * Each method records one bounded metric with its documented labels. Values are
 * always drawn from the finite label sets; request IDs, keys, model IDs, and
 * URLs are never labels.
 */
export interface MetricsRegistry {
  /** Serializes all metrics into Prometheus text exposition format. */
  render(): Promise<string>;

  /** Records an accepted/rejected/completed HTTP client request. */
  httpRequest(endpointProtocol: string, endpoint: string, outcomeCategory: string, stream: boolean): void;

  /** Records end-to-end accepted request duration in seconds. */
  httpDuration(
    endpointProtocol: string,
    targetProtocol: string,
    provider: string,
    publicName: string,
    outcomeCategory: string,
    stream: boolean,
    seconds: number,
  ): void;

  /** Records time from accepted ingress to first client byte in seconds. */
  httpFirstByte(
    endpointProtocol: string,
    targetProtocol: string,
    provider: string,
    publicName: string,
    stream: boolean,
    seconds: number,
  ): void;

  /** Increments the in-flight request gauge. */
  inFlightInc(endpointProtocol: string, stream: boolean): void;

  /** Decrements the in-flight request gauge. */
  inFlightDec(endpointProtocol: string, stream: boolean): void;

  /** Records one provider attempt by bounded result. */
  providerAttempt(targetProtocol: string, provider: string, attemptResult: string, stream: boolean): void;

  /** Records one provider attempt duration in seconds. */
  providerAttemptDuration(
    targetProtocol: string,
    provider: string,
    attemptResult: string,
    stream: boolean,
    seconds: number,
  ): void;

  /** Records one candidate preflight skip (zero dispatch). */
  candidateSkips(
    endpointProtocol: string,
    targetProtocol: string,
    provider: string,
    publicName: string,
    outcomeCategory: string,
  ): void;

  /** Records one scheduled same-candidate retry. */
  retries(targetProtocol: string, provider: string, outcomeCategory: string): void;

  /** Records one route transition to a next candidate. */
  fallbacks(endpointProtocol: string, targetProtocol: string, publicName: string, outcomeCategory: string): void;

  /** Sets the available enabled keys gauge for a provider pool. */
  keyPoolAvailable(targetProtocol: string, provider: string, count: number): void;

  /** Records a runtime trace write failure. */
  traceWriteFailures(operation: string): void;

  /** Records completed trace directories deleted during retention pass. */
  traceCleanupDeleted(reason: string): void;

  /** Sets the count of requests active during shutdown drain. */
  shutdownActiveRequests(count: number): void;

  /** Records an operations-listener request. */
  operations(endpoint: string): void;
}

/**
 * Creates the single Prometheus metrics registry.
 *
 * Every metric name, help text, label set, and bucket boundary follows
 * operational metric specifications.
 *
 * @param options - Optional finite configured provider and public name domains.
 * @returns A {@link MetricsRegistry} instance.
 */
export function createMetricsRegistry(options?: MetricsRegistryOptions): MetricsRegistry {
  const registry = new Registry();

  const validProviders = options?.providers;
  const validPublicNames = options?.publicNames;

  const sanitizeProtocol = (val: string): string => (VALID_PROTOCOLS.has(val) ? val : "openai-chat");

  const sanitizeTargetProtocol = (val: string): string => (VALID_TARGET_PROTOCOLS.has(val) ? val : "unknown");

  const sanitizeEndpoint = (val: string): string => (VALID_HTTP_ENDPOINTS.has(val) ? val : "chat_completions");

  const sanitizeHttpOutcome = (val: string): string => (VALID_HTTP_OUTCOMES.has(val) ? val : "failed");

  const sanitizeFailureCategory = (val: string): string => (VALID_FAILURE_CATEGORIES.has(val) ? val : "provider");

  const sanitizeAttemptResult = (val: string): string => (VALID_ATTEMPT_RESULTS.has(val) ? val : "provider");

  const sanitizeProvider = (val: string): string =>
    validProviders !== undefined ? (validProviders.has(val) ? val : "unknown") : val || "unknown";

  const sanitizePublicName = (val: string): string =>
    validPublicNames !== undefined ? (validPublicNames.has(val) ? val : "unknown") : val || "unknown";

  const sanitizeCleanupReason = (val: string): string => (VALID_CLEANUP_REASONS.has(val) ? val : "age");

  const sanitizeTraceOperation = (val: string): string => (VALID_TRACE_OPERATIONS.has(val) ? val : "trace_write");

  const sanitizeOperationsEndpoint = (val: string): string => {
    if (val === "/health" || val === "/health/ready" || val === "health") return "health_ready";
    if (val === "/health/live") return "health_live";
    if (val === "/metrics") return "metrics";
    return VALID_OPERATIONS_ENDPOINTS.has(val) ? val : "health_ready";
  };

  const httpRequests = new Counter({
    name: "aptus_http_requests_total",
    help: "Accepted Aptus HTTP requests.",
    labelNames: ["endpoint_protocol", "endpoint", "outcome_category", "stream"],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "aptus_http_request_duration_seconds",
    help: "End-to-end accepted request duration.",
    labelNames: ["endpoint_protocol", "target_protocol", "provider", "public_name", "outcome_category", "stream"],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  const httpFirstByte = new Histogram({
    name: "aptus_http_time_to_first_byte_seconds",
    help: "Time from accepted ingress to first client response byte.",
    labelNames: ["endpoint_protocol", "target_protocol", "provider", "public_name", "stream"],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: "aptus_in_flight_requests",
    help: "Current accepted client requests in this process.",
    labelNames: ["endpoint_protocol", "stream"],
    registers: [registry],
  });
  const providerAttempts = new Counter({
    name: "aptus_provider_attempts_total",
    help: "Provider Attempts by bounded result.",
    labelNames: ["target_protocol", "provider", "attempt_result", "stream"],
    registers: [registry],
  });
  const providerAttemptDuration = new Histogram({
    name: "aptus_provider_attempt_duration_seconds",
    help: "Provider Attempt time through response head or failure.",
    labelNames: ["target_protocol", "provider", "attempt_result", "stream"],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  const candidateSkipCounter = new Counter({
    name: "aptus_candidate_skips_total",
    help: "Candidate Preflight skips with zero dispatch.",
    labelNames: ["endpoint_protocol", "target_protocol", "provider", "public_name", "outcome_category"],
    registers: [registry],
  });
  const retriesCounter = new Counter({
    name: "aptus_retries_total",
    help: "Scheduled same-Candidate retries.",
    labelNames: ["target_protocol", "provider", "outcome_category"],
    registers: [registry],
  });
  const fallbacksCounter = new Counter({
    name: "aptus_fallbacks_total",
    help: "Route transitions to a next Candidate.",
    labelNames: ["endpoint_protocol", "target_protocol", "public_name", "outcome_category"],
    registers: [registry],
  });
  const keyPoolAvailableGauge = new Gauge({
    name: "aptus_key_pool_available",
    help: "Available enabled keys in a provider Key Pool.",
    labelNames: ["target_protocol", "provider"],
    registers: [registry],
  });
  const traceWriteFailureCounter = new Counter({
    name: "aptus_trace_write_failures_total",
    help: "Runtime Trace write failures.",
    labelNames: ["operation"],
    registers: [registry],
  });
  const traceCleanupDeletedCounter = new Counter({
    name: "aptus_trace_cleanup_deleted_total",
    help: "Completed Trace directories deleted by retention.",
    labelNames: ["reason"],
    registers: [registry],
  });
  const shutdownActiveRequestsGauge = new Gauge({
    name: "aptus_shutdown_active_requests",
    help: "Requests still active during shutdown.",
    labelNames: [],
    registers: [registry],
  });
  const operationsRequests = new Counter({
    name: "aptus_operations_requests_total",
    help: "Operations listener requests by bounded endpoint.",
    labelNames: ["endpoint"],
    registers: [registry],
  });

  const streamLabel = (stream: boolean): string => String(stream);

  return {
    render: () => registry.metrics(),

    httpRequest(endpointProtocol, endpoint, outcomeCategory, stream) {
      httpRequests.inc({
        endpoint_protocol: sanitizeProtocol(endpointProtocol),
        endpoint: sanitizeEndpoint(endpoint),
        outcome_category: sanitizeHttpOutcome(outcomeCategory),
        stream: streamLabel(stream),
      });
    },
    httpDuration(endpointProtocol, targetProtocol, provider, publicName, outcomeCategory, stream, seconds) {
      httpDuration.observe(
        {
          endpoint_protocol: sanitizeProtocol(endpointProtocol),
          target_protocol: sanitizeTargetProtocol(targetProtocol),
          provider: sanitizeProvider(provider),
          public_name: sanitizePublicName(publicName),
          outcome_category: sanitizeHttpOutcome(outcomeCategory),
          stream: streamLabel(stream),
        },
        seconds,
      );
    },
    httpFirstByte(endpointProtocol, targetProtocol, provider, publicName, stream, seconds) {
      httpFirstByte.observe(
        {
          endpoint_protocol: sanitizeProtocol(endpointProtocol),
          target_protocol: sanitizeTargetProtocol(targetProtocol),
          provider: sanitizeProvider(provider),
          public_name: sanitizePublicName(publicName),
          stream: streamLabel(stream),
        },
        seconds,
      );
    },
    inFlightInc(endpointProtocol, stream) {
      inFlight.inc({ endpoint_protocol: sanitizeProtocol(endpointProtocol), stream: streamLabel(stream) });
    },
    inFlightDec(endpointProtocol, stream) {
      inFlight.dec({ endpoint_protocol: sanitizeProtocol(endpointProtocol), stream: streamLabel(stream) });
    },
    providerAttempt(targetProtocol, provider, attemptResult, stream) {
      providerAttempts.inc({
        target_protocol: sanitizeTargetProtocol(targetProtocol),
        provider: sanitizeProvider(provider),
        attempt_result: sanitizeAttemptResult(attemptResult),
        stream: streamLabel(stream),
      });
    },
    providerAttemptDuration(targetProtocol, provider, attemptResult, stream, seconds) {
      providerAttemptDuration.observe(
        {
          target_protocol: sanitizeTargetProtocol(targetProtocol),
          provider: sanitizeProvider(provider),
          attempt_result: sanitizeAttemptResult(attemptResult),
          stream: streamLabel(stream),
        },
        seconds,
      );
    },
    candidateSkips(endpointProtocol, targetProtocol, provider, publicName, outcomeCategory) {
      candidateSkipCounter.inc({
        endpoint_protocol: sanitizeProtocol(endpointProtocol),
        target_protocol: sanitizeTargetProtocol(targetProtocol),
        provider: sanitizeProvider(provider),
        public_name: sanitizePublicName(publicName),
        outcome_category: sanitizeFailureCategory(outcomeCategory),
      });
    },
    retries(targetProtocol, provider, outcomeCategory) {
      retriesCounter.inc({
        target_protocol: sanitizeTargetProtocol(targetProtocol),
        provider: sanitizeProvider(provider),
        outcome_category: sanitizeFailureCategory(outcomeCategory),
      });
    },
    fallbacks(endpointProtocol, targetProtocol, publicName, outcomeCategory) {
      fallbacksCounter.inc({
        endpoint_protocol: sanitizeProtocol(endpointProtocol),
        target_protocol: sanitizeTargetProtocol(targetProtocol),
        public_name: sanitizePublicName(publicName),
        outcome_category: sanitizeFailureCategory(outcomeCategory),
      });
    },
    keyPoolAvailable(targetProtocol, provider, count) {
      keyPoolAvailableGauge.set(
        { target_protocol: sanitizeTargetProtocol(targetProtocol), provider: sanitizeProvider(provider) },
        count,
      );
    },
    traceWriteFailures(operation) {
      traceWriteFailureCounter.inc({ operation: sanitizeTraceOperation(operation) });
    },
    traceCleanupDeleted(reason) {
      traceCleanupDeletedCounter.inc({ reason: sanitizeCleanupReason(reason) });
    },
    shutdownActiveRequests(count) {
      shutdownActiveRequestsGauge.set(count);
    },
    operations(endpoint) {
      operationsRequests.inc({ endpoint: sanitizeOperationsEndpoint(endpoint) });
    },
  };
}
