/**
 * @fileoverview OpenAI Responses native protocol adapter for the Aptus gateway.
 *
 * Configures the native adapter for the OpenAI Responses wire protocol (`/responses`),
 * supplying Bearer token authentication, failure classification rules (mapping 422 to
 * `invalid_request`), and model catalog list formatting.
 *
 * Used for same-protocol Responses dispatch without intermediate representation translation,
 * as well as rendering OpenAI-compatible catalog responses.
 */

import type { JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.ts";
import { createNativeAdapter } from "../shared/native.ts";

/**
 * Creates the OpenAI Responses native protocol adapter.
 *
 * Binds Responses wire configuration—create path, bearer auth, 422 failure category mapping,
 * and catalog envelope formatting—to the shared native adapter factory.
 *
 * @returns A fully configured {@link ProtocolAdapter} for `openai-responses`.
 */
export function createResponsesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "openai-responses",
    createPath: "/responses",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
    category422: "invalid_request",
    /**
     * Wraps catalog entries in the OpenAI list envelope.
     *
     * Formats entries into model objects labeled with `object: "model"` within
     * a top-level `list` envelope.
     *
     * @param input - Filtered and authorized catalog entries to render.
     * @returns The OpenAI catalog envelope as a {@link JsonObject}.
     */
    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        // Spread the protocol metadata first so that the entry identity below wins over any colliding field.
        ...entry.metadata,
        id: entry.id,
        object: "model",
      }));
      return { object: "list", data };
    },
  });
}
