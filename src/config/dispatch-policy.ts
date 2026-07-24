import type { RouteCandidate } from "../domain/index.js";
import type {
  DispatchCandidatePolicy,
  DispatchPolicyPort,
  DispatchPolicySnapshot,
  RouteConfigPort,
} from "../ports/index.js";
import type { GatewayConfig } from "./schema.js";

/** Fixed safe failure raised when captured policy cannot resolve a candidate. */
export class DispatchPolicyResolutionError extends Error {
  /** Creates a policy resolution failure without candidate/configuration data. */
  constructor() {
    super("dispatch policy could not resolve candidate");
    this.name = "DispatchPolicyResolutionError";
  }
}

/** Construction options for a configuration-backed dispatch policy source. */
export interface ConfiguredDispatchPolicyPortOptions {
  /** Supplies one already validated configuration snapshot. */
  readonly configuration: RouteConfigPort<GatewayConfig>;
}

interface CapturedTargetPolicy {
  readonly providerId: string;
  readonly physicalModel: string;
  readonly providerTimeoutMs: number;
  readonly contextTokens: number;
}

interface CapturedRoutePolicy {
  readonly routeId: string;
  readonly candidateProviders: ReadonlySet<string>;
  readonly attemptBudget: Readonly<GatewayConfig["routes"][number]["attemptBudget"]>;
  readonly statusPolicy: {
    readonly retryable: readonly number[];
    readonly nonRetryable: readonly number[];
  };
}

/** Captures immutable, secret-free dispatch policy from validated configuration. */
export class ConfiguredDispatchPolicyPort implements DispatchPolicyPort {
  private readonly configuration: RouteConfigPort<GatewayConfig>;

  /** Creates a policy source over the injected validated configuration port. */
  constructor(options: ConfiguredDispatchPolicyPortOptions) {
    this.configuration = options.configuration;
  }

  /** Copies one configuration snapshot and never rereads it from resolve(). */
  snapshot(): DispatchPolicySnapshot {
    const configuration = this.configuration.snapshot();
    const targets = new Map<string, CapturedTargetPolicy>();
    for (const model of configuration.models) {
      for (const target of model.targets) {
        const provider = configuration.providers.find(
          (entry) => entry.id === target.providerId,
        );
        if (provider === undefined) continue;
        targets.set(
          `${target.providerId}\u0000${target.physicalModel}`,
          Object.freeze({
            providerId: target.providerId,
            physicalModel: target.physicalModel,
            providerTimeoutMs: provider.timeoutMs,
            contextTokens: target.contextTokens,
          }),
        );
      }
    }

    const routes = new Map<string, CapturedRoutePolicy>();
    for (const route of configuration.routes) {
      routes.set(
        route.id,
        Object.freeze({
          routeId: route.id,
          candidateProviders: new Set(
            route.orderedCandidates.map((candidate) => candidate.providerId),
          ),
          attemptBudget: Object.freeze({ ...route.attemptBudget }),
          statusPolicy: Object.freeze({
            retryable: Object.freeze([...route.statusPolicy.retryable]),
            nonRetryable: Object.freeze([...route.statusPolicy.nonRetryable]),
          }),
        }),
      );
    }

    const defaultDryRun = configuration.server.defaultDryRun;
    const streamIdleTimeoutMs = configuration.server.streamIdleTimeoutMs;
    const snapshot: DispatchPolicySnapshot = {
      defaultDryRun,
      resolve(candidate: RouteCandidate): DispatchCandidatePolicy {
        const route = routes.get(candidate.routeId);
        const target = targets.get(
          `${candidate.providerId}\u0000${candidate.physicalModel}`,
        );
        if (
          route === undefined ||
          target === undefined ||
          !route.candidateProviders.has(candidate.providerId)
        )
          throw new DispatchPolicyResolutionError();
        return Object.freeze({
          attemptBudget: route.attemptBudget,
          statusPolicy: route.statusPolicy,
          providerTimeoutMs: target.providerTimeoutMs,
          streamIdleTimeoutMs,
          contextTokens: target.contextTokens,
        });
      },
    };
    return Object.freeze(snapshot);
  }
}
