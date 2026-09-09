/**
 * @fileoverview
 * Ordered candidate resolution and descriptor generation for routing dispatch.
 *
 * Expands canonical model and route names into ordered {@link CandidateDescriptor} sequences.
 * Connects model configuration, provider configuration, live key pools, native body mutations,
 * and route retry/fallback policies ready for candidate execution loops.
 */

import type { ModelConfig, ProviderConfig, RouteConfig } from "../config/types.ts";
import type { KeyPool, NativeMutations } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";

/**
 * Descriptor pairing a target model with its provider, live key pool, and route policies.
 */
export interface CandidateDescriptor {
  /** Zero-based position of the candidate in the resolved route sequence. */
  readonly index: number;
  /** Model configuration specifying upstream model name, pricing, and mutations. */
  readonly model: ModelConfig;
  /** Provider configuration specifying endpoint URL, protocol, and key strategy. */
  readonly provider: ProviderConfig;
  /** Live key pool managing credentials and cooldown tracking for this provider. */
  readonly pool: KeyPool;
  /** Normalized native body mutation dictionaries (defaults, extraBody, overrides). */
  readonly mutations: NativeMutations;
  /** Failure categories that permit a same-candidate retry. */
  readonly retryOn: readonly IrFailureCategory[];
  /** Failure categories that permit fallback to the next candidate in route order. */
  readonly fallbackOn: readonly IrFailureCategory[];
}

/**
 * Provider configuration entry paired with its active key pool.
 */
export interface ProviderEntry {
  /** Static provider configuration. */
  readonly config: ProviderConfig;
  /** Active key pool for this provider. */
  readonly pool: KeyPool;
}

/**
 * Precomputed indexes mapping canonical model, route, and provider names.
 */
export interface CandidateIndexes {
  /** Map of canonical model names to their configuration. */
  readonly modelsByName: ReadonlyMap<string, ModelConfig>;
  /** Map of canonical route names to their configuration. */
  readonly routesByName: ReadonlyMap<string, RouteConfig>;
  /** Map of provider names to their configuration and active key pool. */
  readonly providers: ReadonlyMap<string, ProviderEntry>;
}

/**
 * Resolves a canonical public name into an ordered sequence of candidate descriptors.
 *
 * Models resolve to a single candidate descriptor with empty retry/fallback policies,
 * while routes resolve to their constituent candidates in configured order.
 *
 * @param canonicalName - Canonical public model or route name.
 * @param indexes - Precomputed configuration and provider pool indexes.
 * @returns Ordered array of candidate descriptors, or an empty array if unresolvable.
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

/**
 * Normalizes optional model body mutation fields into non-null dictionaries.
 *
 * @param model - Model configuration containing optional mutation records.
 * @returns Complete {@link NativeMutations} object with non-null dictionaries.
 */
function mutationsOf(model: ModelConfig): NativeMutations {
  return {
    defaults: model.defaults ?? {},
    extraBody: model.extraBody ?? {},
    overrides: model.overrides ?? {},
  };
}
