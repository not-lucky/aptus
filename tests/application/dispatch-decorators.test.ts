import { describe, expect, it } from "vitest";
import { DispatchBudgetLedger, composeProviderDispatch } from "../../src/application/index.js";
import type { CanonicalRequest, CanonicalResponse, RouteCandidate } from "../../src/domain/index.js";
import type { CredentialStatePort, ProviderDispatchPort } from "../../src/ports/index.js";

const candidate: RouteCandidate = { routeId: "route", providerId: "provider", credentialId: "secret-credential", physicalModel: "model", capabilities: new Set(), estimatedCostUsd: 0.1 };
const request = { requestId: "req-decorator", receivedAt: "2026-07-21T00:00:00Z", source: { adapter: "test", protocol: "custom", path: "/" }, model: "model", messages: [], routing: {}, stream: false } satisfies CanonicalRequest;
const response: CanonicalResponse = { requestId: request.requestId, responseId: "response", createdAt: request.receivedAt, model: request.model, status: "completed", choices: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: { inputUsd: 0.1, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0.1, currency: "USD" }, provider: { providerId: "provider", credentialId: "secret-credential", physicalModel: "model", responseHeaders: {}, upstreamStatus: 200 } };
const clock = { now: () => 0, sleep: async (_delay: number, signal: AbortSignal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } };
const credentials: CredentialStatePort = { state: () => "active", snapshot: () => ({ state: "active", penaltyCount: 0 }), eligible: () => true, hasEligible: () => true, counts: () => ({ active: 1, cooldown: 0, critical_failure: 0, suspended: 0 }), failure: () => ({ state: "active", delayMs: 0, retryable: true }), success: () => undefined, quarantine: () => undefined, reset: () => undefined, probe: () => undefined };

describe("composeProviderDispatch", () => {
  it("forwards once, records a bounded redacted attempt, and omits credential/body traces", async () => {
    let calls = 0;
    const traces: unknown[] = [];
    const leaf: ProviderDispatchPort = { dispatch: async (actualCandidate, actualRequest) => { calls += 1; expect(actualCandidate).toBe(candidate); expect(actualRequest).toBe(request); return response; }, stream: async function* () { yield { type: "response_end", status: "completed" }; } };
    const ledger = new DispatchBudgetLedger({ maxAttempts: 1, maxLatencyMs: 1000, maxCostUsd: 1 }, clock, new AbortController().signal, { isCommitted: () => false });
    const dispatch = composeProviderDispatch(leaf, { candidate, policy: { attemptBudget: { maxAttempts: 1, maxLatencyMs: 1000, maxCostUsd: 1 }, statusPolicy: { retryable: [], nonRetryable: [] }, providerTimeoutMs: 100, streamIdleTimeoutMs: 100, contextTokens: 100 }, requestId: request.requestId, commitment: { isCommitted: () => false }, ledger, clock, credentials, trace: { record: async (record) => { traces.push(record); } } });
    expect(await dispatch.dispatch(candidate, request, new AbortController().signal)).toBe(response);
    expect(calls).toBe(1);
    expect(ledger.attempts()).toHaveLength(1);
    expect(ledger.spentCostUsd).toBe(0.1);
    await Promise.resolve();
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("secret-credential");
    expect(serialized).not.toContain("messages");
  });
});
