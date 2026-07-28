import assert from "node:assert/strict";
import { test } from "vitest";
import type { KeyPoolConfig, ProviderKeyConfig, SecretString } from "../../src/config/types.js";
import { createKeyPool } from "../../src/routing/key-pool.js";
import { TestRandomSource } from "../helpers/test-timing.js";

const DEFAULT_CONFIG: KeyPoolConfig = {
  failureCooldownMs: [500, 2000],
  rateLimitFallbackMs: 1000,
  maxRetryAfterMs: 10000,
  jitterRatio: 0.25,
};

function keys(count: number, enabledFlags: boolean[] = []): ProviderKeyConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `key-${i + 1}`,
    secret: `secret-${i + 1}` as SecretString,
    enabled: enabledFlags[i] ?? true,
  }));
}

test("fill-first strategy always selects first available enabled key and recovers to it", () => {
  const pool = createKeyPool("provider-a", keys(3), "fill-first", DEFAULT_CONFIG, new TestRandomSource([0]));

  // Acquire 1st key
  const acq1 = pool.acquire(100);
  assert.equal(acq1.kind, "acquired");
  assert.equal(acq1.lease.keyName, "key-1");
  assert.equal(acq1.lease.generation, 1);

  // Key 1 fails -> cooldown until 100 + 500 = 600
  pool.observe(acq1.lease, { result: "provider", beforeClientBytes: true }, 100);
  assert.equal(pool.availableCount(100), 2);

  // While key 1 is cooling down (at t=200), fill-first selects key 2
  const acq2 = pool.acquire(200);
  assert.equal(acq2.kind, "acquired");
  assert.equal(acq2.lease.keyName, "key-2");

  // After key 1 cools down (at t=700), fill-first recovers back to key 1
  const acq3 = pool.acquire(700);
  assert.equal(acq3.kind, "acquired");
  assert.equal(acq3.lease.keyName, "key-1");
});

test("round-robin strategy advances cursor across enabled keys and skips cooled keys", () => {
  const pool = createKeyPool("provider-b", keys(3), "round-robin", DEFAULT_CONFIG, new TestRandomSource([0]));

  const acq1 = pool.acquire(100);
  assert.equal(acq1.kind, "acquired");
  assert.equal(acq1.lease.keyName, "key-1");

  const acq2 = pool.acquire(100);
  assert.equal(acq2.kind, "acquired");
  assert.equal(acq2.lease.keyName, "key-2");

  // Key 3 fails and cools until 600
  const acq3 = pool.acquire(100);
  assert.equal(acq3.kind, "acquired");
  assert.equal(acq3.lease.keyName, "key-3");
  pool.observe(acq3.lease, { result: "provider", beforeClientBytes: true }, 100);

  // Next round-robin wraps to key-1
  const acq4 = pool.acquire(200);
  assert.equal(acq4.kind, "acquired");
  assert.equal(acq4.lease.keyName, "key-1");

  // Next is key-2
  const acq5 = pool.acquire(200);
  assert.equal(acq5.kind, "acquired");
  assert.equal(acq5.lease.keyName, "key-2");

  // Next would be key-3, but key-3 is cooling down (at t=200), so it skips to key-1
  const acq6 = pool.acquire(200);
  assert.equal(acq6.kind, "acquired");
  assert.equal(acq6.lease.keyName, "key-1");
});

test("server and transport failures escalate cooldown through bounded rungs and success resets", () => {
  const pool = createKeyPool("provider-c", keys(1), "fill-first", DEFAULT_CONFIG, new TestRandomSource([0]));

  // Failure 1: rung 0 -> 500ms cooldown
  const acq1 = pool.acquire(1000);
  assert.equal(acq1.kind, "acquired");
  pool.observe(acq1.lease, { result: "provider", beforeClientBytes: true }, 1000);

  assert.deepEqual(pool.acquire(1200), { kind: "wait", untilMs: 1500 });
  assert.equal(pool.availableCount(1200), 0);
  assert.equal(pool.availableCount(1500), 1);

  // Failure 2: rung 1 -> 2000ms cooldown (min(2-1, 1) = index 1)
  const acq2 = pool.acquire(1500);
  assert.equal(acq2.kind, "acquired");
  pool.observe(acq2.lease, { result: "provider", beforeClientBytes: true }, 1500);

  assert.deepEqual(pool.acquire(2000), { kind: "wait", untilMs: 3500 });

  // Failure 3: still rung 1 -> 2000ms cooldown (bounded, no further escalation)
  const acq3 = pool.acquire(3500);
  assert.equal(acq3.kind, "acquired");
  pool.observe(acq3.lease, { result: "provider", beforeClientBytes: true }, 3500);

  assert.deepEqual(pool.acquire(4000), { kind: "wait", untilMs: 5500 });

  // Success resets streak to 0 and clears cooldown
  const acq4 = pool.acquire(5500);
  assert.equal(acq4.kind, "acquired");
  pool.observe(acq4.lease, { result: "success", beforeClientBytes: true }, 5500);

  // Next failure after success is rung 0 again (500ms)
  const acq5 = pool.acquire(6000);
  assert.equal(acq5.kind, "acquired");
  pool.observe(acq5.lease, { result: "provider", beforeClientBytes: true }, 6000);
  assert.deepEqual(pool.acquire(6100), { kind: "wait", untilMs: 6500 });
});

