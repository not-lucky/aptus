import { describe, expect, it } from "vitest";

import type { GatewayErrorCategory, UpstreamClassification } from "../../src/domain/index.js";
import {
  REDACTION_PLACEHOLDER,
  classifyUpstreamStatus,
  costFailureToError,
  createGatewayError,
  defaultRetryableForCategory,
  defaultStatusForCategory,
} from "../../src/domain/index.js";

const CATEGORIES: [GatewayErrorCategory, number, boolean][] = [
  ["validation", 400, false],
  ["authentication", 401, false],
  ["authorization", 403, false],
  ["rate_limit", 429, true],
  ["upstream", 502, true],
  ["timeout", 504, true],
  ["routing", 503, true],
  ["internal", 500, false],
];

describe("category defaults", () => {
  it.each(CATEGORIES)("maps %s to status %i and retryable %s", (category, status, retryable) => {
    expect(defaultStatusForCategory(category)).toBe(status);
    expect(defaultRetryableForCategory(category)).toBe(retryable);
  });
});

describe("createGatewayError", () => {
  it.each(CATEGORIES)("builds a complete %s error with defaults", (category, status, retryable) => {
    const error = createGatewayError({ category, code: `${category}_code`, message: "safe message", requestId: "req_1" });
    expect(error).toEqual({
      code: `${category}_code`,
      message: "safe message",
      category,
      retryable,
      status,
      requestId: "req_1",
    });
  });

  it("honors explicit status and retryable overrides", () => {
    const error = createGatewayError({
      category: "rate_limit",
      code: "slow_down",
      message: "safe",
      requestId: "req_1",
      status: 503,
      retryable: false,
    });
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(false);
  });

  it("omits optional fields entirely rather than setting undefined", () => {
    const error = createGatewayError({ category: "internal", code: "x", message: "y", requestId: "req_1" });
    expect("providerId" in error).toBe(false);
    expect("credentialId" in error).toBe(false);
    expect("retryAfterMs" in error).toBe(false);
    expect("details" in error).toBe(false);
  });

  it("includes provided optional fields", () => {
    const error = createGatewayError({
      category: "upstream",
      code: "x",
      message: "y",
      requestId: "req_1",
      retryAfterMs: 1000,
      providerId: "openai-us",
      credentialId: "cred-1",
    });
    expect(error.retryAfterMs).toBe(1000);
    expect(error.providerId).toBe("openai-us");
    expect(error.credentialId).toBe("cred-1");
  });

  it("recursively redacts details and never leaks a secret", () => {
    const error = createGatewayError({
      category: "authentication",
      code: "bad_token",
      message: "Authentication failed.",
      requestId: "req_1",
      details: { authorization: "Bearer super-secret", nested: { apiKey: "sk-leak", ok: 1 } },
    });
    expect(error.details).toEqual({ authorization: REDACTION_PLACEHOLDER, nested: { apiKey: REDACTION_PLACEHOLDER, ok: 1 } });
    expect(JSON.stringify(error)).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("sk-leak");
  });
});

describe("classifyUpstreamStatus", () => {
  const cases: [number, UpstreamClassification][] = [
    [400, { category: "upstream", retryable: false, status: 502 }],
    [401, { category: "authentication", retryable: false, status: 401 }],
    [403, { category: "authorization", retryable: false, status: 403 }],
    [404, { category: "upstream", retryable: false, status: 502 }],
    [409, { category: "upstream", retryable: false, status: 502 }],
    [413, { category: "validation", retryable: false, status: 413 }],
    [415, { category: "validation", retryable: false, status: 415 }],
    [422, { category: "upstream", retryable: false, status: 422 }],
    [429, { category: "rate_limit", retryable: true, status: 429 }],
    [500, { category: "upstream", retryable: true, status: 502 }],
    [502, { category: "upstream", retryable: true, status: 502 }],
    [503, { category: "upstream", retryable: true, status: 503 }],
    [504, { category: "timeout", retryable: true, status: 504 }],
    [451, { category: "upstream", retryable: false, status: 502 }],
    [599, { category: "upstream", retryable: true, status: 502 }],
  ];
  it.each(cases)("classifies upstream %i", (status, expected) => {
    expect(classifyUpstreamStatus(status)).toEqual(expected);
  });

  it("applies the route status policy override in both directions", () => {
    expect(classifyUpstreamStatus(500, { retryable: [], nonRetryable: [500] }).retryable).toBe(false);
    expect(classifyUpstreamStatus(400, { retryable: [400], nonRetryable: [] }).retryable).toBe(true);
  });
});

describe("costFailureToError", () => {
  it("lifts a cost failure into a redacted internal error", () => {
    const error = costFailureToError("non_finite_cost", "req_1");
    expect(error.category).toBe("internal");
    expect(error.code).toBe("cost_calculation_failed");
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_1");
    expect(error.details).toEqual({ reason: "non_finite_cost" });
  });
});
