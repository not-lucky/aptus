/**
 * @fileoverview
 * Protocol-native serialization of normalized domain failures into HTTP responses.
 *
 * Translates domain {@link NormalizedFailure} records into protocol-specific error envelopes
 * matching the wire formats expected by OpenAI Chat, OpenAI Responses, and Anthropic Messages clients.
 * Handles HTTP status mapping, header construction (including `retry-after` and request IDs),
 * and UTF-8 JSON payload serialization for both identified requests and early admission rejections.
 */

import type { Protocol } from "../domain/contracts.ts";
import { filterInboundHeaders } from "../domain/headers.ts";
import {
  anthropicErrorType,
  type EncodedFailure,
  type ErrorEncoder,
  type IrFailureCategory,
  type NormalizedFailure,
} from "../domain/operations.ts";
import type { AptusRequestId } from "../domain/request-id.ts";
import { statusFromCategory } from "../routing/failures.ts";

/** Shared text encoder for serializing error envelopes to response bytes. */
const encoder = new TextEncoder();

/**
 * Creates an error encoder instance implementing the {@link ErrorEncoder} gateway contract.
 *
 * @returns Error encoder capable of formatting failures across all supported client protocols.
 */
export function createErrorEncoder(): ErrorEncoder {
  return {
    /**
     * Encodes a normalized failure into the wire envelope format of the target protocol.
     *
     * @param input - Protocol, failure details, and request ID to encode.
     * @returns Encoded failure containing status code, headers, and serialized body bytes.
     */
    encode(input) {
      return encodeFailure(input.protocol, input.failure, input.aptusRequestId);
    },
  };
}

/**
 * Encodes a pre-admission failure occurring before a request ID has been assigned.
 *
 * @param protocol - Client protocol expected on the receiving endpoint.
 * @param failure - Normalized failure description to encode.
 * @returns Encoded HTTP failure response without request identifier headers or fields.
 */
export function encodeUnidentifiedFailure(protocol: Protocol, failure: NormalizedFailure): EncodedFailure {
  return encodeFailure(protocol, failure);
}

/**
 * Encodes an unexpected internal server error for an identified request.
 *
 * @param protocol - Client protocol expected on the receiving endpoint.
 * @param aptusRequestId - Unique request identifier to correlate in headers and envelopes.
 * @returns Encoded 500 error envelope with safe generic error messaging.
 */
export function encodeInternalFailure(protocol: Protocol, aptusRequestId: AptusRequestId): EncodedFailure {
  return encodeEnvelope(protocol, "internal", "internal server error", "internal_error", 500, aptusRequestId);
}

/**
 * Encodes an unexpected internal server error occurring before request identity assignment.
 *
 * @param protocol - Client protocol expected on the receiving endpoint.
 * @returns Encoded 500 error envelope without request identifier metadata.
 */
export function encodeUnidentifiedInternalFailure(protocol: Protocol): EncodedFailure {
  return encodeEnvelope(protocol, "internal", "internal server error", "internal_error", 500);
}

/**
 * Formats a failure envelope with category-to-status mapping and optional `retry-after` header.
 *
 * @param protocol - Client protocol expected on the receiving endpoint.
 * @param failure - Normalized failure details.
 * @param aptusRequestId - Optional request identifier.
 * @returns Encoded failure ready for HTTP transmission.
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
    statusFromCategory(failure.category, protocol),
    aptusRequestId,
  );
  if (failure.retryAfterSeconds === undefined || failure.retryAfterSeconds <= 0) return encoded;
  return {
    ...encoded,
    headers: { ...encoded.headers, "retry-after": String(Math.floor(failure.retryAfterSeconds)) },
  };
}

/**
 * Constructs protocol-specific wire JSON bodies and attaches standard headers.
 *
 * @param protocol - Target client protocol determining the JSON schema.
 * @param category - Failure category or internal error marker.
 * @param message - Client-safe error message.
 * @param code - Optional provider or application error code.
 * @param status - HTTP status code.
 * @param aptusRequestId - Optional request identifier to attach.
 * @returns Serialized encoded failure record.
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
 * Maps an IR failure category or internal error marker to its OpenAI error type string.
 *
 * @param category - Failure category to map.
 * @returns OpenAI-compatible error type identifier.
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

/** Inbound response header filter shared with the relay path. */
export const filterResponseHeaders = filterInboundHeaders;