test("4xx non-429 responses and client cancellation do not cool the key", () => {
  const pool = createKeyPool("provider-d", keys(1), "fill-first", DEFAULT_CONFIG);

  const acq1 = pool.acquire(100);
  assert.equal(acq1.kind, "acquired");
  // 400 Bad Request
  pool.observe(acq1.lease, { result: "invalid_request", status: 400, beforeClientBytes: true }, 100);

  // Key is immediately available
  const acq2 = pool.acquire(101);
  assert.equal(acq2.kind, "acquired");

  // Client cancellation
  pool.observe(acq2.lease, { result: "client_cancelled", beforeClientBytes: true }, 101);
  const acq3 = pool.acquire(102);
  assert.equal(acq3.kind, "acquired");
});

test("429 honors retryDelayMs, rateLimitFallbackMs, maxRetryAfterMs, and jitter", () => {
  const config: KeyPoolConfig = {
    failureCooldownMs: [500, 2000],
    rateLimitFallbackMs: 2000,
    maxRetryAfterMs: 5000,
    jitterRatio: 0.5,
  };

  // 1. Observed retryDelayMs with 0 jitter
  const pool1 = createKeyPool("provider-e", keys(1), "fill-first", config, new TestRandomSource([0]));
  const acq1 = pool1.acquire(100);
  assert.equal(acq1.kind, "acquired");
  pool1.observe(acq1.lease, { result: "rate_limit", status: 429, retryDelayMs: 3000, beforeClientBytes: true }, 100);
  assert.deepEqual(pool1.acquire(200), { kind: "wait", untilMs: 3100 });

  // 2. Observed retryDelayMs with jitter 0.5 (0.5 * 0.5 * 3000 = 750 => delay 3750)
  const pool2 = createKeyPool("provider-e", keys(1), "fill-first", config, new TestRandomSource([0.5]));
  const acq2 = pool2.acquire(100);
  assert.equal(acq2.kind, "acquired");
  pool2.observe(acq2.lease, { result: "rate_limit", status: 429, retryDelayMs: 3000, beforeClientBytes: true }, 100);
  assert.deepEqual(pool2.acquire(200), { kind: "wait", untilMs: 3850 });

  // 3. 429 without retryDelayMs uses rateLimitFallbackMs (2000)
  const pool3 = createKeyPool("provider-e", keys(1), "fill-first", config, new TestRandomSource([0]));
  const acq3 = pool3.acquire(100);
  assert.equal(acq3.kind, "acquired");
  pool3.observe(acq3.lease, { result: "rate_limit", status: 429, beforeClientBytes: true }, 100);
  assert.deepEqual(pool3.acquire(200), { kind: "wait", untilMs: 2100 });

  // 4. retryDelayMs exceeding maxRetryAfterMs (5000) is capped before jitter
  const pool4 = createKeyPool("provider-e", keys(1), "fill-first", config, new TestRandomSource([0]));
  const acq4 = pool4.acquire(100);
  assert.equal(acq4.kind, "acquired");
  pool4.observe(acq4.lease, { result: "rate_limit", status: 429, retryDelayMs: 60000, beforeClientBytes: true }, 100);
  assert.deepEqual(pool4.acquire(200), { kind: "wait", untilMs: 5100 });
});

test("stale lease generation observations are ignored", () => {
  const pool = createKeyPool("provider-f", keys(1), "fill-first", DEFAULT_CONFIG);

  const acq1 = pool.acquire(100);
  assert.equal(acq1.kind, "acquired");
  assert.equal(acq1.lease.generation, 1);

  // Key is acquired again (e.g. at t=200), incrementing generation to 2
  const acq2 = pool.acquire(200);
  assert.equal(acq2.kind, "acquired");
  assert.equal(acq2.lease.generation, 2);

  // Stale observation with generation 1 fails => ignored!
  pool.observe(acq1.lease, { result: "provider", beforeClientBytes: true }, 250);

  // Key was NOT cooled down by the stale observation
  const acq3 = pool.acquire(260);
  assert.equal(acq3.kind, "acquired");
  assert.equal(acq3.lease.generation, 3);
});

test("all-keys-cooling yields wait result; no-enabled-keys yields unavailable", () => {
  // All keys disabled
  const emptyPool = createKeyPool("provider-g", keys(2, [false, false]), "fill-first", DEFAULT_CONFIG);
  assert.deepEqual(emptyPool.acquire(100), { kind: "unavailable" });
  assert.equal(emptyPool.availableCount(100), 0);

  // 2 keys cooling down
  const pool = createKeyPool("provider-g", keys(2), "fill-first", DEFAULT_CONFIG, new TestRandomSource([0]));
  const k1 = pool.acquire(100);
  assert.equal(k1.kind, "acquired");
  pool.observe(k1.lease, { result: "provider", beforeClientBytes: true }, 100); // until 600

  const k2 = pool.acquire(100);
  assert.equal(k2.kind, "acquired");
  pool.observe(k2.lease, { result: "provider", beforeClientBytes: true }, 200); // until 700

  // Earliest expiration is 600
  assert.deepEqual(pool.acquire(300), { kind: "wait", untilMs: 600 });
  assert.equal(pool.availableCount(300), 0);

  // At t=600, 1 key is available
  assert.equal(pool.availableCount(600), 1);
  const k1Recovered = pool.acquire(600);
  assert.equal(k1Recovered.kind, "acquired");
  assert.equal(k1Recovered.lease.keyName, "key-1");
});
