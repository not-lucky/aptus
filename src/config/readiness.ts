import type { GatewayConfig } from "./schema.js";
import type { ClockPort, HealthPort, RouteConfigPort } from "../ports/index.js";
import type { CredentialState } from "../ports/credentials.js";

/** Readiness status vocabulary exposed by the health capability. */
export type ReadinessStatus = "healthy" | "not_ready";

/** Secret-free aggregate credential lifecycle counts. */
export interface CredentialCounts extends Record<CredentialState, number> {
  /** Number of active credentials. */
  readonly active: number;
  /** Number of cooling-down credentials. */
  readonly cooldown: number;
  /** Number of credentials with critical failures. */
  readonly critical_failure: number;
  /** Number of suspended credentials. */
  readonly suspended: number;
}

/** Immutable, safe liveness and readiness snapshot. */
export interface ReadinessSnapshot {
  /** Healthy only when every readiness predicate is satisfied. */
  readonly status: ReadinessStatus;
  /** Whether configuration and operational readiness predicates pass. */
  readonly ready: boolean;
  /** Always true because this check is liveness-safe. */
  readonly live: true;
  /** Fixed gateway listener port. */
  readonly port: 11248;
  /** Whether a validated configuration has been published. */
  readonly configValid: boolean;
  /** Whether plugin registration completed. */
  readonly pluginsRegistered: boolean;
  /** Safe aggregate credential counts. */
  readonly credentials: CredentialCounts;
  /** Safe upstream provider check statuses. */
  readonly upstreamChecks: Readonly<Record<string, "ok" | "failed">>;
  /** Clock-derived check timestamp. */
  readonly checkedAt: string;
}

/** Complete immutable operational state supplied by lifecycle integrations. */
export interface OperationalReadinessState {
  /** Whether configured plugins have registered. */
  readonly pluginsRegistered: boolean;
  /** Safe aggregate credential counts. */
  readonly credentials: CredentialCounts;
  /** Whether at least one credential is eligible. */
  readonly eligibleCredential: boolean;
  /** Safe upstream statuses by provider identity. */
  readonly upstreamChecks: Readonly<Record<string, "ok" | "failed">>;
  /** Providers whose status must be ok for readiness. */
  readonly requiredUpstreamProviders: ReadonlySet<string>;
}

/** Error raised when no validated configuration snapshot exists. */
export class ConfigurationUnavailableError extends Error {
  /** Creates the documented unavailable-snapshot failure. */
  constructor() {
    super("validated configuration is unavailable");
    this.name = "ConfigurationUnavailableError";
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}


function emptyCounts(): CredentialCounts {
  return { active: 0, cooldown: 0, critical_failure: 0, suspended: 0 };
}
function validCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** Atomically owns validated configuration and computes secret-free liveness/readiness snapshots. */
export class ConfigurationCoordinator implements RouteConfigPort<GatewayConfig>, HealthPort<ReadinessSnapshot> {
  private config: Readonly<GatewayConfig> | undefined;
  private operational: OperationalReadinessState = {
    pluginsRegistered: false,
    credentials: freezeDeep(emptyCounts()),
    eligibleCredential: false,
    upstreamChecks: freezeDeep({}),
    requiredUpstreamProviders: new Set<string>(),
  };

  /** Creates a coordinator using the supplied process clock. */
  constructor(private readonly clock: ClockPort) {}

  /** Deep-freezes and atomically publishes a validated configuration snapshot. */
  publishValidated(config: GatewayConfig): void {
    this.config = freezeDeep(config);
  }

  /** Replaces all operational readiness inputs as one immutable state transition. */
  setOperationalState(state: OperationalReadinessState): void {
    if (typeof state.pluginsRegistered !== "boolean" || typeof state.eligibleCredential !== "boolean") throw new TypeError("readiness boolean state must be boolean");
    const counts = state.credentials;
    if (![counts.active, counts.cooldown, counts.critical_failure, counts.suspended].every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)) throw new TypeError("credential counts must be finite non-negative integers");
    const upstreamChecks: Record<string, "ok" | "failed"> = {};
    for (const [provider, status] of Object.entries(state.upstreamChecks)) {
      if (status !== "ok" && status !== "failed") throw new TypeError("upstream check status must be ok or failed");
      upstreamChecks[provider] = status;
    }
    this.operational = {
      pluginsRegistered: state.pluginsRegistered,
      credentials: freezeDeep({ active: counts.active, cooldown: counts.cooldown, critical_failure: counts.critical_failure, suspended: counts.suspended }),
      eligibleCredential: state.eligibleCredential,
      upstreamChecks: freezeDeep(upstreamChecks),
      requiredUpstreamProviders: new Set(state.requiredUpstreamProviders),
    };
  }

  /** Returns the currently published frozen configuration by identity. */
  snapshot(): Readonly<GatewayConfig> {
    if (!this.config) throw new ConfigurationUnavailableError();
    return this.config;
  }

  /** Returns a cancellation-aware safe readiness snapshot without probing upstreams. */
  async check(signal: AbortSignal): Promise<ReadinessSnapshot> {
    if (signal.aborted) throw signal.reason;
    const configValid = this.config !== undefined;
    const requiredUpstreamsReady = [...this.operational.requiredUpstreamProviders].every((provider) => this.operational.upstreamChecks[provider] === "ok");
    const ready = configValid && this.operational.pluginsRegistered && this.operational.eligibleCredential && requiredUpstreamsReady;
    return freezeDeep({
      status: ready ? "healthy" : "not_ready",
      ready,
      live: true,
      port: 11248,
      configValid,
      pluginsRegistered: this.operational.pluginsRegistered,
      credentials: this.operational.credentials,
      upstreamChecks: this.operational.upstreamChecks,
      checkedAt: new Date(this.clock.now()).toISOString(),
    });
  }
}

