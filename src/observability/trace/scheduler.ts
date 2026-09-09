/**
 * @fileoverview Periodic background scheduler for trace retention sweeps.
 *
 * Runs retention sweeps on a recurring timer to delete expired and oversized trace
 * directories without blocking request traffic. Handles scheduler lifecycle, enforces
 * non-overlapping passes, and reports sweep metrics and degradation events.
 *
 * Invariants: Passes never run concurrently. Sweep errors are reported to telemetry and
 * trigger the readiness failure hook without throwing uncaught exceptions to the process.
 */

import type { TraceRetention } from "../../domain/operations.ts";
import type { GatewayObservability } from "../lifecycle-observer.ts";
import { safeErrorCode } from "./file-recorder.ts";

/**
 * Handle for controlling the background trace retention scheduler.
 */
export interface TraceRetentionScheduler {
  /**
   * Stops the background retention timer and cancels any scheduled passes.
   */
  stop(): void;

  /**
   * Triggers an immediate retention pass outside the recurring schedule.
   *
   * @returns Promise resolving when the pass completes or is skipped.
   */
  triggerNow(): Promise<void>;
}

/**
 * Configuration options for the trace retention scheduler.
 */
export interface TraceRetentionSchedulerOptions {
  /** Retention engine responsible for scanning and deleting trace directories. */
  readonly retention: TraceRetention;
  /** Telemetry observer for reporting sweep metrics and degradation events. */
  readonly observer: GatewayObservability;
  /** Interval in milliseconds between scheduled retention passes. */
  readonly intervalMs: number;
  /** Callback invoked when a sweep fails, degrading trace readiness. */
  readonly onFailure: () => void;
}

/**
 * Starts the periodic background retention scheduler.
 *
 * Arms an unreferenced interval timer that triggers retention passes every `intervalMs`.
 *
 * @param options - Configuration including retention engine, observer, interval, and failure hook.
 * @returns A {@link TraceRetentionScheduler} handle to control or stop the scheduler.
 */
export function startRetentionScheduler(options: TraceRetentionSchedulerOptions): TraceRetentionScheduler {
  const { retention, observer, intervalMs, onFailure } = options;

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  /**
   * Executes a single retention pass if not currently stopped or running.
   *
   * @returns Promise resolving when the pass execution finishes.
   */
  async function executePass(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const nowMs = Date.now();
      const result = await retention.run(nowMs);
      if (!stopped) {
        observer.retentionRun(result);
      }
    } catch (err) {
      if (!stopped) {
        onFailure();
        observer.traceFailure({
          aptusRequestId: "system",
          operation: "retention",
          safeErrorCode: safeErrorCode(err),
        });
      }
    } finally {
      running = false;
    }
  }

  // Arm the background timer that paces consecutive retention passes.
  timer = setInterval(() => {
    void executePass();
  }, intervalMs);

  // Release the timer hold on the event loop so the scheduler never keeps a drained process alive on its own.
  timer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    async triggerNow() {
      await executePass();
    },
  };
}
