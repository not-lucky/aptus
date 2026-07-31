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

const encoder = new TextEncoder();

/**
 * Explicit non-2xx provider statuses with a dedicated failure category; every
 * other non-2xx status classifies as `"provider"`. The table is shared by all
 * three protocols except HTTP 422, which the adapter spec supplies.
 */
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
 * The protocol-specific facts one native adapter supplies.
 *
 * The shared factory owns everything identical across the three protocols
 * (public-model read, mutation pipeline, outbound header filtering, response
 * classification, and body encoding). Each protocol module contributes only
 * its wire facts: create path, auth header, and model-list envelope.
 */
export interface NativeAdapterSpec {
  /** Protocol identifier handled by this adapter. */
  readonly protocol: Protocol;

  /** Exact relative path appended to the provider API base URL. */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";

  /** Builds the outbound auth header from the selected provider secret. */
  readonly createAuth: (secret: string) => OutboundAuth;

  /** Failure category for HTTP 422: `"invalid_request"` where the protocol validates with 422 (OpenAI), `"provider"` where it is not a defined status (Anthropic). */
  readonly category422: IrFailureCategory;

  /** Builds the protocol-native model catalog list envelope. */
  readonly buildModelList: (input: ModelListInput) => JsonObject;
}

/**
 * Creates a native {@link ProtocolAdapter} from protocol-specific facts.
 *
 * The returned adapter reads the public model name from `body.model`, applies
 * the ordered native mutation pipeline (defaults -> extraBody -> overrides ->
 * model replacement), filters outbound headers, installs the protocol auth
 * header, and UTF-8 encodes the request body. `provider` is recorded as `""`
 * (a placeholder); the Gateway replaces it with the actual selected provider
 * name, since a protocol adapter is shared across every provider of that
 * protocol.
 *
 * @param spec - Protocol create path, auth, and catalog facts.
 * @returns A fully implemented native {@link ProtocolAdapter}.
 */
export function createNativeAdapter(spec: NativeAdapterSpec): ProtocolAdapter {
  return {
    protocol: spec.protocol,
    createPath: spec.createPath,

    readPublicModel(body: JsonObject): Result<string, NormalizedFailure> {
      const model = body.model;
      return typeof model === "string" && model.length > 0
        ? { ok: true, value: model }
        : { ok: false, error: invalidRequest("model is required") };
    },

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
          provider: "",
          protocol: input.protocol,
          url: `${input.baseUrl}${spec.createPath}`,
          headers,
          body: encoder.encode(JSON.stringify(body)),
          stream: body.stream === true,
          deadlineMs: input.deadlineMs,
          streamIdleMs: input.streamIdleMs,
          mutations,
        },
      };
    },

    classify(response, nowMs): AttemptObservation {
      if (response.status === 422) {
        return withRetryDelay({ result: spec.category422, status: 422 }, response.headers["retry-after"], nowMs);
      }
      return classifyNativeStatus(response.status, response.headers["retry-after"], nowMs);
    },

    buildModelList: spec.buildModelList,
  };
}

/**
 * Maps a provider response head into a normalized attempt observation.
 *
 * Runs before any client bytes, so `beforeClientBytes` is always `true`. A
 * parseable `Retry-After` is recorded as `retryDelayMs` for every non-2xx
 * status; the key pool decides whether it overrides the fixed cooldown.
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

function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}
