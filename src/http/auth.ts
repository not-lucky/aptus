/**
 * @fileoverview Client credential authentication for the gateway HTTP listener.
 *
 * Validates incoming client credentials before request admission. Supports Bearer tokens
 * (`Authorization: Bearer <secret>`) for OpenAI-compatible endpoints and API keys
 * (`x-api-key: <secret>`) for Anthropic-compatible endpoints. Enforces header singularity,
 * mutual exclusivity between schemes, and fail-closed secret matching against configured keys.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { ClientKeyConfig } from "../config/types.ts";

/**
 * Kind of client credential presented in the request.
 */
export type CredentialKind = "bearer" | "api-key";

/**
 * Identity of an authenticated client.
 */
export type AuthenticatedClient = {
  /** Configured name of the matching client key (safe for logging/telemetry). */
  readonly name: string;
  /** Credential scheme used by the client on this request. */
  readonly kind: CredentialKind;
};

/**
 * Endpoint-specific rule specifying permitted authentication credential schemes.
 */
export type AuthPurpose = "openai-create" | "messages-create" | "catalog";

/**
 * Extracts and authenticates client credentials from incoming request headers.
 *
 * Enforces that exactly one authentication header is present without comma folding or duplication,
 * verifies the credential format matches the expected endpoint purpose, and matches the secret
 * against configured client keys. Fails closed (returns `undefined`) if no match or duplicate matches exist.
 *
 * @param headers - Parsed lowercase request headers.
 * @param clientKeys - Configured client key definitions containing names and secrets.
 * @param purpose - Endpoint authorization purpose restricting permitted schemes.
 * @param rawHeaders - Raw alternating header list from Node's IncomingMessage, if available.
 * @returns The {@link AuthenticatedClient} identity on success, or `undefined` on authentication failure.
 */
export function authenticateClient(
  headers: IncomingHttpHeaders,
  clientKeys: readonly ClientKeyConfig[],
  purpose: AuthPurpose,
  rawHeaders: readonly string[] | undefined = undefined,
): AuthenticatedClient | undefined {
  const authorization = credentialHeader(headers, rawHeaders, "authorization");
  const apiKey = credentialHeader(headers, rawHeaders, "x-api-key");

  // Reject if either header failed singularity validation
  if (authorization.kind === "invalid" || apiKey.kind === "invalid") return undefined;
  // Reject if both headers are present or both are absent (mutual exclusivity)
  if (authorization.kind === apiKey.kind) return undefined;

  let parsed: { readonly kind: CredentialKind; readonly secret: string } | undefined;
  if (authorization.kind === "present") parsed = parseBearer(authorization.value);
  else if (apiKey.kind === "present") parsed = parseApiKey(apiKey.value);
  else return undefined;

  if (parsed === undefined) return undefined;
  // Enforce endpoint-specific credential scheme requirements
  if (purpose === "openai-create" && parsed.kind !== "bearer") return undefined;
  if (purpose === "messages-create" && parsed.kind !== "api-key") return undefined;

  // Fail-closed match against configured keys: require exactly one matching key
  const matches = clientKeys.filter((key) => key.secret === parsed.secret);
  const match = matches[0];
  if (match === undefined || matches.length !== 1) return undefined;
  return { name: match.name, kind: parsed.kind };
}

/**
 * Result of reading and checking singularity on an authentication header.
 */
type CredentialHeader =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly value: string };

/**
 * Reads a single credential header, enforcing that it occurs exactly once without commas.
 *
 * Prefers `rawHeaders` when provided to detect repeated header declarations that parsed maps merge.
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
 * Parses an `Authorization: Bearer <token>` header value.
 */
function parseBearer(value: string): { readonly kind: "bearer"; readonly secret: string } | undefined {
  const match = /^Bearer (\S+)$/.exec(value);
  const secret = match?.[1];
  return secret === undefined ? undefined : { kind: "bearer", secret };
}

/**
 * Parses an `x-api-key: <token>` header value.
 */
function parseApiKey(value: string): { readonly kind: "api-key"; readonly secret: string } | undefined {
  return /^\S+$/.test(value) ? { kind: "api-key", secret: value } : undefined;
}
