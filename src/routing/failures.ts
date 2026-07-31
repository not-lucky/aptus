import type { AttemptObservation, JsonValue, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";

/**
 * The routing failure vocabulary: constructors and projections for the
 * {@link NormalizedFailure} values the Gateway terminates requests with.
 */

export function notFoundFailure(): NormalizedFailure {
  return { category: "not_found", message: "model not found", retryable: false };
}

export function unavailableFailure(): NormalizedFailure {
  return { category: "unavailable", message: "no provider key available", retryable: false };
}

export function timeoutFailure(): NormalizedFailure {
  return { category: "timeout", message: "request deadline exceeded", retryable: false };
}

export function unsupportedCapabilityFailure(targetProtocol: Protocol): NormalizedFailure {
  return {
    category: "unsupported_capability",
    message: "no compatible provider candidate",
    capability: targetProtocol,
    retryable: false,
  };
}

export function interruptedFailure(): NormalizedFailure {
  return { category: "stream_interrupted", message: "provider response body was interrupted", retryable: false };
}

/**
 * Maps a dispatch error (transport or timeout) to a normalized failure.
 */
export function dispatchFailure(error: unknown): NormalizedFailure {
  const kind = (error as { dispatchErrorKind?: unknown }).dispatchErrorKind;
  if (kind === "timeout") {
    return { category: "timeout", message: "provider request timed out", retryable: false };
  }
  return { category: "provider", message: "provider request failed", retryable: false };
}

/**
 * Maps a typed stream error to a normalized failure.
 */
export function streamFailure(error: unknown): NormalizedFailure {
  const kind = (error as { streamErrorKind?: unknown }).streamErrorKind;
  if (kind === "idle_timeout" || kind === "deadline") {
    return { category: "timeout", message: "provider stream timed out", retryable: false };
  }
  return { category: "stream_interrupted", message: "provider stream was interrupted", retryable: false };
}

/**
 * Maps a non-2xx attempt observation to a normalized failure.
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
 * Projects a normalized failure into a plain JSON value for the Trace stage.
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
 * Maps an IR failure category to its target-protocol HTTP response status code.
 *
 * @param category - Canonical failure category.
 * @param protocol - Client protocol owning the response envelope. Only
 * `unavailable` differs across protocols (Anthropic `overloaded_error` is 529
 * while OpenAI uses 503).
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
