import { describe, expect, it } from "vitest";
import {
  CredentialStateMachine,
  CredentialStatePolicyError,
  calculateCooldownDelay,
  classifyCredentialFailure,
} from "../../src/ports/index.js";
import type {
  ClockPort,
  CredentialAuditRecord,
} from "../../src/ports/index.js";

function fixture(options: { random?: number; probe?: boolean } = {}) {
  let nowMs = 1_700_000_000_000;
  const records: CredentialAuditRecord[] = [];
  const clock: ClockPort = {
    now: () => nowMs,
    sleep: async () => undefined,
  };
  const state = new CredentialStateMachine(["credential-a", "credential-b"], {
    clock,
    random: () => options.random ?? 0.5,
    audit: { record: (record) => records.push(record) },
    probe: () => options.probe ?? false,
  });
  return {
    state,
    records,
    advance: (durationMs: number) => {
      nowMs += durationMs;
    },
  };
}

function audit(
  credentialId: string,
  operation: "quarantine" | "reset",
): CredentialAuditRecord {
  return {
    credentialId,
    operation,
    operatorId: "operator-1",
    reason: "incident-42",
    occurredAt: "2026-07-20T10:00:00Z",
  };
}

describe("CredentialStateMachine", () => {
  it("owns exactly four states and secret-free aggregates", () => {
    const { state } = fixture();
    expect([
      "active",
      "cooldown",
      "critical_failure",
      "suspended",
    ]).toHaveLength(4);
    expect(state.counts()).toEqual({
      active: 2,
      cooldown: 0,
      critical_failure: 0,
      suspended: 0,
    });
    expect(state.hasEligible()).toBe(true);
    expect(state.snapshot("credential-a")).toEqual({
      state: "active",
      penaltyCount: 0,
    });
    expect(Object.isFrozen(state.counts())).toBe(true);
    expect(Object.isFrozen(state.snapshot("credential-a"))).toBe(true);
  });

  it.each([
    ["dns", undefined, 1_000],
    ["connection", undefined, 1_000],
    ["timeout", undefined, 1_000],
    ["rate_limit", 429, 5_000],
    ["upstream_5xx", 503, 2_000],
  ] as const)("moves %s failures into cooldown", (kind, status, baseMs) => {
    const { state } = fixture({ random: 0.5 });
    const decision = state.failure("credential-a", {
      kind,
      ...(status === undefined ? {} : { status }),
    });
    expect(decision).toEqual({
      state: "cooldown",
      delayMs: Math.floor(0.5 * (baseMs + 1)),
      retryable: true,
    });
    expect(state.snapshot("credential-a")).toEqual({
      state: "cooldown",
      penaltyCount: 1,
      cooldownUntilMs: 1_700_000_000_000 + decision.delayMs,
    });
    expect(state.eligible("credential-a")).toBe(false);
  });

  it.each([
    ["unauthorized", 401],
    ["forbidden", 403],
  ] as const)("protects %s failures until an audited reset", (kind, status) => {
    const { state, records } = fixture();
    expect(state.failure("credential-a", { kind, status })).toEqual({
      state: "critical_failure",
      delayMs: 0,
      retryable: false,
    });
    expect(() => state.success("credential-a")).toThrowError(
      CredentialStatePolicyError,
    );
    expect(() => state.probe("credential-a")).toThrowError(
      CredentialStatePolicyError,
    );
    state.reset("credential-a", audit("credential-a", "reset"));
    expect(state.snapshot("credential-a")).toEqual({
      state: "active",
      penaltyCount: 0,
    });
    expect(records).toEqual([audit("credential-a", "reset")]);
  });

  it.each([
    { kind: "terminal_4xx", status: 404 } as const,
    { kind: "content_filter" } as const,
    { kind: "context_overflow" } as const,
  ])("leaves active state unchanged for $kind", (failure) => {
    const { state } = fixture();
    expect(state.failure("credential-a", failure)).toEqual({
      state: "active",
      delayMs: 0,
      retryable: false,
    });
    expect(state.snapshot("credential-a")).toEqual({
      state: "active",
      penaltyCount: 0,
    });
  });

  it("requires deadline expiry and an accepted explicit probe", () => {
    const rejected = fixture({ random: 0, probe: false });
    rejected.state.failure("credential-a", { kind: "timeout" });
    rejected.advance(1);
    expect(rejected.state.eligible("credential-a")).toBe(false);
    rejected.state.probe("credential-a");
    expect(rejected.state.eligible("credential-a")).toBe(false);

    const accepted = fixture({ random: 0.5, probe: true });
    const first = accepted.state.failure("credential-a", { kind: "timeout" });
    accepted.state.probe("credential-a");
    expect(accepted.state.eligible("credential-a")).toBe(false);
    accepted.advance(first.delayMs);
    accepted.state.probe("credential-a");
    expect(accepted.state.snapshot("credential-a")).toEqual({
      state: "active",
      penaltyCount: 1,
    });
    const second = accepted.state.failure("credential-a", { kind: "timeout" });
    expect(second.delayMs).toBe(Math.floor(0.5 * 2_001));
  });

  it("audits quarantine and requires audited reset", () => {
    const { state, records } = fixture();
    state.quarantine("credential-a", audit("credential-a", "quarantine"));
    expect(state.state("credential-a")).toBe("suspended");
    expect(state.eligible("credential-a")).toBe(false);
    expect(() => state.reset("credential-a", {
      ...audit("credential-a", "reset"),
      reason: "contains whitespace",
    })).toThrowError(
      expect.objectContaining({ code: "audit_required" }),
    );
    state.reset("credential-a", audit("credential-a", "reset"));
    expect(records).toEqual([
      audit("credential-a", "quarantine"),
      audit("credential-a", "reset"),
    ]);
    expect(state.snapshot("credential-a")).toEqual({
      state: "active",
      penaltyCount: 0,
    });
  });

  it("rejects unknown credentials, unaudited transitions, and invalid calendar dates safely", () => {
    const { state } = fixture();
    for (const action of [
      () => state.state("fixture-secret"),
      () => state.reset("credential-a", audit("credential-a", "reset")),
      () => state.quarantine("credential-a", {
        ...audit("credential-a", "quarantine"),
        occurredAt: "2026-02-31T10:00:00Z",
      }),
    ]) {
      try {
        action();
        throw new Error("expected policy failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialStatePolicyError);
        expect(JSON.stringify(error)).not.toContain("fixture-secret");
        expect((error as Error).message).not.toContain("credential-a");
      }
    }
  });
});

describe("credential cooldown policy helpers", () => {
  it("uses bounded inclusive full jitter and the greater retry window", () => {
    expect(calculateCooldownDelay(1_000, 1, () => 0, 60_000)).toBe(0);
    expect(
      calculateCooldownDelay(1_000, 1, () => 0.999_999_999, 60_000),
    ).toBe(1_000);
    expect(calculateCooldownDelay(1_000, 20, () => 0.5, 60_000)).toBe(
      30_000,
    );
    expect(
      calculateCooldownDelay(5_000, 1, () => 0.5, 60_000, 10_000),
    ).toBe(5_000);
    expect(
      calculateCooldownDelay(5_000, 1, () => 0.5, 60_000, 100_000),
    ).toBe(30_000);
  });

  it.each([NaN, -0.1, 1, Infinity])("rejects invalid jitter %s", (sample) => {
    expect(() =>
      calculateCooldownDelay(1_000, 1, () => sample, 60_000),
    ).toThrowError(expect.objectContaining({ code: "invalid_jitter" }));
  });

  it("classifies safe HTTP, network, content, and context failures", () => {
    expect(classifyCredentialFailure({ status: 429, retryAfterMs: 10_000 })).toEqual({
      kind: "rate_limit",
      status: 429,
      retryAfterMs: 10_000,
    });
    expect(classifyCredentialFailure({ code: "ENOTFOUND" })).toEqual({ kind: "dns" });
    expect(classifyCredentialFailure({ code: "ECONNRESET" })).toEqual({ kind: "connection" });
    expect(classifyCredentialFailure({ category: "timeout" })).toEqual({ kind: "timeout" });
    expect(classifyCredentialFailure({ code: "content_filter" })).toEqual({ kind: "content_filter" });
    expect(classifyCredentialFailure({ code: "context_overflow" })).toEqual({ kind: "context_overflow" });
    expect(() => classifyCredentialFailure({ kind: "toString" })).toThrowError(
      expect.objectContaining({ code: "invalid_failure" }),
    );
  });
});
