/**
 * @fileoverview
 * Timing, sleeping, and randomness abstractions for deterministic gateway execution.
 *
 * Exposes injectable {@link Clock}, {@link Sleeper}, and {@link RandomSource} contracts
 * along with their production system implementations (`systemClock`, `systemSleeper`, `systemRandomSource`).
 * Used across the routing engine for monotonic duration tracking, key cooldown sleeps,
 * deadline enforcement, and backoff jitter.
 */

/**
 * Clock abstraction providing monotonic duration tracking and wall-clock timestamps.
 */
export interface Clock {
  /** Returns the current monotonic timestamp in milliseconds for elapsed duration measurement. */
  nowMonotonicMs(): number;

  /** Returns the current wall-clock Date for directory naming and human-facing timestamps. */
  nowWall(): Date;
}

/**
 * Abortable sleep interface for key cooldowns and backoff delays.
 */
export interface Sleeper {
  /**
   * Suspends execution for the specified duration, aborting early if the signal triggers.
   *
   * @param delayMs - Duration in milliseconds to sleep.
   * @param signal - Optional abort signal to cancel the sleep early.
   */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Pseudo-random number generator seam for retry jitter calculations.
 */
export interface RandomSource {
  /** Returns a pseudo-random floating point number in the range `[0, 1)`. */
  next(): number;
}

/** Production {@link Clock} implementation backed by standard runtime APIs. */
export const systemClock: Clock = {
  /** Returns high-resolution monotonic time via `performance.now()`. */
  nowMonotonicMs(): number {
    return performance.now();
  },
  /** Returns the current host Date via `new Date()`. */
  nowWall(): Date {
    return new Date();
  },
};

/** Production {@link Sleeper} implementation using `setTimeout` and abort listeners. */
export const systemSleeper: Sleeper = {
  /**
   * Suspends execution for `delayMs` milliseconds, cleaning up timers upon abort.
   *
   * @param delayMs - Delay duration in milliseconds.
   * @param signal - Optional cancellation signal.
   */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted"));
    }
    if (delayMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(signal?.reason ?? new Error("aborted"));
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      timer = setTimeout(() => {
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      }, delayMs);
    });
  },
};

/** Production {@link RandomSource} implementation backed by `Math.random()`. */
export const systemRandomSource: RandomSource = {
  /** Returns uniform pseudo-random number via `Math.random()`. */
  next(): number {
    return Math.random();
  },
};
