import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { StreamToolArgumentsBudget } from "../../../src/translation/codecs/shared/stream-limits.ts";

describe("StreamToolArgumentsBudget", () => {
  it("claims fragments within budget", () => {
    const budget = new StreamToolArgumentsBudget();
    assert.equal(budget.claim('{"query":').ok, true);
    assert.equal(budget.claim(' "hello"}').ok, true);
  });

  it("handles multi-byte UTF-8 characters properly", () => {
    const budget = new StreamToolArgumentsBudget(10);
    assert.equal(budget.claim("🚀").ok, true);
    assert.equal(budget.claim("€").ok, true);
    assert.equal(budget.claim("a").ok, true);

    const overflow = budget.claim("€");
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.error.category, "payload_too_large");
  });

  it("enforces exact byte limit boundary", () => {
    const budget = new StreamToolArgumentsBudget(5);
    assert.equal(budget.claim("12345").ok, true);
    const overflow = budget.claim("6");
    assert.equal(overflow.ok, false);
    if (!overflow.ok) {
      assert.equal(overflow.error.category, "payload_too_large");
    }
  });

  it("enforces shared stream-wide budget across multiple accumulators", () => {
    const budget = new StreamToolArgumentsBudget(10);
    assert.equal(budget.claim("123456").ok, true);
    assert.equal(budget.claim("abcd").ok, true);
    const overflow = budget.claim("x");
    assert.equal(overflow.ok, false);
  });
});
