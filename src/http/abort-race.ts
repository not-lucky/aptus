/**
 * @fileoverview Utility for racing asynchronous operations against an AbortSignal.
 *
 * Provides a standardized {@link raceWithAbort} helper used across admission ingress,
 * gateway dispatch, and stream relays to handle client disconnects, timeouts, and shutdown.
 */

/**
 * Tagged union representing the outcome of an abort race.
 *
 * @typeParam T - Type of the resolved value when the operation completes before abort.
 */
export type AbortRace<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T };

/**
 * Races an asynchronous operation against an {@link AbortSignal}.
 *
 * Resolves with `{ aborted: true }` if the signal triggers before the operation settles.
 * Otherwise resolves with `{ aborted: false, value }` or rejects with the operation's error.
 * Ensures abort event listeners are promptly cleaned up in all settlement paths.
 *
 * @typeParam T - Result type of the underlying operation.
 * @param operation - In-flight promise to await.
 * @param signal - AbortSignal to race against.
 * @returns A promise resolving to an {@link AbortRace} tagged result.
 */
export function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<AbortRace<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true });
    };
    if (signal.aborted) {
      void operation.then(
        () => undefined,
        () => undefined,
      );
      resolve({ aborted: true });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
