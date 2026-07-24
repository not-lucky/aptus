import type { ClockPort } from "./infrastructure.js";

/** Exact credential lifecycle states used by routing policy. */
export type CredentialState =
  | "active"
  | "cooldown"
  | "critical_failure"
  | "suspended";

/** Safe credential failure classifications accepted by lifecycle policy. */
export type CredentialFailureKind =
  | "dns"
  | "connection"
  | "timeout"
  | "rate_limit"
  | "unauthorized"
  | "forbidden"
  | "upstream_5xx"
  | "terminal_4xx"
  | "content_filter"
  | "context_overflow";

/** Secret-free failure value consumed by the credential state owner. */
export interface CredentialFailure {
  /** Policy classification of the failure. */
  readonly kind: CredentialFailureKind;
  /** Safe HTTP status when the classification represents an HTTP failure. */
  readonly status?: number;
  /** Provider-requested retry delay in milliseconds when available. */
  readonly retryAfterMs?: number;
}

/** Audited operator action authorizing a protected credential transition. */
export interface CredentialAuditRecord {
  /** Credential identity visible only to the operator audit capability. */
  readonly credentialId: string;
  /** Protected lifecycle operation being authorized. */
  readonly operation: "quarantine" | "reset";
  /** Bounded operator identity suitable for an audit log. */
  readonly operatorId: string;
  /** Bounded operator-supplied reason suitable for an audit log. */
  readonly reason: string;
  /** RFC3339 timestamp for the operator action. */
  readonly occurredAt: string;
}

/** Injected operator-only audit side effect. */
export interface CredentialAuditPort {
  /** Records one validated protected lifecycle operation. */
  record(record: CredentialAuditRecord): void;
}

/** Immutable public view of one credential's lifecycle state. */
export interface CredentialStateSnapshot {
  /** Authoritative lifecycle state. */
  readonly state: CredentialState;
  /** Cooldown deadline, present only while the credential is cooling down. */
  readonly cooldownUntilMs?: number;
  /** Consecutive transient-failure penalty count. */
  readonly penaltyCount: number;
}

/** Secret-free aggregate counts for the four credential lifecycle states. */
export interface CredentialCounts {
  /** Number of active credentials. */
  readonly active: number;
  /** Number of credentials in cooldown. */
  readonly cooldown: number;
  /** Number of credentials awaiting an audited reset after authentication failure. */
  readonly critical_failure: number;
  /** Number of operator-quarantined credentials. */
  readonly suspended: number;
}

/** Secret-free result of applying one credential failure. */
export interface CooldownDecision {
  /** Resulting credential state. */
  readonly state: CredentialState;
  /** Selected delay in milliseconds, or zero when no cooldown applies. */
  readonly delayMs: number;
  /** Whether the failure class permits a later retry. */
  readonly retryable: boolean;
}

/** Stable safe codes for credential lifecycle policy failures. */
export type CredentialStatePolicyErrorCode =
  | "invalid_transition"
  | "audit_required"
  | "invalid_failure"
  | "invalid_jitter"
  | "invalid_retry_after"
  | "unknown_credential";

/** Typed policy error whose message never includes credential or provider data. */
export class CredentialStatePolicyError extends Error {
  /** Stable machine-readable policy failure code. */
  readonly code: CredentialStatePolicyErrorCode;

  /** Creates a policy error with a fixed safe message. */
  constructor(code: CredentialStatePolicyErrorCode) {
    super(POLICY_ERROR_MESSAGES[code]);
    this.name = "CredentialStatePolicyError";
    this.code = code;
  }
}

/** Injected dependencies and fixed cooldown cap for a credential state owner. */
export interface CredentialStateMachineOptions {
  /** Process clock used for cooldown deadlines and probes. */
  readonly clock: ClockPort;
  /** Injected full-jitter sample source. */
  readonly random: () => number;
  /** Operator-only audit capability. */
  readonly audit: CredentialAuditPort;
  /** Maximum cooldown delay in milliseconds; defaults to 60,000. */
  readonly capMs?: number;
  /** Explicit post-deadline health probe; defaults to rejecting reactivation. */
  readonly probe?: (
    snapshot: CredentialStateSnapshot,
    nowMs: number,
  ) => boolean;
}

