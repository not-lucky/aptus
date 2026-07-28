/**
 * Timing, sleep, and randomness abstractions for deterministic gateway testing.
 *
 * Exposes injectable {@link Clock}, {@link Sleeper}, and {@link RandomSource}
 * seams with production system defaults. Test doubles live in `test/helpers/test-timing.ts`.
 */

/**
 * Clock interface providing monotonic time for deadlines/cooldowns and wall-clock time for logs/traces.
 */
export interface Clock {
  /**
   * Returns the current monotonic time in milliseconds.
   *
   * Monotonic time is used exclusively for deadlines, cooldown intervals, attempt durations, and backoff.
   */
  nowMonotonicMs(): number;

  /**
   * Returns the current wall-clock date/time.
   *
   * Wall-clock time is used exclusively for human-facing artifacts such as ISO directory timestamps.
   */
  nowWall(): Date;
}

/**
 * Sleeper interface providing an abortable sleep operation.
 */
export interface Sleeper {
  /**
   * Suspends execution for the specified duration in milliseconds, or aborts if the signal fires.
   *
   * @param delayMs - Duration in milliseconds to sleep.
   * @param signal - Optional cancellation signal.
   * @returns A promise that resolves when the timer expires, or rejects if aborted.
   */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Source of uniform pseudo-random numbers in `[0, 1)`.
 */
export interface RandomSource {
  /**
   * Returns a uniform pseudo-random number in the half-open interval `[0, 1)`.
   */
  next(): number;
}

/**
 * Default production clock using standard Node.js/browser runtime globals.
 */
export const systemClock: Clock = {
  nowMonotonicMs(): number {
    return performance.now();
  },
  nowWall(): Date {
    return new Date();
  },
};

/**
 * Default production sleeper using `setTimeout` with abort signal listener support.
 */
export const systemSleeper: Sleeper = {
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

/**
 * Default production random source using `Math.random()`.
 */
export const systemRandomSource: RandomSource = {
  next(): number {
    return Math.random();
  },
};
