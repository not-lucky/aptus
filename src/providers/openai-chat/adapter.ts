import type {
  AttemptObservation,
  JsonObject,
  ModelListInput,
  NativePreparationInput,
  PreparedProviderRequest,
  ProtocolAdapter,
  Result,
} from "../../domain/contracts.js";
import type { IrFailureCategory, NormalizedFailure } from "../../domain/operations.js";
import { filterOutboundHeaders } from "../shared/headers.js";
import { applyNativeMutations } from "../shared/mutation.js";

const encoder = new TextEncoder();

/**
 * Creates the OpenAI Chat Completions {@link ProtocolAdapter}.
 *
 * This adapter owns Chat native mutation, outbound authentication, response
 * classification, and the OpenAI model-list envelope. `prepareNative` records
 * the configured provider name as `""` (a placeholder); the Gateway replaces
 * it with the actual selected provider name, since a protocol adapter is
 * shared across every provider of that protocol.
 *
 * @returns A fully implemented Chat adapter.
 */
export function createChatAdapter(): ProtocolAdapter {
  return {
    protocol: "openai-chat",
    createPath: "/chat/completions",

    readPublicModel(body: JsonObject): Result<string, NormalizedFailure> {
      const model = body.model;
      return typeof model === "string" && model.length > 0
        ? { ok: true, value: model }
        : { ok: false, error: invalidRequest("model is required") };
    },

    prepareNative(input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure> {
      const { body } = applyNativeMutations(input.clientBody, input.mutations, input.upstreamModel);
      const headers = filterOutboundHeaders(input.clientHeaders, input.providerHeaders, {
        name: "authorization",
        value: `Bearer ${input.providerSecret}`,
      });
      return {
        ok: true,
        value: {
          provider: "",
          protocol: input.protocol,
          url: `${input.baseUrl}${this.createPath}`,
          headers,
          body: encoder.encode(JSON.stringify(body)),
          stream: body.stream === true,
          deadlineMs: input.deadlineMs,
          streamIdleMs: input.streamIdleMs,
        },
      };
    },

    classify(response): AttemptObservation {
      return classifyChat(response.status, response.headers["retry-after"]);
    },

    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        ...entry.metadata,
        id: entry.id,
        object: "model",
      }));
      return { object: "list", data };
    },
  };
}

/**
 * Maps a Chat response head into a normalized attempt observation. Runs before
 * any client bytes, so `beforeClientBytes` is always `true`.
 */
export function classifyChat(status: number, retryAfter?: string): AttemptObservation {
  if (status >= 200 && status < 300) return { result: "success", status, beforeClientBytes: true };
  if (status === 429) {
    return { result: "rate_limit", status, retryDelayMs: parseRetryAfter(retryAfter), beforeClientBytes: true };
  }
  const category: IrFailureCategory | undefined =
    status === 401
      ? "authentication"
      : status === 403
        ? "permission"
        : status === 400
          ? "invalid_request"
          : status === 404
            ? "not_found"
            : status === 409
              ? "conflict"
              : status === 413
                ? "payload_too_large"
                : status === 422
                  ? "invalid_request"
                  : status === 408 || status === 504
                    ? "timeout"
                    : status === 500 || status === 503 || status === 529
                      ? "unavailable"
                      : undefined;
  return { result: category ?? "provider", status, beforeClientBytes: true };
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const date = Date.parse(value);
  const delta = Number.isFinite(date) ? date - Date.now() : Number.NaN;
  return Number.isFinite(delta) && delta > 0 ? Math.ceil(delta) : undefined;
}

function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}
