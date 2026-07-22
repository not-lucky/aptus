import type { HeaderMap, Protocol } from "../domain/contracts.js";
import type { EncodedFailure, ErrorEncoder, IrFailureCategory, NormalizedFailure } from "../domain/operations.js";
import type { AptusRequestId } from "../domain/request-id.js";

const encoder = new TextEncoder();

/**
 * Creates the protocol-native error encoder for converting normalized domain failures into client response envelopes.
 *
 * @returns An {@link ErrorEncoder} instance.
 */
export function createErrorEncoder(): ErrorEncoder {
  return {
    encode(input) {
      return encodeFailure(input.protocol, input.failure, input.aptusRequestId);
    },
  };
}

/**
 * Encodes a pre-admission failure (such as invalid JSON body or missing content-type)
 * before an Aptus request ID has been minted.
 *
 * @param protocol - The target client protocol.
 * @param failure - Normalized failure details.
 * @returns An {@link EncodedFailure} ready for HTTP response serialization.
 */
export function encodeUnidentifiedFailure(protocol: Protocol, failure: NormalizedFailure): EncodedFailure {
  return encodeFailure(protocol, failure);
}

/**
 * Encodes an unexpected internal 500 error after an Aptus request ID has been minted.
 *
 * @param protocol - The target client protocol.
 * @param aptusRequestId - Unique request identifier for traceability.
 * @returns An {@link EncodedFailure} representing an internal server error.
 */
export function encodeInternalFailure(protocol: Protocol, aptusRequestId: AptusRequestId): EncodedFailure {
  return encodeEnvelope(protocol, "internal", "internal server error", "internal_error", 500, aptusRequestId);
}

/**
 * Encodes an unexpected internal 500 error before an Aptus request ID was minted.
 *
 * @param protocol - The target client protocol.
 * @returns An {@link EncodedFailure} representing an internal server error without a request ID.
 */
export function encodeUnidentifiedInternalFailure(protocol: Protocol): EncodedFailure {
  return encodeEnvelope(protocol, "internal", "internal server error", "internal_error", 500);
}

/**
 * Internal helper to format failure envelope, assign status, and attach Retry-After headers if present.
 */
function encodeFailure(
  protocol: Protocol,
  failure: NormalizedFailure,
  aptusRequestId?: AptusRequestId,
): EncodedFailure {
  const encoded = encodeEnvelope(
    protocol,
    failure.category,
    failure.message,
    failure.code,
    failureStatus(failure.category, protocol),
    aptusRequestId,
  );
  if (failure.retryAfterSeconds === undefined || failure.retryAfterSeconds <= 0) return encoded;
  return {
    ...encoded,
    headers: { ...encoded.headers, "retry-after": String(Math.floor(failure.retryAfterSeconds)) },
  };
}

/**
 * Maps failure categories to exact HTTP status codes according to protocol specification.
 *
 * Notable protocol differences:
 * - `"unavailable"` -> Anthropic returns HTTP 529 (`overloaded_error`); OpenAI returns HTTP 503 (`api_error`).
 * - `"stream_interrupted"` -> HTTP 502.
 */
function failureStatus(category: IrFailureCategory, protocol: Protocol): number {
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
    case "timeout":
      return 504;
    case "unavailable":
      return protocol === "anthropic-messages" ? 529 : 503;
    case "provider":
    case "stream_interrupted":
      return 502;
  }
}

/**
 * Constructs protocol-specific error payload shapes:
 * - Anthropic: `{ type: "error", error: { type, message }, request_id? }`
 * - OpenAI: `{ error: { message, type, param: null, code } }`
 */
function encodeEnvelope(
  protocol: Protocol,
  category: IrFailureCategory | "internal",
  message: string,
  code: string | undefined,
  status: number,
  aptusRequestId?: AptusRequestId,
): EncodedFailure {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (aptusRequestId !== undefined) headers["x-aptus-request-id"] = aptusRequestId;
  const body =
    protocol === "anthropic-messages"
      ? {
          type: "error",
          error: { type: anthropicErrorType(category), message },
          ...(aptusRequestId === undefined ? {} : { request_id: aptusRequestId }),
        }
      : {
          error: {
            message,
            type: openAiErrorType(category),
            param: null,
            code: code ?? null,
          },
        };
  return { status, headers, body: encoder.encode(JSON.stringify(body)) };
}

/**
 * Maps failure categories to OpenAI error types.
 */
function openAiErrorType(category: IrFailureCategory | "internal"): string {
  switch (category) {
    case "invalid_request":
    case "unsupported_capability":
    case "payload_too_large":
      return "invalid_request_error";
    case "authentication":
      return "authentication_error";
    case "permission":
      return "permission_error";
    case "not_found":
      return "not_found_error";
    case "rate_limit":
    case "quota":
      return "rate_limit_error";
    default:
      return "api_error";
  }
}

/**
 * Maps failure categories to Anthropic error types.
 */
function anthropicErrorType(category: IrFailureCategory | "internal"): string {
  switch (category) {
    case "invalid_request":
    case "unsupported_capability":
      return "invalid_request_error";
    case "payload_too_large":
      return "request_too_large";
    case "authentication":
      return "authentication_error";
    case "permission":
      return "permission_error";
    case "not_found":
      return "not_found_error";
    case "conflict":
      return "conflict_error";
    case "rate_limit":
    case "quota":
      return "rate_limit_error";
    case "timeout":
      return "timeout_error";
    case "unavailable":
      return "overloaded_error";
    default:
      return "api_error";
  }
}

/**
 * Strips hop-by-hop HTTP headers and cookies before relaying upstream provider responses back to the client.
 *
 * @param headers - Raw response headers from upstream provider.
 * @returns Sanitized header map with lower-cased keys.
 */
export function filterResponseHeaders(headers: HeaderMap): HeaderMap {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS[normalized] !== true && normalized !== "set-cookie") filtered[normalized] = value;
  }
  return filtered;
}

/** RFC 7230 hop-by-hop headers stripped from forwarded responses. */
const HOP_BY_HOP_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};
