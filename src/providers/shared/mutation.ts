import type { JsonObject, JsonValue, NativeMutations } from "../../domain/contracts.ts";

/**
 * A mutable JSON object (the working copy the mutation pipeline writes into).
 */
type MutableJsonObject = Record<string, JsonValue>;

/**
 * Result of applying the ordered native mutation pipeline to a client body.
 */
export interface NativeMutationResult {
  /**
   * Fully mutated request body (a fresh object; the inputs are never mutated).
   */
  readonly body: JsonObject;

  /**
   * RFC 6901 JSON Pointers recording every mutation in application order.
   */
  readonly mutations: readonly string[];
}

/**
 * Applies the protocol-agnostic native mutation pipeline in deterministic order:
 *
 * 1. **defaults** — each leaf inserted only where the path is absent.
 * 2. **extraBody** — deep merge (recurse when both sides are plain objects).
 * 3. **overrides** — replace-or-insert each leaf.
 * 4. **model replacement** — `body.model = upstreamModel`, recorded last.
 *
 * Unknown fields and array order survive; object key order and whitespace are
 * not preserved. The configured mutation maps are deep-frozen and are never
 * mutated; the returned body is a fresh deep clone of the client body.
 *
 * @param clientBody - Parsed, duplicate-free client request body.
 * @param mutations - Ordered native mutation maps.
 * @param upstreamModel - Upstream provider model ID substituted for the public name.
 * @returns The mutated body and the ordered list of mutation pointers.
 */
export function applyNativeMutations(
  clientBody: JsonObject,
  mutations: NativeMutations,
  upstreamModel: string,
): NativeMutationResult {
  const body = cloneJson(clientBody) as MutableJsonObject;
  const pointers: string[] = [];

  // 1. defaults: insert absent-only leaves.
  if (mutations?.defaults) {
    forEachLeaf(mutations.defaults, (segments, value) => {
      if (pathIsWritable(body, segments) && getPath(body, segments) === undefined) {
        setPath(body, segments, cloneJson(value));
        pointers.push(toPointer(segments));
      }
    });
  }

  // 2. extraBody: deep merge, recording each changed/inserted leaf.
  if (mutations?.extraBody) {
    mergeExtraBody(body, mutations.extraBody, pointers, []);
  }

  // 3. overrides: replace-or-insert each changed leaf.
  if (mutations?.overrides) {
    forEachLeaf(mutations.overrides, (segments, value) => {
      const existing = getPath(body, segments);
      if (!isJsonEqual(existing, value)) {
        setPath(body, segments, cloneJson(value));
        pointers.push(toPointer(segments));
      }
    });
  }

  // 4. model replacement is recorded only when it actually changes.
  if (body.model !== upstreamModel) {
    body.model = upstreamModel;
    pointers.push("/model");
  }

  return { body, mutations: pointers };
}

/**
 * Deeply merges `source` into `target`, recursing only when both sides are
 * plain objects; otherwise the source leaf replaces the target value. Every
 * inserted or replaced leaf records its RFC 6901 pointer in application order.
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
 * Deep equality check for JSON values.
 */
function isJsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!isJsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Visits every non-object leaf of a JSON tree depth-first in key order.
 */
function forEachLeaf(root: JsonObject, visit: (segments: readonly string[], value: JsonValue) => void): void {
  const walk = (node: JsonValue, segments: string[]): void => {
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...segments, key]);
    } else {
      visit(segments, node);
    }
  };
  walk(root, []);
}

/**
 * `true` when a value is a plain JSON object (not an array or `null`).
 */
function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-clones a JSON value into fresh plain objects and arrays.
 */
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out: MutableJsonObject = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneJson(child);
    return out;
  }
  return value;
}

/**
 * `true` when every intermediate segment is absent or a plain object.
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

/**
 * Reads a value at a path of object keys; returns `undefined` when absent.
 */
function getPath(target: JsonObject, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = target;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Writes a value at a path of object keys, creating intermediate objects.
 */
function setPath(target: MutableJsonObject, segments: readonly string[], value: JsonValue): void {
  let current = target;
  const last = segments.length - 1;
  for (let index = 0; index < last; index++) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (!isPlainObject(next)) {
      current[segment] = {};
    }
    current = current[segment] as MutableJsonObject;
  }
  current[segments[last] as string] = value;
}

/**
 * Encodes path segments into an RFC 6901 JSON Pointer.
 */
function toPointer(segments: readonly string[]): string {
  return `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
