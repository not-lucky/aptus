import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord, Sink } from "@logtape/logtape";
import { test } from "vitest";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { aptusLogger, configureLogging } from "../../src/observability/logging.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.ts";

test("runtime trace write failure degrades readiness without failing traffic", async () => {
  const captured: LogRecord[] = [];
  const sink: Sink = (record) => {
    captured.push(record);
  };
  configureLogging({ enabled: true, level: "info" }, sink);
  const metrics = createMetricsRegistry();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics,
    loggingEnabled: true,
    metricsEnabled: true,
  });

  // A regular file blocks the trace root so every write fails deterministically.
  const blocker = join(mkdtempSync(join(tmpdir(), "aptus-trace-degrade-")), "blocker");
  writeFileSync(blocker, "occupied\n");
  const root = join(blocker, "traces");

  let ready = true;
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set<string>(),
    onFailure: (operation, safeErrorCode, aptusRequestId) => {
      observer.traceFailure({ aptusRequestId, operation, safeErrorCode });
    },
    onDegrade: () => {
      ready = false;
    },
    onRecover: () => {
      ready = true;
    },
  });

  // start() must not throw; subsequent writes are silently degraded.
  const requestId = createRequestId();
  const session = await recorder.start({
    aptusRequestId: requestId,
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session.recordJson("client_request", { ok: true });
  await session.finish({ kind: "complete", status: 200 });

  assert.equal(ready, false);
  assert.ok(
    captured.some((record) => record.rawMessage === "aptus.trace.failure"),
    `expected aptus.trace.failure log, got ${JSON.stringify(captured.map((r) => r.rawMessage))}`,
  );
  const failureRecord = captured.find((record) => record.rawMessage === "aptus.trace.failure");
  assert.equal(failureRecord?.properties.aptusRequestId, requestId, "request-scoped failure carries the request ID");
  const text = await metrics.render();
  assert.match(text, /aptus_trace_write_failures_total\{operation="trace_start"\} 1/);
});

test("a later successful write restores readiness after degradation", async () => {
  const metrics = createMetricsRegistry();
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics,
    loggingEnabled: false,
    metricsEnabled: false,
  });

  const baseDir = mkdtempSync(join(tmpdir(), "aptus-trace-recover-"));
  // Valid trace root directory
  const root = join(baseDir, "traces");

  let ready = true;
  let degradeCalls = 0;
  let recoverCalls = 0;

  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set<string>(),
    onFailure: (operation, safeErrorCode, aptusRequestId) => {
      observer.traceFailure({ aptusRequestId, operation, safeErrorCode });
    },
    onDegrade: () => {
      ready = false;
      degradeCalls++;
    },
    onRecover: () => {
      ready = true;
      recoverCalls++;
    },
  });

  // 1. Initial successful session starts and records cleanly
  const session1 = await recorder.start({
    aptusRequestId: createRequestId(),
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session1.recordJson("client_request", { step: 1 });
  assert.equal(ready, true);
  assert.equal(degradeCalls, 0);

  // 2. Create a session pointing to an unwritable directory to force degradation
  const blockedRecorder = createFileTraceRecorder({
    root: join(baseDir, "nonexistent-file-blocked", "nested"),
    secrets: new Set<string>(),
    onFailure: () => {},
    onDegrade: () => {
      ready = false;
      degradeCalls++;
    },
    onRecover: () => {
      ready = true;
      recoverCalls++;
    },
  });

  // We write a file where the directory needs to be
  writeFileSync(join(baseDir, "nonexistent-file-blocked"), "blocked");
  const failedSession = await blockedRecorder.start({
    aptusRequestId: createRequestId(),
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await failedSession.recordJson("client_request", { fail: true });
  assert.equal(ready, false);
  assert.equal(degradeCalls, 1);

  // 3. Subsequent successful write on valid recorder restores readiness
  const session2 = await recorder.start({
    aptusRequestId: createRequestId(),
    startedAtLocal: "2026-08-15T01-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session2.recordJson("client_request", { recover: true });
  await session2.finish({ kind: "complete", status: 200 });

  // On successful write, onRecover was called
  // Let's test on the same recorder instance that degraded:
  let singleReady = true;
  let singleDegrades = 0;
  let singleRecovers = 0;

  const dynamicRoot = join(baseDir, "dynamic-traces");
  const dynamicRecorder = createFileTraceRecorder({
    root: dynamicRoot,
    secrets: new Set<string>(),
    onFailure: () => {},
    onDegrade: () => {
      singleReady = false;
      singleDegrades++;
    },
    onRecover: () => {
      singleReady = true;
      singleRecovers++;
    },
  });

  // Force a degradation by simulating a write failure on session
  // Create a blocker file preventing a session dir creation
  writeFileSync(dynamicRoot, "not-a-dir");
  await dynamicRecorder.start({
    aptusRequestId: createRequestId(),
    startedAtLocal: "2026-08-15T02-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  assert.equal(singleReady, false);
  assert.equal(singleDegrades, 1);
  assert.equal(singleRecovers, 0);

  // Remove the blocker file and create a real directory
  const { unlinkSync, mkdirSync } = await import("node:fs");
  unlinkSync(dynamicRoot);
  mkdirSync(dynamicRoot, { recursive: true });

  // Now a subsequent write on the same degraded dynamicRecorder succeeds and restores readiness!
  const recoverSess = await dynamicRecorder.start({
    aptusRequestId: createRequestId(),
    startedAtLocal: "2026-08-15T03-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await recoverSess.recordJson("client_request", { restored: true });

  assert.equal(singleReady, true);
  assert.equal(singleDegrades, 1);
  assert.equal(singleRecovers, 1);
});
