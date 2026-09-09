/**
 * @fileoverview Anthropic Messages native protocol adapter for the Aptus gateway.
 *
 * Configures the native adapter for the Anthropic Messages wire protocol (`/v1/messages`),
 * supplying its authentication headers (`x-api-key`), failure classification rules
 * (mapping 422 to `provider`), and model catalog list formatting.
 *
 * Used for same-protocol Messages dispatch without intermediate representation translation,
 * as well as rendering Anthropic-compatible catalog responses.
 */

import type { JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.ts";
import { createNativeAdapter } from "../shared/native.ts";

/**
 * Creates the Anthropic Messages native protocol adapter.
 *
 * Binds Messages wire configuration—create path, header auth, failure category mapping,
 * and catalog envelope formatting—to the shared native adapter factory.
 *
 * @returns A fully configured {@link ProtocolAdapter} for `anthropic-messages`.
 */
export function createMessagesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "anthropic-messages",
    createPath: "/v1/messages",
    createAuth: (secret) => ({ name: "x-api-key", value: secret }),
    category422: "provider",
    /**
     * Wraps catalog entries in the Anthropic Messages list envelope.
     *
     * Formats entries into model objects with boundary markers (`first_id`, `last_id`)
     * and a `has_more` pagination flag.
     *
     * @param input - Filtered and authorized catalog entries to render.
     * @returns The Messages catalog envelope as a {@link JsonObject}.
     */
    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        // Spread the protocol metadata first so that the entry identity below wins over any colliding field.
        ...entry.metadata,
        type: "model",
        id: entry.id,
      }));
      return {
        data,
        has_more: false,
        // Report null boundary markers for an empty catalog so that clients see an envelope and not a failure.
        first_id: input.entries[0]?.id ?? null,
        last_id: input.entries.at(-1)?.id ?? null,
      };
    },
  });
}
