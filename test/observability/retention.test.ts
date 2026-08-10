import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createLifecycleObserver } from "../../src/observability/lifecycle-observer.ts";
import { aptusLogger } from "../../src/observability/logging.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";
import { createTraceRetention } from "../../src/observability/trace/retention.ts";
import { startRetentionScheduler } from "../../src/observability/trace/scheduler.ts";

function createDirWithTerminal(root: string, dirName: string, sizeBytes = 100, terminal = true): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "000_manifest.json"), "a".repeat(sizeBytes));
  if (terminal) {
    writeFileSync(join(dir, "999_terminal.json"), JSON.stringify({ kind: "complete", status: 200 }));
  }
  return dir;
}

test.concurrent("retention pass deletes traces exceeding maxAgeMs and preserves younger traces", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-retention-age-"));
  const nowMs = new Date("2026-08-17T12:00:00.000Z").getTime();

  // 10 days old trace (maxAge = 7 days)
  createDirWithTerminal(root, "2026-08-07T12-00-00.000+0000_11111111-1111-4111-8111-111111111111");
  // 2 days old trace
  createDirWithTerminal(root, "2026-08-15T12-00-00.000+0000_22222222-2222-4222-8222-222222222222");
  // Incomplete 10 days old trace (no 999_terminal.json)
  createDirWithTerminal(root, "2026-08-07T12-00-00.000+0000_33333333-3333-4333-8333-333333333333", 50, false);

  const deletedReasons: Array<"age" | "size"> = [];
  const retention = createTraceRetention({
    root,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    maxBytes: 10 * 1024 * 1024, // 10 MiB
    onDeleted: (reason) => {
      deletedReasons.push(reason);
    },
  });

  const summary = await retention.run(nowMs);

  assert.equal(summary.deletedForAge, 1);
  assert.equal(summary.deletedForSize, 0);
  assert.equal(summary.incompleteBytes > 0, true);
  assert.deepEqual(deletedReasons, ["age"]);

  const remaining = readdirSync(root);
  assert.ok(!remaining.includes("2026-08-07T12-00-00.000+0000_11111111-1111-4111-8111-111111111111"));
  assert.ok(remaining.includes("2026-08-15T12-00-00.000+0000_22222222-2222-4222-8222-222222222222"));
  assert.ok(remaining.includes("2026-08-07T12-00-00.000+0000_33333333-3333-4333-8333-333333333333"));
});

test.concurrent("retention pass prunes oldest completed traces when total size exceeds maxBytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-retention-size-"));
  const nowMs = new Date("2026-08-17T12:00:00.000Z").getTime();

  // 3 completed traces of ~1000 bytes each
  createDirWithTerminal(root, "2026-08-17T08-00-00.000+0000_11111111-1111-4111-8111-111111111111", 1000);
  createDirWithTerminal(root, "2026-08-17T09-00-00.000+0000_22222222-2222-4222-8222-222222222222", 1000);
  createDirWithTerminal(root, "2026-08-17T10-00-00.000+0000_33333333-3333-4333-8333-333333333333", 1000);

  const retention = createTraceRetention({
    root,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    maxBytes: 1500, // Only enough space for 1 trace
  });

  const summary = await retention.run(nowMs);

  // Oldest 2 traces should be deleted to get total under 1500 bytes
  assert.equal(summary.deletedForSize, 2);
  const remaining = readdirSync(root);
  assert.ok(!remaining.includes("2026-08-17T08-00-00.000+0000_11111111-1111-4111-8111-111111111111"));
  assert.ok(!remaining.includes("2026-08-17T09-00-00.000+0000_22222222-2222-4222-8222-222222222222"));
  assert.ok(remaining.includes("2026-08-17T10-00-00.000+0000_33333333-3333-4333-8333-333333333333"));
});

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.concurrent("retention scheduler executes periodic passes and stops cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-scheduler-"));
  createDirWithTerminal(root, "2026-08-01T00-00-00.000+0000_11111111-1111-4111-8111-111111111111");

  const retention = createTraceRetention({
    root,
    maxAgeMs: 1000,
    maxBytes: 100000,
  });

  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics: createMetricsRegistry(),
    loggingEnabled: false,
    metricsEnabled: false,
  });

  let degraded = false;
  const scheduler = startRetentionScheduler({
    retention,
    observer,
    intervalMs: 10,
    onFailure: () => {
      degraded = true;
    },
  });

  await waitForCondition(() => !readdirSync(root).includes("2026-08-01T00-00-00.000+0000_11111111-1111-4111-8111-111111111111"));
  scheduler.stop();

  assert.equal(degraded, false);
  // Idempotent stop
  scheduler.stop();
});

test.concurrent("failed retention pass emits trace failure with system sentinel, suppresses retention log, and keeps timer alive", async () => {
  const capturedLogs: import("@logtape/logtape").LogRecord[] = [];
  const { configureLogging } = await import("../../src/observability/logging.ts");
  configureLogging({ enabled: true, level: "info" }, (rec) => capturedLogs.push(rec));

  const invalidRoot = join(tmpdir(), "nonexistent-retention-root-" + Math.random());
  const retention = createTraceRetention({
    root: invalidRoot,
    maxAgeMs: 1000,
    maxBytes: 1000,
  });

  // Direct run rejects
  await assert.rejects(async () => {
    await retention.run(Date.now());
  });

  let degradedCount = 0;
  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics: createMetricsRegistry(),
    loggingEnabled: true,
    metricsEnabled: true,
  });

  const scheduler = startRetentionScheduler({
    retention,
    observer,
    intervalMs: 15,
    onFailure: () => {
      degradedCount++;
    },
  });

  await waitForCondition(() => degradedCount >= 2);
  scheduler.stop();

  // Degraded callback called multiple times (timer remained alive)
  assert.ok(degradedCount >= 2, `expected at least 2 degradation callbacks, got ${degradedCount}`);

  // Emitted aptus.trace.failure with system sentinel
  const traceFailures = capturedLogs.filter((r) => r.rawMessage === "aptus.trace.failure");
  assert.ok(traceFailures.length >= 1, "expected aptus.trace.failure log");
  assert.equal(traceFailures[0]?.properties.aptusRequestId, "system");
  assert.equal(traceFailures[0]?.properties.operation, "retention");

  // NEVER emitted aptus.retention.run
  const retentionRuns = capturedLogs.filter((r) => r.rawMessage === "aptus.retention.run");
  assert.equal(retentionRuns.length, 0, "must not emit aptus.retention.run on failure");
});

test.concurrent("scheduler stop() gate immediately blocks subsequent scheduled passes and triggerNow", async () => {
  let runs = 0;
  const mockRetention: import("../../src/domain/operations.ts").TraceRetention = {
    async run() {
      runs++;
      return {
        deletedForAge: 0,
        deletedForSize: 0,
        skipped: 0,
        remainingBytes: 0,
        incompleteBytes: 0,
      };
    },
  };

  const observer = createLifecycleObserver({
    logger: aptusLogger(),
    metrics: createMetricsRegistry(),
    loggingEnabled: false,
    metricsEnabled: false,
  });

  const scheduler = startRetentionScheduler({
    retention: mockRetention,
    observer,
    intervalMs: 10,
    onFailure: () => {},
  });

  scheduler.stop();
  const runsAfterStop = runs;

  // Triggering now after stop does not run
  await scheduler.triggerNow();
  // Yield event loop to ensure stopped timer does not trigger
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runs, runsAfterStop);
});
