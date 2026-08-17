/**
 * JSON Schema dialect validators for the `function-tool-definition` and
 * `function-schema-strictness` matrix rows.
 *
 * The IR carries provider-neutral JSON Schema. Each target protocol honors a
 * different strict subset, so preflight validates the schema against the
 * target dialect before dispatch and rejects with the owning row when the
 * schema cannot be honored.
 */

import type { JsonObject, JsonValue, Result } from "../domain/contracts.ts";
import { isPlainObject } from "../domain/json.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { ok, unsupportedCapability } from "./result.ts";

/** OpenAI strict-mode documented limits (5000 properties, 10 nesting levels, 120k chars, 1000 enum values). */
const OPENAI_STRICT_MAX_PROPERTIES = 5000;
const OPENAI_STRICT_MAX_DEPTH = 10;
const OPENAI_STRICT_MAX_CHARS = 120_000;
const OPENAI_STRICT_MAX_ENUM_VALUES = 1000;

/** The only root keywords Messages strict mode can honor (its documented strict shape). */
const MESSAGES_STRICT_ROOT_KEYWORDS = ["type", "properties", "required"];

/**
 * Child keywords the OpenAI strict walk descends into.
 * `additionalProperties: false` carries no subschema to check, but stays
 * listed so the walk can reject any non-false spelling of it.
 */
const OPENAI_STRICT_CHILD_KEYWORDS = ["properties", "items", "additionalProperties", "$defs"] as const;

/**
 * Combinators and composition keywords the OpenAI strict subset does not
 * document: they appear anywhere in the schema (root or nested) and strict
 * mode cannot honor them, so any occurrence rejects.
 */
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

function isArrayOfStrings(value: JsonValue): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Messages requires every client tool `input_schema` to declare an object
 * root. Any other root is not a tool schema the Messages wire can carry.
 */
export function validateMessagesObjectRoot(schema: JsonObject): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability("function-tool-definition");
  }
  return ok(undefined);
}

/**
 * Messages strict mode honors only object-root schemas whose root keywords
 * stay within {type, properties, required} and whose property values are
 * plain objects. Anything richer is not representable under Messages strict.
 *
 * M documents a validation guarantee but not cross-provider dialect
 * equivalence, so the guarantee is only provable for the exact documented
 * shape; non-strict schemas into M carry no guarantee and pass with only the
 * object-root check.
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
 * OpenAI strict mode (Chat and Responses) honors a documented JSON Schema
 * subset: an object root without anyOf/oneOf, every object node closed with
 * `additionalProperties: false` and `required` listing all property names,
 * within fixed size limits. Schemas outside the subset fall back to
 * best-effort generation, which strict mode must never do, so preflight
 * rejects them.
 */
export function validateOpenAiStrictSchema(schema: JsonObject): Result<void, NormalizedFailure> {
  if (schema.type !== "object") {
    return unsupportedCapability("function-schema-strictness");
  }
  if (JSON.stringify(schema).length > OPENAI_STRICT_MAX_CHARS) {
    return unsupportedCapability("function-schema-strictness");
  }
  const counters = { properties: 0, enumValues: 0 };
  if (!walkOpenAiStrictNode(schema, 1, counters)) {
    return unsupportedCapability("function-schema-strictness");
  }
  return ok(undefined);
}

function walkOpenAiStrictNode(
  node: JsonObject,
  depth: number,
  counters: { properties: number; enumValues: number },
): boolean {
  if (depth > OPENAI_STRICT_MAX_DEPTH) {
    return false;
  }
  const enumValues = node.enum;
  if (enumValues !== undefined && !Array.isArray(enumValues)) {
    // Present-but-malformed `enum` cannot be proven honored under a strict
    // guarantee, so it rejects instead of passing unvalidated.
    return false;
  }
  if (Array.isArray(enumValues)) {
    counters.enumValues += enumValues.length;
    if (counters.enumValues > OPENAI_STRICT_MAX_ENUM_VALUES) {
      return false;
    }
  }
  for (const key of OPENAI_STRICT_FORBIDDEN_KEYWORDS) {
    if (node[key] !== undefined) {
      return false;
    }
  }
  const properties = isPlainObject(node.properties) ? node.properties : undefined;
  const isObjectNode = node.type === "object" || properties !== undefined;
  if (isObjectNode) {
    if (node.additionalProperties !== false) {
      return false;
    }
    const names = properties === undefined ? [] : Object.keys(properties);
    counters.properties += names.length;
    if (counters.properties > OPENAI_STRICT_MAX_PROPERTIES) {
      return false;
    }
    const required = node.required;
    if (
      !Array.isArray(required) ||
      required.length !== names.length ||
      !names.every((name) => required.includes(name))
    ) {
      return false;
    }
  }
  const nextDepth = depth + 1;
  for (const key of OPENAI_STRICT_CHILD_KEYWORDS) {
    const child = node[key];
    if (child === undefined) continue;
    // Tuple-style `items` arrays and non-object bag entries (boolean schemas,
    // strings, numbers) have no strict-subset spelling; any present-but-
    // unusable value rejects rather than passing unvalidated.
    if (key === "additionalProperties" && child === false) continue;
    if (!isPlainObject(child)) return false;
    // `properties` and `$defs` are bags of named child nodes; `items` and a
    // schema-valued `additionalProperties` are single nodes.
    if (key === "properties" || key === "$defs") {
      for (const value of Object.values(child)) {
        if (!isPlainObject(value)) return false;
        if (!walkOpenAiStrictNode(value, nextDepth, counters)) {
          return false;
        }
      }
    } else if (!walkOpenAiStrictNode(child, nextDepth, counters)) {
      return false;
    }
  }
  return true;
}
