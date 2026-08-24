import type { JsonValue } from "../../../domain/contracts.ts";
import type { RequestWireOptions } from "../../contracts.ts";
import type { IrGenerationControls, IrOutputFormat } from "../../ir.ts";

/** Wire-only schema name synthesized for target protocols that require a name when the IR has none. */
export const SYNTHESIZED_FORMAT_NAME = "response";

/**
 * Projects IR output format and wire options onto Chat `response_format`.
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
 * Projects Responses `text` configuration, merging generation verbosity with
 * output format (from sidecar or IR output).
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
 * Projects IR output format onto Messages `output_config`.
 */
export function messagesOutputConfigFields(output: IrOutputFormat | undefined): Record<string, JsonValue> {
  // Omitted `output` or explicit `type: "text"` means text; M wire omits `output_config` entirely for text.
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
