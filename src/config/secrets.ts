import { type Document, Scalar, YAMLMap, YAMLSeq, type Node as YamlNode } from "yaml";
import { jsonPointer, type StartupError, startupError } from "./errors.js";

/** One resolved environment reference: its path segments and the env name. */
interface ResolvedSecret {
  readonly segments: readonly (string | number)[];
  readonly envName: string;
}

export type ResolveSecretsResult =
  | { readonly ok: true; readonly raw: unknown; readonly references: Map<string, string> }
  | { readonly ok: false; readonly errors: readonly StartupError[] };

const SECRET_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Any `${NAME}` occurrence outside a declared secret field. */
const INTERPOLATION_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Resolve every declared secret field (`/auth/clientKeys/<i>/secret` and
 * `/providers/<i>/keys/<j>/secret`) from the process environment. A declared
 * secret must be exactly `\` with `ENV_NAME` matching
 * `[A-Za-z_][A-Za-z0-9_]*` and a non-empty environment value. `${...}` in any
 * other string scalar is rejected; mapping keys are never checked.
 *
 * On success, `raw` is the scalar-coerced YAML value tree with each resolved
 * value overlaid at its path, and `references` maps each secret's JSON pointer
 * to its environment variable name.
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

  const raw = document.toJS();
  const references = new Map<string, string>();
  for (const entry of resolved) {
    setPath(raw, entry.segments, env[entry.envName]);
    references.set(jsonPointer(entry.segments), entry.envName);
  }
  return { ok: true, raw, references };
}

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

/** Overlays `value` at `segments` inside a plain YAML-derived tree. */
function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) {
    current = current[segments[i] as string | number] as Record<string | number, unknown>;
  }
  current[segments[last] as string | number] = value;
}
