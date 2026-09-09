/**
 * @fileoverview Shared native preparation and classification for protocol adapters.
 *
 * Implements common adapter lifecycle logic shared across `openai-chat`,
 * `openai-responses`, and `anthropic-messages`: public model extraction, payload
 * mutation, outbound header normalization with credential injection, response
 * status classification, and `Retry-After` header extraction.
 *
 * Protocol-specific differences (endpoints, auth formats, 422 mappings, and catalog
 * envelopes) are supplied via {@link NativeAdapterSpec}.
 */

import type {
  AttemptObservation,
  JsonObject,
  ModelListInput,
  NativePreparationInput,
  PreparedProviderRequest,
  Protocol,
  ProtocolAdapter,
  Result,
} from "../../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../../domain/operations.ts";
import { filterOutboundHeaders, type OutboundAuth, parseRetryAfter } from "./headers.ts";
import { applyNativeMutations } from "./mutation.ts";

/** Shared UTF-8 encoder for serializing mutated request bodies. */
const encoder = new TextEncoder();

/** Maps HTTP status codes to normalized failure categories across all protocols. */
const STATUS_CATEGORIES: ReadonlyMap<number, IrFailureCategory> = new Map([
  [400, "invalid_request"],
  [401, "authentication"],
  [403, "permission"],
  [404, "not_found"],
  [408, "timeout"],
  [409, "conflict"],
  [413, "payload_too_large"],
  [500, "unavailable"],
  [503, "unavailable"],
  [504, "timeout"],
  [529, "unavailable"],
]);

/**
 * Wire specification and formatting hooks required to instantiate a native protocol adapter.
 *
 * Defines protocol-specific configuration—endpoint path, auth header generation,
 * 422 status mapping, and catalog envelope serialization—passed to {@link createNativeAdapter}.
 */
export interface NativeAdapterSpec {
  /** Protocol identifier handled by this adapter. */
  readonly protocol: Protocol;

  /** Relative endpoint path appended to the provider base URL. */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";

  /** Generates the outbound HTTP authorization header from a leased API key or token. */
  readonly createAuth: (secret: string) => OutboundAuth;

  /** Failure category mapped to HTTP 422 responses for this protocol. */
  readonly category422: IrFailureCategory;

  /** Formats sorted catalog entries into the protocol's native model list response. */
  readonly buildModelList: (input: ModelListInput) => JsonObject;
}

/**
 * Creates a {@link ProtocolAdapter} implementing native dispatch and classification.
 *
 * Binds wire specification rules to common request preparation, header filtering,
 * status classification, and catalog response rendering.
 *
 * @param spec - Protocol-specific endpoint, auth, error mapping, and catalog configuration.
 * @returns Fully implemented, stateless {@link ProtocolAdapter}.
 */
export function createNativeAdapter(spec: NativeAdapterSpec): ProtocolAdapter {
  return {
    protocol: spec.protocol,
    createPath: spec.createPath,

    /**
     * Extracts the public model identifier from the incoming request body.
     *
     * @param body - Parsed JSON request payload.
     * @returns A {@link Result} containing the non-empty model string or an `invalid_request` error.
     */
    readPublicModel(body: JsonObject): Result<string, NormalizedFailure> {
      const model = body.model;
      return typeof model === "string" && model.length > 0
        ? { ok: true, value: model }
        : { ok: false, error: invalidRequest("model is required") };
    },

    /**
     * Prepares an upstream request by applying mutations, setting headers, and serializing the body.
     *
     * @param input - Client request body, headers, mutations, upstream model, and timeouts.
     * @returns A {@link Result} containing the prepared request ready for dispatch.
     */
    prepareNative(input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure> {
      const { body, mutations } = applyNativeMutations(input.clientBody, input.mutations, input.upstreamModel);
      const headers = filterOutboundHeaders(
        input.clientHeaders,
        input.providerHeaders,
        spec.createAuth(input.providerSecret),
      );
      return {
        ok: true,
        value: {
          // Leave the provider name empty here because this adapter is shared; the gateway stamps the name next.
          provider: "",
          protocol: input.protocol,
          url: `${input.baseUrl}${spec.createPath}`,
          headers,
          body: encoder.encode(JSON.stringify(body)),
          // Enable streaming only for an explicit boolean opt-in, so truthy non-booleans never change framing.
          stream: body.stream === true,
          deadlineMs: input.deadlineMs,
          streamIdleMs: input.streamIdleMs,
          mutations,
        },
      };
    },

    /**
     * Classifies an upstream HTTP response status and headers into an attempt observation.
     *
     * @param response - Response status and headers returned by the upstream provider.
     * @param nowMs - Optional current timestamp in milliseconds for parsing HTTP dates in `Retry-After`.
     * @returns Normalized {@link AttemptObservation} indicating outcome and retry hints.
     */
    classify(response, nowMs): AttemptObservation {
      if (response.status === 422) {
        return withRetryDelay({ result: spec.category422, status: 422 }, response.headers["retry-after"], nowMs);
      }
      return classifyNativeStatus(response.status, response.headers["retry-after"], nowMs);
    },

    /** Catalog envelope builder supplied by the owning protocol. */
    buildModelList: spec.buildModelList,
  };
}

/**
 * Classifies an HTTP status code into a normalized attempt result.
 *
 * Maps 2xx to success, 429 to rate limit, and known non-2xx statuses via {@link STATUS_CATEGORIES},
 * falling back to `provider`. Attaches parsed `Retry-After` delays when present.
 *
 * @param status - Upstream HTTP status code.
 * @param retryAfter - Raw `Retry-After` header value if present.
 * @param nowMs - Optional current timestamp for HTTP date calculations.
 * @returns Normalized {@link AttemptObservation}.
 */
function classifyNativeStatus(status: number, retryAfter: string | undefined, nowMs?: number): AttemptObservation {
  if (status >= 200 && status < 300) {
    return { result: "success", status, beforeClientBytes: true };
  }
  return withRetryDelay(
    { result: status === 429 ? "rate_limit" : (STATUS_CATEGORIES.get(status) ?? "provider"), status },
    retryAfter,
    nowMs,
  );
}

/**
 * Attaches a parsed `Retry-After` delay to an attempt observation if valid.
 *
 * @param observation - Base attempt observation containing result category and status.
 * @param retryAfter - Raw `Retry-After` header value if present.
 * @param nowMs - Optional current timestamp for HTTP date calculations.
 * @returns Observation augmented with `retryDelayMs` and `beforeClientBytes: true`.
 */
function withRetryDelay(
  observation: { readonly result: AttemptObservation["result"]; readonly status: number },
  retryAfter: string | undefined,
  nowMs?: number,
): AttemptObservation {
  const retryDelayMs = parseRetryAfter(retryAfter, nowMs);
  return {
    ...observation,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    beforeClientBytes: true,
  };
}

/**
 * Constructs a non-retryable `invalid_request` normalized failure.
 *
 * @param message - Descriptive failure message.
 * @returns Normalized failure object.
 */
function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}
