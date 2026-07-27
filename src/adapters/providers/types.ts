import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
  RouteCandidate,
} from "../../domain/index.js";
import { createGatewayError } from "../../domain/index.js";
import type { ProviderTransportPort } from "../../ports/index.js";

/** Builds one isolated provider request from canonical routing inputs. */
export interface ProviderRequestFactory<TRequest> {
  /** Creates a request without retaining the canonical request or credentials. */
  (candidate: RouteCandidate, request: CanonicalRequest): TRequest;
}

/** Decodes one bounded provider response into a validated canonical response. */
export interface ProviderResponseDecoder<TResponse> {
  /** Returns a canonical response or throws a safe gateway error. */
  (response: TResponse, context: ProviderDecodeContext): CanonicalResponse;
}

/** Decodes one complete provider event directly into canonical chunks. */
export interface ProviderEventDecoder {
  /** Maps a bounded event without introducing an intermediate stream format. */
  (event: unknown, context: ProviderDecodeContext): ReadonlyArray<CanonicalChunk>;
}

/** Safe request-local identity available to provider decoders. */
export interface ProviderDecodeContext {
  /** Correlating canonical request identifier. */
  readonly requestId: string;
  /** Credential-safe selected route. */
  readonly candidate: RouteCandidate;
  /** Physical model used for this provider attempt. */
  readonly model: string;
}

/** Request-local parser for bounded provider transport chunks. */
export interface ProviderStreamParser {
  /** Consumes one complete transport byte chunk. */
  push(
    frame: Uint8Array,
    context: ProviderDecodeContext,
  ): ReadonlyArray<CanonicalChunk>;
  /** Completes parser state without synthesizing successful stream lifecycle. */
  finish(context: ProviderDecodeContext): ReadonlyArray<CanonicalChunk>;
  /** Releases all retained parser state; implementations must be idempotent. */
  close(): Promise<void>;
}

/** Creates one isolated parser for each provider stream. */
export interface ProviderStreamParserFactory {
  /** Creates request-local framing, decoder, and sequence state. */
  (context: ProviderDecodeContext): ProviderStreamParser;
}

/** Hard byte and queue bounds applied by one provider adapter. */
export interface ProviderAdapterLimits {
  /** Maximum bytes accepted for one provider response body. */
  readonly maxBodyBytes: number;
  /** Maximum encoded data payload bytes accepted for one provider event. */
  readonly maxFrameBytes: number;
  /** Maximum cumulative UTF-8 bytes accepted for one tool argument object. */
  readonly maxToolArgumentsBytes: number;
  /** Maximum number of canonical chunks retained by the queue. */
  readonly queueCapacity: number;
  /** Queue size at which provider production pauses. */
  readonly highWaterMark: number;
  /** Queue size at or below which paused provider production resumes. */
  readonly lowWaterMark: number;
}

/** Complete dependencies and limits for a canonical provider adapter. */
export interface ProviderAdapterOptions<TRequest, TResponse> {
  /** Raw provider byte transport. */
  readonly transport: ProviderTransportPort<TRequest, TResponse>;
  /** Isolated provider request builder. */
  readonly buildRequest: ProviderRequestFactory<TRequest>;
  /** Bounded response decoder. */
  readonly decodeResponse: ProviderResponseDecoder<TResponse>;
  /** Request-local provider stream parser factory. */
  readonly createParser: ProviderStreamParserFactory;
  /** Validated body, frame, tool, and queue limits. */
  readonly limits: ProviderAdapterLimits;
  /** Extracts the safe request correlation identifier. */
  readonly requestId: (request: CanonicalRequest) => string;
}

/** Indicates invalid provider adapter bounds before transport activity. */
export class ProviderAdapterConfigurationError extends Error {
  /** Creates the fixed, safe configuration failure. */
  public constructor() {
    super("provider adapter configuration is invalid");
    this.name = "ProviderAdapterConfigurationError";
  }
}

const ERROR_CATEGORIES: ReadonlySet<GatewayError["category"]> = new Set([
  "validation",
  "authentication",
  "authorization",
  "rate_limit",
  "upstream",
  "timeout",
  "routing",
  "internal",
]);

function isGatewayError(value: unknown): value is GatewayError {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Partial<GatewayError>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.category === "string" &&
    ERROR_CATEGORIES.has(error.category as GatewayError["category"]) &&
    typeof error.retryable === "boolean" &&
    Number.isInteger(error.status) &&
    typeof error.requestId === "string"
  );
}

function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (typeof value === "object" &&
      value !== null &&
      "name" in value &&
      value.name === "AbortError")
  );
}

/** @internal Validates all adapter bounds before any transport operation. */
export function validateProviderAdapterLimits(
  limits: ProviderAdapterLimits,
): void {
  const integers = [
    limits.maxBodyBytes,
    limits.maxFrameBytes,
    limits.maxToolArgumentsBytes,
    limits.queueCapacity,
    limits.highWaterMark,
    limits.lowWaterMark,
  ];
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.lowWaterMark >= limits.highWaterMark ||
    limits.highWaterMark > limits.queueCapacity
  ) {
    throw new ProviderAdapterConfigurationError();
  }
}

/** @internal Safely projects arbitrary provider failures to canonical errors. */
export function toProviderError(
  value: unknown,
  requestId: string,
  fallbackCode: string,
): GatewayError {
  if (isGatewayError(value)) {
    return createGatewayError({
      category: value.category,
      code: value.code,
      message: value.message,
      requestId,
      retryable: value.retryable,
      status: value.status,
      ...(value.retryAfterMs !== undefined
        ? { retryAfterMs: value.retryAfterMs }
        : {}),
      ...(value.providerId !== undefined ? { providerId: value.providerId } : {}),
      ...(value.credentialId !== undefined
        ? { credentialId: value.credentialId }
        : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
    });
  }
  if (isAbortError(value)) {
    return createGatewayError({
      category: "timeout",
      code: "upstream_timeout",
      message: "The upstream provider timed out.",
      requestId,
      retryable: true,
      status: 504,
    });
  }
  return createGatewayError({
    category: "upstream",
    code: fallbackCode,
    message: "The upstream provider failed.",
    requestId,
    retryable: false,
    status: 502,
  });
}
