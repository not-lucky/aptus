import assert from "node:assert/strict";
import { test } from "vitest";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";

test.concurrent("metrics registry sanitizes labels to closed domain and records all metrics", async () => {
  const registry = createMetricsRegistry({
    providers: new Set(["chat-provider", "backup-provider"]),
    publicNames: new Set(["gpt-main", "gpt-backup"]),
  });

  // 1. HTTP request metrics & label sanitization
  registry.httpRequest("openai-chat", "chat_completions", "complete", false);
  // Unrecognized protocol and endpoint map to defaults
  registry.httpRequest("unknown-protocol" as any, "unrecognized_endpoint", "failed", true);

  // 2. Histograms
  registry.httpDuration("openai-chat", "openai-chat", "chat-provider", "gpt-main", "complete", false, 0.123);
  registry.httpFirstByte("openai-chat", "openai-chat", "chat-provider", "gpt-main", false, 0.045);

  // 3. Active requests gauge (inFlight)
  registry.inFlightInc("openai-chat", false);
  registry.inFlightDec("openai-chat", false);

  // 4. Provider attempt and duration
  registry.providerAttempt("openai-chat", "chat-provider", "success", false);
  registry.providerAttemptDuration("openai-chat", "chat-provider", "success", false, 0.1);

  // 5. Routing metrics
  registry.retries("openai-chat", "chat-provider", "rate_limit");
  registry.fallbacks("openai-chat", "openai-chat", "gpt-main", "unavailable");
  registry.candidateSkips(
    "openai-chat",
    "anthropic-messages",
    "unknown-candidate",
    "gpt-main",
    "unsupported_capability",
  );

  // 6. Key pool gauge
  registry.keyPoolAvailable("openai-chat", "chat-provider", 3);
  registry.keyPoolAvailable("openai-chat", "rogue-provider", 1); // maps to "unknown"

  // 7. Trace write failure and cleanup metrics
  registry.traceWriteFailures("trace_write");
  registry.traceCleanupDeleted("age");
  registry.traceCleanupDeleted("size");

  // 8. Shutdown active requests gauge
  registry.shutdownActiveRequests(5);

  // 9. Operations requests
  registry.operations("health_ready");
  registry.operations("metrics");

  const rendered = await registry.render();

  // Verify Prometheus metric families are rendered with sanitized bounded labels
  assert.match(
    rendered,
    /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="complete",stream="false"\} 1/,
  );
  assert.match(
    rendered,
    /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="failed",stream="true"\} 1/,
  );
  assert.match(rendered, /aptus_http_request_duration_seconds_bucket/);
  assert.match(rendered, /aptus_http_time_to_first_byte_seconds_bucket/);
  assert.match(rendered, /aptus_in_flight_requests\{endpoint_protocol="openai-chat",stream="false"\} 0/);
  assert.match(
    rendered,
    /aptus_provider_attempts_total\{target_protocol="openai-chat",provider="chat-provider",attempt_result="success",stream="false"\} 1/,
  );
  assert.match(rendered, /aptus_provider_attempt_duration_seconds_bucket/);
  assert.match(
    rendered,
    /aptus_retries_total\{target_protocol="openai-chat",provider="chat-provider",outcome_category="rate_limit"\} 1/,
  );
  assert.match(
    rendered,
    /aptus_fallbacks_total\{endpoint_protocol="openai-chat",target_protocol="openai-chat",public_name="gpt-main",outcome_category="unavailable"\} 1/,
  );
  assert.match(
    rendered,
    /aptus_candidate_skips_total\{endpoint_protocol="openai-chat",target_protocol="anthropic-messages",provider="unknown",public_name="gpt-main",outcome_category="unsupported_capability"\} 1/,
  );
  assert.match(rendered, /aptus_key_pool_available\{target_protocol="openai-chat",provider="chat-provider"\} 3/);
  assert.match(rendered, /aptus_key_pool_available\{target_protocol="openai-chat",provider="unknown"\} 1/);
  assert.match(rendered, /aptus_trace_write_failures_total\{operation="trace_write"\} 1/);
  assert.match(rendered, /aptus_trace_cleanup_deleted_total\{reason="age"\} 1/);
  assert.match(rendered, /aptus_trace_cleanup_deleted_total\{reason="size"\} 1/);
  assert.match(rendered, /aptus_shutdown_active_requests 5/);
  assert.match(rendered, /aptus_operations_requests_total\{endpoint="health_ready"\} 1/);
  assert.match(rendered, /aptus_operations_requests_total\{endpoint="metrics"\} 1/);
});
