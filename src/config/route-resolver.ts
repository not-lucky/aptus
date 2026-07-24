import {
  createCredentialSelector,
  type CredentialSelectionSupport,
  type CredentialSelectorFactory,
  type RouteResolver,
} from "../application/index.js";
import type { GatewayContext } from "../application/lifecycle.js";
import {
  calculateCost,
  checkRequiredCapabilities,
  createGatewayError,
  type CanonicalRequest,
  type RouteCandidate,
  type TokenUsage,
} from "../domain/index.js";
import type {
  CredentialStatePort,
  RouteConfigPort,
} from "../ports/index.js";
import type { GatewayConfig } from "./schema.js";

/** Dependencies and deterministic estimation policies for configured routing. */
export interface ConfiguredRouteResolverOptions {
  /** Supplies one already validated immutable configuration snapshot. */
  readonly configuration: RouteConfigPort<GatewayConfig>;
  /** Supplies the authoritative lifecycle state for each credential ID. */
  readonly credentials: CredentialStatePort;
  /** Estimates complete token usage for one canonical request. */
  readonly estimate: (request: CanonicalRequest) => TokenUsage;
  /** Estimates target latency, or returns undefined when no estimate exists. */
  readonly estimateLatencyMs: (
    providerId: string,
    physicalModel: string,
    request: CanonicalRequest,
  ) => number | undefined;
  /** Returns the current non-negative connection count for one candidate. */
  readonly connections?: (candidate: RouteCandidate) => number;
  /** Returns a deterministic cursor for one provider snapshot. */
  readonly cursor?: (namespace: string, length: number) => number;
  /** Creates configured selectors; defaults to the public selector factory. */
  readonly selectorFactory?: CredentialSelectorFactory;
}

type Route = GatewayConfig["routes"][number];
type Target = GatewayConfig["models"][number]["targets"][number];
type Credential = GatewayConfig["providers"][number]["credentials"][number];

interface OrderedCandidate {
  readonly value: RouteCandidate;
  readonly candidateIndex: number;
  readonly preferenceRank: number;
  readonly candidateWeight: number;
  readonly credentialWeight: number;
}

const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOrderedCandidates(
  left: OrderedCandidate,
  right: OrderedCandidate,
): number {
  return (
    left.candidateIndex - right.candidateIndex ||
    left.preferenceRank - right.preferenceRank ||
    right.candidateWeight - left.candidateWeight ||
    right.credentialWeight - left.credentialWeight ||
    compareText(left.value.providerId, right.value.providerId) ||
    compareText(left.value.credentialId, right.value.credentialId) ||
    compareText(left.value.physicalModel, right.value.physicalModel)
  );
}

function readOwnPath(
  root: CanonicalRequest,
  field: string,
): { readonly found: boolean; readonly value?: unknown } {
  const segments = field.split(".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || FORBIDDEN_PATH_SEGMENTS.has(segment),
    )
  ) {
    return { found: false };
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }

  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).sort(compareText);
  const rightKeys = Object.keys(rightObject).sort(compareText);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.hasOwn(rightObject, key) &&
        jsonEqual(leftObject[key], rightObject[key]),
    )
  );
}

function routeMatches(
  route: Route,
  alias: string,
  request: CanonicalRequest,
): boolean {
  if (!route.modelAliases.includes(alias)) return false;
  return route.conditions.every((condition) => {
    const actual = readOwnPath(request, condition.field);
    if (!actual.found) return false;
    return Object.hasOwn(condition, "equals")
      ? jsonEqual(actual.value, condition.equals)
      : actual.value === true;
  });
}

