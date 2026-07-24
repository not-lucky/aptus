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
 * Creates the OpenAI Responses {@link ProtocolAdapter}.
 *
 * Implements catalog and model-reading behavior; `prepareNative` and `classify`
 * remain `unavailable` pending full Responses native mutation and classification.
 *
 * @returns A stub Responses adapter with real catalog/read-model behavior.
 */
export function createResponsesAdapter(): ProtocolAdapter {
  return {
    protocol: "openai-responses",
    createPath: "/responses",

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
