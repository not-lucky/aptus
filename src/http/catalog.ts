/**
 * @fileoverview Authorized model catalog for model listing endpoints.
 *
 * Filters configured models and routes against the authenticated client's whitelist,
 * projects entries into the target wire protocol's metadata representation, and returns
 * a stably sorted list of authorized models.
 */

import type { AptusConfig, CatalogMetadata } from "../config/types.ts";
import type { JsonObject, ModelListEntry, Protocol } from "../domain/contracts.ts";
import type { NameIndex } from "../routing/resolution.ts";

/**
 * Returns authorized catalog entries for an authenticated client, projected to target protocol metadata.
 *
 * Filters models and routes by client whitelist (or includes all if unconstrained), projects
 * metadata for OpenAI or Anthropic listing schemas, and sorts alphabetically by model/route name.
 *
 * @param config - Verified runtime configuration.
 * @param nameIndex - Precomputed authorization index mapping client keys to allowed models.
 * @param clientKeyName - Authenticated client key name.
 * @param protocol - Target wire protocol for metadata shaping (`anthropic-messages`, `openai-chat`, etc.).
 * @returns Lexicographically sorted array of authorized {@link ModelListEntry} objects.
 */
export function authorizedCatalogEntries(
  config: AptusConfig,
  nameIndex: NameIndex,
  clientKeyName: string,
  protocol: Protocol,
): readonly ModelListEntry[] {
  if (!nameIndex.allowedNamesByClient.has(clientKeyName)) return [];
  const allowed = nameIndex.allowedNamesByClient.get(clientKeyName);
  return [...config.models, ...config.routes]
    .filter((entry) => allowed === undefined || allowed.has(entry.name))
    .map((entry) => ({ id: entry.name, metadata: catalogMetadata(entry.catalog, protocol) }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Projects internal multi-protocol catalog metadata into the target protocol's public schema.
 */
function catalogMetadata(metadata: CatalogMetadata, protocol: Protocol): JsonObject {
  if (protocol === "anthropic-messages") {
    return {
      display_name: metadata.anthropic.displayName,
      created_at: metadata.anthropic.createdAt,
      capabilities: metadata.anthropic.capabilities === null ? null : { ...metadata.anthropic.capabilities },
      max_input_tokens: metadata.anthropic.maxInputTokens,
      max_output_tokens: metadata.anthropic.maxOutputTokens,
    };
  }
  return {
    created: metadata.openai.created,
    owned_by: metadata.openai.ownedBy,
  };
}
