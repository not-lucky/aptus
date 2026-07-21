import { describe, expect, it } from "vitest";

import {
  checkRequiredCapabilities,
  intersectCapabilities,
  unionCapabilities,
} from "../../src/domain/index.js";

describe("intersectCapabilities", () => {
  it("returns the deduplicated, sorted common capabilities", () => {
    expect(
      intersectCapabilities(
        ["tools", "vision", "tools"],
        ["vision", "tools", "mcp"],
      ),
    ).toEqual(["tools", "vision"]);
  });

  it("retains unknown open-string capabilities", () => {
    expect(
      intersectCapabilities(
        ["future-capability", "tools"],
        ["tools", "future-capability"],
      ),
    ).toEqual(["future-capability", "tools"]);
  });

  it("is empty when there is no overlap", () => {
    expect(intersectCapabilities(["tools"], ["vision"])).toEqual([]);
  });
});

describe("unionCapabilities", () => {
  it("returns the deduplicated, sorted union", () => {
    expect(unionCapabilities(["vision", "tools"], ["tools", "mcp"])).toEqual([
      "mcp",
      "tools",
      "vision",
    ]);
  });
});

describe("checkRequiredCapabilities", () => {
  it("is satisfied when required is a subset of supported", () => {
    expect(
      checkRequiredCapabilities(
        ["tools", "vision"],
        ["vision", "tools", "mcp"],
      ),
    ).toEqual({
      satisfied: true,
      missing: [],
    });
  });

  it("reports missing capabilities in deterministic order", () => {
    expect(
      checkRequiredCapabilities(["vision", "reasoning", "tools"], ["tools"]),
    ).toEqual({
      satisfied: false,
      missing: ["reasoning", "vision"],
    });
  });

  it("treats an empty requirement as satisfied", () => {
    expect(checkRequiredCapabilities([], ["tools"])).toEqual({
      satisfied: true,
      missing: [],
    });
  });

  it("detects a missing unknown open-string capability", () => {
    expect(checkRequiredCapabilities(["future-capability"], ["tools"])).toEqual(
      {
        satisfied: false,
        missing: ["future-capability"],
      },
    );
  });
});
