import type { ModelConfig, ProviderConfig, RouteConfig } from "../config/types.js";
import type { KeyPool, NativeMutations } from "../domain/contracts.js";
import type { IrFailureCategory } from "../domain/operations.js";

/**
 * One resolved candidate (a model, its provider, and that provider's key pool)
 * in route order, carrying the route's retry/fallback policies.
 */
export interface CandidateDescriptor {
  readonly index: number;
  readonly model: ModelConfig;
  readonly provider: ProviderConfig;
  readonly pool: KeyPool;
  readonly mutations: NativeMutations;
  readonly retryOn: readonly IrFailureCategory[];
  readonly fallbackOn: readonly IrFailureCategory[];
}

/**
 * Provider configuration paired with its process-local key pool.
 */
export interface ProviderEntry {
  readonly config: ProviderConfig;
  readonly pool: KeyPool;
}

/**
 * The precomputed indexes candidate resolution reads from.
 */
export interface CandidateIndexes {
  readonly modelsByName: ReadonlyMap<string, ModelConfig>;
  readonly routesByName: ReadonlyMap<string, RouteConfig>;
  readonly providers: ReadonlyMap<string, ProviderEntry>;
}

/**
 * Resolves a canonical public name into an ordered list of candidate descriptors.
 *
 * A public model resolves to exactly one candidate with no retry or fallback
 * policy; a route resolves to its configured candidates in order, each carrying
 * the route's `retryOn`/`fallbackOn` categories. Names referencing unknown
 * models, providers, or route members resolve to fewer (possibly zero)
 * candidates.
 *
 * @param canonicalName - Authorized canonical public model or route name.
 * @param indexes - Configuration indexes built once at gateway construction.
 * @returns The ordered candidate descriptors.
 */
export function resolveCandidates(canonicalName: string, indexes: CandidateIndexes): readonly CandidateDescriptor[] {
  const model = indexes.modelsByName.get(canonicalName);
  if (model !== undefined) {
    const entry = indexes.providers.get(model.provider);
    if (entry === undefined) return [];
    return [
      {
        index: 0,
        model,
        provider: entry.config,
        pool: entry.pool,
        mutations: mutationsOf(model),
        retryOn: [],
        fallbackOn: [],
      },
    ];
  }
  const route = indexes.routesByName.get(canonicalName);
  if (route === undefined) return [];
  const candidates: CandidateDescriptor[] = [];
  route.candidates.forEach((modelName, index) => {
    const candidateModel = indexes.modelsByName.get(modelName);
    const entry = candidateModel === undefined ? undefined : indexes.providers.get(candidateModel.provider);
    if (candidateModel !== undefined && entry !== undefined) {
      candidates.push({
        index,
        model: candidateModel,
        provider: entry.config,
        pool: entry.pool,
        mutations: mutationsOf(candidateModel),
        retryOn: route.retryOn,
        fallbackOn: route.fallbackOn,
      });
    }
  });
  return candidates;
}

function mutationsOf(model: ModelConfig): NativeMutations {
  return { defaults: model.defaults, extraBody: model.extraBody, overrides: model.overrides };
}
