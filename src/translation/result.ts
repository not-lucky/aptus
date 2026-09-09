/**
 * @fileoverview Result constructors and failure wrappers for translation pipeline stages.
 *
 * Provides standardized factory functions to construct successful `Result` values and
 * normalized failure results for invalid requests, oversized payloads, and unsupported capabilities.
 */

import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { invalidRequestFailure, payloadTooLargeFailure, unsupportedCapabilityFailure } from "./failures.ts";
import type { MatrixRowId } from "./matrix.ts";

/**
 * Wraps a parsed value in a successful `Result`.
 *
 * @typeParam T - Type of the encapsulated value.
 * @param value - Success payload.
 * @returns Successful result containing `value`.
 */
export function ok<T>(value: T): Result<T, NormalizedFailure> {
  return { ok: true, value };
}

/**
 * Wraps a normalized domain failure in a failed `Result`.
 *
 * @typeParam T - Inferred success type (defaults to `never`).
 * @param error - Normalized domain failure.
 * @returns Failed result containing `error`.
 */
export function failure<T = never>(error: NormalizedFailure): Result<T, NormalizedFailure> {
  return { ok: false, error };
}

/**
 * Constructs a failed `Result` with category `invalid_request`.
 *
 * @typeParam T - Inferred success type (defaults to `never`).
 * @param message - Diagnostic message describing the validation or invariant failure.
 * @returns Failed result with normalized `invalid_request` failure.
 */
export function invalidRequest<T = never>(message: string): Result<T, NormalizedFailure> {
  return failure(invalidRequestFailure(message));
}

/**
 * Constructs a failed `Result` with category `payload_too_large`.
 *
 * @typeParam T - Inferred success type (defaults to `never`).
 * @param message - Diagnostic message describing the exceeded size limit.
 * @returns Failed result with normalized `payload_too_large` failure.
 */
export function payloadTooLarge<T = never>(message: string): Result<T, NormalizedFailure> {
  return failure(payloadTooLargeFailure(message));
}

/**
 * Constructs a failed `Result` with category `unsupported_capability` naming a matrix row.
 *
 * @typeParam T - Inferred success type (defaults to `never`).
 * @param capability - Owning capability matrix row identifier.
 * @param detail - Optional explanatory diagnostic detail.
 * @returns Failed result with normalized `unsupported_capability` failure.
 */
export function unsupportedCapability<T = never>(
  capability: MatrixRowId,
  detail?: string,
): Result<T, NormalizedFailure> {
  return failure(unsupportedCapabilityFailure(capability, detail));
}
