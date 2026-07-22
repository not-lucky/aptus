import type { Usage } from "./usage.js";

/**
 * A non-negative decimal USD amount per one million tokens, represented as text to preserve exact precision.
 *
 * Pattern: Non-negative integer or fixed-point decimal (e.g., `"2.50"`, `"0.15"`).
 */
export type DecimalUsdPerMillion = string;

/**
 * Pricing rates per one million tokens used for post-request cost accounting and telemetry.
 */
export interface PricingConfig {
  /**
   * Price in USD per 1,000,000 un-cached input tokens.
   */
  readonly inputUsdPerMillionTokens: DecimalUsdPerMillion;

  /**
   * Price in USD per 1,000,000 output tokens.
   */
  readonly outputUsdPerMillionTokens: DecimalUsdPerMillion;

  /**
   * Price in USD per 1,000,000 cached input read tokens, or `null` if the provider does not charge or discount for cache reads.
   */
  readonly cacheReadUsdPerMillionTokens: DecimalUsdPerMillion | null;

  /**
   * Price in USD per 1,000,000 cached input write tokens, or `null` if the provider does not charge for cache writes.
   */
  readonly cacheWriteUsdPerMillionTokens: DecimalUsdPerMillion | null;
}

/**
 * Computes an estimated request cost in USD based on observed token usage counts and configured pricing rates.
 *
 * @param pricing - Configured token unit pricing rates for the resolved model.
 * @param usage - Measured token usage counters reported by the provider or calculated from stream chunks.
 * @returns Decimal string representation of the total estimated cost in USD.
 *
 * @remarks
 * Each token bucket is multiplied by its unit rate per million tokens, summed, and then divided by 1,000,000.
 * If cache pricing fields are `null` or usage counters are missing, their contribution is computed as zero.
 */
export function estimateCostUsd(pricing: PricingConfig, usage: Usage): string {
  // Multiply token counts by USD rates per million tokens.
  const input = usage.input * Number.parseFloat(pricing.inputUsdPerMillionTokens);
  const output = usage.output * Number.parseFloat(pricing.outputUsdPerMillionTokens);

  // Cache read/write rates default to zero if null/omitted.
  const cacheRead = (usage.cacheReadInput ?? 0) * Number.parseFloat(pricing.cacheReadUsdPerMillionTokens ?? "0");
  const cacheWrite = (usage.cacheWriteInput ?? 0) * Number.parseFloat(pricing.cacheWriteUsdPerMillionTokens ?? "0");

  // Normalize from cost-per-million to absolute USD amount.
  const total = (input + output + cacheRead + cacheWrite) / 1_000_000;
  return total.toString();
}
