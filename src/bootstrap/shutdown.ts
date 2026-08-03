import type { Server } from "../http/listeners.ts";
import type { RequestCancellationRegistry } from "../http/request-cancellation.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import type { TraceRetentionScheduler } from "../observability/trace/scheduler.ts";
import { type Clock, systemClock } from "../routing/timing.ts";

/**
 * Controller interface coordinating listener drain and forced abort during process shutdown.
 */
export interface GracefulShutdown {
  /**
   * Initiates the graceful shutdown sequence.
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
  readonly observer?: GatewayObservability;
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
 * Sequence:
 * 1. Emits `shutdownStarted` log/metric and invokes `onDraining()` to mark runtime draining.
 * 2. Stops accepting new client connections and closes idle keep-alive sockets.
 * 3. Starts a timeout timer for `drainMs` milliseconds.
 * 4. Waits for in-flight requests on the client listener to complete normally.
 * 5. If `drainMs` expires before in-flight requests finish (or the public
 *    `abort()` is invoked via a second signal), records the count of requests
 *    still registered, triggers aborts, and calls `closeAllConnections()`.
 * 6. Awaits in-flight request finalizations (bounded by grace period) to write trace terminals.
 * 7. Stops the retention scheduler.
 * 8. Closes the operations listener last, ensuring health and metrics remain scrapable throughout the drain.
 * 9. Invokes `onShutdown()` to clean up background resources (e.g. Undici dispatcher).
 * 10. Emits `shutdownCompleted` log with the drained/aborted request split.
 *
 * `finish(forceAbort)` is single-fire: whichever of the timer, the second
 * signal, or the natural client-drain path reaches it first wins. The
 * `aborted` count is captured from the cancellation registry at the instant a
 * forced abort fires, *before* the registered requests are aborted (they
 * unregister asynchronously), so the telemetry distinguishes requests that
 * completed within the drain window from requests that were cut off.
 *
 * @param options - Shutdown parameters and server handles.
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
        // Cumulative registrations at shutdown start, so requests admitted in the
        // gap before `client.close()` takes effect are counted in the drained split.
        const totalRegisteredAtStart = options.cancellations?.registeredCount() ?? 0;

        // Step 1: Emit shutdown started and mark runtime as draining so readiness
        // probes fail immediately. The observer already swallows its own errors.
        options.observer?.shutdownStarted({ activeRequests: initialActiveRequests, drainMs: options.drainMs });
        options.onDraining();

        // Step 2: Stop accepting new client connections and sever idle keep-alives.
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
          // Capture the requests still registered at the moment of forced abort
          // (before aborting them) so the drained/aborted split is exact.
          abortedCount = options.cancellations?.size() ?? 0;
          // Force-abort any remaining active requests and forcibly close open sockets.
          options.shutdownController?.abort("shutdown");
          options.onAbortActive();
          options.client.closeAllConnections();
        };
        // Step 3: Set timer for maximum drain grace period. Firing it forces a
        // deadline abort; a natural client drain (`finish(false)`) clears it.
        timer = setTimeout(() => finish(true), options.drainMs);
        force = () => finish(true);

        // Step 4: Wait for client server to finish draining. When every request
        // completed on its own, `closed.promise` resolves and `finish(false)`
        // finalizes the drain without aborting anything (abortedCount stays 0).
        // In the forced-abort path, `closeAllConnections()` itself resolves
        // `closed.promise`, so this second call is a no-op on the settled flag.
        await closed.promise;
        finish(false);

        // Step 5: Await in-flight request terminal finalizations to settle.
        await options.cancellations?.awaitSettled(200);

        // Step 6: Stop retention timer after Trace sessions finish and before operations closes.
        options.retentionScheduler?.stop();

        // Step 7: Close operations server last.
        await closeOperations(options.operations);

        // Step 8: Invoke shutdown cleanup callback.
        await options.onShutdown?.();

        // Step 9: Emit shutdown completed telemetry. `abortedCount` is already
        // the exact forced-abort count (0 on the natural-drain path). The drained
        // count is every request that was ever active during the shutdown window
        // (initial plus any admitted before the listener stopped accepting) minus
        // the ones cut off by the forced abort.
        const totalRegisteredAtFinish = options.cancellations?.registeredCount() ?? 0;
        const lateAdmitted = Math.max(0, totalRegisteredAtFinish - totalRegisteredAtStart);
        const drainedCount = Math.max(0, initialActiveRequests + lateAdmitted - abortedCount);
        const durationMs = clock.nowMonotonicMs() - startedMs;

        options.observer?.shutdownCompleted({
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
 */
function closeOperations(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeIdleConnections();
  return closed.promise;
}
