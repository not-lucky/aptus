import { type Document, Scalar, YAMLMap, YAMLSeq, type Node as YamlNode } from "yaml";
import { jsonPointer, type StartupError, startupError } from "./errors.ts";

/**
 * Internal record of a discovered secret environment reference.
 */
interface ResolvedSecret {
  /** RFC 6901 JSON pointer segments locating the secret field. */
  readonly segments: readonly (string | number)[];
  /** Name of the referenced environment variable (e.g., `"OPENAI_API_KEY"`). */
  readonly envName: string;
}

/**
 * Result of secret discovery and environment resolution.
 */
export type ResolveSecretsResult =
  | {
      readonly ok: true;
      /** Javascript object representation of the parsed YAML with resolved secrets overlaid. */
      readonly raw: unknown;
      /** Map of secret JSON pointer paths to their referenced environment variable names. */
      readonly references: Map<string, string>;
    }
  | {
      readonly ok: false;
      /** Validation and resolution errors encountered. */
      readonly errors: readonly StartupError[];
    };

/** Matches an exact `${ENV_VAR_NAME}` pattern with a valid identifier. */
const SECRET_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Matches any `${NAME}` substring, used to detect illegal interpolation in non-secret scalar values. */
const INTERPOLATION_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Scans the parsed YAML AST to resolve declared secret fields and enforce strict secret grammar:
 *
 * Rules:
 * 1. Only declared secret fields (`/auth/clientKeys/<i>/secret` and `/providers/<i>/keys/<j>/secret`) may contain `${ENV_NAME}`.
 * 2. In declared secret fields, the value must be an exact `${ENV_NAME}` token (no partial interpolation, whitespace, or prefix/suffix).
 * 3. The referenced environment variable must exist and be non-empty.
 * 4. `${...}` interpolation patterns in any non-secret scalar string are strictly rejected (`CONFIG_INTERPOLATION_FORBIDDEN`).
 * 5. Mapping keys are never evaluated for secret grammar or interpolation.
 *
 * @param document - The parsed YAML AST document.
 * @param env - Environment variable map.
 * @returns {@link ResolveSecretsResult} containing the overlaid raw data tree and references map, or errors.
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

  // Convert YAML AST to plain JS objects.
  const raw = document.toJS();
  const references = new Map<string, string>();
  // Overlay actual resolved secret values into the raw object tree and record their env variable names.
  for (const entry of resolved) {
    setPath(raw, entry.segments, env[entry.envName]);
    references.set(jsonPointer(entry.segments), entry.envName);
  }
  return { ok: true, raw, references };
}

/**
 * Recursive visitor traversing YAML AST nodes to locate secret fields and validate against illegal interpolation.
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
        // Mapping keys are never checked for interpolation or secret grammar.
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
  // If this AST node is located at a declared secret path:
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
    // Check if the secret value looks like an invalid environment reference (e.g. invalid chars).
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
    // Plain literal string or other non-exact pattern in secret field.
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
  // If not a declared secret field, ensure no ${...} interpolation pattern is present in scalar strings.
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
 * Checks whether a given path corresponds to a declared secret field:
 * - `/auth/clientKeys/<i>/secret` (length 4)
 * - `/providers/<i>/keys/<j>/secret` (length 5)
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

/**
 * Overlays a value at `segments` inside a plain YAML-derived JavaScript object/array tree.
 */
function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) {
    current = current[segments[i] as string | number] as Record<string | number, unknown>;
  }
  current[segments[last] as string | number] = value;
}
