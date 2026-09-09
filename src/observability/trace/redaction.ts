/**
 * @fileoverview Field-aware secret redaction for parsed trace payloads.
 *
 * Sanitizes parsed trace payloads before they are serialized to disk. Replaces
 * known credential header values and strings matching resolved provider/client
 * secrets with a pinned `"[REDACTED]"` token.
 *
 * Invariants: Operates exclusively on parsed JSON structures and header maps. Raw byte
 * streams (SSE, binary payloads) are never substring-scanned and rely on filesystem
 * permissions for protection. Matching against secrets requires exact string equality.
 */

import type { HeaderMap, JsonValue } from "../../domain/contracts.ts";

/** Pinned replacement marker for redacted credential values and resolved secrets. */
export const REDACTED = "[REDACTED]";

/** Credential header names whose values are always redacted in parsed fields. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "set-cookie",
]);

/**
 * Field-aware redactor for scrubbed trace fields and headers.
 *
 * Provides methods to scrub sensitive values from JSON payloads and HTTP headers
 * before persistence, preserving structural shapes while replacing secrets with {@link REDACTED}.
 */
export interface Redactor {
  /**
   * Replaces exact secret matches and credential header values inside parsed JSON.
   *
   * @param value - Parsed JSON value to redact. Input is never mutated.
   * @returns A fresh {@link JsonValue} with secrets replaced.
   */
  redactJson(value: JsonValue): JsonValue;

  /**
   * Redacts credential header values and any header value equal to a secret.
   *
   * @param headers - The header map to redact. Keys are normalized to lowercase.
   * @returns A fresh {@link HeaderMap} with lowercase keys and redacted values.
   */
  redactHeaders(headers: HeaderMap): HeaderMap;
}

/**
 * Creates a redactor bound to a fixed set of resolved secrets.
 *
 * @param secrets - Resolved client and provider secret strings to redact.
 * @returns A {@link Redactor} instance.
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
 * Recursively redacts exact secret matches and credential header values in parsed JSON.
 *
 * @param value - Parsed JSON value to traverse.
 * @param secrets - Resolved secret values to match against exactly.
 * @returns A fresh {@link JsonValue} with sensitive strings replaced by {@link REDACTED}.
 */
function redactValue(value: JsonValue, secrets: ReadonlySet<string>): JsonValue {
  if (typeof value === "string") return secrets.has(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((child) => redactValue(child, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) {
      // A field held under a credential header name is redacted even when the secret carries a scheme prefix.
      // For example, the value `Bearer <secret>` never equals the bare secret, so only the key reveals it.
      const redacted =
        CREDENTIAL_HEADERS.has(key.toLowerCase()) && typeof child === "string" ? REDACTED : redactValue(child, secrets);
      Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}
