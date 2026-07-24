import { describe, expect, it } from "vitest";
import {
  CredentialSelectionPolicyError,
  createCredentialSelector,
} from "../../src/application/index.js";
import type {
  CredentialSelectionStrategyName,
  CredentialSelectionSupport,
} from "../../src/application/index.js";
import type { RouteCandidate } from "../../src/domain/index.js";

function candidate(credentialId: string, providerId = "provider"): RouteCandidate {
  return {
    routeId: "route",
    providerId,
    credentialId,
    physicalModel: "model",
    capabilities: new Set(),
    estimatedCostUsd: 0,
  };
}

function fixtureSupport(options: {
  weights?: Readonly<Record<string, number>>;
  connections?: Readonly<Record<string, number>>;
  cursor?: number;
} = {}): CredentialSelectionSupport {
  return {
    weight: (value) => options.weights?.[value.credentialId] ?? 1,
    connections: (value) => options.connections?.[value.credentialId] ?? 0,
    cursor: (_namespace, _length) => options.cursor ?? 0,
  };
}

function ids(values: ReadonlyArray<RouteCandidate>): string[] {
  return values.map(({ credentialId }) => credentialId);
}

describe("credential selectors", () => {
  const input = [candidate("c"), candidate("a"), candidate("b")];

  it.each([
    ["fill-first", ["c", "a", "b"]],
    ["round-robin", ["b", "c", "a"]],
    ["weighted-round-robin", ["b", "c", "a"]],
    ["least-connections", ["a", "b", "c"]],
  ] as const)("orders %s deterministically without input mutation", (strategy, expected) => {
    const original = [...input];
    const support = fixtureSupport({ cursor: 1 });
    const selector = createCredentialSelector(strategy, "provider", support);
    const first = selector.select(input);
    const second = selector.select(input);
    expect(ids(first)).toEqual(expected);
    expect(ids(second)).toEqual(expected);
    expect(input).toEqual(original);
    expect(first).not.toBe(input);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("uses smooth weights and cursor tie-breaking for one snapshot", () => {
    const selector = createCredentialSelector(
      "weighted-round-robin",
      "provider",
      fixtureSupport({ weights: { a: 1, b: 5, c: 2 }, cursor: 0 }),
    );
    expect(ids(selector.select(input))).toEqual(["b", "c", "a"]);
  });

  it("orders least connections then weight then stable key", () => {
    const selector = createCredentialSelector(
      "least-connections",
      "provider",
      fixtureSupport({
        connections: { a: 2, b: 1, c: 1 },
        weights: { a: 9, b: 0, c: 3 },
      }),
    );
    expect(ids(selector.select(input))).toEqual(["c", "b", "a"]);
  });

  it("reflects changed caller snapshots without ambient state", () => {
    let connections: Readonly<Record<string, number>> = { a: 0, b: 1, c: 2 };
    const support: CredentialSelectionSupport = {
      weight: () => 1,
      connections: ({ credentialId }) => connections[credentialId] ?? 0,
      cursor: () => 0,
    };
    const selector = createCredentialSelector("least-connections", "provider", support);
    expect(ids(selector.select(input))).toEqual(["a", "b", "c"]);
    connections = { a: 2, b: 1, c: 0 };
    expect(ids(selector.select(input))).toEqual(["c", "b", "a"]);
  });

  it.each([
    ["round-robin", fixtureSupport({ cursor: -1 })],
    ["weighted-round-robin", fixtureSupport({ weights: { a: 0 } })],
    ["least-connections", fixtureSupport({ connections: { a: NaN } })],
  ] as const)("rejects invalid support for %s safely", (strategy, support) => {
    try {
      createCredentialSelector(
        strategy as CredentialSelectionStrategyName,
        "provider",
        support,
      ).select(input);
      throw new Error("expected selector failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialSelectionPolicyError);
      expect((error as Error).message).toBe(
        "credential selection support is invalid",
      );
    }
  });
});
