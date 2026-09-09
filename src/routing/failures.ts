/**
 * @fileoverview
 * Normalized routing failure vocabulary and status mapping for the Aptus gateway.
 *
 * Provides factory functions for standard routing failures (`not_found`, `unavailable`,
 * `timeout`, `unsupported_capability`, `stream_interrupted`), mappers from transport/stream
 * exceptions and provider attempt observations to {@link NormalizedFailure}, serialization
 * to trace JSON, and HTTP status code resolution across client protocols.
 */

import type { AttemptObservation, JsonValue, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";

/**
 * Constructs a normalized failure for an unresolvable model or route name.
 *
 * @returns Non-retryable 404 failure record.
 */
export function notFoundFailure(): NormalizedFailure {
  return { category: "not_found", message: "model not found", retryable: false };
}

/**
 * Constructs a normalized failure when no usable provider key is available.
 *
 * @returns Non-retryable failure indicating provider key exhaustion.
 */
export function unavailableFailure(): NormalizedFailure {
  return { category: "unavailable", message: "no provider key available", retryable: false };
}

/**
 * Constructs a normalized failure when a request exceeds its allotted deadline.
 *
 * @returns Non-retryable timeout failure record.
 */
export function timeoutFailure(): NormalizedFailure {
  return { category: "timeout", message: "request deadline exceeded", retryable: false };
}

/**
 * Constructs a normalized failure when no candidate supports the requested protocol capability.
 *
 * @param targetProtocol - Provider protocol for which translation or capability is missing.
 * @returns Non-retryable capability failure record.
 */
export function unsupportedCapabilityFailure(targetProtocol: Protocol): NormalizedFailure {
  return {
    category: "unsupported_capability",
    message: "no compatible provider candidate",
    capability: targetProtocol,
    retryable: false,
  };
}

/**
 * Constructs a normalized failure when a provider streaming response disconnects prematurely.
 *
 * @returns Non-retryable stream interruption failure record.
 */
export function interruptedFailure(): NormalizedFailure {
  return { category: "stream_interrupted", message: "provider response body was interrupted", retryable: false };
}

/**
 * Maps an upstream dispatch or connection error to a normalized failure.
 *
 * @param error - Caught dispatch error.
 * @returns Normalized failure categorized as timeout or provider error.
 */
export function dispatchFailure(error: unknown): NormalizedFailure {
  const kind = (error as { dispatchErrorKind?: unknown }).dispatchErrorKind;
  if (kind === "timeout") {
    return { category: "timeout", message: "provider request timed out", retryable: false };
  }
  return { category: "provider", message: "provider request failed", retryable: false };
}

/**
 * Maps an SSE or chunk streaming error to a normalized failure.
 *
 * @param error - Caught stream error.
 * @returns Normalized failure categorized as timeout or stream interruption.
 */
export function streamFailure(error: unknown): NormalizedFailure {
  const kind = (error as { streamErrorKind?: unknown }).streamErrorKind;
  if (kind === "idle_timeout" || kind === "deadline") {
    return { category: "timeout", message: "provider stream timed out", retryable: false };
  }
  return { category: "stream_interrupted", message: "provider stream was interrupted", retryable: false };
}

/**
 * Maps a non-success provider attempt observation to a normalized failure.
 *
 * @param observation - Provider attempt observation.
 * @returns Normalized failure with retry delay if reported by the upstream provider.
 */
export function failureFromObservation(observation: AttemptObservation): NormalizedFailure {
  const category: IrFailureCategory =
    observation.result === "success" || observation.result === "client_cancelled" ? "provider" : observation.result;
  return {
    category,
    message: "upstream provider request failed",
    retryable: false,
    ...(observation.retryDelayMs === undefined
      ? {}
      : { retryAfterSeconds: Math.ceil(observation.retryDelayMs / 1000) }),
  };
}

/**
 * Serializes a normalized failure into a plain JSON object for trace recording.
 *
 * @param failure - Normalized failure to serialize.
 * @returns JSON-safe representation of the failure.
 */
export function failureJson(failure: NormalizedFailure): JsonValue {
  const out: Record<string, JsonValue> = {
    category: failure.category,
    message: failure.message,
    retryable: failure.retryable,
  };
  if (failure.code !== undefined) out.code = failure.code;
  if (failure.capability !== undefined) out.capability = failure.capability;
  if (failure.retryAfterSeconds !== undefined) out.retryAfterSeconds = failure.retryAfterSeconds;
  return out;
}

/**
 * Maps an IR failure category to the corresponding HTTP status code for the client protocol.
 *
 * @param category - Canonical failure category.
 * @param protocol - Client protocol owning the response envelope.
 * @returns Standard HTTP response status code.
 */
export function statusFromCategory(category: IrFailureCategory, protocol: Protocol): number {
  switch (category) {
    case "invalid_request":
    case "unsupported_capability":
      return 400;
    case "authentication":
      return 401;
    case "permission":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "payload_too_large":
      return 413;
    case "rate_limit":
    case "quota":
      return 429;
    case "unavailable":
      return protocol === "anthropic-messages" ? 529 : 503;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}