function exhausted(requestId: string): ReturnType<typeof createGatewayError> {
  return createGatewayError({
    category: "routing",
    code: "route_exhausted",
    message: "no eligible route candidate",
    status: 503,
    retryable: true,
    requestId,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/** Resolves validated configuration records into bounded secret-free candidates. */
export class ConfiguredRouteResolver implements RouteResolver {
  readonly #options: ConfiguredRouteResolverOptions;

  /** Creates a resolver backed only by injected configuration and policies. */
  constructor(options: ConfiguredRouteResolverOptions) {
    this.#options = options;
  }

  /** Returns deterministic eligible route candidates for one request snapshot. */
  async resolve(
    request: CanonicalRequest,
    context: GatewayContext,
  ): Promise<ReadonlyArray<RouteCandidate>> {
    throwIfAborted(context.signal);
    const snapshot = this.#options.configuration.snapshot();
    const effectiveAlias = request.routing.modelAlias ?? request.model;
    const roots = request.routing.overrideRoute
      ? snapshot.routes.filter(
          (route) =>
            route.id === request.routing.overrideRoute &&
            routeMatches(route, effectiveAlias, request),
        )
      : snapshot.routes.filter((route) =>
          routeMatches(route, effectiveAlias, request),
        );

    if (roots.length === 0) throw exhausted(request.requestId);

    throwIfAborted(context.signal);
    const usage = this.#options.estimate(request);
    const visited = new Set<string>();
    const emittedKeys = new Set<string>();
    const output: RouteCandidate[] = [];
    const excludedProviders = new Set(
      request.routing.excludedProviders ?? [],
    );
    const preferredProviders = new Set(
      request.routing.preferredProviders ?? [],
    );
    const requestMaxCost = request.routing.maxCostUsd ?? Infinity;
    const requestMaxLatency = request.routing.maxLatencyMs ?? Infinity;

    const expandRoute = (route: Route): OrderedCandidate[] => {
      const expanded: OrderedCandidate[] = [];
      const requiredCapabilities = [
        ...new Set([
          ...(request.routing.requiredCapabilities ?? []),
          ...route.requiredCapabilities,
        ]),
      ];
      const model = snapshot.models.find(
        (configuredModel) => configuredModel.alias === effectiveAlias,
      );
      if (model === undefined) return expanded;

      route.orderedCandidates.forEach((configuredCandidate, candidateIndex) => {
        throwIfAborted(context.signal);
        if (
          configuredCandidate.modelAlias !== effectiveAlias ||
          excludedProviders.has(configuredCandidate.providerId)
        ) {
          return;
        }
        const provider = snapshot.providers.find(
          (configuredProvider) =>
            configuredProvider.id === configuredCandidate.providerId,
        );
        if (provider === undefined) return;

        const targets = model.targets.filter(
          (target) => target.providerId === configuredCandidate.providerId,
        );
        for (const target of targets) {
          throwIfAborted(context.signal);
          const eligibleTarget = this.#evaluateTarget(
            target,
            requiredCapabilities,
            usage,
            request,
            route,
            requestMaxCost,
            requestMaxLatency,
          );
          if (eligibleTarget === undefined) continue;

          for (const credential of provider.credentials) {
            throwIfAborted(context.signal);
            if (!this.#options.credentials.eligible(credential.id)) continue;
            expanded.push(
              this.#orderedCandidate(
                route,
                target,
                credential,
                eligibleTarget.cost,
                eligibleTarget.latency,
                candidateIndex,
                configuredCandidate.weight,
                preferredProviders.has(configuredCandidate.providerId) ? 0 : 1,
              ),
            );
          }
        }
      });
      expanded.sort(compareOrderedCandidates);
      return expanded;
    };

    const routesById = new Map(snapshot.routes.map((route) => [route.id, route]));
    for (const root of roots) {
      throwIfAborted(context.signal);
      let rootCount = 0;
      const visit = (route: Route): void => {
        throwIfAborted(context.signal);
        if (rootCount >= root.attemptBudget.maxAttempts || visited.has(route.id))
          return;
        visited.add(route.id);
        if (!routeMatches(route, effectiveAlias, request)) return;

        let localCount = 0;
        for (const candidate of expandRoute(route)) {
          if (
            localCount >= route.attemptBudget.maxAttempts ||
            rootCount >= root.attemptBudget.maxAttempts
          ) {
            break;
          }
          const key = `${candidate.value.routeId}\u0000${candidate.value.providerId}\u0000${candidate.value.credentialId}\u0000${candidate.value.physicalModel}`;
          if (emittedKeys.has(key)) continue;
          emittedKeys.add(key);
          output.push(candidate.value);
          localCount += 1;
          rootCount += 1;
        }

        if (rootCount >= root.attemptBudget.maxAttempts) return;
        for (const fallbackId of route.fallbackGroups) {
          throwIfAborted(context.signal);
          const fallback = routesById.get(fallbackId);
          if (fallback !== undefined) visit(fallback);
          if (rootCount >= root.attemptBudget.maxAttempts) return;
        }
      };
      visit(root);
    }

    if (output.length === 0) throw exhausted(request.requestId);
    const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    const weightByCredential = new Map(
      snapshot.providers.flatMap((provider) =>
        provider.credentials.map((credential) => [
          `${provider.id}\u0000${credential.id}`,
          credential.weight,
        ] as const),
      ),
    );
    const support: CredentialSelectionSupport = {
      weight: (candidate) =>
        weightByCredential.get(`${candidate.providerId}\u0000${candidate.credentialId}`) ?? 0,
      connections: this.#options.connections ?? (() => 0),
      cursor: this.#options.cursor ?? (() => 0),
    };
    const factory = this.#options.selectorFactory ?? createCredentialSelector;
    const grouped = new Map<string, RouteCandidate[]>();
    for (const candidate of output) {
      const group = grouped.get(candidate.providerId);
      if (group === undefined) grouped.set(candidate.providerId, [candidate]);
      else group.push(candidate);
    }
    const selectionRank = new Map<string, number>();
    const candidateKey = (candidate: RouteCandidate): string =>
      `${candidate.routeId}\u0000${candidate.providerId}\u0000${candidate.credentialId}\u0000${candidate.physicalModel}`;
    for (const [providerId, group] of grouped) {
      const provider = providers.get(providerId);
      if (provider === undefined) continue;
      const selected = factory(
        provider.credentialSelection,
        providerId,
        support,
      ).select(group);
      selected.forEach((candidate, rank) => {
        selectionRank.set(candidateKey(candidate), rank);
      });
    }
    const buckets = new Map<string, RouteCandidate[]>();
    for (const candidate of output) {
      const bucketKey = `${candidate.routeId}\u0000${candidate.providerId}\u0000${candidate.physicalModel}`;
      const bucket = buckets.get(bucketKey);
      if (bucket === undefined) buckets.set(bucketKey, [candidate]);
      else bucket.push(candidate);
    }
    for (const bucket of buckets.values())
      bucket.sort((left, right) =>
        (selectionRank.get(candidateKey(left)) ?? 0) -
        (selectionRank.get(candidateKey(right)) ?? 0),
      );
    const selected = output.map((candidate) => {
      const bucketKey = `${candidate.routeId}\u0000${candidate.providerId}\u0000${candidate.physicalModel}`;
      return buckets.get(bucketKey)!.shift()!;
    });
    return Object.freeze(selected);
  }

  #evaluateTarget(
    target: Target,
    requiredCapabilities: readonly string[],
    usage: TokenUsage,
    request: CanonicalRequest,
    route: Route,
    requestMaxCost: number,
    requestMaxLatency: number,
  ): { readonly cost: number; readonly latency: number } | undefined {
    if (usage.inputTokens > target.contextTokens) return undefined;
    if (
      !checkRequiredCapabilities(
        requiredCapabilities,
        target.capabilities,
      ).satisfied
    ) {
      return undefined;
    }

    const cost = calculateCost(usage, target.pricesPerMillionUsd);
    if (!cost.ok || !Number.isFinite(cost.cost.totalUsd)) return undefined;
    const costLimit = Math.min(requestMaxCost, route.attemptBudget.maxCostUsd);
    if (!Number.isFinite(costLimit) || cost.cost.totalUsd > costLimit)
      return undefined;

    const latency = this.#options.estimateLatencyMs(
      target.providerId,
      target.physicalModel,
      request,
    );
    const latencyLimit = Math.min(
      requestMaxLatency,
      route.attemptBudget.maxLatencyMs,
    );
    if (
      latency === undefined ||
      !Number.isFinite(latency) ||
      latency < 0 ||
      !Number.isFinite(latencyLimit) ||
      latency > latencyLimit
    ) {
      return undefined;
    }
    return { cost: cost.cost.totalUsd, latency };
  }

  #orderedCandidate(
    route: Route,
    target: Target,
    credential: Credential,
    cost: number,
    latency: number,
    candidateIndex: number,
    candidateWeight: number,
    preferenceRank: number,
  ): OrderedCandidate {
    const capabilities = new Set([...target.capabilities].sort(compareText));
    return {
      value: {
        routeId: route.id,
        providerId: target.providerId,
        credentialId: credential.id,
        physicalModel: target.physicalModel,
        capabilities,
        estimatedCostUsd: cost,
        estimatedLatencyMs: latency,
      },
      candidateIndex,
      preferenceRank,
      candidateWeight,
      credentialWeight: credential.weight,
    };
  }
}
