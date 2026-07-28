import type { HeaderMap, JsonValue } from "../../domain/contracts.ts";

/**
 * Pinned replacement marker for redacted credential values and resolved secrets.
 */
export const REDACTED = "[REDACTED]";

/**
 * Credential header names whose values are always redacted in parsed fields,
 * regardless of whether they equal a resolved secret.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "set-cookie",
]);

/**
 * Redacts parsed trace fields: credential headers and any string exactly equal
 * to a resolved client or provider secret. Raw byte payloads (`.sse`/`.bin`)
 * are never substring-scanned and remain exact.
 */
export interface Redactor {
  /**
   * Recursively replaces any string equal to a resolved secret with the
   * pinned marker, returning a fresh value.
   */
  redactJson(value: JsonValue): JsonValue;

  /**
   * Redacts credential header values and any header value equal to a secret.
   */
  redactHeaders(headers: HeaderMap): HeaderMap;
}

/**
 * Creates a {@link Redactor} for a fixed set of resolved secrets.
 *
 * @param secrets - Resolved client and provider secret values.
 * @returns A redactor applying field-aware secret redaction.
 */
export function createRedactor(secrets: ReadonlySet<string>): Redactor {
  return {
    redactJson(value) {
      return redactValue(value, secrets);
    },
    redactHeaders(headers) {
      const result: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        const normalized = name.toLowerCase();
        result[normalized] = CREDENTIAL_HEADERS.has(normalized) || secrets.has(value) ? REDACTED : value;
      }
      return result;
    },
  };
}

/**
 * Recursively redacts exact secret matches and credential-header values in a
 * parsed JSON value. Raw byte payloads are never passed through this function.
 */
function redactValue(value: JsonValue, secrets: ReadonlySet<string>): JsonValue {
  if (typeof value === "string") return secrets.has(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((child) => redactValue(child, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) {
      // A credential-header keyed field is redacted even when the secret is
      // embedded in a scheme prefix (e.g. `Bearer <secret>`).
      const redacted =
        CREDENTIAL_HEADERS.has(key.toLowerCase()) && typeof child === "string" ? REDACTED : redactValue(child, secrets);
      Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}
