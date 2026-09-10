import assert from "node:assert/strict";
import type { LogRecord, Sink } from "@logtape/logtape";
import { test } from "vitest";
import type { AptusRequestId } from "../../src/domain/request-id.ts";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { aptusLogger, configureLogging } from "../../src/observability/logging.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";

test.concurrent("lifecycle observer emits structured LogTape logs and observed metrics", async () => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => {
    records.push(record);
  };
  configureLogging({ enabled: true, level: "info" }, sink);
  const metrics = createMetricsRegistry();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics,
    loggingEnabled: true,
    metricsEnabled: true,
  });

  const reqId = "req-test-123" as AptusRequestId;

  // Ingress
  observer.observe({
    type: "request_ingress",
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    endpoint: "/v1/chat/completions",
    stream: false,
  });

  // Auth
  observer.observe({
    type: "auth_result",
    aptusRequestId: reqId,
    scheme: "bearer",
    result: "matched",
  });

  // Resolution
  observer.observe({
    type: "name_resolved",
    aptusRequestId: reqId,
    canonicalPublicName: "gpt-main",
    kind: "model",
  });

  // Key Selection
  observer.observe({
    type: "key_selected",
    aptusRequestId: reqId,
    attemptNumber: 1,
    provider: "chat-provider",
    keyName: "key-1",
    strategy: "fill-first",
  });

  // Attempt Started
  observer.observe({
    type: "attempt_started",
    aptusRequestId: reqId,
    attemptNumber: 1,
    candidateIndex: 0,
    provider: "chat-provider",
    targetProtocol: "openai-chat",
    stream: false,
  });

  // Retry Scheduled
  observer.observe({
    type: "retry_scheduled",
    aptusRequestId: reqId,
    attemptNumber: 1,
    provider: "chat-provider",
    targetProtocol: "openai-chat",
    category: "rate_limit",
    delayMs: 500,
  });

  // Fallback Selected
  observer.observe({
    type: "fallback_selected",
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    publicName: "gpt-main",
    fromCandidateIndex: 0,
    toCandidateIndex: 1,
    category: "unavailable",
  });

  // Candidate Skipped
  observer.observe({
    type: "candidate_skipped",
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    canonicalPublicName: "gpt-main",
    candidateIndex: 1,
    provider: "anthropic-provider",
    targetProtocol: "anthropic-messages",
    category: "unsupported_capability",
  });

  // Attempt Completed
  observer.observe({
    type: "attempt_completed",
    aptusRequestId: reqId,
    attemptNumber: 2,
    targetProtocol: "openai-chat",
    provider: "chat-provider",
    attemptResult: "success",
    status: 200,
    durationMs: 120,
    stream: false,
  });

  // Completed / Terminal (completion log plus first-byte timing)
  observer.observe({
    type: "request_terminal",
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    admissionStream: false,
    stream: false,
    result: "complete",
    outcomeCategory: "complete",
    targetProtocol: "openai-chat",
    provider: "chat-provider",
    canonicalPublicName: "gpt-main",
    status: 200,
    attempts: 2,
    durationMs: 150,
    firstByteMs: 45,
    emitCompleted: true,
  });

  // Background Retention Run with system fallback
  observer.observe({
    type: "retention_run",
    deletedForAge: 3,
    deletedForSize: 1,
    skipped: 0,
    remainingBytes: 1024,
    incompleteBytes: 0,
  });

  // Background Shutdown Started and Completed
  observer.observe({ type: "shutdown_started", activeRequests: 2, drainMs: 5000 });
  observer.observe({ type: "shutdown_completed", drained: 2, aborted: 0, durationMs: 120 });

  // Verify LogTape structured messages
  const messageNames = records.map((r) => r.rawMessage);
  assert.ok(messageNames.includes("aptus.request.ingress"));
  assert.ok(messageNames.includes("aptus.auth.result"));
  assert.ok(messageNames.includes("aptus.name.resolved"));
  assert.ok(messageNames.includes("aptus.key.selected"));
  assert.ok(messageNames.includes("aptus.attempt.started"));
  assert.ok(messageNames.includes("aptus.retry.scheduled"));
  assert.ok(messageNames.includes("aptus.fallback.selected"));
  assert.ok(messageNames.includes("aptus.candidate.skipped"));
  assert.ok(messageNames.includes("aptus.dispatch.completed"));
  assert.ok(messageNames.includes("aptus.response.first_byte"));
  assert.ok(messageNames.includes("aptus.request.completed"));
  assert.ok(messageNames.includes("aptus.retention.run"));
  assert.ok(messageNames.includes("aptus.shutdown.started"));
  assert.ok(messageNames.includes("aptus.shutdown.completed"));

  // Background retention/shutdown events carry only their documented fields.
  const retentionRecord = records.find((r) => r.rawMessage === "aptus.retention.run");
  assert.ok(retentionRecord);
  assert.equal(retentionRecord?.properties.deletedForAge, 3);
  assert.equal(retentionRecord?.properties.aptusRequestId, undefined);
  const shutdownRecord = records.find((r) => r.rawMessage === "aptus.shutdown.started");
  assert.ok(shutdownRecord);
  assert.equal(shutdownRecord?.properties.aptusRequestId, undefined);
});

test.concurrent("request_terminal without emitCompleted records the accepted-request counter without the completion log", async () => {
  const records: LogRecord[] = [];
  configureLogging({ enabled: true, level: "info" }, (record) => {
    records.push(record);
  });
  const metrics = createMetricsRegistry();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics,
    loggingEnabled: true,
    metricsEnabled: true,
  });

  observer.observe({
    type: "request_terminal",
    aptusRequestId: "req-pre-gateway",
    endpointProtocol: "openai-chat",
    admissionStream: false,
    stream: false,
    result: "failed",
    outcomeCategory: "failed",
    targetProtocol: "unknown",
    provider: "unknown",
    canonicalPublicName: "unknown",
    status: 400,
    attempts: 0,
    durationMs: 12,
    emitCompleted: false,
  });

  assert.ok(!records.some((r) => r.rawMessage === "aptus.request.completed"));
  const text = await metrics.render();
  assert.match(
    text,
    /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="failed",stream="false"\} 1/,
  );
  assert.match(text, /aptus_http_request_duration_seconds_bucket\{.*target_protocol="unknown"/);
});
