/**
 * @fileoverview Provider header helpers shared by native preparation and dispatch.
 *
 * Re-exports domain header filtering utilities for outbound requests and inbound
 * responses, and provides RFC 7231 `Retry-After` parsing to normalize provider
 * rate-limit backoff hints into millisecond delays for key pool cooldown management.
 */

/**
 * Re-exports canonical header filtering utilities and auth types from the domain layer.
 */
export {
  filterInboundHeaders,
  filterOutboundHeaders,
  HOP_BY_HOP,
  INBOUND_REMOVE,
  OUTBOUND_REMOVE,
  type OutboundAuth,
} from "../../domain/headers.ts";

/**
 * Parses an RFC 7231 `Retry-After` header into a millisecond delay.
 *
 * Supports both delta-seconds and HTTP-date formats. Converts delta-seconds to
 * milliseconds and computes the difference between HTTP dates and the provided clock.
 * Expired dates or unparseable formats return `undefined`.
 *
 * @param value - Raw header value, or `undefined` if the header is absent.
 * @param nowMs - Current Unix epoch timestamp in milliseconds for date comparisons.
 * @returns Delay in milliseconds, or `undefined` if missing, invalid, or expired.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    // Guard the finite check against digit strings so long that parsing overflows to infinity.
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const date = Date.parse(value);
  const delta = Number.isFinite(date) ? date - nowMs : Number.NaN;
  // Drop past dates instead of returning a negative delay, so an expired hint means no delay.
  return Number.isFinite(delta) && delta > 0 ? Math.ceil(delta) : undefined;
}
