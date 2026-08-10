import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderKeyConfig, SecretString } from "../../src/config/types.ts";
import type { KeyLease } from "../../src/domain/contracts.ts";
import { createKeyPool } from "../../src/routing/key-pool.ts";

// Deterministic linear congruential generator so property failures reproduce
// exactly from the fixed seed below ("Pure contract tests": seeded/fixed random values).
const RANDOM_SEED = 0x41505455;

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

const random = createSeededRandom(RANDOM_SEED);

test.concurrent("property: key pool state transitions preserve safety invariants under arbitrary interleavings", () => {
  const keyConfigs: ProviderKeyConfig[] = [
    { name: "k1", secret: "s1" as SecretString, enabled: true },
    { name: "k2", secret: "s2" as SecretString, enabled: true },
    { name: "k3", secret: "s3" as SecretString, enabled: true },
    { name: "k4", secret: "s4" as SecretString, enabled: false }, // permanently disabled
  ];

  for (const strategy of ["fill-first", "round-robin"] as const) {
    const pool = createKeyPool("provider-p", keyConfigs, strategy, {
      failureCooldownMs: [100, 500],
      rateLimitFallbackMs: 200,
      maxRetryAfterMs: 2000,
      jitterRatio: 0.2,
    });

    let currentNowMs = 0;
    const activeLeases: KeyLease[] = [];
    const highestGenerationByKey = new Map<string, number>();

    for (let step = 0; step < 1000; step++) {
      // Advance time randomly
      const timeDelta = randomInt(0, 150);
      currentNowMs += timeDelta;

      const action = randomInt(0, 2);

      if (action === 0 || activeLeases.length === 0) {
        // Perform acquire
        const availableCountBefore = pool.availableCount(currentNowMs);
        const result = pool.acquire(currentNowMs);

        if (availableCountBefore > 0) {
          assert.equal(result.kind, "acquired", `Expected acquired when availableCount is ${availableCountBefore}`);
          const lease = result.lease;
          assert.ok(lease.generation > 0);

          const prevGen = highestGenerationByKey.get(lease.keyName) ?? 0;
          assert.ok(
            lease.generation > prevGen,
            `Generation for key ${lease.keyName} must strictly increase (was ${prevGen}, got ${lease.generation})`,
          );
          highestGenerationByKey.set(lease.keyName, lease.generation);

          activeLeases.push(lease);
        } else {
          assert.ok(result.kind === "wait" || result.kind === "unavailable");
          if (result.kind === "wait") {
            assert.ok(
              result.untilMs > currentNowMs,
              `Wait untilMs (${result.untilMs}) must be in the future of ${currentNowMs}`,
            );
          }
        }
      } else {
        // Perform observe on a random active or stale lease
        const leaseIndex = randomInt(0, activeLeases.length - 1);
        const lease = activeLeases[leaseIndex];
        if (lease !== undefined) {
          const outcomeType = randomInt(0, 4);
          if (outcomeType === 0) {
            pool.observe(lease, { result: "success", beforeClientBytes: true }, currentNowMs);
          } else if (outcomeType === 1) {
            pool.observe(lease, { result: "client_cancelled", beforeClientBytes: true }, currentNowMs);
          } else if (outcomeType === 2) {
            pool.observe(lease, { result: "invalid_request", status: 400, beforeClientBytes: true }, currentNowMs);
          } else if (outcomeType === 3) {
            pool.observe(
              lease,
              { result: "rate_limit", status: 429, retryDelayMs: randomInt(50, 400), beforeClientBytes: true },
              currentNowMs,
            );
          } else {
            pool.observe(lease, { result: "provider", status: 500, beforeClientBytes: true }, currentNowMs);
          }
        }
      }

      // Assert invariant: availableCount must never exceed enabled key count
      const count = pool.availableCount(currentNowMs);
      assert.ok(count >= 0 && count <= 3, `Available count must be between 0 and 3, got ${count}`);
    }
  }
});
