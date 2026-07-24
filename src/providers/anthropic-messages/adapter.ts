import type {
  AttemptObservation,
  JsonObject,
  ModelListInput,
  NativePreparationInput,
  PreparedProviderRequest,
  ProtocolAdapter,
  Result,
} from "../../domain/contracts.js";
import type { NormalizedFailure } from "../../domain/operations.js";

/**
 * Creates the Anthropic Messages {@link ProtocolAdapter}.
 *
 * Implements catalog and model-reading behavior; `prepareNative` and `classify`
 * remain `unavailable` pending full Messages native mutation and classification.
 *
 * @returns A stub Messages adapter with real catalog/read-model behavior.
 */
export function createMessagesAdapter(): ProtocolAdapter {
  return {
    protocol: "anthropic-messages",
    createPath: "/v1/messages",

    readPublicModel(body: JsonObject): Result<string, NormalizedFailure> {
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
    },
  };
}

function invalidRequest(message: string): NormalizedFailure {
  return { category: "invalid_request", message, retryable: false };
}

function unavailable(message: string): NormalizedFailure {
  return { category: "unavailable", message, retryable: false };
}
