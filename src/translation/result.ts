import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { invalidRequestFailure, payloadTooLargeFailure, unsupportedCapabilityFailure } from "./failures.ts";

/**
 * The single spelling of "produce a {@link Result}" for the translation layer.
 *
 * Decode, preflight, and validation are one long chain of `Result`-returning
 * parsers, so the success and failure spellings live here once: no call site
 * builds result literals by hand, and a reader never has to check which of the
 * two forms a parser used. The `T = never` default on the failure helpers makes
 * them assignable at every `Result` return position without a type argument.
 */

/** Wraps a value in a successful result. */
export function ok<T>(value: T): Result<T, NormalizedFailure> {
  return { ok: true, value };
}

/** Wraps a normalized failure in a failed result. */
export function failure<T = never>(error: NormalizedFailure): Result<T, NormalizedFailure> {
  return { ok: false, error };
}

/**
 * Fails with `invalid_request`: the wire value or IR invariant is malformed,
 * not merely untranslatable.
 */
export function invalidRequest<T = never>(message: string): Result<T, NormalizedFailure> {
  return failure(invalidRequestFailure(message));
}

/**
 * Fails with `payload_too_large`: request body or inline media payload exceeds size limits.
 */
export function payloadTooLarge<T = never>(message: string): Result<T, NormalizedFailure> {
  return failure(payloadTooLargeFailure(message));
}

/**
 * Fails with `unsupported_capability` naming its owning matrix row, so routing
 * can skip the candidate and the client sees the exact capability ID.
 */
export function unsupportedCapability<T = never>(capability: string, detail?: string): Result<T, NormalizedFailure> {
  return failure(unsupportedCapabilityFailure(capability, detail));
}
