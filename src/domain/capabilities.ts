/**
 * Set algebra over open-string {@link Capability} tags.
 *
 * Capabilities are open strings (unknown provider capabilities must survive), so
 * these helpers treat them as an unordered set: results are deduplicated and
 * sorted by code unit for deterministic output regardless of input order. This
 * module is pure and performs no I/O. Validating that requested semantics are
 * actually supported is done here rather than by silently ignoring capabilities.
 */

import type { Capability } from "./canonical.js";

/** Outcome of checking that required capabilities are a subset of supported. */
export interface CapabilityRequirementResult {
  /** True when every required capability is present in the supported set. */
  readonly satisfied: boolean;
  /** Required capabilities absent from the supported set, deterministically ordered. */
  readonly missing: readonly Capability[];
}

function sortedUnique(values: Iterable<Capability>): Capability[] {
  return [...new Set(values)].sort();
}

/** Deduplicated, deterministically ordered intersection of two capability sets. */
export function intersectCapabilities(
  a: readonly Capability[],
  b: readonly Capability[],
): Capability[] {
  const other = new Set(b);
  return sortedUnique(a.filter((capability) => other.has(capability)));
}

/** Deduplicated, deterministically ordered union of two capability sets. */
export function unionCapabilities(
  a: readonly Capability[],
  b: readonly Capability[],
): Capability[] {
  return sortedUnique([...a, ...b]);
}

/**
 * Check that `required` is a subset of `supported`, returning the missing
 * capabilities in deterministic order. An empty requirement is always satisfied.
 */
export function checkRequiredCapabilities(
  required: readonly Capability[],
  supported: readonly Capability[],
): CapabilityRequirementResult {
  const available = new Set(supported);
  const missing = sortedUnique(required.filter((capability) => !available.has(capability)));
  return { satisfied: missing.length === 0, missing };
}
