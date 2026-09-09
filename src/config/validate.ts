/**
 * @fileoverview Semantic cross-reference checks for loaded configuration in the Aptus gateway.
 *
 * Validates cross-section integrity across providers, models, routes, and auth keys.
 * Enforces global public name uniqueness (models, routes, aliases), verifies reference
 * targets (model providers, route candidates, client allowlists), rejects forbidden headers,
 * validates provider baseUrl constraints, and normalizes trailing slashes in place.
 *
 * Executed as stage five of config loading after structural schema parsing. Any semantic
 * inconsistency produces structured `StartupError` records that abort startup.
 */

import { jsonPointer, type StartupError, startupError } from "./errors.ts";
import type { AptusConfig } from "./types.ts";

/** Hop-by-hop and credential header names forbidden in provider static headers. */
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key",
  "set-cookie",
]);

/**
 * Validates cross references, uniqueness constraints, address policy, and security rules across configuration.
 *
 * Checks provider names, key pool uniqueness, global model/route namespace, reference validity,
 * forbidden provider headers, provider URL shapes, and route retry/fallback category uniqueness.
 * Normalizes provider `baseUrl` in place by stripping a single trailing slash.
 *
 * @param config - Parsed configuration object satisfying structural schema.
 * @returns An array of semantic {@link StartupError} records, or an empty array if valid.
 */
export function validateCrossReferences(config: AptusConfig): readonly StartupError[] {
  const errors: StartupError[] = [];

  // Check provider names first because later checks resolve provider references against this set.
  const providerNames = new Set<string>();
  config.providers.forEach((provider, providerIndex) => {
    if (providerNames.has(provider.name)) {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_NAME_DUPLICATE",
          jsonPointer(["providers", providerIndex, "name"]),
          `provider name ${provider.name} is already declared`,
        ),
      );
    } else {
      providerNames.add(provider.name);
    }

    // Check key names and secrets inside each pool so one provider cannot hold two identical credentials.
    const keyNames = new Set<string>();
    const keySecrets = new Set<string>();
    provider.keys.forEach((key, keyIndex) => {
      if (keyNames.has(key.name)) {
        errors.push(
          startupError(
            "CONFIG_PROVIDER_KEY_NAME_DUPLICATE",
            jsonPointer(["providers", providerIndex, "keys", keyIndex, "name"]),
            `provider key name ${key.name} duplicates another key name in this key pool`,
          ),
        );
      } else {
        keyNames.add(key.name);
      }
      if (keySecrets.has(key.secret)) {
        errors.push(
          startupError(
            "CONFIG_PROVIDER_SECRET_DUPLICATE",
            jsonPointer(["providers", providerIndex, "keys", keyIndex, "secret"]),
            "provider key secret duplicates another secret in this key pool",
          ),
        );
      } else {
        keySecrets.add(key.secret);
      }
    });
  });

  // Claim model names before route names so the first declaration wins across the shared namespace.
  const publicNames = new Set<string>();
  config.models.forEach((model, modelIndex) => {
    claimPublicName(publicNames, model.name, ["models", modelIndex, "name"], errors);
    model.aliases.forEach((alias, aliasIndex) => {
      claimPublicName(publicNames, alias, ["models", modelIndex, "aliases", aliasIndex], errors);
    });
  });
  config.routes.forEach((route, routeIndex) => {
    claimPublicName(publicNames, route.name, ["routes", routeIndex, "name"], errors);
    route.aliases.forEach((alias, aliasIndex) => {
      claimPublicName(publicNames, alias, ["routes", routeIndex, "aliases", aliasIndex], errors);
    });
  });

  // Check model provider references against the provider set collected in the first pass.
  config.models.forEach((model, modelIndex) => {
    if (!providerNames.has(model.provider)) {
      errors.push(
        startupError(
          "CONFIG_REFERENCE_UNKNOWN",
          jsonPointer(["models", modelIndex, "provider"]),
          "model provider must reference a configured provider name",
        ),
      );
    }
  });

  // Check route candidates against canonical model names so aliases can never appear as candidates.
  const canonicalModelNames = new Set(config.models.map((model) => model.name));
  config.routes.forEach((route, routeIndex) => {
    const candidates = new Set<string>();
    route.candidates.forEach((candidate, candidateIndex) => {
      if (!canonicalModelNames.has(candidate)) {
        errors.push(
          startupError(
            "CONFIG_REFERENCE_NOT_CANONICAL",
            jsonPointer(["routes", routeIndex, "candidates", candidateIndex]),
            "route candidates must reference canonical model names",
          ),
        );
      }
      if (candidates.has(candidate)) {
        errors.push(
          startupError(
            "CONFIG_ROUTE_CANDIDATE_DUPLICATE",
            jsonPointer(["routes", routeIndex, "candidates", candidateIndex]),
            "route candidate duplicates another candidate in this route",
          ),
        );
      } else {
        candidates.add(candidate);
      }
    });

    // Check retry and fallback lists for repeats, where empty lists are valid and mean no action.
    claimUniqueCategories(route.retryOn, ["routes", routeIndex, "retryOn"], "CONFIG_RETRY_ON_DUPLICATE", errors);
    claimUniqueCategories(
      route.fallbackOn,
      ["routes", routeIndex, "fallbackOn"],
      "CONFIG_FALLBACK_ON_DUPLICATE",
      errors,
    );
  });

  // Check client allow entries against the global namespace so keys cannot reference unknown names.
  config.auth.clientKeys.forEach((clientKey, clientKeyIndex) => {
    clientKey.allow?.forEach((allowed, allowIndex) => {
      if (!publicNames.has(allowed)) {
        errors.push(
          startupError(
            "CONFIG_CLIENT_ALLOW_UNKNOWN",
            jsonPointer(["auth", "clientKeys", clientKeyIndex, "allow", allowIndex]),
            "client allow entry must reference a public model or route name",
          ),
        );
      }
    });
  });

  // Check static headers and base addresses per provider, normalizing one trailing slash in place.
  config.providers.forEach((provider, providerIndex) => {
    for (const headerName of Object.keys(provider.headers)) {
      if (FORBIDDEN_HEADERS.has(headerName)) {
        errors.push(
          startupError(
            "CONFIG_PROVIDER_HEADER_FORBIDDEN",
            jsonPointer(["providers", providerIndex, "headers", headerName]),
            `provider header ${headerName} is forbidden`,
          ),
        );
      }
    }

    // Parse with the address constructor, trusting the schema to have rejected unparseable text already.
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_SCHEME",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must use http or https",
        ),
      );
    }
    if (url.username !== "" || url.password !== "") {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_CREDENTIALS",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must not contain user credentials",
        ),
      );
    }
    if (url.search !== "") {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_QUERY",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must not contain a query",
        ),
      );
    }
    if (url.hash !== "") {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_FRAGMENT",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must not contain a fragment",
        ),
      );
    }
    // Reject a bare root slash path so normalization cannot produce an empty path downstream.
    if (url.pathname === "/" && provider.baseUrl.endsWith("/")) {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_PATH_EMPTY",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must keep a non-empty path after removing one trailing slash",
        ),
      );
    }
    // Normalize one trailing slash in place so address joining never produces a double slash.
    if (provider.baseUrl.endsWith("/")) {
      (provider as { baseUrl: string }).baseUrl = provider.baseUrl.slice(0, -1);
    }
  });

  return errors;
}

