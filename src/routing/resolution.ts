/**
 * @fileoverview
 * Canonical public name resolution and client authorization index.
 *
 * Resolves requested model and alias names to canonical identifiers and validates client key
 * allowlist access permissions. Constructs precomputed {@link NameIndex} snapshots from configuration,
 * providing fast in-memory authorization during HTTP request admission.
 */

import type { AptusConfig, ClientKeyConfig } from "../config/types.ts";

/**
 * Precomputed lookup maps for model/route resolution and client key authorization.
 */
export interface NameIndex {
  /** Map of public model names and aliases to their canonical model or route identifier. */
  readonly canonicalNames: ReadonlyMap<string, string>;
  /** Map of client key names to their optional allowlist of authorized canonical names (undefined allows all). */
  readonly allowedNamesByClient: ReadonlyMap<string, ReadonlySet<string> | undefined>;
}

/**
 * Precomputes the name and authorization index from the gateway configuration snapshot.
 *
 * @param config - Validated gateway configuration.
 * @returns Precomputed immutable {@link NameIndex} instance.
 */
export function createNameIndex(config: AptusConfig): NameIndex {
  const canonicalNames = canonicalNameIndex(config);
  const allowedNamesByClient = new Map<string, ReadonlySet<string> | undefined>();
  for (const clientKey of config.auth.clientKeys) {
    allowedNamesByClient.set(
      clientKey.name,
      clientKey.allow === undefined ? undefined : allowedCanonicalNames(clientKey, canonicalNames),
    );
  }
  return { canonicalNames, allowedNamesByClient };
}

/**
 * Resolves a requested model name or alias and verifies caller authorization.
 *
 * @param index - Precomputed name and authorization index.
 * @param clientKeyName - Authenticated client key name.
 * @param requestedName - Raw model or route name from the client request payload.
 * @returns Canonical model or route name if authorized; undefined if unresolvable or unauthorized.
 */
export function authorizePublicName(
  index: NameIndex,
  clientKeyName: string,
  requestedName: string,
): string | undefined {
  if (!index.allowedNamesByClient.has(clientKeyName)) return undefined;
  const canonical = index.canonicalNames.get(requestedName);
  if (canonical === undefined) return undefined;
  const allowed = index.allowedNamesByClient.get(clientKeyName);
  if (allowed === undefined) return canonical;
  return allowed.has(canonical) ? canonical : undefined;
}

/**
 * Builds a lookup map from all configured model names, route names, and aliases to their canonical name.
 *
 * @param config - Validated gateway configuration.
 * @returns Read-only mapping of aliases and public names to canonical names.
 */
export function canonicalNameIndex(config: AptusConfig): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const entry of [...config.models, ...config.routes]) {
    names.set(entry.name, entry.name);
    for (const alias of entry.aliases) names.set(alias, entry.name);
  }
  return names;
}

/**
 * Resolves the configured allowlist entries for a client key into a set of canonical names.
 *
 * @param clientKey - Client key configuration entry.
 * @param aliases - Precomputed alias-to-canonical name mapping.
 * @returns Set of canonical names permitted for this key.
 */
export function allowedCanonicalNames(
  clientKey: ClientKeyConfig,
  aliases: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const reference of clientKey.allow ?? []) {
    const canonical = aliases.get(reference);
    if (canonical !== undefined) allowed.add(canonical);
  }
  return allowed;
}
