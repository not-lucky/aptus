import type {
  AttemptObservation,
  JsonObject,
  ModelListInput,
  NativePreparationInput,
  PreparedProviderRequest,
  Protocol,
  ProtocolAdapter,
  Result,
} from "../../domain/contracts.js";
import type { NormalizedFailure } from "../../domain/operations.js";
import { filterOutboundHeaders, type OutboundAuth } from "./headers.js";
import { applyNativeMutations } from "./mutation.js";

const encoder = new TextEncoder();

/**
 * The protocol-specific facts one native adapter supplies.
 *
 * The shared factory owns everything identical across the three protocols
 * (public-model read, mutation pipeline, outbound header filtering, and body
 * encoding). Each protocol module contributes only its wire facts: create
 * path, auth header, response classification, and model-list envelope.
 */
export interface NativeAdapterSpec {
  /** Protocol identifier handled by this adapter. */
  readonly protocol: Protocol;

  /** Exact relative path appended to the provider API base URL. */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";

  /** Builds the outbound auth header from the selected provider secret. */
  readonly createAuth: (secret: string) => OutboundAuth;

  /** Maps a response head (status + optional Retry-After) into an observation. */
  readonly classify: (status: number, retryAfter?: string) => AttemptObservation;

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
 * @param spec - Protocol create path, auth, classification, and catalog facts.
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
      const { body } = applyNativeMutations(input.clientBody, input.mutations, input.upstreamModel);
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
        },
      };
    },

    classify(response): AttemptObservation {
      return spec.classify(response.status, response.headers["retry-after"]);
    },

    buildModelList: spec.buildModelList,
  };
}

function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}
