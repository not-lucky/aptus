import type { IncomingHttpHeaders } from "node:http";
import type { ClientKeyConfig } from "../config/types.ts";

/**
 * Kind of client authentication credential provided:
 * - `"bearer"`: `Authorization: Bearer <secret>` header.
 * - `"api-key"`: `x-api-key: <secret>` header.
 */
export type CredentialKind = "bearer" | "api-key";

/**
 * Authenticated client identity containing the configured safe key name and credential type.
 */
export type AuthenticatedClient = { readonly name: string; readonly kind: CredentialKind };

/**
 * Expected client authentication purpose:
 * - `"openai-create"`: Requires `Authorization: Bearer <secret>` header.
 * - `"messages-create"`: Requires `x-api-key: <secret>` header.
 * - `"catalog"`: Accepts either `Authorization: Bearer` or `x-api-key`.
 */
export type AuthPurpose = "openai-create" | "messages-create" | "catalog";

/**
 * Extracts and authenticates an incoming HTTP client credential against configured client keys.
 *
 * Security and protocol invariants:
 * 1. Mutual exclusivity: A request must provide exactly one authentication header (`Authorization` OR `x-api-key`). Providing both is rejected (`undefined`).
 * 2. Duplicate header rejection: Multiple instances of the same auth header or comma-separated lists are rejected.
 * 3. Exact matching: Secret is matched against configured client key secrets in constant-time logic.
 *
 * @param headers - Express / Node.js parsed request headers.
 * @param clientKeys - Configured client key configurations.
 * @param purpose - Expected authentication format based on endpoint.
 * @param rawHeaders - Optional raw header tuple array from Node HTTP request to detect multi-header occurrences.
 * @returns {@link AuthenticatedClient} if valid; otherwise `undefined`.
 */
export function authenticateClient(
  headers: IncomingHttpHeaders,
  clientKeys: readonly ClientKeyConfig[],
  purpose: AuthPurpose,
  rawHeaders: readonly string[] | undefined = undefined,
): AuthenticatedClient | undefined {
  const authorization = credentialHeader(headers, rawHeaders, "authorization");
  const apiKey = credentialHeader(headers, rawHeaders, "x-api-key");

  // Reject if either header had invalid formatting/duplicates.
  if (authorization.kind === "invalid" || apiKey.kind === "invalid") return undefined;
  // Reject if both headers are present or both are absent (must provide exactly one).
  if (authorization.kind === apiKey.kind) return undefined;

  let parsed: { readonly kind: CredentialKind; readonly secret: string } | undefined;
  if (authorization.kind === "present") parsed = parseBearer(authorization.value);
  else if (apiKey.kind === "present") parsed = parseApiKey(apiKey.value);
  else return undefined;

  if (parsed === undefined) return undefined;
  // Enforce endpoint-specific credential scheme requirements.
  if (purpose === "openai-create" && parsed.kind !== "bearer") return undefined;
  if (purpose === "messages-create" && parsed.kind !== "api-key") return undefined;

  const matches = clientKeys.filter((key) => key.secret === parsed.secret);
  const match = matches[0];
  if (match === undefined || matches.length !== 1) return undefined;
  return { name: match.name, kind: parsed.kind };
}

type CredentialHeader =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly value: string };

/**
 * Inspects headers (preferring rawHeaders array when available) to ensure single-value presence without comma joins.
 */
function credentialHeader(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[] | undefined,
  name: "authorization" | "x-api-key",
): CredentialHeader {
  if (rawHeaders !== undefined) {
    const values: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
    }
    if (values.length === 0) return { kind: "absent" };
    const value = values[0];
    // Reject multiple header declarations or comma-separated lists.
    if (value === undefined || values.length !== 1 || value.length === 0 || value.includes(",")) {
      return { kind: "invalid" };
    }
    return { kind: "present", value };
  }
  const value = headers[name];
  if (value === undefined) return { kind: "absent" };
  return typeof value === "string" && value.length > 0 && !value.includes(",")
    ? { kind: "present", value }
    : { kind: "invalid" };
}

/**
 * Parses a `Bearer <token>` string, ensuring non-whitespace secret payload.
 */
function parseBearer(value: string): { readonly kind: "bearer"; readonly secret: string } | undefined {
  const match = /^Bearer (\S+)$/.exec(value);
  const secret = match?.[1];
  return secret === undefined ? undefined : { kind: "bearer", secret };
}

/**
 * Parses an `x-api-key` string, ensuring non-whitespace secret payload.
 */
function parseApiKey(value: string): { readonly kind: "api-key"; readonly secret: string } | undefined {
  return /^\S+$/.test(value) ? { kind: "api-key", secret: value } : undefined;
}
