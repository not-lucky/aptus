/**
 * @fileoverview Ordered native mutation pipeline for same-protocol provider requests.
 *
 * Transforms an admitted client payload into an upstream provider request body by
 * sequentially applying four mutation layers: defaults (insert absent paths), extra body
 * (deep-merge provider extensions), overrides (replace or insert paths), and model
 * replacement (swap public name for upstream ID).
 *
 * Tracks every inserted or modified leaf as an RFC 6901 JSON Pointer for dry-run
 * previews and observability traces. Operates on deep clones to preserve immutability.
 */

import type { JsonObject, JsonValue, NativeMutations } from "../../domain/contracts.ts";
import {
  cloneJson,
  forEachLeaf,
  getPath,
  jsonEqual as isJsonEqual,
  isPlainObject,
  setPathCreate as setPath,
  jsonPointer as toPointer,
} from "../../domain/json.ts";

/**
 * Writable representation of {@link JsonObject} for internal pipeline mutations.
 */
type MutableJsonObject = Record<string, JsonValue>;

/**
 * Result of applying the ordered native mutation pipeline to a client body.
 *
 * Pairs the transformed request payload with an ordered list of RFC 6901 JSON
 * Pointers recording every mutated path for auditing and dry-run reporting.
 */
export interface NativeMutationResult {
  /** Fully mutated request payload with all configured layers and model replacement applied. */
  readonly body: JsonObject;

  /** RFC 6901 JSON Pointers for every inserted or modified leaf, in application order. */
  readonly mutations: readonly string[];
}

/**
 * Applies the ordered native mutation pipeline to a client body.
 *
 * Clones the input body and executes four deterministic mutation stages:
 * 1. Defaults: Inserts values at absent paths without overwriting existing client values.
 * 2. Extra body: Recursively deep-merges provider extensions into matching object trees.
 * 3. Overrides: Unconditionally replaces or inserts values at specified paths.
 * 4. Model replacement: Sets the `model` field to the upstream provider identifier.
 *
 * @param clientBody - Parsed and validated incoming JSON body.
 * @param mutations - Configured defaults, extra body, and override mappings.
 * @param upstreamModel - Upstream model identifier to substitute in the payload.
 * @returns Mutated payload alongside RFC 6901 pointers for all applied mutations.
 */
export function applyNativeMutations(
  clientBody: JsonObject,
  mutations: NativeMutations,
  upstreamModel: string,
): NativeMutationResult {
  const body = cloneJson(clientBody) as MutableJsonObject;
  const pointers: string[] = [];

  // Apply defaults first so that explicit client choices survive and only absent paths gain values.
  if (mutations?.defaults) {
    forEachLeaf(mutations.defaults, (segments, value) => {
      if (pathIsWritable(body, segments) && getPath(body, segments) === undefined) {
        setPath(body, segments, cloneJson(value));
        pointers.push(toPointer(segments));
      }
    });
  }

  // Merge the extra body second so that provider extensions overlay the defaulted body leaf by leaf.
  if (mutations?.extraBody) {
    mergeExtraBody(body, mutations.extraBody, pointers, []);
  }

  // Apply overrides third so that forced values win over the client body and both earlier layers.
  if (mutations?.overrides) {
    forEachLeaf(mutations.overrides, (segments, value) => {
      const existing = getPath(body, segments);
      if (!isJsonEqual(existing, value)) {
        setPath(body, segments, cloneJson(value));
        pointers.push(toPointer(segments));
      }
    });
  }

  // Replace the model last and record the pointer only on change, so audits show substitution at the end.
  if (body.model !== upstreamModel) {
    body.model = upstreamModel;
    pointers.push("/model");
  }

  return { body, mutations: pointers };
}

/**
 * Recursively merges an extra body object into a mutable target.
 *
 * Recurses when both target and source values are plain objects; otherwise,
 * overwrites the target leaf with a clone of the source value and appends an
 * RFC 6901 pointer if the value changed.
 *
 * @param target - Mutable target object being modified in place.
 * @param source - Extension object containing properties to merge.
 * @param pointers - Accumulator array for recorded JSON Pointers.
 * @param segments - Current path segments from the root of the target object.
 */
function mergeExtraBody(
  target: MutableJsonObject,
  source: JsonObject,
  pointers: string[],
  segments: readonly string[],
): void {
  for (const [key, value] of Object.entries(source)) {
    const path = [...segments, key];
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {};
      }
      mergeExtraBody(target[key] as MutableJsonObject, value, pointers, path);
    } else {
      const existing = target[key];
      if (!isJsonEqual(existing, value)) {
        target[key] = cloneJson(value);
        pointers.push(toPointer(path));
      }
    }
  }
}

/**
 * Checks whether a default path can be created without overwriting existing scalar branches.
 *
 * Traverses intermediate segments from the root. Returns `false` if any intermediate
 * step encounters an existing non-object value (e.g., a primitive scalar or array).
 *
 * @param target - Root JSON object being inspected.
 * @param segments - Full path segments down to the desired leaf property.
 * @returns `true` if all intermediate segments are objects or absent; `false` otherwise.
 */
function pathIsWritable(target: JsonObject, segments: readonly string[]): boolean {
  let current: JsonValue | undefined = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current)) return false;
    const next: JsonValue | undefined = current[segment];
    if (next !== undefined && !isPlainObject(next)) return false;
    current = next;
  }
  return true;
}
