import type { AptusConfig, ClientKeyConfig } from "../config/types.js";

/**
 * Precomputed index for fast model/route resolution and client authorization checks.
 */
export interface NameIndex {
  /** Map from all public names and aliases to their canonical model/route name. */
  readonly canonicalNames: ReadonlyMap<string, string>;
  /** Map from client key name to its allowed canonical model/route names (`undefined` if client has no whitelist and can access all models). */
  readonly allowedNamesByClient: ReadonlyMap<string, ReadonlySet<string> | undefined>;
}

/**
 * Precomputes lookup maps for canonical model name resolution and client permission sets.
 *
 * @param config - Deep-frozen startup configuration snapshot.
 * @returns An immutable {@link NameIndex}.
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
 * Resolves a client-requested model or alias name into a canonical model/route name and checks authorization.
 *
 * @param index - Precomputed name and client authorization index.
 * @param clientKeyName - Name of the authenticated client key.
 * @param requestedName - Raw model name string extracted from the request body.
 * @returns The canonical public model/route name if found and authorized; otherwise `undefined`.
 */
export function authorizePublicName(
  index: NameIndex,
  clientKeyName: string,
  requestedName: string,
): string | undefined {
  // Reject if client key is unknown to the index.
  if (!index.allowedNamesByClient.has(clientKeyName)) return undefined;
  // Resolve alias or canonical name to the canonical identifier.
  const canonical = index.canonicalNames.get(requestedName);
  if (canonical === undefined) return undefined;
  // If client has no allowlist, all known canonical names are permitted.
  const allowed = index.allowedNamesByClient.get(clientKeyName);
  if (allowed === undefined) return canonical;
  // Otherwise check if canonical name is present in client's allowlist set.
  return allowed.has(canonical) ? canonical : undefined;
}

/**
 * Builds a map from every canonical model/route name and every declared alias to its canonical name.
 *
 * @param config - Active configuration snapshot.
 * @returns Readonly map from alias/canonical name to canonical name.
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
 * Resolves references declared in a client key's `allow` array into a set of canonical names.
 *
 * @param clientKey - Client key configuration.
 * @param aliases - Canonical name lookup map.
 * @returns Set of authorized canonical model/route names.
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
