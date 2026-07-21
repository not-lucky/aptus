/**
 * Deterministic token and USD cost arithmetic.
 *
 * Cost math is pure and request-agnostic: it takes a {@link TokenUsage} snapshot
 * and per-million-token prices and returns {@link CostMetrics} in USD, or a typed
 * failure reason for negative, unsafe, non-finite, or overflowing inputs. It
 * never throws and performs no I/O, so callers (including dry-run estimation)
 * always get a deterministic, finite result or an explicit rejection. Lifting a
 * failure into a `GatewayError` is done by `costFailureToError` in `errors.ts`.
 */

import type { CostMetrics, TokenUsage } from "./canonical.js";

/**
 * USD prices per one million tokens, matching config `Target.pricesPerMillionUsd`.
 * Cache-read applies to `cachedInputTokens`; cache-write applies to the summed
 * `cacheWriteBreakdown` tokens.
 */
export interface PricesPerMillionUsd {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Stable reason a cost calculation was rejected. */
export type CostErrorReason =
  | "negative_tokens"
  | "unsafe_token_count"
  | "negative_price"
  | "non_finite_price"
  | "non_finite_cost";

/** Pure cost outcome; failures are values, never exceptions. */
export type CostResult =
  | { readonly ok: true; readonly cost: CostMetrics }
  | { readonly ok: false; readonly reason: CostErrorReason };

const TOKENS_PER_MILLION = 1_000_000;

/** Sum of `cacheWriteBreakdown` token counts; `0` when the breakdown is absent. */
export function cacheWriteTokens(usage: TokenUsage): number {
  return (usage.cacheWriteBreakdown ?? []).reduce(
    (total, entry) => total + entry.tokens,
    0,
  );
}

/**
 * Billable non-cached input tokens. Cached input tokens are treated as a subset
 * of `inputTokens` (priced separately at the cache-read rate), so they are
 * subtracted here and the result never drops below zero.
 */
export function billableInputTokens(usage: TokenUsage): number {
  return Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));
}

/** All-zero cost, used for empty usage and dry-run responses. */
export function zeroCost(): CostMetrics {
  return {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    totalUsd: 0,
    currency: "USD",
  };
}

/**
 * Compute {@link CostMetrics} from token usage and per-million prices. Each
 * component is `tokens * pricePerMillion / 1_000_000`. Returns a failure reason
 * when any token count is negative or not a safe integer, any price is negative
 * or non-finite, or any component overflows to a non-finite value.
 */
export function calculateCost(
  usage: TokenUsage,
  prices: PricesPerMillionUsd,
): CostResult {
  const cachedInput = usage.cachedInputTokens ?? 0;
  const cacheWrite = cacheWriteTokens(usage);
  const tokenCounts = [
    usage.inputTokens,
    usage.outputTokens,
    cachedInput,
    cacheWrite,
  ];
  for (const count of tokenCounts) {
    if (count < 0) return { ok: false, reason: "negative_tokens" };
    if (!Number.isSafeInteger(count))
      return { ok: false, reason: "unsafe_token_count" };
  }
  const priceValues = [
    prices.input,
    prices.output,
    prices.cacheRead,
    prices.cacheWrite,
  ];
  for (const price of priceValues) {
    if (!Number.isFinite(price))
      return { ok: false, reason: "non_finite_price" };
    if (price < 0) return { ok: false, reason: "negative_price" };
  }

  const inputUsd =
    (billableInputTokens(usage) * prices.input) / TOKENS_PER_MILLION;
  const outputUsd = (usage.outputTokens * prices.output) / TOKENS_PER_MILLION;
  const cacheReadUsd = (cachedInput * prices.cacheRead) / TOKENS_PER_MILLION;
  const cacheWriteUsd = (cacheWrite * prices.cacheWrite) / TOKENS_PER_MILLION;
  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;

  if (
    ![inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd, totalUsd].every(
      Number.isFinite,
    )
  ) {
    return { ok: false, reason: "non_finite_cost" };
  }
  return {
    ok: true,
    cost: {
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      totalUsd,
      currency: "USD",
    },
  };
}
