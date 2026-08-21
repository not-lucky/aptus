import type { JsonObject, JsonValue } from "./contracts.ts";

/**
 * `true` when a value is a plain JSON object (not an array or `null`).
 *
 * The single spelling of this check: the translation decoders, the IR
 * validator, and the provider request mutators all narrow wire values with it.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep equality for JSON values (order-independent for objects).
 * `undefined` is treated as absent (only equal to itself) to support
 * mutation path-missing checks.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, (b as unknown[])[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) && jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Alias kept for mutation call sites. */
export const isJsonEqual = jsonEqual;

/**
 * Deep clone for JSON values via `structuredClone`.
 */
export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value) as T;
}

/**
 * Encodes an array of path segments into an RFC 6901 JSON pointer string.
 *
 * @param path - Array of string keys or numeric array indexes.
 * @returns Formatted JSON pointer prefixed with `/` (or `""` if empty).
 */
export function jsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/**
 * Decodes an RFC 6901 JSON pointer string into unescaped path segments.
 */
export function segmentsFromPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Reads a value at a path of object keys; returns `undefined` when absent.
 */
export function getPath(target: JsonObject, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = target;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Writes a value at a path, creating intermediate plain objects.
 */
export function setPathCreate(target: Record<string, JsonValue>, segments: readonly string[], value: JsonValue): void {
  let current = target;
  const last = segments.length - 1;
  for (let index = 0; index < last; index++) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (!isPlainObject(next)) current[segment] = {} as JsonValue;
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments[last] as string] = value;
}

/**
 * Overlays a value at `segments` inside a plain JS object/array tree
 * (used for config secret overlay; parents are assumed to exist).
 */
export function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) current = current[segments[i] as string | number] as Record<string | number, unknown>;
  current[segments[last] as string | number] = value;
}

/**
 * Visits every non-object leaf of a JSON tree depth-first in key order.
 */
export function forEachLeaf(root: JsonObject, visit: (segments: readonly string[], value: JsonValue) => void): void {
  const walk = (node: JsonValue, segments: string[]): void => {
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...segments, key]);
    } else visit(segments, node);
  };
  walk(root, []);
}
