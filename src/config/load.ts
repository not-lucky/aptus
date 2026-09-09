/**
 * @fileoverview Fail-closed configuration loading pipeline for the Aptus gateway.
 *
 * Implements the seven-stage startup sequence: file reading, strict YAML AST parsing,
 * environment credential resolution, Zod structural validation, semantic cross-reference
 * checks, trace root storage probing, and deep-freezing with canonical SHA-256 revision hashing.
 *
 * Aborts startup deterministically on any failure before listeners bind, guaranteeing that
 * the gateway process only runs against a fully validated, immutable configuration snapshot.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Alias, parseAllDocuments, Scalar, YAMLMap, YAMLSeq, type Node as YamlNode } from "yaml";
import type { $ZodIssue } from "zod/v4/core";
import type { Result } from "../domain/contracts.ts";
import { jsonPointer, segmentsFromPointer, setPath } from "../domain/json.ts";
import { type StartupError, sortStartupErrors, startupError } from "./errors.ts";
import { probeTraceRoot } from "./probe.ts";
import { aptusConfigSchema } from "./schema.ts";
import { resolveSecrets } from "./secrets.ts";
import type { AptusConfig } from "./types.ts";
import { validateCrossReferences } from "./validate.ts";

/**
 * Verified runtime configuration snapshot produced by a successful load.
 */
export interface LoadedConfig {
  /** Deep-frozen resolved configuration snapshot shared across the gateway process. */
  readonly config: AptusConfig;

  /** SHA-256 revision digest computed over canonical redacted configuration JSON. */
  readonly revision: string;
}

/**
 * Resolves the configuration file path from CLI flags, environment variables, or default location.
 *
 * Precedence: `--config <path>` flag > `APTUS_CONFIG` environment variable > `./aptus.yaml`.
 *
 * @param argv - CLI argument list (excluding node and script paths).
 * @param env - Environment variable map.
 * @returns Result containing the resolved path or startup configuration errors.
 */
export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Result<string, readonly StartupError[]> {
  const firstFlag = argv.indexOf("--config");
  // Reject repeated flags so two paths can never compete silently for precedence.
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
 * Executes the seven-stage fail-closed configuration loading and validation pipeline.
 *
 * Reads and parses YAML, resolves secrets, validates structure and cross references,
 * probes trace storage, and produces a frozen configuration with a revision digest.
 *
 * @param path - File path to the YAML configuration document.
 * @param env - Environment variable map for credential lookups (defaults to `process.env`).
 * @returns A promise resolving to a {@link LoadedConfig} snapshot or sorted startup errors.
 */
export async function loadConfig(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<LoadedConfig, readonly StartupError[]>> {
  // Read the file into memory as the first stage, failing fast when the path is unreadable.
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: [startupError("CONFIG_FILE_READ", "", `cannot read config file "${path}"`)] };
  }

  // Parse the YAML document with strict options as the second stage, keeping source tokens for locations.
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

  // Stop before schema validation when syntax failed, because the node graph is unreliable in that state.
  if (document.errors.length > 0) {
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Resolve credentials at declared secret paths as the third stage, stopping when any rule fails.
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

  // Validate structure with defaults as the fourth stage, mapping each issue to a located error.
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

  // Validate cross references as the fifth stage, normalizing provider addresses in place.
  errors.push(...validateCrossReferences(parsed.data));
  if (errors.length > 0) {
    return { ok: false, error: sortStartupErrors(errors) };
  }

  // Probe the trace directory as the sixth stage, but only when tracing is enabled.
  if (parsed.data.tracing.enabled) {
    const probeError = await probeTraceRoot(parsed.data.tracing.root);
    if (probeError !== null) {
      errors.push(probeError);
      return { ok: false, error: sortStartupErrors(errors) };
    }
  }

  // Build the redacted revision over a clone as the seventh stage, then freeze the live snapshot.
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
 * Serializes a value to deterministic canonical JSON with sorted keys and no whitespace.
 *
 * Used for hashing configuration revisions independently of property insertion order or spacing.
 *
 * @param value - Value to serialize into canonical JSON.
 * @returns Deterministic JSON string representation.
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
 * Recursively freezes an object graph to enforce runtime immutability.
 *
 * @typeParam T - Object type being frozen.
 * @param value - Target object or primitive to freeze.
 * @returns The deeply frozen immutable reference.
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
 * Translates a Zod validation issue into a safe diagnostic message without leaking raw input values.
 *
 * @param issue - Zod validation issue.
 * @returns Safe human-readable error description.
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
 * Traverses a YAML AST to detect forbidden syntax features: aliases, merge keys, non-string keys, and custom tags.
 *
 * @param node - YAML AST node to inspect.
 * @param path - Current path segments from document root.
 * @param errors - Sink for discovered startup error records.
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
  // Reject custom type tags so only the standard core tag namespace reaches later stages.
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
 * Resolves the deepest YAML AST node path whose source range contains the given character offset.
 *
 * @param node - YAML AST root or subtree to search.
 * @param offset - Character offset in source text.
 * @param path - Accumulated path segments.
 * @returns Path segments to the enclosing AST node.
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
 * Computes the lowercase hexadecimal SHA-256 digest of a text string.
 *
 * @param text - Input text to hash.
 * @returns 64-character hexadecimal SHA-256 hash.
 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
