import type { AptusConfig, CatalogMetadata } from "../config/types.ts";
import type { JsonObject, ModelListEntry, Protocol } from "../domain/contracts.ts";
import type { NameIndex } from "../routing/resolution.ts";

/**
 * Returns a sorted list of canonical model and route catalog entries authorized for the specified client key.
 *
 * Invariants:
 * - Only models and routes permitted by the client's `allow` whitelist are returned (or all if `allow` is omitted).
 * - Catalog entries are projected into the target protocol format (OpenAI vs Anthropic).
 * - Entries are sorted lexicographically by canonical `id`.
 *
 * @param config - Active configuration snapshot.
 * @param nameIndex - Precomputed name and client allowlist index.
 * @param clientKeyName - Name of the authenticated client key.
 * @param protocol - Target protocol format for catalog metadata projection.
 * @returns Sorted array of {@link ModelListEntry} instances.
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
 * Extracts protocol-specific metadata dictionary from multi-protocol catalog configuration.
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
  return { created: metadata.openai.created, owned_by: metadata.openai.ownedBy };
}
