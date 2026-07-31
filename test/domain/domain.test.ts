import assert from "node:assert/strict";
import { test } from "vitest";
import { isPublicName } from "../../src/domain/names.ts";
import { estimateCostUsd, type PricingConfig } from "../../src/domain/pricing.ts";
import { createRequestId } from "../../src/domain/request-id.ts";

test("isPublicName: valid names", () => {
  assert.equal(isPublicName("gpt-main"), true);
  assert.equal(isPublicName("a.b-c_d"), true);
  assert.equal(isPublicName("a".repeat(128)), true);
  assert.equal(isPublicName("A"), true);
});

test("isPublicName: invalid names", () => {
  assert.equal(isPublicName("-x"), false);
  assert.equal(isPublicName(""), false);
  assert.equal(isPublicName("a".repeat(129)), false);
  assert.equal(isPublicName("gpt main"), false);
  assert.equal(isPublicName("gpt/main"), false);
  assert.equal(isPublicName("1"), true); // Leading digits are legal.
});

test("createRequestId: unique across 100 calls", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const id = createRequestId();
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
    seen.add(id);
  }
  assert.equal(seen.size, 100);
});

function pricing(overrides: Partial<PricingConfig> = {}): PricingConfig {
  return {
    inputUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    cacheReadUsdPerMillionTokens: null,
    cacheWriteUsdPerMillionTokens: null,
    ...overrides,
  };
}

test("estimateCostUsd: plan formula splits exactly", () => {
  // 1,000,000 input tokens at 0.10 and 1,000,000 output tokens at 0.20.
  assert.equal(
    estimateCostUsd(pricing({ inputUsdPerMillionTokens: "0.1", outputUsdPerMillionTokens: "0.2" }), {
      input: 1_000_000,
      output: 1_000_000,
    }),
    "0.3",
  );
});

test("estimateCostUsd: one million tokens at 2.50", () => {
  assert.equal(estimateCostUsd(pricing({ inputUsdPerMillionTokens: "2.50" }), { input: 1_000_000, output: 0 }), "2.5");
});

test("estimateCostUsd: null cache prices contribute zero", () => {
  assert.equal(
    estimateCostUsd(pricing(), {
      input: 0,
      output: 0,
      cacheReadInput: 1_000_000,
      cacheWriteInput: 1_000_000,
    }),
    "0",
  );
});

test("estimateCostUsd: cache inputs count at their own prices", () => {
  assert.equal(
    estimateCostUsd(pricing({ cacheReadUsdPerMillionTokens: "0.25", cacheWriteUsdPerMillionTokens: "0.5" }), {
      input: 0,
      output: 0,
      cacheReadInput: 1_000_000,
      cacheWriteInput: 500_000,
    }),
    "0.5",
  );
});

test("estimateCostUsd: zero usage is zero", () => {
  assert.equal(estimateCostUsd(pricing(), { input: 0, output: 0 }), "0");
});

test("estimateCostUsd: mixed usage sums all four terms", () => {
  const cost = estimateCostUsd(
    pricing({
      inputUsdPerMillionTokens: "1",
      outputUsdPerMillionTokens: "2",
      cacheReadUsdPerMillionTokens: "0.25",
      cacheWriteUsdPerMillionTokens: "0.5",
    }),
    { input: 500_000, output: 250_000, cacheReadInput: 100_000, cacheWriteInput: 50_000 },
  );
  // 0.5 + 0.5 + 0.025 + 0.025 = 1.05
  assert.equal(cost, "1.05");
});

test("estimateCostUsd: exact decimal never emits scientific notation or float artifacts", () => {
  // IEEE-754 computes 0.1 + 0.2 = 0.30000000000000004, and dividing by 1e6 would render
  // as "3.0000000000000004e-7". Exact decimal fixed-point arithmetic must yield the true value.
  assert.equal(
    estimateCostUsd(pricing({ inputUsdPerMillionTokens: "0.1", outputUsdPerMillionTokens: "0.2" }), {
      input: 1,
      output: 1,
    }),
    "0.0000003",
  );
  // A rate with five decimal places also stays exact and never uses scientific notation.
  assert.equal(
    estimateCostUsd(pricing({ inputUsdPerMillionTokens: "0.12345" }), { input: 1_000_000, output: 0 }),
    "0.12345",
  );
});
