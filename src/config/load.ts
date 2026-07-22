import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Alias, parseAllDocuments, Scalar, YAMLMap, YAMLSeq, type Node as YamlNode } from "yaml";
import type { $ZodIssue } from "zod/v4/core";
import type { Result } from "../domain/contracts.js";
import { jsonPointer, type StartupError, sortStartupErrors, startupError } from "./errors.js";
import { probeTraceRoot } from "./probe.js";
import { aptusConfigSchema } from "./schema.js";
import { resolveSecrets } from "./secrets.js";
import type { AptusConfig } from "./types.js";
import { validateCrossReferences } from "./validate.js";

/**
 * Result of a successful configuration load and verification.
 */
export interface LoadedConfig {
  /** Deep-frozen resolved configuration snapshot. */
  readonly config: AptusConfig;
  /** `sha256:` digest computed over the canonical redacted configuration JSON. */
  readonly revision: string;
}

/**
 * Resolves the configuration file path using strict precedence:
 * 1. CLI flag `--config <path>`
 * 2. Environment variable `APTUS_CONFIG`
 * 3. Default fallback `./aptus.yaml`
 *
 * @param argv - Process CLI argument list.
 * @param env - Process environment variable dictionary.
 * @returns Result containing the resolved configuration path or startup errors for invalid arguments.
 */
export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Result<string, readonly StartupError[]> {
  const firstFlag = argv.indexOf("--config");
  // Check for duplicate --config flags.
  if (firstFlag !== -1 && argv.indexOf("--config", firstFlag + 1) !== -1) {
    return { ok: false, error: [startupError("CONFIG_CLI_ARGUMENT", "", "--config must be provided at most once")] };
  }
  if (firstFlag !== -1) {
    const value = argv[firstFlag + 1];
    if (value === undefined) {
      return { ok: false, error: [startupError("CONFIG_CLI_ARGUMENT", "", "--config requires a path argument")] };
    }
    return { ok: true, value };
  }
  const fromEnv = env.APTUS_CONFIG;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { ok: true, value: fromEnv };
  }
  if (fromEnv !== undefined && fromEnv === "") {
    return { ok: false, error: [startupError("CONFIG_CLI_ARGUMENT", "", "APTUS_CONFIG must be a non-empty path")] };
  }
  return { ok: true, value: "./aptus.yaml" };
}

/**
 * Executes the complete fail-closed configuration loading and validation pipeline:
 *
 * 1. File reading: Read YAML file into memory.
 * 2. YAML syntax & AST rules: Exactly 1 document; reject aliases, merge keys (`<<`), non-string keys, and custom tags.
 * 3. Secret resolution: Resolve declared `${ENV_NAME}` references against environment variables.
 * 4. Structural validation: Validate shapes, defaults, and bounds with Zod schema.
 * 5. Semantic & policy validation: Verify cross-references, URL normalization, and namespace uniqueness.
 * 6. Filesystem probe: Verify trace storage root permissions and writeability when tracing is enabled.
 * 7. Revision & freeze: Compute deterministic SHA-256 revision over redacted config and deep-freeze the object.
 *
 * @param path - Path to the YAML configuration file.
 * @param env - Environment variable dictionary (defaults to `process.env`).
 * @returns Promise resolving to {@link LoadedConfig} on success, or a sorted array of {@link StartupError} on failure.
 */
export async function loadConfig(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<LoadedConfig, readonly StartupError[]>> {
  // Stage 1: Read configuration file.
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: [startupError("CONFIG_FILE_READ", "", `cannot read config file "${path}"`)] };
  }

  // Stage 2: Parse YAML document and check AST constraints.
  const documents = parseAllDocuments(text, { keepSourceTokens: true, merge: false, uniqueKeys: true, schema: "core" });
  const document = documents[0];
  if (documents.length !== 1 || document === undefined) {
    return {
      ok: false,
      error: [startupError("CONFIG_YAML_DOCUMENT_COUNT", "", "config must contain exactly one YAML document")],
    };
  }

  const errors: StartupError[] = [];
  for (const err of document.errors) {
    const linePos = err.linePos?.[0];
    errors.push(
      startupError(
        "CONFIG_YAML_PARSE",
        jsonPointer(deepestPath(document.contents, err.pos?.[0] ?? -1)),
        linePos === undefined ? "invalid YAML" : `invalid YAML at line ${linePos.line}, column ${linePos.col}`,
      ),
    );
  }
  collectYamlViolations(document.contents, [], errors);

  // Parse-level errors make the document tree unreliable; never feed it to the schema.
  if (document.errors.length > 0) {
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Stage 3: Exact secret resolution at declared secret paths only.
  const secretResult = resolveSecrets(document, env);
  if (!secretResult.ok) {
    errors.push(...secretResult.errors);
    return { ok: false, error: sortStartupErrors(errors) };
  }

  const raw = secretResult.raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(startupError("CONFIG_SCHEMA", "", "config must be a YAML mapping"));
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Stage 4: Strict structural validation with defaults.
  const parsed = aptusConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          errors.push(
            startupError("CONFIG_SCHEMA", jsonPointer([...issue.path.map(String), key]), `unknown key "${key}"`),
          );
        }
      } else {
        errors.push(startupError("CONFIG_SCHEMA", jsonPointer(issue.path.map(String)), safeSchemaMessage(issue)));
      }
    }
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Stage 5: Cross-reference and policy validation (normalizes baseUrl in place).
  errors.push(...validateCrossReferences(parsed.data));
  if (errors.length > 0) {
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Stage 6: Trace startup probe when tracing is enabled (the default).
  if (parsed.data.tracing.enabled) {
    const probeError = await probeTraceRoot(parsed.data.tracing.root);
    if (probeError !== null) {
      errors.push(probeError);
      return { ok: false, error: sortStartupErrors(errors) };
    }
  }

  // Stage 7: Redacted revision over a clone with env names at secret paths, then freeze.
  const redacted = structuredClone(parsed.data);
  for (const [pointer, envName] of secretResult.references) {
    setPath(redacted, segmentsFromPointer(pointer), envName);
  }
  const config = deepFreeze(parsed.data);
  return {
    ok: true,
    value: { config, revision: `sha256:${sha256Hex(canonicalJson(redacted))}` },
  };
}

