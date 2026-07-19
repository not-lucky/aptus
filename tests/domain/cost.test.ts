import { describe, expect, it } from "vitest";

import type { CostErrorReason, PricesPerMillionUsd, TokenUsage } from "../../src/domain/index.js";
import { billableInputTokens, cacheWriteTokens, calculateCost, zeroCost } from "../../src/domain/index.js";

const PRICES: PricesPerMillionUsd = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 };

function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...overrides };
}

function costOf(u: TokenUsage, prices: PricesPerMillionUsd = PRICES) {
  const result = calculateCost(u, prices);
  if (!result.ok) throw new Error(`unexpected failure: ${result.reason}`);
  return result.cost;
}

describe("zero and dry-run cost", () => {
  it("returns all-zero USD metrics", () => {
    expect(zeroCost()).toEqual({ inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0, currency: "USD" });
    expect(costOf(usage({}))).toEqual(zeroCost());
  });
});

describe("normal and fractional pricing", () => {
  it("prices whole-million token counts", () => {
    const cost = costOf(usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }));
    expect(cost.inputUsd).toBe(2);
    expect(cost.outputUsd).toBe(4);
    expect(cost.totalUsd).toBe(6);
    expect(cost.currency).toBe("USD");
  });

  it("prices fractional-price rates deterministically", () => {
    const cost = costOf(usage({ inputTokens: 500_000, totalTokens: 500_000 }), { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(cost.inputUsd).toBe(0.25);
  });
});

describe("cache accounting", () => {
  it("treats cached input tokens as a subset billed at the cache-read rate", () => {
    const u = usage({ inputTokens: 1_000_000, cachedInputTokens: 400_000, totalTokens: 1_000_000 });
    expect(billableInputTokens(u)).toBe(600_000);
    const cost = costOf(u);
    expect(cost.inputUsd).toBeCloseTo(1.2, 10);
    expect(cost.cacheReadUsd).toBeCloseTo(0.2, 10);
  });

  it("sums a multi-entry cache-write breakdown", () => {
    const u = usage({
      inputTokens: 0,
      totalTokens: 0,
      cacheWriteBreakdown: [
        { ttlSeconds: 300, tokens: 100_000 },
        { ttlSeconds: 3600, tokens: 900_000 },
      ],
    });
    expect(cacheWriteTokens(u)).toBe(1_000_000);
    expect(costOf(u).cacheWriteUsd).toBe(1);
  });
});

describe("uncosted token dimensions", () => {
  it("ignores reasoning, audio, and server-tool usage in cost", () => {
    const u = usage({
      inputTokens: 1_000_000,
      totalTokens: 1_000_000,
      reasoningTokens: 500_000,
      audioOutputTokens: 250_000,
      serverToolUsage: { web_search_requests: 3 },
    });
    expect(costOf(u).totalUsd).toBe(2);
  });
});

describe("invalid and overflowing inputs", () => {
  const cases: [Partial<TokenUsage>, PricesPerMillionUsd, CostErrorReason][] = [
    [{ inputTokens: -1 }, PRICES, "negative_tokens"],
    [{ inputTokens: Number.MAX_SAFE_INTEGER + 1 }, PRICES, "unsafe_token_count"],
    [{ inputTokens: Number.NaN }, PRICES, "unsafe_token_count"],
    [{ inputTokens: 100 }, { ...PRICES, input: Number.NaN }, "non_finite_price"],
    [{ inputTokens: 100 }, { ...PRICES, input: Number.POSITIVE_INFINITY }, "non_finite_price"],
    [{ inputTokens: 100 }, { ...PRICES, input: -1 }, "negative_price"],
    [{ inputTokens: Number.MAX_SAFE_INTEGER, totalTokens: 0 }, { ...PRICES, input: Number.MAX_VALUE }, "non_finite_cost"],
  ];
  it.each(cases)("rejects invalid input %#", (overrides, prices, reason) => {
    const result = calculateCost(usage(overrides), prices);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});
