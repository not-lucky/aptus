import { jsonPointer, type StartupError, startupError } from "./errors.ts";
import type { AptusConfig } from "./types.ts";

/** Hop-by-hop and authentication-related headers that provider static headers must never set. */
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
 * Validates cross-references, semantic uniqueness, URL structures, and security policies across the loaded configuration.
 *
 * Checks performed:
 * 1. Provider name uniqueness across providers.
 * 2. Key name and resolved secret uniqueness within each provider's Key Pool.
 * 3. Unified global namespace uniqueness across models, routes, and aliases (first declaration wins).
 * 4. Model provider references resolve to configured providers.
 * 5. Route candidates reference canonical model names only (no aliases, no candidate duplicates in a route).
 * 6. Client key `allow` lists reference known public models or routes.
 * 7. Provider static headers exclude forbidden hop-by-hop / auth headers.
 * 8. Provider `baseUrl` validation: HTTP/HTTPS only, no userinfo, no query, no fragment, non-empty path; normalizes single trailing slash.
 * 9. `retryOn` and `fallbackOn` category lists have no duplicate members.
 *
 * @param config - The parsed configuration object to validate (mutates `baseUrl` to normalize trailing slashes).
 * @returns Array of semantic {@link StartupError} issues found (empty if valid).
 */
export function validateCrossReferences(config: AptusConfig): readonly StartupError[] {
  const errors: StartupError[] = [];

  // 1. Provider names must be unique across all providers.
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

    // 2. Key names and resolved secrets must be unique inside each Key Pool.
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

  // 3. Models, Routes, and all aliases share one unified global namespace; first declaration wins.
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

  // 4. Every model must reference a configured provider name.
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

  // 5. Route candidates must reference canonical model names only (not aliases) without duplicates within a single route.
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

    // 9. retryOn and fallbackOn have no duplicates; empty arrays are legal.
    claimUniqueCategories(route.retryOn, ["routes", routeIndex, "retryOn"], "CONFIG_RETRY_ON_DUPLICATE", errors);
    claimUniqueCategories(
      route.fallbackOn,
      ["routes", routeIndex, "fallbackOn"],
      "CONFIG_FALLBACK_ON_DUPLICATE",
      errors,
    );
  });

  // 6. Each client allow entry must resolve to a valid canonical model or route name in the global namespace.
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

  // 7. Provider static headers must not configure hop-by-hop or auth headers.
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

    // 8. baseUrl policy and normalization. URL constructor parses valid URLs validated by Zod.
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
    // Reject baseUrl that consists solely of root "/" with trailing slash, leaving no path.
    if (url.pathname === "/" && provider.baseUrl.endsWith("/")) {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_PATH_EMPTY",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must keep a non-empty path after removing one trailing slash",
        ),
      );
    }
    // In-place normalization: remove trailing slash.
    if (provider.baseUrl.endsWith("/")) {
      (provider as { baseUrl: string }).baseUrl = provider.baseUrl.slice(0, -1);
    }
  });

  return errors;
}

/**
 * Validates that a public model, route, or alias name is unique across the global namespace.
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
 * Validates that an array of failure categories has no duplicate entries.
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
