import type {
  AttemptObservation,
  JsonObject,
  ModelListInput,
  NativePreparationInput,
  PreparedProviderRequest,
  Protocol,
  ProtocolAdapter,
  Result,
} from "../domain/contracts.js";
import type { NormalizedFailure } from "../domain/operations.js";

/**
 * Instantiates the default set of protocol adapters for OpenAI Chat, OpenAI Responses, and Anthropic Messages.
 *
 * @returns Immutable dictionary of {@link ProtocolAdapter} implementations keyed by {@link Protocol}.
 */
export function createProtocolAdapters(): Readonly<Record<Protocol, ProtocolAdapter>> {
  return {
    "openai-chat": createAdapter("openai-chat", "/chat/completions"),
    "openai-responses": createAdapter("openai-responses", "/responses"),
    "anthropic-messages": createAdapter("anthropic-messages", "/v1/messages"),
  };
}

/**
 * Creates a protocol adapter instance with standard model-reading and catalog list construction.
 */
function createAdapter(protocol: Protocol, createPath: ProtocolAdapter["createPath"]): ProtocolAdapter {
  return {
    protocol,
    createPath,
    readPublicModel(body) {
      const model = body.model;
      return typeof model === "string" && model.length > 0
        ? { ok: true, value: model }
        : { ok: false, error: invalidRequest("model is required") };
    },
    prepareNative(_input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure> {
      return { ok: false, error: unavailable("provider dispatch is not available") };
    },
    classify(_response): AttemptObservation {
      return { result: "unavailable", beforeClientBytes: true };
    },
    buildModelList(input: ModelListInput): JsonObject {
      // Anthropic catalog envelope: { data: [...], has_more: false, first_id, last_id }
      if (protocol === "anthropic-messages") {
        const data: readonly JsonObject[] = input.entries.map((entry) => ({
          ...entry.metadata,
          type: "model",
          id: entry.id,
        }));
        return {
          data,
          has_more: false,
          first_id: input.entries[0]?.id ?? null,
          last_id: input.entries.at(-1)?.id ?? null,
        };
      }
      // OpenAI catalog envelope: { object: "list", data: [...] }
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        ...entry.metadata,
        id: entry.id,
        object: "model",
      }));
      return { object: "list", data };
    },
  };
}

function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}

function unavailable(message: string): NormalizedFailure {
  return { category: "unavailable", message, retryable: false };
}