/** Authoritative credential lifecycle capability used by routing and plugins. */
export interface CredentialStatePort {
  /** Reads the authoritative current state. */
  state(credentialId: string): CredentialState;
  /** Reads an immutable lifecycle snapshot. */
  snapshot(credentialId: string): CredentialStateSnapshot;
  /** Reports whether one credential is currently active. */
  eligible(credentialId: string): boolean;
  /** Reports whether at least one registered credential is active. */
  hasEligible(): boolean;
  /** Returns exact aggregate counts for all registered credentials. */
  counts(): CredentialCounts;
  /** Applies one classified failure and returns its safe policy decision. */
  failure(
    credentialId: string,
    outcome: CredentialFailure,
  ): CooldownDecision;
  /** Clears an active credential's consecutive transient-failure penalty. */
  success(credentialId: string): void;
  /** Moves any credential to suspended after recording an operator audit. */
  quarantine(credentialId: string, audit: CredentialAuditRecord): void;
  /** Reactivates a protected credential after recording an operator audit. */
  reset(credentialId: string, audit: CredentialAuditRecord): void;
  /** Runs the injected post-deadline probe for a cooling credential. */
  probe(credentialId: string): void;
}

const POLICY_ERROR_MESSAGES: Readonly<
  Record<CredentialStatePolicyErrorCode, string>
> = Object.freeze({
  invalid_transition: "credential state transition is not permitted",
  audit_required: "a valid operator audit record is required",
  invalid_failure: "credential failure classification is invalid",
  invalid_jitter: "credential cooldown jitter is invalid",
  invalid_retry_after: "credential retry delay is invalid",
  unknown_credential: "credential is not registered",
});

const FAILURE_KINDS: Readonly<Record<CredentialFailureKind, true>> =
  Object.freeze({
    dns: true,
    connection: true,
    timeout: true,
    rate_limit: true,
    unauthorized: true,
    forbidden: true,
    upstream_5xx: true,
    terminal_4xx: true,
    content_filter: true,
    context_overflow: true,
  });

const HTTP_FAILURE_KINDS: ReadonlySet<CredentialFailureKind> = new Set([
  "rate_limit",
  "unauthorized",
  "forbidden",
  "upstream_5xx",
  "terminal_4xx",
]);

function policyError(
  code: CredentialStatePolicyErrorCode,
): CredentialStatePolicyError {
  return new CredentialStatePolicyError(code);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateStatus(kind: CredentialFailureKind, status: unknown): void {
  if (!HTTP_FAILURE_KINDS.has(kind)) {
    if (status !== undefined) throw policyError("invalid_failure");
    return;
  }
  if (!Number.isInteger(status) || !isFiniteNonNegative(status))
    throw policyError("invalid_failure");
  const valid =
    (kind === "rate_limit" && status === 429) ||
    (kind === "unauthorized" && status === 401) ||
    (kind === "forbidden" && status === 403) ||
    (kind === "upstream_5xx" && status >= 500 && status <= 599) ||
    (kind === "terminal_4xx" &&
      status >= 400 &&
      status <= 499 &&
      status !== 401 &&
      status !== 403 &&
      status !== 429);
  if (!valid) throw policyError("invalid_failure");
}

function validateFailure(outcome: CredentialFailure): CredentialFailure {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    typeof outcome.kind !== "string" ||
    !Object.hasOwn(FAILURE_KINDS, outcome.kind)
  )
    throw policyError("invalid_failure");
  const kind = outcome.kind as CredentialFailureKind;
  validateStatus(kind, outcome.status);
  if (
    outcome.retryAfterMs !== undefined &&
    !isFiniteNonNegative(outcome.retryAfterMs)
  )
    throw policyError("invalid_retry_after");
  return Object.freeze({
    kind,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: outcome.retryAfterMs }),
  });
}

