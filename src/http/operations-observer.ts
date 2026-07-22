/**
 * Discrete operations endpoints monitored by the internal metrics recorder.
 */
export type OperationsEndpoint = "metrics" | "health_live" | "health_ready";

/**
 * Operations observer interface for tracking operations listener request counts and rendering Prometheus metric text.
 */
export interface OperationsObserver {
  /**
   * Increments the request counter for an operations endpoint.
   *
   * @param endpoint - The accessed operations endpoint.
   */
  observe(endpoint: OperationsEndpoint): void;

  /**
   * Serializes current endpoint counters into Prometheus text exposition format (version 0.0.4).
   *
   * @returns Formatted Prometheus plain-text string.
   */
  renderMetrics(): string;
}

/**
 * Instantiates an in-memory operations observer for recording operations listener request counts.
 *
 * @returns An {@link OperationsObserver} instance.
 */
export function createOperationsObserver(): OperationsObserver {
  const counts: Record<OperationsEndpoint, number> = { metrics: 0, health_live: 0, health_ready: 0 };
  return {
    observe(endpoint) {
      counts[endpoint]++;
    },
    renderMetrics() {
      // Format Prometheus counter metric block with HELP and TYPE descriptors.
      return [
        "# HELP aptus_operations_requests_total Operations listener requests by bounded endpoint.",
        "# TYPE aptus_operations_requests_total counter",
        ...Object.entries(counts).map(
          ([endpoint, count]) => `aptus_operations_requests_total{endpoint="${endpoint}"} ${count}`,
        ),
        "",
      ].join("\n");
    },
  };
}
