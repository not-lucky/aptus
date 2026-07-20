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

export interface LoadedConfig {
  /** Deep-frozen resolved config snapshot. */
  readonly config: AptusConfig;
  /** `sha256:` digest over the canonical redacted config JSON. */
  readonly revision: string;
}

/** Resolve the config path: `--config <path>`, then `APTUS_CONFIG`, then `./aptus.yaml`. */
export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Result<string, readonly StartupError[]> {
  const firstFlag = argv.indexOf("--config");
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
 * Read the selected file once, then run the strict startup pipeline in order:
 * one YAML document with aliases, merge keys, non-string keys, and custom tags
 * rejected; exact secret resolution at declared secret fields; strict Zod
 * validation; cross-reference and policy validation; the Trace startup probe
 * when tracing is enabled; and finally deep-freeze plus a SHA-256 revision
 * over the canonical redacted representation (resolved secret values replaced
 * by their environment variable names).
 */
export async function loadConfig(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<LoadedConfig, readonly StartupError[]>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: [startupError("CONFIG_FILE_READ", "", `cannot read config file "${path}"`)] };
  }

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

  // Stage 3: exact secret resolution at declared secret paths only.
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

  // Stage 4: strict structural validation with defaults.
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

  // Stage 5: cross-reference and policy validation (normalizes baseUrl in place).
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

  // Stage 7: redacted revision over a clone with env names at secret paths, then freeze.
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
 * Deterministic canonical JSON: sorted object keys, no whitespace, and no
 * undefined values. Resolved secret values are never present in the input to
 * this function; the caller overlays environment variable names first.
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

/** Safe bounded message for one Zod issue; never embeds received values. */
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
  if (node.tag !== undefined && node.tag !== null && !node.tag.startsWith("tag:yaml.org,2002:")) {
    errors.push(startupError("CONFIG_YAML_CUSTOM_TAG", jsonPointer(path), "YAML custom tags are not allowed"));
  }
}

/** Path of the deepest YAML node whose source range contains `offset`. */
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

/** Numeric pointer segments stay strings; array and object indexing accepts both. */
function segmentsFromPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Overlays `value` at `segments` inside a plain object/array tree. */
function setPath(target: unknown, segments: readonly (string | number)[], value: unknown): void {
  let current = target as Record<string | number, unknown>;
  const last = segments.length - 1;
  for (let i = 0; i < last; i++) {
    current = current[segments[i] as string | number] as Record<string | number, unknown>;
  }
  current[segments[last] as string | number] = value;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
