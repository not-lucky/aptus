import type { KeyPoolConfig, KeyStrategy, ProviderKeyConfig } from "../config/types.ts";
import type { AttemptObservation, KeyAcquireResult, KeyLease, KeyPool } from "../domain/contracts.ts";
import { calculateRetryDelay } from "./retry-policy.ts";
import { type RandomSource, systemRandomSource } from "./timing.ts";

/**
 * Mutable health and lease tracking state for a single provider key.
 */
interface KeyState {
  readonly config: ProviderKeyConfig;
  failureStreak: number;
  cooldownUntilMs: number;
  generation: number;
}

/**
 * Creates a per-provider {@link KeyPool} managing key selection strategies and adaptive health.
 *
 * Requirements (ADR 0002):
 * - Key selection supports `fill-first` and `round-robin` across enabled keys.
 * - `acquire` is non-blocking and returns `acquired`, `wait` (when all enabled keys are cooling down), or `unavailable`.
 * - `observe` ignores stale lease generations where the key was re-leased since the observation began.
 * - Success resets the failure streak and clears cooldown.
 * - 4xx non-429 and client cancellation bypass cooldown.
 * - Rate limit (429 or observed `retryDelayMs`) applies `base = min(delay, maxRetryAfterMs)` plus uniform jitter `[0, jitterRatio * base)`.
 * - Server/transport failures escalate through fixed `failureCooldownMs` rungs `min(failureStreak - 1, 1)` with no jitter.
 * - Exposes `availableCount(nowMs)` returning the number of enabled keys not cooling down at `nowMs`.
 *
 * @param provider - Provider name owning this pool.
 * @param keys - Configured provider keys.
 * @param strategy - Key selection strategy (`fill-first` or `round-robin`).
 * @param config - Key pool timing and cooldown configuration.
 * @param random - Injectable pseudo-random number generator seam.
 * @returns A {@link KeyPool} instance.
 */
export function createKeyPool(
  provider: string,
  keys: readonly ProviderKeyConfig[],
  strategy: KeyStrategy,
  config: KeyPoolConfig,
  random: RandomSource = systemRandomSource,
): KeyPool {
  const statesByName = new Map<string, KeyState>(
    keys.map((key) => [key.name, { config: key, failureStreak: 0, cooldownUntilMs: 0, generation: 0 }]),
  );

  // Process-local cursor. `acquire` and `observe` are fully synchronous and
  // the pool is only touched from the single event-loop thread, so a plain
  // number gives the atomicity the round-robin strategy requires.
  let roundRobinCursor = 0;

  return {
    acquire(nowMs: number): KeyAcquireResult {
      const enabled = [...statesByName.values()].filter((state) => state.config.enabled);
      if (enabled.length === 0) {
        return { kind: "unavailable" };
      }

      // Scan for the first available key; round-robin starts its scan at the
      // cursor and advances it past the key it selects.
      const count = enabled.length;
      for (let offset = 0; offset < count; offset++) {
        const index = strategy === "round-robin" ? (roundRobinCursor + offset) % count : offset;
        const state = enabled[index];
        if (state !== undefined && state.cooldownUntilMs <= nowMs) {
          if (strategy === "round-robin") {
            roundRobinCursor = (index + 1) % count;
          }
          state.generation++;
          return {
            kind: "acquired",
            lease: {
              provider,
              keyName: state.config.name,
              secret: state.config.secret,
              generation: state.generation,
            },
          };
        }
      }

      // All enabled keys are cooling down: wait until the earliest expiration.
      let earliestUntilMs = Number.POSITIVE_INFINITY;
      for (const state of enabled) {
        if (state.cooldownUntilMs < earliestUntilMs) {
          earliestUntilMs = state.cooldownUntilMs;
        }
      }
      return { kind: "wait", untilMs: earliestUntilMs };
    },

    observe(lease: KeyLease, observation: AttemptObservation, nowMs: number): number | undefined {
      const state = statesByName.get(lease.keyName);
      if (state === undefined) {
        return undefined;
      }

      // Detect and ignore stale lease observations.
      if (state.generation !== lease.generation) {
        return undefined;
      }

      // Success: reset failure streak and clear cooldown.
      if (observation.result === "success") {
        state.failureStreak = 0;
        state.cooldownUntilMs = 0;
        return undefined;
      }

      // Client cancellation: bypass cooldown.
      if (observation.result === "client_cancelled") {
        return undefined;
      }

      // 4xx status (except 429): bypass cooldown.
      if (
        observation.status !== undefined &&
        observation.status >= 400 &&
        observation.status < 500 &&
        observation.status !== 429
      ) {
        return undefined;
      }

      // Apply cooldown to this key, returning the exact scheduled delay so the
      // Gateway can record it without recomputing (and re-jittering) it.
      state.failureStreak++;

      const isRateLimit = observation.status === 429 || observation.retryDelayMs !== undefined;
      let delayMs: number;
      if (isRateLimit) {
        delayMs = calculateRetryDelay(observation.retryDelayMs, config, random);
      } else {
        // Server or transport failure: fixed step duration index min(streak - 1, 1).
        const rung = Math.min(state.failureStreak - 1, 1);
        delayMs = config.failureCooldownMs[rung] ?? config.failureCooldownMs[0];
      }
      state.cooldownUntilMs = nowMs + delayMs;
      return delayMs;
    },

    availableCount(nowMs: number): number {
      let count = 0;
      for (const state of statesByName.values()) {
        if (state.config.enabled && state.cooldownUntilMs <= nowMs) {
          count++;
        }
      }
      return count;
    },
  };
}
