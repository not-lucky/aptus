/**
 * @fileoverview HTTP header filtering for provider dispatch and response relay.
 *
 * Sanitizes headers crossing the gateway boundary in both directions: strips hop-by-hop
 * transport headers (RFC 7230), prevents client credential leakage, injects provider
 * authentication tokens, and blocks inbound cookies (`set-cookie`).
 */

import type { HeaderMap } from "./contracts.ts";

/**
 * Hop-by-hop and transport framing header names from RFC 7230 section 6.1.
 * Dropped in both inbound and outbound directions as each connection negotiates framing independently.
 */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers stripped from outbound requests before dispatching to upstream providers.
 * Combines hop-by-hop headers, dispatcher-managed framing (`host`, `content-length`),
 * and client credentials (`authorization`, `x-api-key`).
 */
export const OUTBOUND_REMOVE: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "authorization",
  "x-api-key",
]);

/**
 * Headers stripped from inbound upstream provider responses before relaying to clients.
 * Combines hop-by-hop headers with `set-cookie` to prevent providers from setting client cookies.
 */
export const INBOUND_REMOVE: ReadonlySet<string> = new Set([...HOP_BY_HOP, "set-cookie"]);

/**
 * Upstream provider authentication header configuration.
 */
export interface OutboundAuth {
  /** Target header name (e.g. `authorization` or `x-api-key`). Normalized to lowercase during dispatch. */
  readonly name: string;
  /** Full credential string, including any required schema prefix (e.g. `Bearer <token>`). */
  readonly value: string;
}

/**
 * Prepares outbound HTTP headers for provider dispatch.
 *
 * Merges client and static provider headers after filtering through {@link OUTBOUND_REMOVE},
 * then installs the leased provider authentication header. Provider headers override
 * matching client headers, and the authentication header takes final precedence.
 *
 * @param clientHeaders - Admitted client request headers.
 * @param providerHeaders - Static headers configured on the target provider.
 * @param auth - Leased provider authentication credential.
 * @returns An immutable lowercased {@link HeaderMap} safe for outbound network dispatch.
 */
export function filterOutboundHeaders(
  clientHeaders: HeaderMap,
  providerHeaders: HeaderMap,
  auth: OutboundAuth,
): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const normalized = name.toLowerCase();
    if (!OUTBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  for (const [name, value] of Object.entries(providerHeaders)) {
    const normalized = name.toLowerCase();
    if (!OUTBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  result[auth.name.toLowerCase()] = auth.value;
  return result;
}

/**
 * Filters upstream response headers before relaying to the downstream client.
 *
 * Strips hop-by-hop framing headers and `set-cookie` directives matching {@link INBOUND_REMOVE}.
 *
 * @param headers - Raw response headers received from upstream provider.
 * @returns A filtered lowercased {@link HeaderMap} safe for downstream client delivery.
 */
export function filterInboundHeaders(headers: HeaderMap): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!INBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  return result;
}
