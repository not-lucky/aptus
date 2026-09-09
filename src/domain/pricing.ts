/**
 * @fileoverview Exact decimal cost estimation for token usage.
 *
 * Calculates US Dollar costs from observed {@link Usage} counters and configured per-model
 * {@link PricingConfig} rates. Uses fixed-point `bigint` arithmetic to avoid floating-point
 * rounding errors, returning exact decimal strings for metrics and trace manifests.
 */

import type { Usage } from "./usage.ts";

/**
 * Decimal string representing US dollars per one million tokens (e.g. `"2.50"`).
 * Preserves exact decimal precision without IEEE-754 floating-point inaccuracies.
 */
export type DecimalUsdPerMillion = string;

/**
 * Per-model pricing configuration across input, output, and prompt cache tiers.
 */
export interface PricingConfig {
  /** Cost per million uncached input tokens. */
  readonly inputUsdPerMillionTokens: DecimalUsdPerMillion;

  /** Cost per million output / completion tokens. */
  readonly outputUsdPerMillionTokens: DecimalUsdPerMillion;

  /** Cost per million cached input read tokens. Null if provider does not charge or discount cache reads. */
  readonly cacheReadUsdPerMillionTokens: DecimalUsdPerMillion | null;

  /** Cost per million cached input write tokens. Null if provider does not charge for cache writes. */
  readonly cacheWriteUsdPerMillionTokens: DecimalUsdPerMillion | null;
}

/**
 * Computes exact estimated USD cost for a completed request.
 *
 * Multiplies observed {@link Usage} token counts by the model's {@link PricingConfig}
 * rates using fixed-point `bigint` arithmetic, yielding an exact decimal string without
 * floating-point rounding. Missing counters or null cache rates evaluate to zero cost.
 *
 * @param pricing - Configured model pricing rates per million tokens.
 * @param usage - Observed token counts from the provider or stream accumulator.
 * @returns Exact decimal dollar string without exponent notation (e.g. `"0.00425"`).
 */
export function estimateCostUsd(pricing: PricingConfig, usage: Usage): string {
  const terms = [
    { tokens: BigInt(usage.input), rate: parseRate(pricing.inputUsdPerMillionTokens) },
    { tokens: BigInt(usage.output), rate: parseRate(pricing.outputUsdPerMillionTokens) },
    { tokens: BigInt(usage.cacheReadInput ?? 0), rate: parseRate(pricing.cacheReadUsdPerMillionTokens) },
    { tokens: BigInt(usage.cacheWriteInput ?? 0), rate: parseRate(pricing.cacheWriteUsdPerMillionTokens) },
  ];
  const maxDecimalPlaces = Math.max(...terms.map((term) => term.rate.decimalPlaces));

  // Scale every rate to the widest decimal width and sum integer products
  let numerator = 0n;
  for (const term of terms) {
    const scale = 10n ** BigInt(maxDecimalPlaces - term.rate.decimalPlaces);
    numerator += term.tokens * term.rate.integer * scale;
  }

  // Denominator is 10^(maxDecimalPlaces + 6), where 10^6 accounts for per-million rate normalization
  return formatDecimal(numerator, maxDecimalPlaces + 6);
}

/**
 * Internal intermediate representation of a parsed decimal rate.
 */
interface ParsedRate {
  /** Rate value converted to an integer with the decimal point removed. */
  readonly integer: bigint;
  /** Number of decimal places in the original string. */
  readonly decimalPlaces: number;
}

/**
 * Parses a decimal rate string into an integer and decimal-place count.
 * Returns a zero rate if the input is null.
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
 * Formats a scaled integer numerator divided by 10^denominatorPower into a decimal string,
 * omitting scientific notation and trimming trailing fractional zeros.
 */
function formatDecimal(numerator: bigint, denominatorPower: number): string {
  const divisor = 10n ** BigInt(denominatorPower);
  const whole = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(denominatorPower, "0").replace(/0+$/, "");
  return `${whole}.${fraction}`;
}
