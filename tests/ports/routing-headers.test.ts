import { describe, expect, it } from "vitest";
import {
  MAX_TRUSTED_REQUIRED_CAPABILITIES,
  MAX_TRUSTED_ROUTING_COST_USD,
  MAX_TRUSTED_ROUTING_LATENCY_MS,
  mergeTrustedRoutingOverrides,
  parseTrustedRoutingHeaders,
} from "../../src/ports/routing-headers.js";

const requestId = "header-test";

function parse(
  headers: Record<string, string | readonly string[]>,
  trusted = true,
) {
  return parseTrustedRoutingHeaders({ trusted, headers, requestId });
}

describe("trusted routing headers", () => {
  it("ignores all headers when trust is not explicitly established", () => {
    const result = parse(
      {
        "x-gateway-model-alias": "attacker-model",
        "x-gateway-route": "attacker-route",
        "x-gateway-max-cost-usd": "0",
        "x-gateway-required-capability": ["tools"],
        "x-forwarded-for": "attacker",
        "x-provider-api-key": "secret",
      },
      false,
    );
    expect(result.routing).toEqual({});
    expect(result.headers).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("parses every supported override and normalizes repeat capabilities", () => {
    const result = parse({
      "x-gateway-model-alias": "fast",
      "x-gateway-route": "route-a",
      "x-gateway-max-cost-usd": "0",
      "x-gateway-max-latency-ms": "1000",
      "x-gateway-dry-run": "true",
      "x-gateway-required-capability": ["tools", "vision", "tools\njson"],
      "x-provider-mode": "must-not-appear",
    });
    expect(result.routing).toEqual({
      modelAlias: "fast",
      overrideRoute: "route-a",
      maxCostUsd: 0,
      maxLatencyMs: 1000,
      dryRun: true,
      requiredCapabilities: ["tools", "vision", "json"],
    });
    expect(result.headers).toEqual({
      "x-gateway-model-alias": "fast",
      "x-gateway-route": "route-a",
      "x-gateway-max-cost-usd": "0",
      "x-gateway-max-latency-ms": "1000",
      "x-gateway-dry-run": "true",
      "x-gateway-required-capability": "tools\nvision\njson",
    });
    expect(Object.isFrozen(result.headers)).toBe(true);
    expect(Object.isFrozen(result.routing)).toBe(true);
    expect(Object.isFrozen(result.routing.requiredCapabilities)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("provider");
  });

  it("merges trusted values over JSON routing and freezes nested arrays", () => {
    const base = {
      modelAlias: "json",
      preferredProviders: ["p1"],
      requiredCapabilities: ["json"],
    };
    const overrides = parse({
      "x-gateway-model-alias": "trusted",
      "x-gateway-required-capability": "tools\ntools\nvision",
    }).routing;
    const merged = mergeTrustedRoutingOverrides(base, overrides);
    expect(merged).toEqual({
      modelAlias: "trusted",
      preferredProviders: ["p1"],
      requiredCapabilities: ["tools", "vision"],
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.preferredProviders)).toBe(true);
    expect(Object.isFrozen(merged.requiredCapabilities)).toBe(true);
    expect(base.preferredProviders).toEqual(["p1"]);
  });

  it("rejects malformed values atomically with a safe typed validation error", () => {
    const bad = {
      "x-gateway-model-alias": "good",
      "x-gateway-max-cost-usd": "not-a-number",
      "x-gateway-route": "also-good",
    };
    let failure: unknown;
    try {
      parse(bad);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "invalid_trusted_routing_headers",
      category: "validation",
      status: 400,
      requestId,
    });
    expect(() => parse({ "x-gateway-dry-run": "yes" })).toThrowError();
    expect(() => parse({ "x-gateway-max-latency-ms": "0" })).toThrowError();
    expect(() =>
      parse({
        "x-gateway-max-cost-usd": String(MAX_TRUSTED_ROUTING_COST_USD + 1),
      }),
    ).toThrowError();
    expect(() =>
      parse({
        "x-gateway-max-latency-ms": String(MAX_TRUSTED_ROUTING_LATENCY_MS + 1),
      }),
    ).toThrowError();
    expect(() =>
      parse({ "x-gateway-model-alias": ["array-is-not-scalar"] }),
    ).toThrowError();
  });

  it("caps raw repeated capability values before dedupe", () => {
    const repeated = Array.from(
      { length: MAX_TRUSTED_REQUIRED_CAPABILITIES + 1 },
      () => "tools",
    );
    expect(() =>
      parse({ "x-gateway-required-capability": repeated }),
    ).toThrowError();
    expect(() =>
      parse({
        "x-gateway-required-capability": "tools\n".repeat(
          MAX_TRUSTED_REQUIRED_CAPABILITIES + 1,
        ),
      }),
    ).toThrowError();
  });
});
