import type { JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.js";
import { createNativeAdapter } from "../shared/native.js";

/**
 * Creates the OpenAI Chat Completions {@link ProtocolAdapter}.
 *
 * This adapter owns only Chat wire facts: the create path, Bearer auth, and
 * the OpenAI model-list envelope. Model reading, mutation, header filtering,
 * classification, and encoding are shared native behavior.
 *
 * @returns A fully implemented Chat adapter.
 */
export function createChatAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "openai-chat",
    createPath: "/chat/completions",
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
