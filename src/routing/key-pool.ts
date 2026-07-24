import type { KeyStrategy, ProviderKeyConfig } from "../config/types.js";
import type { KeyAcquireResult, KeyLease, KeyPool } from "../domain/contracts.js";

/**
 * Creates a per-provider {@link KeyPool}.
 *
 * Implements the selection seam with key strategies:
 * `acquire` honors `fill-first` and `round-robin` (a process-local cursor) and
 * the per-key `enabled` flag, and always returns `acquired` or `unavailable`
 * (never `wait`). `observe` is a no-op placeholder whose signature is stable for
 * cooldown and health tracking additions.
 *
 * @param provider - The provider name owned by this pool (for lease telemetry).
 * @param keys - Configured provider keys.
 * @param strategy - The configured key selection strategy.
 * @returns A minimal {@link KeyPool} instance.
 */
export function createKeyPool(provider: string, keys: readonly ProviderKeyConfig[], strategy: KeyStrategy): KeyPool {
  const enabled = keys.filter((key) => key.enabled);
  let generation = 0;
  let cursor = 0;

  return {
    acquire(_nowMs: number): KeyAcquireResult {
      if (enabled.length === 0) return { kind: "unavailable" };
      // Fill-first always selects the first enabled key; round-robin advances
      // a process-local cursor across the enabled keys in order.
      const index = strategy === "fill-first" ? 0 : cursor++ % enabled.length;
      const key = enabled[index];
      if (key === undefined) return { kind: "unavailable" };
      generation++;
      return {
        kind: "acquired",
        lease: { provider, keyName: key.name, secret: key.secret, generation },
      };
    },

    observe(_lease: KeyLease, _observation, _nowMs: number): void {
      // Per-key health state / cooldowns can be tracked here.
    },
  };
}
