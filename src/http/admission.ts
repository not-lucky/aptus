/**
 * @fileoverview Process-local limit on the number of client requests admitted concurrently.
 *
 * Provides concurrency control for HTTP admission (authentication, body parsing, model
 * extraction, and name resolution) to prevent bursts of client requests from exhausting
 * process memory or file descriptors before dispatch.
 */

/**
 * Concurrency limiter guarding in-flight admission capacity.
 */
export interface AdmissionLimiter {
  /**
   * Attempts to acquire one admission concurrency lease.
   *
   * @returns An idempotent release function if capacity was available, or `undefined` if saturated.
   */
  tryAcquire(): (() => void) | undefined;
}

/**
 * Creates a process-local admission limiter with a fixed capacity ceiling.
 *
 * @param limit - Maximum number of concurrent requests allowed in admission.
 * @returns An {@link AdmissionLimiter} tracking leases in a closure.
 */
export function createAdmissionLimiter(limit: number): AdmissionLimiter {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= limit) return undefined;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}
