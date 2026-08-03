/**
 * Registry for tracking in-flight request abort controllers to support graceful shutdown drains and immediate aborts.
 */
export interface RequestCancellationRegistry {
  /**
   * Registers an active request's `AbortController` and optional finalization promise.
   *
   * @param controller - The `AbortController` bound to the active request lifecycle.
   * @param finalized - Optional promise resolving when request coordinator finalizes.
   * @returns Idempotent unregister cleanup function.
   */
  register(controller: AbortController, finalized?: Promise<void>): () => void;

  /**
   * Returns the count of currently registered active requests.
   */
  size(): number;

  /**
   * Returns the total number of requests ever registered (monotonic, never
   * decremented). Used by shutdown telemetry to account for requests admitted
   * in the gap between shutdown start and when the listener stops accepting.
   */
  registeredCount(): number;

  /**
   * Signals abort on all currently registered in-flight request controllers.
   *
   * @param reason - Optional abort reason string passed to `controller.abort(reason)`.
   */
  abortAll(reason?: string): void;

  /**
   * Waits for all registered request finalizations to settle, bounded by a maximum grace period.
   *
   * @param graceMs - Maximum wait duration in milliseconds before giving up.
   */
  awaitSettled(graceMs: number): Promise<void>;
}

/**
 * Instantiates a registry for managing active request abort signals.
 *
 * @returns A {@link RequestCancellationRegistry} instance.
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
      // Abort all in-flight request controllers during forced shutdown.
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
