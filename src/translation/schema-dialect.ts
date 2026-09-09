/**
 * @fileoverview Validation of JSON Schema dialects for strict tool definitions and structured outputs.
 *
 * Verifies that provider-neutral JSON Schema definitions satisfy target-specific strict requirements:
 * OpenAI strict mode (depth <= 10, total properties <= 5000, forbidden combinators, closed additionalProperties),
 * Anthropic Messages object root requirements, and Messages structured output constraints.
 */

import type { JsonObject, JsonValue, Result } from "../domain/contracts.ts";
import { isPlainObject } from "../domain/json.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { MatrixRowId } from "./matrix.ts";
import { ok, unsupportedCapability } from "./result.ts";

/** Maximum number of object properties across an OpenAI strict schema tree. */
const OPENAI_STRICT_MAX_PROPERTIES = 5000;

/** Maximum nesting depth permitted in an OpenAI strict schema tree. */
const OPENAI_STRICT_MAX_DEPTH = 10;

/** Maximum serialized character length of an OpenAI strict schema payload. */
const OPENAI_STRICT_MAX_CHARS = 120_000;

/** Maximum total enumeration elements permitted in an OpenAI strict schema tree. */
const OPENAI_STRICT_MAX_ENUM_VALUES = 1000;

/** Allowed root-level keywords in an Anthropic Messages strict tool schema. */
const MESSAGES_STRICT_ROOT_KEYWORDS = ["type", "properties", "required"];

/** Child keywords traversed during OpenAI strict schema descent. */
const OPENAI_STRICT_CHILD_KEYWORDS = ["properties", "items", "additionalProperties", "$defs"] as const;

/** Schema keywords forbidden in OpenAI strict mode. */
const OPENAI_STRICT_FORBIDDEN_KEYWORDS = [
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "const",
] as const;

/**
 * Verifies that a value is an array consisting solely of string elements.
 *
 * @param value - Value to inspect.
 * @returns True if value is an array of strings.
 */
function isArrayOfStrings(value: JsonValue): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validates that an Anthropic Messages tool input schema specifies an object root type.
 *
 * @param schema - Schema to validate.
 * @returns Ok if schema root is an object; otherwise unsupported capability failure.
 */
export function validateMessagesObjectRoot(schema: JsonObject): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability("function-tool-definition");
  }
  return ok(undefined);
}

/**
 * Validates that an Anthropic Messages tool schema satisfies strict mode restrictions.
 *
 * @param schema - Tool input schema to validate.
 * @returns Ok if schema adheres to Messages strict subset; otherwise unsupported capability failure.
 */
export function validateMessagesStrictSchema(schema: JsonObject): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability("function-schema-strictness");
  }
  for (const key of Object.keys(schema)) {
    if (!MESSAGES_STRICT_ROOT_KEYWORDS.includes(key)) {
      return unsupportedCapability("function-schema-strictness");
    }
  }
  if (schema.required !== undefined && !isArrayOfStrings(schema.required)) {
    return unsupportedCapability("function-schema-strictness");
  }
  const properties = schema.properties;
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      return unsupportedCapability("function-schema-strictness");
    }
    for (const value of Object.values(properties)) {
      if (!isPlainObject(value)) {
        return unsupportedCapability("function-schema-strictness");
      }
    }
  }
  return ok(undefined);
}

/**
 * Escapes special characters (`~` and `/`) in a JSON Pointer path token.
 *
 * @param segment - Raw property or key token.
 * @returns Escaped JSON Pointer segment.
 */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Validates a schema against the OpenAI strict subset for Chat and Responses.
 *
 * @param schema - Schema object to validate.
 * @param capability - Matrix capability ID reported upon rejection.
 * @returns Ok if compliant with strict dialect; otherwise unsupported capability failure.
 */
export function validateOpenAiStrictSchema(
  schema: JsonObject,
  capability: MatrixRowId = "function-schema-strictness",
): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability(capability, "/: root type must be object");
  }
  if (JSON.stringify(schema).length > OPENAI_STRICT_MAX_CHARS) {
    return unsupportedCapability(capability, "/: schema exceeds 120000 characters");
  }
  const counters = { properties: 0, enumValues: 0 };
  const violation = walkOpenAiStrictNode(schema, "", 1, counters);
  if (violation !== undefined) {
    return unsupportedCapability(capability, violation);
  }
  return ok(undefined);
}

/**
 * Recursively validates an OpenAI strict schema node, enforcing keywords, bounds, and closed schemas.
 */
