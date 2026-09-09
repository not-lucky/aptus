/**
 * @fileoverview Utility functions for inspecting, mutating, and traversing JSON structures.
 *
 * Provides shared helpers for deep equality, cloning, RFC 6901 JSON Pointers, path-based
 * reads/writes, and recursive leaf node traversals across gateway payloads and configurations.
 */

import type { JsonObject, JsonValue } from "./contracts.ts";

/**
 * Type guard testing whether a value is a non-null, non-array plain object.
 *
 * @param value - Value to test.
 * @returns `true` if `value` is an object and not an array or null; otherwise `false`.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

/**
 * Performs deep equality comparison between two JSON values.
 *
 * Compares primitives, arrays element-by-element, and objects key-by-key regardless of key ordering.
 *
 * @param a - First value to compare.
 * @param b - Second value to compare.
 * @returns `true` if both values are structurally equivalent; otherwise `false`.
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

/**
 * Compatibility alias for {@link jsonEqual}.
 */
export const isJsonEqual = jsonEqual;

/**
 * Creates a deep copy of a JSON value using `structuredClone`.
 *
 * @typeParam T - JSON value type.
 * @param value - Value to clone.
 * @returns A deep copy of `value`.
 */
export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value) as T;
}

/**
 * Encodes an array of path keys into an RFC 6901 JSON Pointer string.
 *
 * Characters `~` and `/` in segments are escaped to `~0` and `~1` respectively.
 *
 * @param path - Path keys or numeric array indices.
 * @returns JSON Pointer string prefixed with `/`, or `""` if the path is empty.
 */
export function jsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/**
 * Decodes an RFC 6901 JSON Pointer string into an array of unescaped path segments.
 *
 * Reverses escaping (`~1` to `/`, `~0` to `~`).
 *
 * @param pointer - RFC 6901 JSON Pointer string.
 * @returns Array of unescaped path key segments.
 */
export function segmentsFromPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Safely reads a nested property along an array of key segments, returning `undefined` if missing.
 *
 * @param target - Root object to inspect.
 * @param segments - Sequence of keys defining the lookup path.
 * @returns The value at the specified path, or `undefined` if any intermediate node is absent or non-object.
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
 * Writes a value to a nested path in place, automatically creating intermediate plain objects as needed.
 *
 * @param target - Target object to mutate.
 * @param segments - Non-empty sequence of key segments locating the property.
 * @param value - Value to set at the leaf.
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
 * Writes a value into an existing object/array tree at a path, without creating missing parents.
 *
 * Used for config secret overlays where the target structure is pre-validated.
 *
 * @param target - Pre-existing object or array tree to mutate in place.
 * @param segments - Non-empty key or index segments locating the target position.
 * @param value - Value to assign.
 */
export function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) current = current[segments[i] as string | number] as Record<string | number, unknown>;
  current[segments[last] as string | number] = value;
}

/**
 * Traverses a JSON tree depth-first, invoking a callback for every non-plain-object leaf value.
 *
 * Arrays are visited as a single unit rather than descended into.
 *
 * @param root - Root object to traverse.
 * @param visit - Callback invoked with `(segments, leafValue)` for each leaf node.
 */
export function forEachLeaf(root: JsonObject, visit: (segments: readonly string[], value: JsonValue) => void): void {
  const walk = (node: JsonValue, segments: string[]): void => {
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...segments, key]);
    } else visit(segments, node);
  };
  walk(root, []);
}
