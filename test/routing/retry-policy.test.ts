import assert from "node:assert/strict";
import { test } from "vitest";
import type { KeyPoolConfig } from "../../src/config/types.ts";
import {
  calculateRetryDelay,
  MAX_SAME_CANDIDATE_RETRIES,
  RETRYABLE_STATUSES,
  shouldFallback,
  shouldRetry,
} from "../../src/routing/retry-policy.ts";
import { TestRandomSource } from "../helpers/test-timing.ts";

test.concurrent("RETRYABLE_STATUSES contains exactly 429, 500, 503, 529", () => {
  assert.deepEqual([...RETRYABLE_STATUSES].sort(), [429, 500, 503, 529]);
});

test.concurrent("shouldRetry allows retry for retryable status when category matches under cap", () => {
  for (const status of [429, 500, 503, 529]) {
    const result = shouldRetry({
      status,
      category: "rate_limit",
      beforeClientBytes: true,
      candidateAttemptCount: 1, // attempt 1 failed -> retry #1 allowed
      retryOn: ["rate_limit", "unavailable"],
    });
    assert.equal(result, true);
  }

  // Attempt 2 failed -> retry #2 allowed (attempt 3 will run)
  assert.equal(
    shouldRetry({
      status: 503,
      category: "unavailable",
      beforeClientBytes: true,
      candidateAttemptCount: 2,
      retryOn: ["unavailable"],
    }),
    true,
  );
});

test.concurrent("shouldRetry rejects retry after attempt cap is reached", () => {
  // candidateAttemptCount = 3 means 3 attempts have been performed (initial + 2 retries)
  assert.equal(
    shouldRetry({
      status: 503,
      category: "unavailable",
      beforeClientBytes: true,
      candidateAttemptCount: 3,
      retryOn: ["unavailable"],
    }),
    false,
  );
  assert.equal(
    shouldRetry({
      status: 429,
      category: "rate_limit",
      beforeClientBytes: true,
      candidateAttemptCount: MAX_SAME_CANDIDATE_RETRIES + 1,
      retryOn: ["rate_limit"],
    }),
    false,
  );
});

test.concurrent("shouldRetry rejects non-retryable statuses", () => {
  for (const status of [400, 401, 403, 404, 408, 422, 502, 504]) {
    const result = shouldRetry({
      status,
      category: "provider",
      beforeClientBytes: true,
      candidateAttemptCount: 1,
      retryOn: ["provider", "timeout", "rate_limit", "unavailable"],
    });
    assert.equal(result, false, `Status ${status} should not be retryable`);
  }
});

test.concurrent("shouldRetry rejects when status is undefined (e.g. transport error)", () => {
  assert.equal(
    shouldRetry({
      status: undefined,
      category: "provider",
      beforeClientBytes: true,
      candidateAttemptCount: 1,
      retryOn: ["provider"],
    }),
    false,
  );
});

test.concurrent("shouldRetry rejects once client bytes have been written", () => {
  assert.equal(
    shouldRetry({
      status: 500,
      category: "provider",
      beforeClientBytes: false,
      candidateAttemptCount: 1,
      retryOn: ["provider"],
    }),
    false,
  );
});

test.concurrent("shouldRetry rejects when category is not in retryOn", () => {
  assert.equal(
    shouldRetry({
      status: 500,
      category: "provider",
      beforeClientBytes: true,
      candidateAttemptCount: 1,
      retryOn: ["rate_limit", "unavailable"],
    }),
    false,
  );
});

test.concurrent("shouldRetry rejects success and client_cancelled", () => {
  assert.equal(
    shouldRetry({
      status: 200,
      category: "success",
      beforeClientBytes: true,
      candidateAttemptCount: 1,
      retryOn: ["rate_limit", "unavailable"],
    }),
    false,
  );
  assert.equal(
    shouldRetry({
      category: "client_cancelled",
      beforeClientBytes: true,
      candidateAttemptCount: 1,
      retryOn: ["rate_limit", "unavailable"],
    }),
    false,
  );
});

test.concurrent("shouldFallback allows fallback when category in fallbackOn, before bytes, and next candidate exists", () => {
  assert.equal(
    shouldFallback({
      category: "unavailable",
      beforeClientBytes: true,
      hasNextCandidate: true,
      fallbackOn: ["unavailable", "timeout"],
    }),
    true,
  );

  assert.equal(
    shouldFallback({
      category: "timeout",
      beforeClientBytes: true,
      hasNextCandidate: true,
      fallbackOn: ["timeout"],
    }),
    true,
  );
});

test.concurrent("shouldFallback rejects fallback if client bytes written, no next candidate, or category not in fallbackOn", () => {
  // After client bytes
  assert.equal(
    shouldFallback({
      category: "unavailable",
      beforeClientBytes: false,
      hasNextCandidate: true,
      fallbackOn: ["unavailable"],
    }),
    false,
  );

  // No next candidate
  assert.equal(
    shouldFallback({
      category: "unavailable",
      beforeClientBytes: true,
      hasNextCandidate: false,
      fallbackOn: ["unavailable"],
    }),
    false,
  );

  // Category not in fallbackOn
  assert.equal(
    shouldFallback({
      category: "provider",
      beforeClientBytes: true,
      hasNextCandidate: true,
      fallbackOn: ["unavailable", "timeout"],
    }),
    false,
  );

  // Success or client_cancelled
  assert.equal(
    shouldFallback({
      category: "success",
      beforeClientBytes: true,
      hasNextCandidate: true,
      fallbackOn: ["unavailable"],
    }),
    false,
  );
  assert.equal(
    shouldFallback({
      category: "client_cancelled",
      beforeClientBytes: true,
      hasNextCandidate: true,
      fallbackOn: ["unavailable"],
    }),
    false,
  );
});

test.concurrent("calculateRetryDelay honors delay, maxRetryAfterMs cap, and uniform jitter", () => {
  const config: KeyPoolConfig = {
    failureCooldownMs: [250, 1000],
    rateLimitFallbackMs: 1000,
    maxRetryAfterMs: 5000,
    jitterRatio: 0.5,
  };

  // With 0 jitter: base = min(2000, 5000) = 2000
  const randomZero = new TestRandomSource([0]);
  const delayZero = calculateRetryDelay(2000, config, randomZero);
  assert.equal(delayZero, 2000);

  // With jitter 0.5: jitter = 0.5 * (0.5 * 2000) = 500 => 2500
  const randomHalf = new TestRandomSource([0.5]);
  const delayHalf = calculateRetryDelay(2000, config, randomHalf);
  assert.equal(delayHalf, 2500);

  // Delay exceeding maxRetryAfterMs: base capped at 5000, jitter = 0.5 * (0.5 * 5000) = 1250 => 6250
  const delayCapped = calculateRetryDelay(60000, config, randomHalf);
  assert.equal(delayCapped, 6250);

  // Undefined delay uses rateLimitFallbackMs (1000), 0 jitter => 1000
  const delayFallback = calculateRetryDelay(undefined, config, randomZero);
  assert.equal(delayFallback, 1000);
});
