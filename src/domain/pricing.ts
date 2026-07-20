import type { Usage } from "./usage.js";

/** A non-negative decimal USD amount per one million tokens, stored as text. */
export type DecimalUsdPerMillion = string;

/** Optional cost-bookkeeping values. */
export interface PricingConfig {
  /** Input USD per million tokens. */
  readonly inputUsdPerMillionTokens: DecimalUsdPerMillion;
  /** Output USD per million tokens. */
  readonly outputUsdPerMillionTokens: DecimalUsdPerMillion;
  /** Cached-input read USD per million tokens, or null. */
  readonly cacheReadUsdPerMillionTokens: DecimalUsdPerMillion | null;
  /** Cached-input write USD per million tokens, or null. */
  readonly cacheWriteUsdPerMillionTokens: DecimalUsdPerMillion | null;
}

/**
 * Cost estimate in USD: each count times its price (null cache
 * prices contribute zero), divided by one million.
 */
export function estimateCostUsd(pricing: PricingConfig, usage: Usage): string {
  const input = usage.input * Number.parseFloat(pricing.inputUsdPerMillionTokens);
  const output = usage.output * Number.parseFloat(pricing.outputUsdPerMillionTokens);
  const cacheRead = (usage.cacheReadInput ?? 0) * Number.parseFloat(pricing.cacheReadUsdPerMillionTokens ?? "0");
  const cacheWrite = (usage.cacheWriteInput ?? 0) * Number.parseFloat(pricing.cacheWriteUsdPerMillionTokens ?? "0");
  const total = (input + output + cacheRead + cacheWrite) / 1_000_000;
  return total.toString();
}
