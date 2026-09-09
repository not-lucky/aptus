/**
 * @fileoverview Projection of intermediate representation output formats onto target wire protocols.
 *
 * Translates semantic IR output shapes (text, structured JSON schemas) and legacy JSON object
 * modes into protocol-specific wire fields: Chat `response_format`, Responses `text.format` and
 * `text.verbosity`, and Messages `output_config`.
 *
 * Used by complete and streaming egress encoders across OpenAI Chat, OpenAI Responses, and
 * Anthropic Messages to ensure consistent wire schema generation.
 */

import type { JsonValue } from "../../../domain/contracts.ts";
import type { RequestWireOptions } from "../../contracts.ts";
import type { IrGenerationControls, IrOutputFormat } from "../../ir.ts";

/** Default schema name synthesized when target wires require a named schema but the IR provides none. */
export const SYNTHESIZED_FORMAT_NAME = "response";

/**
 * Projects IR output shape and sidecar flags into Chat `response_format` fields.
 * Legacy JSON object mode takes precedence over IR output formats.
 *
 * @param output - IR output format specification.
 * @param wireOptions - Request sidecar containing wire-specific options.
 * @returns Record containing `response_format` when applicable, or empty object.
 */
export function chatOutputFormatFields(
  output: IrOutputFormat | undefined,
  wireOptions?: RequestWireOptions,
): Record<string, JsonValue> {
  if (wireOptions?.legacyJsonObject === true) {
    return { response_format: { type: "json_object" } };
  }
  if (output === undefined) return {};
  if (output.type === "text") {
    return { response_format: { type: "text" } };
  }
  const jsonSchema: Record<string, JsonValue> = {
    name: output.name ?? SYNTHESIZED_FORMAT_NAME,
    schema: output.schema as JsonValue,
  };
  if (output.description !== undefined) jsonSchema.description = output.description;
  if (output.strict !== undefined) jsonSchema.strict = output.strict;
  return { response_format: { type: "json_schema", json_schema: jsonSchema } };
}

/**
 * Projects verbosity controls and IR output shape into Responses `text` configuration fields.
 * Legacy JSON object mode takes precedence over IR output formats.
 *
 * @param generation - Generation controls potentially carrying verbosity.
 * @param output - IR output format specification.
 * @param wireOptions - Request sidecar containing wire-specific options.
 * @returns Record containing `text` configuration when applicable, or empty object.
 */
export function responsesTextConfig(
  generation: IrGenerationControls | undefined,
  output: IrOutputFormat | undefined,
  wireOptions?: RequestWireOptions,
): Record<string, JsonValue> {
  const text: Record<string, JsonValue> = {};
  if (generation?.verbosity !== undefined) {
    text.verbosity = generation.verbosity;
  }
  if (wireOptions?.legacyJsonObject === true) {
    text.format = { type: "json_object" };
  } else if (output !== undefined) {
    if (output.type === "text") {
      text.format = { type: "text" };
    } else {
      const format: Record<string, JsonValue> = {
        type: "json_schema",
        name: output.name ?? SYNTHESIZED_FORMAT_NAME,
        schema: output.schema as JsonValue,
      };
      if (output.description !== undefined) format.description = output.description;
      if (output.strict !== undefined) format.strict = output.strict;
      text.format = format;
    }
  }
  if (Object.keys(text).length === 0) return {};
  return { text };
}

/**
 * Projects IR output shape into Anthropic Messages `output_config` fields.
 * Omitted for plain text responses as Messages defaults to text.
 *
 * @param output - IR output format specification.
 * @returns Record containing `output_config` for JSON schemas, or empty object.
 */
export function messagesOutputConfigFields(output: IrOutputFormat | undefined): Record<string, JsonValue> {
  if (output === undefined || output.type !== "json_schema") return {};
  return {
    output_config: {
      format: {
        type: "json_schema",
        schema: output.schema as JsonValue,
      },
    },
  };
}
