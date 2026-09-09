/**
 * @fileoverview Registry of in-flight request abort controllers for graceful shutdown.
 *
 * Tracks active request abort controllers and finalization promises. Enables the shutdown
 * coordinator to broadcast abort signals to all in-flight requests simultaneously and await
 * terminal telemetry settlement within a bounded grace window.
 */

/**
 * Registry tracking active request abort controllers and finalization promises.
 */
export interface RequestCancellationRegistry {
  /**
   * Registers an active request's abort controller and optional finalization promise.
   *
   * @param controller - Request abort controller.
   * @param finalized - Promise that settles when request terminal bookkeeping finishes.
   * @returns Idempotent unregister callback to invoke on request completion.
   */
  register(controller: AbortController, finalized?: Promise<void>): () => void;

  /**
   * Returns the count of currently registered in-flight requests.
   */
  size(): number;

  /**
   * Returns the cumulative total of all requests registered since initialization.
   */
  registeredCount(): number;

  /**
   * Triggers abort on all currently registered request controllers.
   *
   * @param reason - Optional abort reason passed to each controller (e.g. `"shutdown"`).
   */
  abortAll(reason?: string): void;

  /**
   * Awaits settlement of all registered finalization promises within a bounded grace window.
   *
   * @param graceMs - Maximum duration in milliseconds to wait before timing out.
   */
  awaitSettled(graceMs: number): Promise<void>;
}

/**
 * Creates a request cancellation registry.
 *
 * @returns An empty {@link RequestCancellationRegistry} instance.
 */
export function createRequestCancellationRegistry(): RequestCancellationRegistry {
  const entries = new Set<{ readonly controller: AbortController; readonly finalized?: Promise<void> }>();
  let registrations = 0;
  return {
    register(controller, finalized) {
      const entry = { controller, finalized };
      entries.add(entry);
      registrations++;
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        entries.delete(entry);
      };
    },
    size() {
      return entries.size;
    },
    registeredCount() {
      return registrations;
    },
    abortAll(reason?: string) {
      for (const entry of entries) {
        entry.controller.abort(reason);
      }
    },
    async awaitSettled(graceMs: number): Promise<void> {
      const promises: Promise<unknown>[] = [];
      for (const entry of entries) {
        if (entry.finalized !== undefined) {
          promises.push(entry.finalized);
        }
      }
      if (promises.length === 0) return;

      const settled = Promise.allSettled(promises);
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      });
      await Promise.race([settled, timeout]);
    },
  };
}
