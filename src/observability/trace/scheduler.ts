import type { TraceRetention } from "../../domain/operations.ts";
import type { GatewayObservability } from "../lifecycle-observer.ts";
import { safeErrorCode } from "./file-recorder.ts";

/**
 * Handle to a running trace retention scheduler.
 */
export interface TraceRetentionScheduler {
  /**
   * Stops the background retention timer and suppresses future passes.
   */
  stop(): void;

  /**
   * Triggers an immediate retention pass outside the timer.
   */
  triggerNow(): Promise<void>;
}

/**
 * Options for configuring {@link TraceRetentionScheduler}.
 */
export interface TraceRetentionSchedulerOptions {
  /** Trace retention runner implementation. */
  readonly retention: TraceRetention;
  /** Telemetry observer for recording retention results and degradation events. */
  readonly observer: GatewayObservability;
  /** Interval in milliseconds between retention passes. */
  readonly intervalMs: number;
  /** Callback to degrade readiness on retention I/O failure. */
  readonly onFailure: () => void;
}

/**
 * Starts the periodic background retention scheduler.
 *
 * @param options - Retention engine, telemetry observer, interval, and failure hook.
 * @returns A {@link TraceRetentionScheduler} instance.
 */
export function startRetentionScheduler(options: TraceRetentionSchedulerOptions): TraceRetentionScheduler {
  const { retention, observer, intervalMs, onFailure } = options;

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

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

  // Schedule background timer
  timer = setInterval(() => {
    void executePass();
  }, intervalMs);

  // Unref timer so it does not block Node process exit on its own
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
