/**
 * @fileoverview Secret discovery and environment resolution for startup configuration in the Aptus gateway.
 *
 * Scans parsed YAML abstract syntax trees to resolve environment references (`${ENV_NAME}`)
 * at declared secret paths (`/auth/clientKeys/<index>/secret` and `/providers/<index>/keys/<index>/secret`).
 * Non-secret scalar fields containing `${...}` patterns are rejected to prohibit unintended interpolation.
 *
 * Resolved credential values are overlaid into the raw configuration tree for schema validation, while
 * a pointer-to-variable map is retained so the config revision digest can hash variable names instead of secrets.
 */

import { type Document, Scalar, YAMLMap, YAMLSeq, type Node as YamlNode } from "yaml";
import { jsonPointer, setPath } from "../domain/json.ts";
import { type StartupError, startupError } from "./errors.ts";

/** Discovered credential reference mapping a YAML path to an environment variable name. */
interface ResolvedSecret {
  /** JSON Pointer path segments leading to the secret field. */
  readonly segments: readonly (string | number)[];
  /** Name of the referenced environment variable. */
  readonly envName: string;
}

/**
 * Result of secret resolution, returning an overlaid configuration tree or startup errors.
 */
export type ResolveSecretsResult =
  | {
      /** Discriminator indicating successful secret resolution. */
      readonly ok: true;
      /** Plain configuration tree with resolved credential values overlaid. */
      readonly raw: unknown;
      /** Mapping from RFC 6901 JSON Pointers to referenced environment variable names. */
      readonly references: Map<string, string>;
    }
  | {
      /** Discriminator indicating secret resolution failure. */
      readonly ok: false;
      /** Startup errors encountered during secret discovery or environment lookup. */
      readonly errors: readonly StartupError[];
    };

/** Pattern matching exact `${ENV_NAME}` references in declared secret fields. */
const SECRET_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Pattern detecting `${...}` substrings outside declared secret fields. */
const INTERPOLATION_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Resolves environment credentials in a parsed YAML document and enforces interpolation rules.
 *
 * Validates that only declared secret fields use `${ENV_NAME}` references, that referenced
 * variables exist and are non-empty, and that no interpolation syntax appears in ordinary fields.
 *
 * @param document - Parsed YAML document AST to inspect.
 * @param env - Environment variable map for credential lookups.
 * @returns An overlaid configuration tree and reference map on success, or startup errors on failure.
 */
export function resolveSecrets(
  document: Document.Parsed,
  env: Readonly<Record<string, string | undefined>>,
): ResolveSecretsResult {
  const errors: StartupError[] = [];
  const resolved: ResolvedSecret[] = [];
  walkSecrets(document.contents, [], env, errors, resolved);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Convert the node graph to plain objects so later stages work with ordinary values.
  const raw = document.toJS();
  const references = new Map<string, string>();
  // Overlay each resolved credential into the plain tree and record the variable name for redaction.
  for (const entry of resolved) {
    setPath(raw, entry.segments, env[entry.envName]);
    references.set(jsonPointer(entry.segments), entry.envName);
  }
  return { ok: true, raw, references };
}

/**
 * Recursively traverses YAML AST nodes to resolve credentials and detect illegal interpolation.
 *
 * @param node - Current YAML AST node to inspect.
 * @param path - Current path segments from the document root.
 * @param env - Environment variable map for credential lookup.
 * @param errors - Sink for accumulated startup error records.
 * @param resolved - Sink for valid discovered secret references.
 */
function walkSecrets(
  node: YamlNode | null,
  path: readonly (string | number)[],
  env: Readonly<Record<string, string | undefined>>,
  errors: StartupError[],
  resolved: ResolvedSecret[],
): void {
  if (node === null || node instanceof Scalar === false) {
    if (node instanceof YAMLMap) {
      for (const pair of node.items) {
        const key = pair.key as YamlNode | null;
        const keySegment = key instanceof Scalar && typeof key.value === "string" ? key.value : null;
        // Skip keys for grammar checks so key text can never trigger a secret failure.
        walkSecrets(
          pair.value as YamlNode | null,
          keySegment === null ? path : [...path, keySegment],
          env,
          errors,
          resolved,
        );
      }
    } else if (node instanceof YAMLSeq) {
      node.items.forEach((item, index) => {
        walkSecrets(item as YamlNode | null, [...path, index], env, errors, resolved);
      });
    }
    return;
  }

  const value = node.value;
  // Handle declared secret fields with exact-token validation and environment lookup.
  if (isSecretPath(path)) {
    if (typeof value !== "string") {
      errors.push(
        startupError(
          "CONFIG_SECRET_LITERAL",
          jsonPointer(path),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pinned literal message text.
          "secret must be an exact ${ENV_NAME} environment reference",
        ),
      );
      return;
    }
    const match = SECRET_REFERENCE_PATTERN.exec(value);
    if (match !== null) {
      const envName = match[1] as string;
      const envValue = env[envName];
      if (envValue === undefined || envValue === "") {
        errors.push(
          startupError(
            "CONFIG_SECRET_MISSING",
            jsonPointer(path),
            `environment variable ${envName} is absent or empty`,
          ),
        );
        return;
      }
      resolved.push({ segments: path, envName });
      return;
    }
    // Treat brace-wrapped text with an invalid name as a malformed reference rather than a literal.
    if (value.startsWith("${") && value.endsWith("}")) {
      errors.push(
        startupError(
          "CONFIG_SECRET_REFERENCE_INVALID",
          jsonPointer(path),
          "secret environment reference name is invalid",
        ),
      );
      return;
    }
    // Handle plain text and partial interpolation in secret fields as literal violations.
    errors.push(
      startupError(
        "CONFIG_SECRET_LITERAL",
        jsonPointer(path),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pinned literal message text.
        "secret must be an exact ${ENV_NAME} environment reference",
      ),
    );
    return;
  }
  // Reject interpolation patterns in ordinary scalar strings outside secret fields.
  if (typeof value === "string" && INTERPOLATION_PATTERN.test(value)) {
    errors.push(
      startupError(
        "CONFIG_INTERPOLATION_FORBIDDEN",
        jsonPointer(path),
        "environment interpolation is allowed only in declared secret fields",
      ),
    );
  }
}

/**
 * Determines whether the specified path segments match a declared secret field location.
 *
 * @param path - Path segments from document root.
 * @returns `true` if path points to `/auth/clientKeys/<index>/secret` or `/providers/<index>/keys/<index>/secret`.
 */
function isSecretPath(path: readonly (string | number)[]): boolean {
  return (
    (path.length === 4 &&
      path[0] === "auth" &&
      path[1] === "clientKeys" &&
      typeof path[2] === "number" &&
      path[3] === "secret") ||
    (path.length === 5 &&
      path[0] === "providers" &&
      typeof path[1] === "number" &&
      path[2] === "keys" &&
      typeof path[3] === "number" &&
      path[4] === "secret")
  );
}
