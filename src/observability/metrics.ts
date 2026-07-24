import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Shared duration histogram boundaries for request, attempt, and TTFF timing
 * (seconds).
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

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

  /** Sets the available enabled keys gauge for a provider pool. */
  keyPoolAvailable(targetProtocol: string, provider: string, count: number): void;

  /** Records a runtime trace write failure. */
  traceWriteFailures(operation: string): void;

  /** Records an operations-listener request. */
  operations(endpoint: string): void;
}

/**
 * Creates the single Prometheus metrics registry.
 *
 * Every metric name, help text, label set, and bucket boundary follows
 * operational metric specifications.
 *
 * @returns A {@link MetricsRegistry} instance.
 */
export function createMetricsRegistry(): MetricsRegistry {
  const registry = new Registry();

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
        endpoint_protocol: endpointProtocol,
        endpoint,
        outcome_category: outcomeCategory,
        stream: streamLabel(stream),
      });
    },
    httpDuration(endpointProtocol, targetProtocol, provider, publicName, outcomeCategory, stream, seconds) {
      httpDuration.observe(
        {
          endpoint_protocol: endpointProtocol,
          target_protocol: targetProtocol,
          provider,
          public_name: publicName,
          outcome_category: outcomeCategory,
          stream: streamLabel(stream),
        },
        seconds,
      );
    },
    httpFirstByte(endpointProtocol, targetProtocol, provider, publicName, stream, seconds) {
      httpFirstByte.observe(
        {
          endpoint_protocol: endpointProtocol,
          target_protocol: targetProtocol,
          provider,
          public_name: publicName,
          stream: streamLabel(stream),
        },
        seconds,
      );
    },
    inFlightInc(endpointProtocol, stream) {
      inFlight.inc({ endpoint_protocol: endpointProtocol, stream: streamLabel(stream) });
    },
    inFlightDec(endpointProtocol, stream) {
      inFlight.dec({ endpoint_protocol: endpointProtocol, stream: streamLabel(stream) });
    },
    providerAttempt(targetProtocol, provider, attemptResult, stream) {
      providerAttempts.inc({
        target_protocol: targetProtocol,
        provider,
        attempt_result: attemptResult,
        stream: streamLabel(stream),
      });
    },
    providerAttemptDuration(targetProtocol, provider, attemptResult, stream, seconds) {
      providerAttemptDuration.observe(
        { target_protocol: targetProtocol, provider, attempt_result: attemptResult, stream: streamLabel(stream) },
        seconds,
      );
    },
    candidateSkips(endpointProtocol, targetProtocol, provider, publicName, outcomeCategory) {
      candidateSkipCounter.inc({
        endpoint_protocol: endpointProtocol,
        target_protocol: targetProtocol,
        provider,
        public_name: publicName,
        outcome_category: outcomeCategory,
      });
    },
    keyPoolAvailable(targetProtocol, provider, count) {
      keyPoolAvailableGauge.set({ target_protocol: targetProtocol, provider }, count);
    },
    traceWriteFailures(operation) {
      traceWriteFailureCounter.inc({ operation });
    },
    operations(endpoint) {
      operationsRequests.inc({ endpoint });
    },
  };
}
