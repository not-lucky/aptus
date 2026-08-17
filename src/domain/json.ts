import type { JsonObject } from "./contracts.ts";

/**
 * `true` when a value is a plain JSON object (not an array or `null`).
 *
 * The single spelling of this check: the translation decoders, the IR
 * validator, and the provider request mutators all narrow wire values with it.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}
