import type { KeyPoolConfig } from "../config/types.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { RandomSource } from "./timing.ts";

/**
 * Explicit HTTP statuses eligible for same-candidate retry (ADR 0004).
 *
 * Status 529 is included as retryable on all protocols (Anthropic Overloaded).
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 503, 529]);

/**
 * Maximum number of same-candidate retries permitted after the first attempt.
 */
export const MAX_SAME_CANDIDATE_RETRIES = 2;

/**
 * Inputs for evaluating same-candidate retry eligibility.
 */
export interface RetryDecisionInput {
  /** Explicit HTTP status code returned by the provider, if available. */
  readonly status?: number;
  /** Normalized failure category of the attempt outcome. */
  readonly category: IrFailureCategory | "success" | "client_cancelled";
  /** Whether no response bytes have been exposed to the downstream client yet. */
  readonly beforeClientBytes: boolean;
  /** Number of attempts executed so far for this candidate (1 after first attempt). */
  readonly candidateAttemptCount: number;
  /** Configured retry-eligible failure categories for this candidate / route. */
  readonly retryOn: readonly IrFailureCategory[];
}

/**
 * Pure decision evaluating whether a failed attempt may retry on the same candidate.
 *
 * Rules (ADR 0004):
 * - Must be an explicit pre-body HTTP status in `{429, 500, 503, 529}`.
 * - No client bytes written yet (`beforeClientBytes: true`).
 * - At most 2 retries after the first attempt (`candidateAttemptCount <= 2`).
 * - Normalized failure category is present in `retryOn`.
 *
 * @param input - Decision facts.
 * @returns `true` if retry is allowed; otherwise `false`.
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

/**
 * Inputs for evaluating candidate fallback eligibility.
 */
export interface FallbackDecisionInput {
  /** Normalized failure category of the attempt outcome or candidate terminal condition. */
  readonly category: IrFailureCategory | "success" | "client_cancelled";
  /** Whether no response bytes have been exposed to the downstream client yet. */
  readonly beforeClientBytes: boolean;
  /** Whether an eligible subsequent candidate exists in the resolved route order. */
  readonly hasNextCandidate: boolean;
  /** Configured fallback-eligible failure categories for the active route. */
  readonly fallbackOn: readonly IrFailureCategory[];
}

/**
 * Pure decision evaluating whether execution may fall back to the next candidate in route order.
 *
 * Rules (ADR 0004):
 * - No client bytes written yet (`beforeClientBytes: true`).
 * - Subsequent candidate exists (`hasNextCandidate: true`).
 * - Normalized failure category is present in `fallbackOn`.
 *
 * @param input - Decision facts.
 * @returns `true` if fallback is allowed; otherwise `false`.
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
 * Calculates backoff wait duration in milliseconds with uniform random jitter.
 *
 * Formula:
 * `base = min(delay ?? rateLimitFallbackMs, maxRetryAfterMs)`
 * `wait = base + uniform(0, jitterRatio * base)`
 *
 * @param delay - Optional delay from Retry-After or provider reset in milliseconds.
 * @param config - Key pool timing configuration.
 * @param random - Random source for jitter calculation.
 * @returns Total wait duration in milliseconds.
 */
export function calculateRetryDelay(delay: number | undefined, config: KeyPoolConfig, random: RandomSource): number {
  const rawDelay = delay ?? config.rateLimitFallbackMs;
  const base = Math.min(rawDelay, config.maxRetryAfterMs);
  const jitter = random.next() * (config.jitterRatio * base);
  return base + jitter;
}
