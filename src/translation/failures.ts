/**
 * @fileoverview Normalized failure factories and diagnostic formatters for the translation layer.
 *
 * Constructs `NormalizedFailure` domain values for fail-closed capability rejections
 * referencing matrix capability IDs, invalid request payloads, and oversized payloads.
 * Also provides upstream error string bounding and Retry-After header parsing.
 */

import type { NormalizedFailure } from "../domain/operations.ts";
import type { MatrixRowId } from "./matrix.ts";

/** Maximum character length permitted for upstream error messages reflected in failure envelopes. */
export const PROVIDER_ERROR_STRING_LIMIT = 1024;

/**
 * Truncates an upstream provider error message to the gateway diagnostic character limit.
 *
 * @param value - Raw upstream error or status message.
 * @returns Bounded string with length at most {@link PROVIDER_ERROR_STRING_LIMIT}.
 */
export function truncateProviderErrorString(value: string): string {
  return value.length > PROVIDER_ERROR_STRING_LIMIT ? value.slice(0, PROVIDER_ERROR_STRING_LIMIT) : value;
}

/**
 * Parses an HTTP standard `Retry-After` header string into a non-negative integer number of seconds.
 *
 * @param rawRetry - Raw header value received from upstream response headers.
 * @returns Non-negative whole second delay, or `undefined` if absent or non-numeric.
 */
export function parseRetryAfterHeaderSeconds(rawRetry?: string): number | undefined {
  if (rawRetry === undefined) return undefined;
  const parsed = Number.parseInt(rawRetry.trim(), 10);
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Constructs a non-retryable `NormalizedFailure` for an unsupported capability in a translation direction.
 *
 * @param capabilityId - Validated matrix row identifier that has no admitted translation mapping.
 * @param message - Optional human-readable diagnostic detail.
 * @returns Normalized domain failure with category `unsupported_capability`.
 */
export function unsupportedCapabilityFailure(capabilityId: MatrixRowId, message?: string): NormalizedFailure {
  return {
    category: "unsupported_capability",
    message: message ?? `unsupported translation capability: ${capabilityId}`,
    capability: capabilityId,
    retryable: false,
  };
}

/**
 * Constructs a non-retryable `NormalizedFailure` for a malformed payload or invariant violation.
 *
 * @param message - Human-readable description of the validation error.
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
 * Constructs a non-retryable `NormalizedFailure` for an input exceeding payload or media byte limits.
 *
 * @param message - Human-readable description of the exceeded limit.
 * @returns Normalized domain failure with category `payload_too_large`.
 */
export function payloadTooLargeFailure(message: string): NormalizedFailure {
  return {
    category: "payload_too_large",
    message,
    retryable: false,
  };
}
