import type { JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.ts";
import { createNativeAdapter } from "../shared/native.ts";

/**
 * Creates the OpenAI Responses {@link ProtocolAdapter}.
 *
 * This adapter owns only Responses wire facts: the create path, Bearer auth,
 * and the OpenAI model-list envelope. Model reading, mutation, header
 * filtering, classification, and encoding are shared native behavior.
 *
 * @returns A fully implemented Responses adapter.
 */
export function createResponsesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "openai-responses",
    createPath: "/responses",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
    category422: "invalid_request",
    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        ...entry.metadata,
        id: entry.id,
        object: "model",
      }));
      return { object: "list", data };
    },
  });
}
