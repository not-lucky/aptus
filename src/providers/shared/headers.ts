export {
  filterInboundHeaders,
  filterOutboundHeaders,
  HOP_BY_HOP,
  INBOUND_REMOVE,
  OUTBOUND_REMOVE,
  type OutboundAuth,
} from "../../domain/headers.ts";

/**
 * Parses an RFC 7231 `Retry-After` header (either delta-seconds or HTTP-date)
 * into a positive millisecond delay, or returns `undefined` if missing or unparseable.
 *
 * @param value - The raw header value, if present.
 * @param nowMs - Current Unix epoch timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Millisecond delay in integer milliseconds if valid and positive; otherwise `undefined`.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const date = Date.parse(value);
  const delta = Number.isFinite(date) ? date - nowMs : Number.NaN;
  return Number.isFinite(delta) && delta > 0 ? Math.ceil(delta) : undefined;
}
