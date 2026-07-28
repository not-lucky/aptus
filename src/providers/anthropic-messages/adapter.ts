import type { JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.js";
import { createNativeAdapter } from "../shared/native.js";

/**
 * Creates the Anthropic Messages {@link ProtocolAdapter}.
 *
 * This adapter owns only Messages wire facts: the create path, `x-api-key`
 * auth, and the Anthropic model-list envelope. Model reading, mutation,
 * header filtering, classification, and encoding are shared native behavior.
 *
 * @returns A fully implemented Messages adapter.
 */
export function createMessagesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "anthropic-messages",
    createPath: "/v1/messages",
    createAuth: (secret) => ({ name: "x-api-key", value: secret }),
    category422: "provider",
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
  });
}
