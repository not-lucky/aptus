/**
 * Registry for tracking in-flight request abort controllers to support graceful shutdown drains and immediate aborts.
 */
export interface RequestCancellationRegistry {
  /**
   * Registers an active request's `AbortController`.
   *
   * @param controller - The `AbortController` bound to the active request lifecycle.
   * @returns Idempotent unregister cleanup function.
   */
  register(controller: AbortController): () => void;

  /**
   * Signals abort on all currently registered in-flight request controllers.
   */
  abortAll(): void;
}

/**
 * Instantiates a registry for managing active request abort signals.
 *
 * @returns A {@link RequestCancellationRegistry} instance.
 */
export function createRequestCancellationRegistry(): RequestCancellationRegistry {
  const controllers = new Set<AbortController>();
  return {
    register(controller) {
      controllers.add(controller);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        controllers.delete(controller);
      };
    },
    abortAll() {
      // Abort all in-flight request controllers during forced shutdown.
      for (const controller of controllers) controller.abort();
    },
  };
}
