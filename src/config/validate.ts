import { jsonPointer, type StartupError, startupError } from "./errors.js";
import type { AptusConfig } from "./types.js";

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
 * Cross-reference and policy validation over the schema-normalized config.
 * Iteration is deterministic (YAML order) and sticks to the global namespace
 * rule "first declaration wins". `baseUrl` values are normalized in place:
 * exactly one trailing slash is removed. The config is not frozen yet.
 */
export function validateCrossReferences(config: AptusConfig): readonly StartupError[] {
  const errors: StartupError[] = [];

  // 1. Provider names are unique.
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

    // 2. Key names and resolved secrets are unique inside one Key Pool.
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

  // 3. Models, Routes, and every alias share one global namespace; first declaration wins.
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

  // 4. Every model references a configured provider name.
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

  // 5. Route Candidates reference canonical model names only, once per Route.
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

  // 6. Each client allow entry resolves in the global namespace.
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

  // 7. Provider static headers reject the forbidden set.
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

    // 8. baseUrl policy and normalization. Zod `.url()` already passed, so parsing cannot throw.
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
    if (url.pathname === "/" && provider.baseUrl.endsWith("/")) {
      errors.push(
        startupError(
          "CONFIG_PROVIDER_URL_PATH_EMPTY",
          jsonPointer(["providers", providerIndex, "baseUrl"]),
          "provider baseUrl must keep a non-empty path after removing one trailing slash",
        ),
      );
    }
    if (provider.baseUrl.endsWith("/")) {
      (provider as { baseUrl: string }).baseUrl = provider.baseUrl.slice(0, -1);
    }
  });

  return errors;
}

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
