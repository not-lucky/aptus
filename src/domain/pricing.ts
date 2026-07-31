import type { Usage } from "./usage.ts";

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
 * @returns Exact decimal string representation of the total estimated cost in USD.
 *
 * @remarks
 * The computation uses exact decimal fixed-point integer arithmetic (BigInt), never IEEE-754
 * floating point, so the returned string is the exact decimal value with no scientific-notation
 * or rounding artifacts. Each rate is parsed into integer digits plus its decimal-place count;
 * the four terms are scaled to the widest decimal width, summed as integers, and the per-million
 * normalization is applied as a final power-of-ten division. If cache pricing fields are `null`
 * or usage counters are missing, their contribution is computed as zero.
 */
export function estimateCostUsd(pricing: PricingConfig, usage: Usage): string {
  const terms = [
    { tokens: BigInt(usage.input), rate: parseRate(pricing.inputUsdPerMillionTokens) },
    { tokens: BigInt(usage.output), rate: parseRate(pricing.outputUsdPerMillionTokens) },
    { tokens: BigInt(usage.cacheReadInput ?? 0), rate: parseRate(pricing.cacheReadUsdPerMillionTokens) },
    { tokens: BigInt(usage.cacheWriteInput ?? 0), rate: parseRate(pricing.cacheWriteUsdPerMillionTokens) },
  ];
  const maxDecimalPlaces = Math.max(...terms.map((term) => term.rate.decimalPlaces));

  // Sum token * rate with every rate scaled to the widest decimal width, as integers.
  let numerator = 0n;
  for (const term of terms) {
    const scale = 10n ** BigInt(maxDecimalPlaces - term.rate.decimalPlaces);
    numerator += term.tokens * term.rate.integer * scale;
  }

  // cost = numerator / 10^(maxDecimalPlaces + 6); the +6 is the per-million normalization.
  return formatDecimal(numerator, maxDecimalPlaces + 6);
}

/** A rate parsed into its integer digits and decimal-place count. */
interface ParsedRate {
  readonly integer: bigint;
  readonly decimalPlaces: number;
}

/**
 * Parses a non-negative decimal rate string into integer digits and its decimal-place
 * count. A `null` cache price contributes zero.
 */
function parseRate(rate: string | null): ParsedRate {
  if (rate === null) return { integer: 0n, decimalPlaces: 0 };
  const trimmed = rate.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return { integer: BigInt(trimmed), decimalPlaces: 0 };
  const integerPart = trimmed.slice(0, dot);
  const fractionPart = trimmed.slice(dot + 1);
  return {
    integer: BigInt((integerPart === "" ? "0" : integerPart) + fractionPart),
    decimalPlaces: fractionPart.length,
  };
}

/**
 * Formats `numerator / 10^denominatorPower` as a plain decimal string without
 * scientific notation or trailing fractional zeros.
 */
function formatDecimal(numerator: bigint, denominatorPower: number): string {
  const divisor = 10n ** BigInt(denominatorPower);
  const whole = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(denominatorPower, "0").replace(/0+$/, "");
  return `${whole}.${fraction}`;
}