/**
 * Claims a public identifier in the shared global namespace, reporting duplicate conflicts.
 *
 * @param publicNames - Accumulated set of registered public names and aliases.
 * @param name - Candidate public identifier to register.
 * @param path - Path segments locating the identifier for error reporting.
 * @param errors - Sink for duplicate name startup error records.
 */
function claimPublicName(
  publicNames: Set<string>,
  name: string,
  path: readonly (string | number)[],
  errors: StartupError[],
): void {
  if (publicNames.has(name)) {
    errors.push(
      startupError(
        "CONFIG_PUBLIC_NAME_DUPLICATE",
        jsonPointer(path),
        `public name or alias ${name} is already declared`,
      ),
    );
  } else {
    publicNames.add(name);
  }
}

/**
 * Verifies that a list of failure categories contains no duplicate entries.
 *
 * @param categories - Array of failure category strings to check.
 * @param pathPrefix - Path segments locating the category list.
 * @param code - Startup error code to report on duplication.
 * @param errors - Sink for duplicate category error records.
 */
function claimUniqueCategories(
  categories: readonly string[],
  pathPrefix: readonly (string | number)[],
  code: "CONFIG_RETRY_ON_DUPLICATE" | "CONFIG_FALLBACK_ON_DUPLICATE",
  errors: StartupError[],
): void {
  const seen = new Set<string>();
  categories.forEach((category, index) => {
    if (seen.has(category)) {
      errors.push(
        startupError(
          code,
          jsonPointer([...pathPrefix, index]),
          code === "CONFIG_RETRY_ON_DUPLICATE"
            ? "retryOn categories must not repeat"
            : "fallbackOn categories must not repeat",
        ),
      );
    } else {
      seen.add(category);
    }
  });
}
