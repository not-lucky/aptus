import assert from "node:assert/strict";
import type { LogRecord, Sink } from "@logtape/logtape";
import { test } from "vitest";
import type { AptusRequestId } from "../../src/domain/request-id.ts";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { aptusLogger, configureLogging } from "../../src/observability/logging.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";

test("lifecycle observer emits structured LogTape logs and observed metrics", async () => {
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
  observer.requestIngress({
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    endpoint: "/v1/chat/completions",
    stream: false,
  });

  // Auth
  observer.authResult({
    aptusRequestId: reqId,
    scheme: "bearer",
    result: "matched",
  });

  // Resolution
  observer.nameResolved({
    aptusRequestId: reqId,
    canonicalPublicName: "gpt-main",
    kind: "model",
  });

  // Key Selection
  observer.keySelected({
    aptusRequestId: reqId,
    attemptNumber: 1,
    provider: "chat-provider",
    keyName: "key-1",
    strategy: "fill-first",
  });

  // Attempt Started
  observer.attemptStarted({
    aptusRequestId: reqId,
    attemptNumber: 1,
    candidateIndex: 0,
    provider: "chat-provider",
    targetProtocol: "openai-chat",
    stream: false,
  });

  // Retry Scheduled
  observer.retryScheduled({
    aptusRequestId: reqId,
    attemptNumber: 1,
    provider: "chat-provider",
    targetProtocol: "openai-chat",
    category: "rate_limit",
    delayMs: 500,
  });

  // Fallback Selected
  observer.fallbackSelected({
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    publicName: "gpt-main",
    fromCandidateIndex: 0,
    toCandidateIndex: 1,
    category: "unavailable",
  });

  // Candidate Skipped
  observer.candidateSkipped({
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    canonicalPublicName: "gpt-main",
    candidateIndex: 1,
    provider: "anthropic-provider",
    targetProtocol: "anthropic-messages",
    category: "unsupported_capability",
  });

  // Attempt Completed
  observer.attemptCompleted({
    aptusRequestId: reqId,
    attemptNumber: 2,
    targetProtocol: "openai-chat",
    provider: "chat-provider",
    attemptResult: "success",
    status: 200,
    durationMs: 120,
    stream: false,
  });

  // First Byte
  observer.firstByte({
    aptusRequestId: reqId,
    attemptNumber: 2,
    durationMs: 45,
  });

  // Completed / Terminal
  observer.completed({
    aptusRequestId: reqId,
    endpointProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    provider: "chat-provider",
    canonicalPublicName: "gpt-main",
    status: 200,
    attempts: 2,
    stream: false,
    outcomeCategory: "complete",
    durationMs: 150,
  });

  // Background Retention Run with system fallback
  observer.retentionRun({
    deletedForAge: 3,
    deletedForSize: 1,
    skipped: 0,
    remainingBytes: 1024,
    incompleteBytes: 0,
  });

  // Background Shutdown Started and Completed
  observer.shutdownStarted({ activeRequests: 2, drainMs: 5000 });
  observer.shutdownCompleted({ drained: 2, aborted: 0, durationMs: 120 });

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

test("httpTerminal records the accepted-request counter without the completion log", async () => {
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

  observer.httpTerminal({
    aptusRequestId: "req-pre-gateway",
    endpointProtocol: "openai-chat",
    targetProtocol: "unknown",
    provider: "unknown",
    canonicalPublicName: "unknown",
    outcomeCategory: "failed",
    status: 400,
    attempts: 0,
    stream: false,
    durationMs: 12,
  });

  assert.ok(!records.some((r) => r.rawMessage === "aptus.request.completed"));
  const text = await metrics.render();
  assert.match(
    text,
    /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="failed",stream="false"\} 1/,
  );
  assert.match(text, /aptus_http_request_duration_seconds_bucket\{.*target_protocol="unknown"/);
});
