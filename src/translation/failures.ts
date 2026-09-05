import type { NormalizedFailure } from "../domain/operations.ts";

/**
 * Maximum characters copied from a single upstream error message or
 * code/type string into translated complete and stream failure responses.
 *
 * Gateway policy caps user-visible wire diagnostic strings at 1024 characters
 * to bound downstream payload overhead and prevent unbounded wire reflections;
 * the full, unredacted raw upstream bytes remain preserved in Trace.
 */
export const PROVIDER_ERROR_STRING_LIMIT = 1024;

/**
 * Truncates an upstream provider error string to {@link PROVIDER_ERROR_STRING_LIMIT}.
 *
 * @param value - Upstream message or code/type string.
 * @returns Value unchanged when within bound, otherwise the leading prefix.
 */
export function truncateProviderErrorString(value: string): string {
  return value.length > PROVIDER_ERROR_STRING_LIMIT ? value.slice(0, PROVIDER_ERROR_STRING_LIMIT) : value;
}

/**
 * Parses a Retry-After header string into non-negative whole seconds.
 *
 * Used for complete-path responses where the downstream client expects an HTTP
 * standard Retry-After header value in whole seconds.
 *
 * @param rawRetry - Raw header value from upstream response headers.
 * @returns Non-negative integer delay in seconds, or undefined if absent or invalid.
 */
export function parseRetryAfterHeaderSeconds(rawRetry?: string): number | undefined {
  if (rawRetry === undefined) return undefined;
  const parsed = Number.parseInt(rawRetry.trim(), 10);
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Creates a normalized failure for an unsupported cross-protocol capability.
 *
 * This translation-local helper avoids importing `src/routing/failures.ts`
 * to maintain strict layer isolation and prevent dependency cycles.
 *
 * @param capabilityId - Canonical capability identifier from the matrix.
 * @param message - Optional human-readable message.
 * @returns Normalized domain failure with category `unsupported_capability`.
 */
export function unsupportedCapabilityFailure(capabilityId: string, message?: string): NormalizedFailure {
  return {
    category: "unsupported_capability",
    message: message ?? `unsupported translation capability: ${capabilityId}`,
    capability: capabilityId,
    retryable: false,
  };
}

/**
 * Creates a normalized failure for an invalid cross-protocol request format or payload.
 *
 * @param message - Description of the malformed payload or violated invariant.
 * @returns Normalized domain failure with category `invalid_request`.
 */
export function invalidRequestFailure(message: string): NormalizedFailure {
  return {
    category: "invalid_request",
    message,
    retryable: false,
  };
}

/**
 * Creates a normalized failure for a payload exceeding configured size limits.
 *
 * @param message - Description of the exceeded limit.
 * @returns Normalized domain failure with category `payload_too_large`.
 */
export function payloadTooLargeFailure(message: string): NormalizedFailure {
  return {
    category: "payload_too_large",
    message,
    retryable: false,
  };
}