function classifyStatus(status: number, retryAfterMs?: number): CredentialFailure {
  if (!Number.isInteger(status) || status < 0)
    throw policyError("invalid_failure");
  if (status === 429)
    return validateFailure({
      kind: "rate_limit",
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  if (status === 401) return Object.freeze({ kind: "unauthorized", status });
  if (status === 403) return Object.freeze({ kind: "forbidden", status });
  if (status >= 500 && status <= 599)
    return Object.freeze({ kind: "upstream_5xx", status });
  if (status >= 400 && status <= 499)
    return Object.freeze({ kind: "terminal_4xx", status });
  throw policyError("invalid_failure");
}

/**
 * Converts a safe classified value, gateway error, or recognized network error
 * into the closed credential failure vocabulary.
 */
export function classifyCredentialFailure(
  errorOrOutcome: unknown,
): CredentialFailure {
  if (typeof errorOrOutcome !== "object" || errorOrOutcome === null)
    throw policyError("invalid_failure");
  const value = errorOrOutcome as Record<string, unknown>;
  if (typeof value["kind"] === "string")
    return validateFailure(value as unknown as CredentialFailure);

  const code = typeof value["code"] === "string" ? value["code"] : "";
  const category =
    typeof value["category"] === "string" ? value["category"] : "";
  if (code === "content_filter" || category === "content_filter")
    return Object.freeze({ kind: "content_filter" });
  if (code === "context_overflow" || category === "context_overflow")
    return Object.freeze({ kind: "context_overflow" });
  if (category === "timeout") return Object.freeze({ kind: "timeout" });

  const networkCode = code.toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN", "DNS"].includes(networkCode))
    return Object.freeze({ kind: "dns" });
  if (
    ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(
      networkCode,
    )
  )
    return Object.freeze({ kind: "connection" });
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(networkCode))
    return Object.freeze({ kind: "timeout" });

  if (value["status"] !== undefined) {
    const retryAfterMs = value["retryAfterMs"];
    if (retryAfterMs !== undefined && !isFiniteNonNegative(retryAfterMs))
      throw policyError("invalid_retry_after");
    return classifyStatus(
      value["status"] as number,
      retryAfterMs as number | undefined,
    );
  }
  throw policyError("invalid_failure");
}

/**
 * Calculates bounded exponential full jitter with an optional bounded
 * provider-requested minimum policy window.
 */
export function calculateCooldownDelay(
  baseMs: number,
  penaltyCount: number,
  random: () => number,
  capMs: number,
  retryAfterMs?: number,
): number {
  if (
    !isFiniteNonNegative(baseMs) ||
    !Number.isInteger(baseMs) ||
    !Number.isInteger(penaltyCount) ||
    penaltyCount < 1 ||
    !isFiniteNonNegative(capMs) ||
    !Number.isInteger(capMs)
  )
    throw policyError("invalid_failure");
  if (retryAfterMs !== undefined && !isFiniteNonNegative(retryAfterMs))
    throw policyError("invalid_retry_after");
  const exponential = baseMs * 2 ** (penaltyCount - 1);
  const raw = Math.min(capMs, exponential);
  const boundedRetryAfter =
    retryAfterMs === undefined ? 0 : Math.min(capMs, retryAfterMs);
  const windowMs = Math.max(raw, boundedRetryAfter);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw policyError("invalid_jitter");
  return Math.floor(sample * (windowMs + 1));
}

interface MutableCredentialState {
  state: CredentialState;
  penaltyCount: number;
  cooldownUntilMs?: number;
}

function cooldownBase(kind: CredentialFailureKind): number | undefined {
  if (kind === "dns" || kind === "connection" || kind === "timeout")
    return 1_000;
  if (kind === "rate_limit") return 5_000;
  if (kind === "upstream_5xx") return 2_000;
  return undefined;
}

function safeAuditText(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/\s|[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validRfc3339(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    offsetMinute > 59
  )
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1]!;
  if (day < 1 || day > daysInMonth) return false;
  return Number.isFinite(Date.parse(value));
}

/** In-memory authoritative owner of the audited credential lifecycle policy. */
export class CredentialStateMachine implements CredentialStatePort {
  readonly #states = new Map<string, MutableCredentialState>();
  readonly #clock: ClockPort;
  readonly #random: () => number;
  readonly #audit: CredentialAuditPort;
  readonly #capMs: number;
  readonly #probePolicy: (
    snapshot: CredentialStateSnapshot,
    nowMs: number,
  ) => boolean;

  /** Creates an isolated owner whose registered credentials start active. */
  constructor(
    credentialIds: ReadonlyArray<string>,
    options: CredentialStateMachineOptions,
  ) {
    if (
      !Array.isArray(credentialIds) ||
      credentialIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(credentialIds).size !== credentialIds.length
    )
      throw policyError("unknown_credential");
    const capMs = options.capMs ?? 60_000;
    if (!Number.isInteger(capMs) || !isFiniteNonNegative(capMs))
      throw policyError("invalid_failure");
    this.#clock = options.clock;
    this.#random = options.random;
    this.#audit = options.audit;
    this.#capMs = capMs;
    this.#probePolicy = options.probe ?? (() => false);
    for (const id of credentialIds)
      this.#states.set(id, { state: "active", penaltyCount: 0 });
  }

  /** Reads the authoritative current state. */
  state(credentialId: string): CredentialState {
    return this.#entry(credentialId).state;
  }

  /** Reads an immutable lifecycle snapshot. */
  snapshot(credentialId: string): CredentialStateSnapshot {
    const entry = this.#entry(credentialId);
    return Object.freeze({
      state: entry.state,
      penaltyCount: entry.penaltyCount,
      ...(entry.state === "cooldown" && entry.cooldownUntilMs !== undefined
        ? { cooldownUntilMs: entry.cooldownUntilMs }
        : {}),
    });
  }

  /** Reports whether one credential is currently active. */
  eligible(credentialId: string): boolean {
    return this.#entry(credentialId).state === "active";
  }

  /** Reports whether at least one registered credential is active. */
  hasEligible(): boolean {
    for (const entry of this.#states.values())
      if (entry.state === "active") return true;
    return false;
  }

  /** Returns exact aggregate counts for all registered credentials. */
  counts(): CredentialCounts {
    const counts = {
      active: 0,
      cooldown: 0,
      critical_failure: 0,
      suspended: 0,
    };
    for (const entry of this.#states.values()) counts[entry.state] += 1;
    return Object.freeze(counts);
  }

  /** Applies one classified failure and returns its safe policy decision. */
  failure(
    credentialId: string,
    outcome: CredentialFailure,
  ): CooldownDecision {
    const entry = this.#entry(credentialId);
    if (entry.state !== "active") throw policyError("invalid_transition");
    const failure = validateFailure(outcome);
    const baseMs = cooldownBase(failure.kind);
    if (baseMs !== undefined) {
      const penaltyCount = entry.penaltyCount + 1;
      const delayMs = calculateCooldownDelay(
        baseMs,
        penaltyCount,
        this.#random,
        this.#capMs,
        failure.retryAfterMs,
      );
      const nowMs = this.#now();
      entry.state = "cooldown";
      entry.penaltyCount = penaltyCount;
      entry.cooldownUntilMs = nowMs + delayMs;
      return Object.freeze({ state: "cooldown", delayMs, retryable: true });
    }
    if (failure.kind === "unauthorized" || failure.kind === "forbidden") {
      entry.state = "critical_failure";
      delete entry.cooldownUntilMs;
      return Object.freeze({
        state: "critical_failure",
        delayMs: 0,
        retryable: false,
      });
    }
    return Object.freeze({ state: "active", delayMs: 0, retryable: false });
  }

  /** Clears an active credential's consecutive transient-failure penalty. */
  success(credentialId: string): void {
    const entry = this.#entry(credentialId);
    if (entry.state !== "active") throw policyError("invalid_transition");
    entry.penaltyCount = 0;
    delete entry.cooldownUntilMs;
  }

  /** Moves any credential to suspended after recording an operator audit. */
  quarantine(credentialId: string, audit: CredentialAuditRecord): void {
    const entry = this.#entry(credentialId);
    const record = this.#validatedAudit(credentialId, "quarantine", audit);
    this.#audit.record(record);
    entry.state = "suspended";
    delete entry.cooldownUntilMs;
  }

  /** Reactivates a protected credential after recording an operator audit. */
  reset(credentialId: string, audit: CredentialAuditRecord): void {
    const entry = this.#entry(credentialId);
    if (entry.state !== "critical_failure" && entry.state !== "suspended")
      throw policyError("invalid_transition");
    const record = this.#validatedAudit(credentialId, "reset", audit);
    this.#audit.record(record);
    entry.state = "active";
    entry.penaltyCount = 0;
    delete entry.cooldownUntilMs;
  }

  /** Runs the injected post-deadline probe for a cooling credential. */
  probe(credentialId: string): void {
    const entry = this.#entry(credentialId);
    if (entry.state !== "cooldown" || entry.cooldownUntilMs === undefined)
      throw policyError("invalid_transition");
    const nowMs = this.#now();
    if (nowMs < entry.cooldownUntilMs) return;
    const snapshot = this.snapshot(credentialId);
    if (!this.#probePolicy(snapshot, nowMs)) return;
    entry.state = "active";
    delete entry.cooldownUntilMs;
  }

  #entry(credentialId: string): MutableCredentialState {
    const entry = this.#states.get(credentialId);
    if (entry === undefined) throw policyError("unknown_credential");
    return entry;
  }

  #now(): number {
    const nowMs = this.#clock.now();
    if (!isFiniteNonNegative(nowMs)) throw policyError("invalid_transition");
    return nowMs;
  }

  #validatedAudit(
    credentialId: string,
    operation: CredentialAuditRecord["operation"],
    audit: CredentialAuditRecord,
  ): CredentialAuditRecord {
    if (
      typeof audit !== "object" ||
      audit === null ||
      audit.credentialId !== credentialId ||
      audit.operation !== operation ||
      !safeAuditText(audit.operatorId, 128) ||
      !safeAuditText(audit.reason, 256) ||
      !validRfc3339(audit.occurredAt)
    )
      throw policyError("audit_required");
    return Object.freeze({
      credentialId,
      operation,
      operatorId: audit.operatorId,
      reason: audit.reason,
      occurredAt: audit.occurredAt,
    });
  }
}
