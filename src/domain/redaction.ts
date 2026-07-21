/**
 * Boundary-safe recursive redaction policy.
 *
 * This module is the single place that decides which values are sensitive and
 * how they are masked. It is imported by the error builder and is intended to be
 * reused by trace, log, and metrics adapters so that authorization headers,
 * resolved secrets, token hashes, request/response bodies, prompts, tool
 * arguments, provider responses, and arbitrary metadata are never emitted in the
 * clear. Redaction produces a deep copy and never mutates its input, so callers
 * keep ownership of the original value; it performs no I/O.
 */

/** Substituted for any value stored under a sensitive key, at any depth. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";
/** Substituted when a cyclic reference is re-encountered during traversal. */
export const CIRCULAR_PLACEHOLDER = "[CIRCULAR]";

/**
 * Sensitive key names in normalized form (lowercase, with `-`, `_`, and spaces
 * removed) so that `token_hash`, `tokenHash`, and `token-hash` all collapse to
 * the same entry. Whenever an object key normalizes to one of these, its entire
 * value is replaced rather than recursed into.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "tokens",
  "tokenhash",
  "tokenhashes",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
  "apikey",
  "apikeys",
  "secret",
  "secrets",
  "secretref",
  "secretreference",
  "password",
  "passphrase",
  "credential",
  "credentials",
  "authorizationtoken",
  "body",
  "requestbody",
  "responsebody",
  "rawbody",
  "prompt",
  "prompts",
  "arguments",
  "argumentsjson",
  "toolarguments",
  "providerresponse",
  "rawresponse",
  "metadata",
  "headers",
]);

/** Normalize a key for case- and separator-insensitive sensitive-key matching. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** A plain data object (object literal or null-prototype), not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return CIRCULAR_PLACEHOLDER;
  if (Array.isArray(value)) {
    seen.add(value);
    const result = value.map((element) => redactInternal(element, seen));
    seen.delete(value);
    return result;
  }
  // Non-plain objects (Map, Set, class instances, Date, ...) may expose secrets
  // through non-enumerable state, so they are masked wholesale rather than copied.
  if (!isPlainObject(value)) return REDACTION_PLACEHOLDER;
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? REDACTION_PLACEHOLDER
      : redactInternal(entry, seen);
  }
  seen.delete(value);
  return result;
}

/** True when a key names a value that must be masked before it leaves the core. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

/**
 * Return a redacted deep copy of any JSON-like value. Values stored under a
 * sensitive key are replaced with {@link REDACTION_PLACEHOLDER}; cyclic
 * references become {@link CIRCULAR_PLACEHOLDER}. Key order and array positions
 * are preserved and the input is never mutated.
 */
export function redactValue(value: unknown): unknown {
  return redactInternal(value, new WeakSet<object>());
}

/**
 * Redact a `GatewayError.details` bag. Returns `undefined` unchanged so callers
 * can conditionally include the field under `exactOptionalPropertyTypes`.
 */
export function redactDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return redactInternal(details, new WeakSet<object>()) as Record<
    string,
    unknown
  >;
}
