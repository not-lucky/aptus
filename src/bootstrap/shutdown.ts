/**
 * @fileoverview Graceful process shutdown coordination.
 *
 * Coordinates orderly server termination when SIGINT or SIGTERM is received: marks the runtime
 * as draining, stops accepting new client connections, drains in-flight requests within a
 * bounded window, awaits terminal telemetry finalization, stops retention schedulers, and
 * closes the operations listener last.
 */

import type { Server } from "../http/listeners.ts";
import type { RequestCancellationRegistry } from "../http/request-cancellation.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import type { TraceRetentionScheduler } from "../observability/trace/scheduler.ts";
import { type Clock, systemClock } from "../routing/timing.ts";

/**
 * Controller coordinating listener drain and forced abort during process shutdown.
 */
export interface GracefulShutdown {
  /**
   * Initiates the graceful shutdown sequence. Safe for concurrent or multiple invocations.
   *
   * @returns Promise that resolves when all listeners and connections have closed.
   */
  run(): Promise<void>;

  /**
   * Forces immediate cancellation of all active requests without waiting for the drain timeout.
   */
  abort(): void;
}

/**
 * Configuration options for the graceful shutdown controller.
 */
export interface GracefulShutdownOptions {
  /** Active client HTTP server instance. */
  readonly client: Server;
  /** Active operations HTTP server instance. */
  readonly operations: Server;
  /** Maximum grace period in milliseconds to allow in-flight requests to complete. */
  readonly drainMs: number;
  /** Process-global shutdown abort controller. */
  readonly shutdownController?: AbortController;
  /** Active retention scheduler instance. */
  readonly retentionScheduler?: TraceRetentionScheduler;
  /** Request cancellation registry for tracking active requests and awaiting finalization. */
  readonly cancellations?: RequestCancellationRegistry;
  /** Observability observer for shutdown logs and metrics. */
  readonly observer?: LifecycleObserver;
  /** Clock source for calculating shutdown duration. */
  readonly clock?: Clock;
  /** Callback triggered immediately upon shutdown initiation to set runtime `draining = true`. */
  readonly onDraining: () => void;
  /** Callback triggered when the drain window expires to abort remaining in-flight requests. */
  readonly onAbortActive: () => void;
  /** Optional callback invoked after all listeners close to release transport resources. */
  readonly onShutdown?: () => Promise<void> | void;
}

/**
 * Creates the graceful shutdown coordinator.
 *
 * Execution stages:
 * 1. Emits `shutdownStarted` log/metric and invokes `onDraining()` to fail health readiness probes.
 * 2. Stops accepting new client connections and closes idle keep-alive sockets.
 * 3. Starts a timer for the `drainMs` grace window.
 * 4. Awaits normal completion of in-flight client requests.
 * 5. If `drainMs` expires or `abort()` is triggered by a second signal, forces request cancellations.
 * 6. Awaits request terminal finalizations to ensure trace manifests are written.
 * 7. Stops trace retention schedulers.
 * 8. Closes the operations listener last, keeping `/health` and `/metrics` scrapable throughout drain.
 * 9. Cleans up background resources (e.g. Undici dispatcher) via `onShutdown()`.
 * 10. Emits `shutdownCompleted` telemetry recording the drained versus aborted request counts.
 *
 * @param options - Shutdown configuration and server handles.
 * @returns A {@link GracefulShutdown} controller.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const clock = options.clock ?? systemClock;
  let force: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    run(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      shutdownPromise = (async () => {
        const startedMs = clock.nowMonotonicMs();
        const initialActiveRequests = options.cancellations?.size() ?? 0;
        // Cumulative registrations at shutdown start, capturing requests admitted in the gap
        // before client.close() completes.
        const totalRegisteredAtStart = options.cancellations?.registeredCount() ?? 0;

        // Step 1: Emit shutdown started and mark runtime as draining
        options.observer?.observe({
          type: "shutdown_started",
          activeRequests: initialActiveRequests,
          drainMs: options.drainMs,
        });
        options.onDraining();

        // Step 2: Stop accepting new client connections and sever idle keep-alives
        const closed = Promise.withResolvers<void>();
        options.client.close(() => closed.resolve());
        options.client.closeIdleConnections();

        let settled = false;
        let abortedCount = 0;
        let timer: NodeJS.Timeout | undefined;
        const finish = (forceAbort: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!forceAbort) return;
          // Capture requests still registered at the moment of forced abort
          abortedCount = options.cancellations?.size() ?? 0;
          options.shutdownController?.abort("shutdown");
          options.onAbortActive();
          options.client.closeAllConnections();
        };

        // Step 3: Timer for maximum drain grace period
        timer = setTimeout(() => finish(true), options.drainMs);
        force = () => finish(true);

        // Step 4: Wait for client server to finish draining
        await closed.promise;
        finish(false);

        // Step 5: Await in-flight request terminal finalizations to settle
        await options.cancellations?.awaitSettled(200);

        // Step 6: Stop retention timer after trace sessions finish and before operations closes
        options.retentionScheduler?.stop();

        // Step 7: Close operations server last
        await closeOperations(options.operations);

        // Step 8: Invoke shutdown cleanup callback
        await options.onShutdown?.();

        // Step 9: Emit shutdown completed telemetry
        const totalRegisteredAtFinish = options.cancellations?.registeredCount() ?? 0;
        const lateAdmitted = Math.max(0, totalRegisteredAtFinish - totalRegisteredAtStart);
        const drainedCount = Math.max(0, initialActiveRequests + lateAdmitted - abortedCount);
        const durationMs = clock.nowMonotonicMs() - startedMs;

        options.observer?.observe({
          type: "shutdown_completed",
          drained: drainedCount,
          aborted: abortedCount,
          durationMs,
        });
      })();
      return shutdownPromise;
    },
    abort(): void {
      force?.();
    },
  };
}

/**
 * Closes the operations HTTP server instance.
 *
 * No-op if the server is not currently listening.
 *
 * @param server - The operations server to close.
 * @returns Promise that resolves when the server closes.
 */
function closeOperations(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeIdleConnections();
  return closed.promise;
}
