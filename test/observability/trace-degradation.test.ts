import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord, Sink } from "@logtape/logtape";
import { test } from "vitest";
import { createRequestId } from "../../src/domain/request-id.js";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.js";
import { aptusLogger, configureLogging } from "../../src/observability/logging.js";
import { createMetricsRegistry } from "../../src/observability/metrics.js";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.js";

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
    onFailure: (safeErrorCode) => {
      ready = false;
      observer.traceFailure({ aptusRequestId: "req-degrade", operation: "trace_write", safeErrorCode });
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
  const text = await metrics.render();
  assert.match(text, /aptus_trace_write_failures_total\{operation="trace_write"\} 1/);
});
