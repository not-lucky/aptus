import type { NormalizedFailure } from "../domain/operations.ts";

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
