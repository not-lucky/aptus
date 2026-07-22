/**
 * Process-local concurrency limiter for gating in-flight client requests.
 */
export interface AdmissionLimiter {
  /**
   * Attempts to acquire a concurrency lease.
   *
   * @returns An idempotent release function if a slot was available; otherwise `undefined` if limit reached.
   */
  tryAcquire(): (() => void) | undefined;
}

/**
 * Creates an in-memory admission concurrency limiter with a fixed positive capacity.
 *
 * @param limit - Maximum number of simultaneous active requests permitted.
 * @returns An {@link AdmissionLimiter} instance.
 */
export function createAdmissionLimiter(limit: number): AdmissionLimiter {
  let active = 0;
  return {
    tryAcquire() {
      // Reject if max in-flight capacity is reached.
      if (active >= limit) return undefined;
      active++;
      let released = false;
      // Return an idempotent release closure that decrements active count exactly once.
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}