function walkOpenAiStrictNode(
  node: JsonObject,
  pointer: string,
  depth: number,
  counters: { properties: number; enumValues: number },
): string | undefined {
  if (depth > OPENAI_STRICT_MAX_DEPTH) {
    return `${pointer === "" ? "/" : pointer}: nesting depth limit exceeded`;
  }
  const enumValues = node.enum;
  if (enumValues !== undefined && !Array.isArray(enumValues)) {
    return `${pointer}/enum: enum must be an array`;
  }
  if (Array.isArray(enumValues)) {
    counters.enumValues += enumValues.length;
    if (counters.enumValues > OPENAI_STRICT_MAX_ENUM_VALUES) {
      return `${pointer}/enum: enum values limit exceeded`;
    }
  }
  for (const key of OPENAI_STRICT_FORBIDDEN_KEYWORDS) {
    if (node[key] !== undefined) {
      return `${pointer}/${escapePointer(key)}: ${key}`;
    }
  }
  const properties = isPlainObject(node.properties) ? node.properties : undefined;
  const isObjectNode = node.type === "object" || properties !== undefined;
  if (isObjectNode) {
    if (node.additionalProperties !== false) {
      return `${pointer}/additionalProperties: additionalProperties must be false`;
    }
    const names = properties === undefined ? [] : Object.keys(properties);
    counters.properties += names.length;
    if (counters.properties > OPENAI_STRICT_MAX_PROPERTIES) {
      return `${pointer}/properties: property count limit exceeded`;
    }
    const required = node.required;
    if (
      !Array.isArray(required) ||
      required.length !== names.length ||
      !names.every((name) => required.includes(name))
    ) {
      return `${pointer}/required: required must list all property names`;
    }
  }
  const nextDepth = depth + 1;
  for (const key of OPENAI_STRICT_CHILD_KEYWORDS) {
    const child = node[key];
    if (child === undefined) continue;
    if (key === "additionalProperties" && child === false) continue;
    if (!isPlainObject(child)) {
      return `${pointer}/${escapePointer(key)}: ${key} must be an object`;
    }
    if (key === "properties" || key === "$defs") {
      const childKeys = Object.keys(child).sort();
      for (const childKey of childKeys) {
        const value = child[childKey];
        const childPointer = `${pointer}/${escapePointer(key)}/${escapePointer(childKey)}`;
        if (!isPlainObject(value)) {
          return `${childPointer}: schema must be an object`;
        }
        const violation = walkOpenAiStrictNode(value, childPointer, nextDepth, counters);
        if (violation !== undefined) {
          return violation;
        }
      }
    } else {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      const violation = walkOpenAiStrictNode(child, childPointer, nextDepth, counters);
      if (violation !== undefined) {
        return violation;
      }
    }
  }
  return undefined;
}

/** Allowed keywords per node in Anthropic Messages structured output schemas. */
const MESSAGES_OUTPUT_ALLOWED_KEYWORDS: ReadonlyArray<string> = ["type", "properties", "required"];

/**
 * Validates a schema against the Messages structured output subset.
 *
 * @param schema - Schema object to validate.
 * @param capability - Capability identifier reported on rejection.
 * @returns Ok if schema conforms to Messages output subset; otherwise unsupported capability failure.
 */
export function validateMessagesOutputSchema(
  schema: JsonObject,
  capability: MatrixRowId = "structured-json-schema",
): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability(capability, "/: root type must be object");
  }
  const violation = walkMessagesOutputNode(schema, "", 1);
  if (violation !== undefined) {
    return unsupportedCapability(capability, violation);
  }
  return ok(undefined);
}

/**
 * Recursively validates a Messages structured output node against allowed keywords and depth limits.
 */
function walkMessagesOutputNode(node: JsonObject, pointer: string, depth: number): string | undefined {
  if (depth > OPENAI_STRICT_MAX_DEPTH) {
    return `${pointer === "" ? "/" : pointer}: nesting depth limit exceeded`;
  }
  const sortedKeys = Object.keys(node).sort();
  for (const key of sortedKeys) {
    if (!MESSAGES_OUTPUT_ALLOWED_KEYWORDS.includes(key)) {
      return `${pointer}/${escapePointer(key)}: ${key}`;
    }
  }
  if (node.required !== undefined && !isArrayOfStrings(node.required)) {
    return `${pointer}/required: required must be an array of strings`;
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      return `${pointer}/properties: properties must be an object`;
    }
    const propKeys = Object.keys(node.properties).sort();
    for (const propKey of propKeys) {
      const val = node.properties[propKey];
      const childPointer = `${pointer}/properties/${escapePointer(propKey)}`;
      if (!isPlainObject(val)) {
        return `${childPointer}: schema must be an object`;
      }
      const violation = walkMessagesOutputNode(val, childPointer, depth + 1);
      if (violation !== undefined) {
        return violation;
      }
    }
  }
  return undefined;
}