/**
 * Serializes a value into deterministic canonical JSON format:
 * - Object keys sorted lexicographically
 * - No whitespace
 * - Non-finite numbers coerced to `null`
 *
 * @param value - Value to serialize into canonical JSON string.
 * @returns Deterministic JSON string.
 *
 * @remarks
 * Resolved secret values are never passed directly to this function; the caller overlays
 * environment variable names first to ensure secret material is excluded from config digests.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/**
 * Recursively freezes an object and all nested properties using `Object.freeze()`.
 *
 * @typeParam T - Object type to freeze.
 * @param value - Object or primitive to freeze.
 * @returns Deeply frozen immutable reference to `value`.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

/**
 * Produces a safe, bounded human error message for a Zod issue without reflecting raw input values.
 */
function safeSchemaMessage(issue: $ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}, received ${typeof issue.input}`;
    case "too_small":
      return `must be at least ${issue.minimum}`;
    case "too_big":
      return `must be at most ${issue.maximum}`;
    case "invalid_format":
      return `invalid ${issue.format}`;
    case "not_multiple_of":
      return `must be a multiple of ${issue.divisor}`;
    case "invalid_union":
      return "does not match any allowed shape";
    case "invalid_key":
      return `invalid ${issue.origin} key`;
    case "invalid_element":
      return `invalid ${issue.origin} element`;
    case "invalid_value":
      return `must be one of ${issue.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "custom":
      return issue.message;
    case "unrecognized_keys":
      return `unknown key ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}`;
  }
}

/**
 * Traverses a YAML AST node tree to detect forbidden constructs:
 * - YAML anchors / aliases (`*alias`)
 * - YAML merge keys (`<<`)
 * - Non-string mapping keys
 * - Non-standard / custom YAML tags
 */
function collectYamlViolations(
  node: YamlNode | null,
  path: readonly (string | number)[],
  errors: StartupError[],
): void {
  if (node === null) {
    return;
  }
  if (node instanceof Alias) {
    errors.push(startupError("CONFIG_YAML_ALIAS", jsonPointer(path), "YAML aliases are not allowed"));
    return;
  }
  // Check for custom YAML type tags (only standard 2002 core tags allowed).
  if (node.tag !== undefined && node.tag !== null && !node.tag.startsWith("tag:yaml.org,2002:")) {
    errors.push(startupError("CONFIG_YAML_CUSTOM_TAG", jsonPointer(path), "YAML custom tags are not allowed"));
  }
  if (node instanceof YAMLMap) {
    for (const pair of node.items) {
      const key = pair.key as YamlNode | null;
      const keySegment = key instanceof Scalar && typeof key.value === "string" ? key.value : null;
      if (keySegment === null) {
        errors.push(startupError("CONFIG_YAML_NON_STRING_KEY", jsonPointer(path), "YAML mapping keys must be strings"));
        collectYamlViolations(pair.value as YamlNode | null, path, errors);
        continue;
      }
      if (keySegment === "<<") {
        errors.push(
          startupError("CONFIG_YAML_MERGE_KEY", jsonPointer([...path, keySegment]), "YAML merge keys are not allowed"),
        );
      }
      collectYamlViolations(key, [...path, keySegment], errors);
      collectYamlViolations(pair.value as YamlNode | null, [...path, keySegment], errors);
    }
    return;
  }
  if (node instanceof YAMLSeq) {
    node.items.forEach((item, index) => {
      collectYamlViolations(item as YamlNode | null, [...path, index], errors);
    });
    return;
  }
}

/**
 * Finds the deepest path in the YAML AST whose source character range encloses `offset`.
 */
function deepestPath(
  node: YamlNode | null,
  offset: number,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] {
  if (
    node === null ||
    node.range === undefined ||
    node.range === null ||
    offset < node.range[0] ||
    offset > node.range[1]
  ) {
    return path;
  }
  let deepest = path;
  if (node instanceof YAMLMap) {
    for (const pair of node.items) {
      const key = pair.key as YamlNode | null;
      const keySegment = key instanceof Scalar && typeof key.value === "string" ? key.value : null;
      const keyPath = keySegment === null ? path : [...path, keySegment];
      deepest = deepestPath(key, offset, keyPath);
      deepest = deepestPath(pair.value as YamlNode | null, offset, keyPath);
    }
  } else if (node instanceof YAMLSeq) {
    node.items.forEach((item, index) => {
      deepest = deepestPath(item as YamlNode | null, offset, [...path, index]);
    });
  }
  return deepest;
}

/**
 * Parses an RFC 6901 JSON pointer string into unescaped path segments.
 */
function segmentsFromPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Sets a value at a specified path in a mutable object/array tree.
 */
function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) {
    current = current[segments[i] as string | number] as Record<string | number, unknown>;
  }
  current[segments[last] as string | number] = value;
}

/**
 * Computes a hex-encoded SHA-256 digest of the provided string.
 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
