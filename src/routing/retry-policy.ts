/**
 * @fileoverview
 * Same-candidate retry, route fallback, and jittered backoff policies.
 *
 * Evaluates pure routing decisions during failure recovery: determines whether a failed attempt
 * may be retried against the same candidate via {@link shouldRetry}, or if execution should advance
 * to the next candidate in route order via {@link shouldFallback}. Also calculates jittered cooldown
 * durations for rate-limited keys via {@link calculateRetryDelay}.
 */

import type { KeyPoolConfig } from "../config/types.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { RandomSource } from "./timing.ts";

/** HTTP statuses permitted for same-candidate retries: 429 (rate limit), 500/503 (server errors), 529 (overload). */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 503, 529]);

/** Maximum number of retry attempts permitted per candidate (yielding up to 3 total attempts). */
export const MAX_SAME_CANDIDATE_RETRIES = 2;

/** Contextual facts required to evaluate a same-candidate retry decision. */
export interface RetryDecisionInput {
  /** HTTP status code returned by the provider, if a response head was received. */
  readonly status?: number;
  /** Classified failure category of the attempt. */
  readonly category: IrFailureCategory | "success" | "client_cancelled";
  /** Whether no response bytes have yet been emitted to the downstream client. */
  readonly beforeClientBytes: boolean;
  /** Number of attempts executed so far for this candidate (starting at 1). */
  readonly candidateAttemptCount: number;
  /** Configured retry-eligible failure categories for the active route. */
  readonly retryOn: readonly IrFailureCategory[];
}

/**
 * Evaluates whether a failed provider attempt may be retried on the same candidate.
 *
 * Requires that no response bytes have reached the client, the status is retryable,
 * the per-candidate retry cap has not been exceeded, and the category is in `retryOn`.
 *
 * @param input - Attempt status, failure category, byte state, and route retry policy.
 * @returns Whether the attempt can be retried on the current candidate.
 */
export function shouldRetry(input: RetryDecisionInput): boolean {
  if (!input.beforeClientBytes) {
    return false;
  }
  if (input.status === undefined || !RETRYABLE_STATUSES.has(input.status)) {
    return false;
  }
  if (input.candidateAttemptCount > MAX_SAME_CANDIDATE_RETRIES) {
    return false;
  }
  if (input.category === "success" || input.category === "client_cancelled") {
    return false;
  }
  return input.retryOn.includes(input.category);
}

/** Contextual facts required to evaluate a route candidate fallback decision. */
export interface FallbackDecisionInput {
  /** Classified failure category of the exhausted candidate. */
  readonly category: IrFailureCategory | "success" | "client_cancelled";
  /** Whether no response bytes have yet been emitted to the downstream client. */
  readonly beforeClientBytes: boolean;
  /** Whether another candidate exists in the configured route sequence. */
  readonly hasNextCandidate: boolean;
  /** Configured fallback-eligible failure categories for the active route. */
  readonly fallbackOn: readonly IrFailureCategory[];
}

/**
 * Evaluates whether routing may fall back to the next candidate in the configured route order.
 *
 * Requires that no client response bytes have been emitted, a subsequent candidate is available,
 * and the failure category is explicitly listed in `fallbackOn`.
 *
 * @param input - Failure category, client delivery state, candidate availability, and fallback policy.
 * @returns Whether execution may advance to the next candidate.
 */
export function shouldFallback(input: FallbackDecisionInput): boolean {
  if (!input.beforeClientBytes) {
    return false;
  }
  if (!input.hasNextCandidate) {
    return false;
  }
  if (input.category === "success" || input.category === "client_cancelled") {
    return false;
  }
  return input.fallbackOn.includes(input.category);
}

/**
 * Calculates a jittered backoff delay in milliseconds for rate-limited provider keys.
 *
 * Clamps the upstream `Retry-After` delay (or fallback) to `maxRetryAfterMs` and adds
 * uniform random jitter scaled by `jitterRatio`.
 *
 * @param delay - Optional retry delay advertised by the upstream provider in milliseconds.
 * @param config - Key pool timing configuration for ceilings and fallback durations.
 * @param random - Random number source for jitter calculation.
 * @returns Total cooldown duration in milliseconds.
 */
export function calculateRetryDelay(delay: number | undefined, config: KeyPoolConfig, random: RandomSource): number {
  const rawDelay = delay ?? config.rateLimitFallbackMs;
  const base = Math.min(rawDelay, config.maxRetryAfterMs);
  const jitter = random.next() * (config.jitterRatio * base);
  return base + jitter;
}
