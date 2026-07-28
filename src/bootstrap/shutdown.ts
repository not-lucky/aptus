import type { Server } from "../http/listeners.ts";

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
 * 1. Invokes `onDraining()` to mark the process draining (causing `/health/ready` to return 503).
 * 2. Stops accepting new client connections and closes idle keep-alive sockets.
 * 3. Starts a timeout timer for `drainMs` milliseconds.
 * 4. Waits for in-flight requests on the client listener to complete normally.
 * 5. If `drainMs` expires before in-flight requests finish, triggers `onAbortActive()` and `closeAllConnections()`.
 * 6. Closes the operations listener last, ensuring health and metrics remain scrapable throughout the drain window.
 * 7. Invokes `onShutdown()` to clean up background resources (e.g. Undici dispatcher).
 *
 * @param options - Shutdown parameters and server handles.
 * @returns A {@link GracefulShutdown} controller.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  let force: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    run(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      shutdownPromise = (async () => {
        // Step 1: Mark runtime as draining so readiness probes fail immediately.
        options.onDraining();

        // Step 2: Stop accepting new client connections and sever idle keep-alives.
        const closed = Promise.withResolvers<void>();
        options.client.close(() => closed.resolve());
        options.client.closeIdleConnections();

        let forced = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (): void => {
          if (forced) return;
          forced = true;
          clearTimeout(timer);
          // Force-abort any remaining active requests and forcibly close open sockets.
          options.onAbortActive();
          options.client.closeAllConnections();
        };
        // Step 3: Set timer for maximum drain grace period.
        timer = setTimeout(finish, options.drainMs);
        force = finish;

        // Step 4: Wait for client server to finish draining.
        await closed.promise;
        finish();
        // Step 5: Close operations server last.
        await closeOperations(options.operations);
        // Step 6: Invoke shutdown cleanup callback.
        await options.onShutdown?.();
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
