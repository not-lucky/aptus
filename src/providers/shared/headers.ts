import type { HeaderMap } from "../../domain/contracts.js";

/**
 * Hop-by-hop and transport-framing header names defined by RFC 7230 §6.1.
 * These are never forwarded across the gateway boundary in either direction.
 */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
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
 *
 * The header name is always lower-case; the value is pre-formatted (e.g.
 * `"Bearer <secret>"`).
 */
export interface OutboundAuth {
  readonly name: string;
  readonly value: string;
}

/**
 * Builds the filtered outbound request headers for a provider dispatch.
 *
 * Order of precedence (later entries win):
 * 1. The client's end-to-end headers (already sanitized at ingress).
 * 2. The provider's configured static headers (validated to contain no auth).
 * 3. The selected provider authentication header.
 *
 * All names are lower-cased. Hop-by-hop, framing, and client-auth headers are
 * removed. The result is a fresh object; the inputs are never mutated.
 *
 * @param clientHeaders - End-to-end headers forwarded from the client.
 * @param providerHeaders - Configured static provider headers (no auth).
 * @param auth - The selected provider authentication header to install.
 * @returns The filtered, lower-case outbound header map.
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
 *
 * Strips hop-by-hop headers and `set-cookie`, lower-cases all names, and
 * returns a fresh map. Diagnostic headers (`x-request-id`, `openai-*`, etc.)
 * are preserved. Values are never mutated.
 *
 * @param headers - Raw response headers from the dispatcher.
 * @returns The filtered, lower-case inbound header map.
 */
export function filterInboundHeaders(headers: HeaderMap): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!INBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  return result;
}

/**
 * Parses an RFC 7231 `Retry-After` header (either delta-seconds or HTTP-date)
 * into a positive millisecond delay, or returns `undefined` if missing or unparseable.
 *
 * @param value - The raw header value, if present.
 * @returns Millisecond delay in integer milliseconds if valid and positive; otherwise `undefined`.
 */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const date = Date.parse(value);
  const delta = Number.isFinite(date) ? date - Date.now() : Number.NaN;
  return Number.isFinite(delta) && delta > 0 ? Math.ceil(delta) : undefined;
}
