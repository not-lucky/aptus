/**
 * @fileoverview
 * Provider API key pool with selection strategies and adaptive health tracking.
 *
 * Manages pools of credentials for upstream LLM providers. Supports `fill-first` (traffic
 * concentration to maximize provider prompt cache hits) and `round-robin` load spreading.
 * Tracks key health, applying jittered backoff on rate limits (429) and stepped cooldowns
 * on repeated server/transport errors while ignoring stale lease generations.
 */

import type { KeyPoolConfig, KeyStrategy, ProviderKeyConfig } from "../config/types.ts";
import type { AttemptObservation, KeyAcquireResult, KeyLease, KeyPool } from "../domain/contracts.ts";
import { calculateRetryDelay } from "./retry-policy.ts";
import { type RandomSource, systemRandomSource } from "./timing.ts";

/** Internal mutable state tracking health and lease generation for a single provider key. */
interface KeyState {
  /** Static configuration entry for this key. */
  readonly config: ProviderKeyConfig;
  /** Number of consecutive failed observations triggering cooldown. */
  failureStreak: number;
  /** Monotonic millisecond timestamp until which this key is unavailable. */
  cooldownUntilMs: number;
  /** Monotonically increasing generation count to detect and discard stale lease observations. */
  generation: number;
}

/**
 * Creates a per-provider {@link KeyPool} managing key selection strategies and adaptive health.
 *
 * @param provider - Name of the upstream provider owning this key pool.
 * @param keys - Configured provider keys.
 * @param strategy - Key selection strategy (`fill-first` or `round-robin`).
 * @param config - Key pool cooldown configuration.
 * @param random - Optional random source for jitter calculation (defaults to `systemRandomSource`).
 * @returns Key pool instance.
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

  let roundRobinCursor = 0;

  return {
    /**
     * Attempts to acquire an active lease for an enabled, non-cooling key.
     *
     * @param nowMs - Current monotonic millisecond timestamp.
     * @returns Acquired lease, wait timestamp if all keys are cooling, or unavailable.
     */
    acquire(nowMs: number): KeyAcquireResult {
      const enabled = [...statesByName.values()].filter((state) => state.config.enabled);
      if (enabled.length === 0) {
        return { kind: "unavailable" };
      }

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

    /**
     * Updates key health following a provider attempt observation.
     *
     * Resets failure streaks on success, bypasses cooldown on client cancellation / non-429 4xx errors,
     * applies jittered backoff on rate limits, and stepped cooldowns on server/transport errors.
     *
     * @param lease - Lease issued for the attempt.
     * @param observation - Attempt result observation.
     * @param nowMs - Current monotonic millisecond timestamp.
     * @returns Cooldown delay applied in milliseconds, or undefined if no cooldown was applied.
     */
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

    /** Returns the number of enabled keys not currently cooling down. */
    availableCount(nowMs: number): number {
      let count = 0;
      for (const state of statesByName.values()) {
        if (state.config.enabled && state.cooldownUntilMs <= nowMs) {
          count++;
        }
      }
      return count;
    },

    /** Previews the next key that would be selected without advancing cursor or lease generation. */
    preview() {
      const enabled = [...statesByName.values()].filter((state) => state.config.enabled);
      if (enabled.length === 0) {
        return undefined;
      }
      if (strategy === "fill-first") {
        const first = enabled[0];
        return first !== undefined ? { keyName: first.config.name, secret: first.config.secret } : undefined;
      }
      const index = roundRobinCursor % enabled.length;
      const state = enabled[index];
      return state !== undefined ? { keyName: state.config.name, secret: state.config.secret } : undefined;
    },
  };
}
