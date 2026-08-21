import type { HeaderMap } from "./contracts.ts";

/**
 * Hop-by-hop and transport-framing header names defined by RFC 7230 §6.1.
 * Never forwarded across the gateway boundary in either direction.
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
 * Outbound request headers removed before dispatch. Extends the hop-by-hop set
 * with framing fields the dispatcher owns (`host`, `content-length`) and the
 * client's authentication credentials, which Aptus replaces with the selected
 * provider key credential.
 */
export const OUTBOUND_REMOVE: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "authorization",
  "x-api-key",
]);

/**
 * Inbound response headers removed after dispatch. Extends the hop-by-hop set
 * with `set-cookie`, which is intentionally never relayed to downstream clients.
 */
export const INBOUND_REMOVE: ReadonlySet<string> = new Set([...HOP_BY_HOP, "set-cookie"]);

/**
 * Provider authentication header installed on an outbound request.
 */
export interface OutboundAuth {
  readonly name: string;
  readonly value: string;
}

/**
 * Builds the filtered outbound request headers for a provider dispatch.
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
 * Filters inbound provider response headers before they reach the Gateway.
 */
export function filterInboundHeaders(headers: HeaderMap): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!INBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  return result;
}
