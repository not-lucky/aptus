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

export function cancelledFailure(): NormalizedFailure {
  return { category: "provider", message: "request cancelled", retryable: false };
}

export function internalFailure(): NormalizedFailure {
  return { category: "provider", message: "internal gateway error", retryable: false };
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
