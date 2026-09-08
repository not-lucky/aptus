export type AbortRace<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T };

/**
 * Races an async operation against an AbortSignal, returning an
 * `{ aborted: true }` tag when the signal fires first.
 *
 * Single owner of the abort-race spelling shared by admission ingress,
 * gateway dispatch, and stream relay reads: callers branch on the tag
 * instead of re-spelling listener setup and teardown.
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
