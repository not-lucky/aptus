/**
 * @fileoverview Parsing of client tool definitions and tool choices across wire grammars.
 *
 * Provides wire-agnostic parsers for client tool definitions (functions and custom tools) and
 * tool choices across nested (Chat), flat (Responses), and typeless (Messages) layouts.
 * Enforces schema validation, unknown key rejection, and direct-caller tracking.
 *
 * Used by ingress decoders across OpenAI Chat, OpenAI Responses, and Anthropic Messages to normalize
 * wire tool declarations into intermediate representation (IR) definitions and sidecar facts.
 */

import type { Result } from "../../../domain/contracts.ts";
import { isPlainObject } from "../../../domain/json.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { IrTool, IrToolChoice } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { firstUnknownKey, parseAllowedCallers } from "./controls.ts";

/**
 * Structural layout of tool definitions on the incoming wire:
 * `nested` wraps payloads under function/custom keys (Chat); `flat` places fields top-level (Responses);
 * `messages` uses typeless Anthropic client tool definitions.
 */
export type ToolWireShape = "nested" | "flat" | "messages";

/** Format object of a custom tool definition projected from the source wire. */
type CustomToolFormat = Extract<IrTool, { type: "custom" }>["format"];

/**
 * Protocol-specific specification configuring tool definition and choice parsing rules.
 * Captures wire shape, schema key names, validation requirements, and native capability hooks.
 */
export interface ToolWireSpec {
  /** Entry layout used by the source wire (`nested`, `flat`, or `messages`). */
  readonly shape: ToolWireShape;

  /** Wire key carrying function input schemas (`parameters` or `input_schema`). */
  readonly schemaField: "parameters" | "input_schema";

  /** Whether the schema object must declare `"type": "object"` at the top level. */
  readonly requireObjectSchemaType: boolean;

  /** Whether the `strict` boolean field is mandatory on function tool entries. */
  readonly strictRequired: boolean;

  /** Whether flat-layout entries must explicitly declare a `type` field. */
  readonly requireType?: boolean;

  /** Tool choice grammar style on the wire (`openai` or `messages`). */
  readonly choiceShape?: "openai" | "messages";

  /** Failure reporting policy when a function tool lacks an input schema. */
  readonly missingSchema: "invalid" | "unsupported";

  /** Whether `allowed_callers` annotations are permitted on tool definitions. */
  readonly allowCallers: boolean;

  /** Documented caller tokens admitted by the wire format. */
  readonly documentedCallers: ReadonlySet<string>;

  /** Optional custom validator for function tool names. */
  readonly validateFunctionName?: (value: unknown, context: string) => Result<string, NormalizedFailure>;

  /** Optional custom validator for custom tool names. */
  readonly validateCustomName?: (value: unknown, context: string) => Result<string, NormalizedFailure>;

  /** Optional parser for custom tool grammar formats. */
  readonly parseCustomFormat?: (value: unknown, context: string) => Result<CustomToolFormat, NormalizedFailure>;

  /** Protocol-owned rejection hook for provider-hosted native capabilities. */
  readonly rejectNative?: (raw: Record<string, unknown>, context: string) => NormalizedFailure | undefined;
}

/** Internal parse result for one tool entry pairing the IR tool with any direct-caller fact. */
interface ParsedToolEntry {
  /** The parsed tool projected into the intermediate representation. */
  readonly tool: IrTool;

  /** The tool's name if declared as a direct caller in `allowed_callers`. */
  readonly directCallerName?: string;
}

/** Result of parsing a request `tools` array into IR tools and sidecar caller facts. */
export interface ParsedToolArray {
  /** Parsed tools in wire order, or `undefined` if tools were absent or empty. */
  readonly tools?: readonly IrTool[];

  /** Names of tools that declared themselves as direct callers, in wire order. */
  readonly directCallerNames: readonly string[];
}

/** Result of parsing a request `tool_choice` field into an IR choice or allowed-tool subset. */
export interface ToolChoiceDecode {
  /** Projected IR tool choice, or `undefined` if an allowed-tool subset was decoded. */
  readonly choice?: IrToolChoice;

  /** `false` if the wire explicitly disabled parallel tool calls. */
  readonly parallelToolCalls?: boolean;

  /** Allowed-tools subset restriction for the request sidecar. */
  readonly subset?: { readonly mode: "auto" | "required"; readonly tools: readonly IrTool[] };

  /** Names of direct-caller tools declared within an allowed-tools subset. */
  readonly directCallerNames: readonly string[];
}

/**
 * Validates that a raw name value is a non-empty, non-blank string.
 *
 * @param value - Raw name value to validate.
 * @param context - Context path for error attribution.
 * @returns Validated name string, or an `invalid_request` failure.
 */
function nonEmptyName(value: unknown, context: string): Result<string, NormalizedFailure> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidRequest(`${context} name must be a non-empty string`);
  }
  return ok(value);
}

/**
 * Validates that a raw field value is a plain JSON object.
 *
 * @param value - Raw value to validate.
 * @param context - Context path for error attribution.
 * @param field - Field name for error formatting.
 * @returns Validated object record, or an `invalid_request` failure.
 */
function objectField(
  value: unknown,
  context: string,
  field: string,
): Result<Record<string, unknown>, NormalizedFailure> {
  if (!isPlainObject(value)) {
    return invalidRequest(`${context}: ${field} must be an object`);
  }
  return ok(value as Record<string, unknown>);
}

/**
 * Validates and parses a single function tool definition according to the wire spec.
 *
 * @param raw - Unwrapped tool payload object.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns Parsed tool entry, or a normalized failure.
 */
function parseFunctionTool(
  raw: Record<string, unknown>,
  context: string,
  spec: ToolWireSpec,
): Result<ParsedToolEntry, NormalizedFailure> {
  const allowed = [
    "type",
    "name",
    "description",
    spec.schemaField,
    "strict",
    ...(spec.allowCallers ? ["allowed_callers"] : []),
  ];
  const extra = firstUnknownKey(raw, allowed);
  if (extra !== undefined) return invalidRequest(`${context}: unknown field '${extra}'`);

  const nameResult = (spec.validateFunctionName ?? nonEmptyName)(raw.name, `${context}: function`);
  if (!nameResult.ok) return nameResult;
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return invalidRequest(`${context}: description must be a string`);
  }

  const schema = raw[spec.schemaField];
  if (schema === undefined) {
    return spec.missingSchema === "unsupported"
      ? unsupportedCapability("function-tool-definition")
      : invalidRequest(`${context}: ${spec.schemaField} must be a JSON object`);
  }
  if (!isPlainObject(schema)) {
    return invalidRequest(`${context}: ${spec.schemaField} must be a JSON object`);
  }
  if (spec.requireObjectSchemaType && schema.type !== "object") {
    return invalidRequest(`${context}: ${spec.schemaField}.type must be 'object'`);
  }
  if (spec.strictRequired && typeof raw.strict !== "boolean") {
    return invalidRequest(`${context}: strict must be a boolean`);
  }
  if (raw.strict !== undefined && typeof raw.strict !== "boolean") {
    return invalidRequest(`${context}: strict must be a boolean`);
  }

  const callers = spec.allowCallers
    ? parseAllowedCallers(raw.allowed_callers, spec.documentedCallers, context)
    : ok(false);
  if (!callers.ok) return callers;

  return ok({
    tool: {
      type: "function",
      name: nameResult.value,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      inputSchema: schema,
      ...(typeof raw.strict === "boolean" ? { strict: raw.strict } : {}),
    },
    ...(callers.value ? { directCallerName: nameResult.value } : {}),
  });
}

/**
 * Validates and parses a single custom tool definition according to the wire spec.
 *
 * @param raw - Unwrapped custom tool payload object.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns Parsed tool entry, or an `invalid_request` failure.
 */
function parseCustomTool(
  raw: Record<string, unknown>,
  context: string,
  spec: ToolWireSpec,
): Result<ParsedToolEntry, NormalizedFailure> {
  const allowed = ["type", "name", "description", "format", ...(spec.allowCallers ? ["allowed_callers"] : [])];
  const extra = firstUnknownKey(raw, allowed);
  if (extra !== undefined) return invalidRequest(`${context}: unknown field '${extra}'`);

  const nameResult = (spec.validateCustomName ?? nonEmptyName)(raw.name, `${context}: custom`);
  if (!nameResult.ok) return nameResult;
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return invalidRequest(`${context}: description must be a string`);
  }
  const formatResult = spec.parseCustomFormat?.(raw.format, `${context}.custom`) ?? ok({ type: "text" });
  if (!formatResult.ok) return formatResult;

  const callers = spec.allowCallers
    ? parseAllowedCallers(raw.allowed_callers, spec.documentedCallers, context)
    : ok(false);
  if (!callers.ok) return callers;

  return ok({
    tool: {
      type: "custom",
      name: nameResult.value,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      format: formatResult.value,
    },
    ...(callers.value ? { directCallerName: nameResult.value } : {}),
  });
}

/**
 * Dispatches a raw tool array entry to its shape-specific parser (nested, flat, or messages).
 *
 * @param value - Raw array element to parse.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns Parsed tool entry, or a normalized failure.
 */
function parseToolEntryWithFacts(
  value: unknown,
  context: string,
  spec: ToolWireSpec,
): Result<ParsedToolEntry, NormalizedFailure> {
  if (!isPlainObject(value)) return invalidRequest(`${context} must be an object`);
  const raw = value as Record<string, unknown>;
  const nativeFailure = spec.rejectNative?.(raw, context);
  if (nativeFailure !== undefined) return failure(nativeFailure);

  if (spec.shape === "nested") {
    if (raw.type !== "function" && raw.type !== "custom") {
      return invalidRequest(`${context}: type must be 'function' or 'custom'`);
    }
    const wrapperResult = objectField(raw[raw.type], context, `'${raw.type}' sub-object`);
    if (!wrapperResult.ok) return wrapperResult;
    return raw.type === "function"
      ? parseFunctionTool(wrapperResult.value, context, spec)
      : parseCustomTool(wrapperResult.value, context, spec);
  }
  if (spec.shape === "messages") {
    if (raw.type !== undefined && raw.type !== "custom") {
      const hostedFailure = spec.rejectNative?.(raw, context);
      return hostedFailure !== undefined
        ? failure(hostedFailure)
        : invalidRequest(`${context}: type '${String(raw.type)}' is not recognized`);
    }
    return parseFunctionTool(raw, context, spec);
  }
  if (typeof raw.type !== "string") {
    return spec.requireType
      ? invalidRequest(`${context}: type is required`)
      : invalidRequest(`${context}: type '${String(raw.type)}' is not recognized`);
  }
  if (raw.type !== "function" && raw.type !== "custom") {
    return invalidRequest(`${context}: type '${String(raw.type)}' is not recognized`);
  }
  return raw.type === "function" ? parseFunctionTool(raw, context, spec) : parseCustomTool(raw, context, spec);
}

/**
 * Parses a request `tools` array into IR tool definitions and direct-caller facts.
 *
 * @param value - Raw `tools` wire array.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns ParsedToolArray with tools and directCallerNames, or a normalized failure.
 */
export function parseToolArray(
  value: unknown,
  context: string,
  spec: ToolWireSpec,
): Result<ParsedToolArray, NormalizedFailure> {
  if (value === undefined) return ok({ tools: undefined, directCallerNames: [] });
  if (!Array.isArray(value)) return invalidRequest(`${context} must be an array`);
  if (value.length === 0) return ok({ tools: undefined, directCallerNames: [] });

  const tools: IrTool[] = [];
  const directCallerNames: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entryResult = parseToolEntryWithFacts(value[i], `${context}[${i}]`, spec);
    if (!entryResult.ok) return entryResult;
    tools.push(entryResult.value.tool);
    if (entryResult.value.directCallerName !== undefined) directCallerNames.push(entryResult.value.directCallerName);
  }
  return ok({ tools, directCallerNames });
}

/**
 * Parses an explicit named tool choice forcing a specific function or custom tool.
 *
 * @param raw - Raw named tool choice object.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns Decoded tool choice, or an `invalid_request` failure.
 */
function parseNamedChoice(
  raw: Record<string, unknown>,
  context: string,
  spec: ToolWireSpec,
): Result<ToolChoiceDecode, NormalizedFailure> {
  const kind = raw.type;
  const nested = spec.shape === "nested";
  const allowed: string[] = nested ? ["type", String(kind)] : ["type", "name"];
  const extra = firstUnknownKey(raw, allowed);
  if (extra !== undefined) return invalidRequest(`${context}.${extra} is not recognized`);
  const source = nested ? raw[kind as string] : raw.name;
  const sourceObj = nested ? objectField(source, context, `tool_choice '${String(kind)}'`) : ok(raw);
  if (!sourceObj.ok) return sourceObj;
  const name = nested ? sourceObj.value.name : raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    return invalidRequest(`tool_choice '${String(kind)}' name must be a non-empty string`);
  }
  return ok({ choice: { type: "named", name }, directCallerNames: [] });
}

/**
 * Parses a request `tool_choice` field across OpenAI and Messages wire grammars.
 *
 * @param value - Raw `tool_choice` wire value.
 * @param context - Context path for error attribution.
 * @param spec - Wire specification defining layout and validation rules.
 * @returns Decoded tool choice or allowed-tools subset, or a normalized failure.
 */
export function parseToolChoice(
  value: unknown,
  context: string,
  spec: ToolWireSpec,
): Result<ToolChoiceDecode, NormalizedFailure> {
  if (spec.choiceShape === "messages") {
    if (!isPlainObject(value)) return invalidRequest("tool_choice must be an object");
    const raw = value as Record<string, unknown>;
    const extra = firstUnknownKey(raw, ["type", "name", "disable_parallel_tool_use"]);
    if (extra !== undefined) return invalidRequest(`${context}.${extra} is not recognized`);
    if (raw.disable_parallel_tool_use !== undefined && typeof raw.disable_parallel_tool_use !== "boolean") {
      return invalidRequest(`${context}.disable_parallel_tool_use must be a boolean`);
    }
    const disableParallel = raw.disable_parallel_tool_use === true;
    if (raw.name !== undefined && raw.type !== "tool") {
      return invalidRequest(`${context}.name is not documented on type '${String(raw.type)}'`);
    }
    if (raw.type === "none") {
      if (raw.disable_parallel_tool_use !== undefined) {
        return invalidRequest(`${context}.disable_parallel_tool_use is not documented on type 'none'`);
      }
      return ok({ choice: { type: "none" }, directCallerNames: [] });
    }
    if (raw.type === "auto" || raw.type === "any") {
      return ok({
        choice: { type: raw.type === "any" ? "required" : "auto" },
        ...(disableParallel ? { parallelToolCalls: false } : {}),
        directCallerNames: [],
      });
    }
    if (raw.type === "tool") {
      if (typeof raw.name !== "string" || raw.name.trim() === "") {
        return invalidRequest(`${context} name must be a non-empty string`);
      }
      return ok({
        choice: { type: "named", name: raw.name },
        ...(disableParallel ? { parallelToolCalls: false } : {}),
        directCallerNames: [],
      });
    }
    return invalidRequest(`${context} type '${String(raw.type)}' is not recognized`);
  }

  if (value === "auto" || value === "none" || value === "required") {
    return ok({ choice: { type: value }, directCallerNames: [] });
  }
  if (!isPlainObject(value)) return invalidRequest(`${context} must be a string or an object`);
  const raw = value as Record<string, unknown>;
  const nativeFailure = spec.rejectNative?.(raw, context);
  if (nativeFailure !== undefined) return failure(nativeFailure);
  if (raw.type === "function" || raw.type === "custom") return parseNamedChoice(raw, context, spec);
  if (raw.type !== "allowed_tools") {
    return invalidRequest(`${context} type '${String(raw.type)}' is not recognized`);
  }

  if (spec.shape === "nested") {
    const extra = firstUnknownKey(raw, ["type", "allowed_tools"]);
    if (extra !== undefined) return invalidRequest(`${context}.${extra} is not recognized`);
    const subset = objectField(raw.allowed_tools, context, "allowed_tools");
    if (!subset.ok) return subset;
    const subsetExtra = firstUnknownKey(subset.value, ["mode", "tools"]);
    if (subsetExtra !== undefined) return invalidRequest(`${context}.allowed_tools.${subsetExtra} is not recognized`);
    if (subset.value.mode !== "auto" && subset.value.mode !== "required") {
      return invalidRequest(`${context} mode must be 'auto' or 'required'`);
    }
    const toolsResult = parseToolArray(subset.value.tools, `${context}.tools`, spec);
    if (!toolsResult.ok) return toolsResult;
    if (toolsResult.value.tools === undefined) return invalidRequest(`${context} tools must be a non-empty array`);
    return ok({
      choice: { type: subset.value.mode },
      subset: { mode: subset.value.mode, tools: toolsResult.value.tools },
      directCallerNames: [...toolsResult.value.directCallerNames],
    });
  }

  const extra = firstUnknownKey(raw, ["type", "mode", "tools"]);
  if (extra !== undefined) return invalidRequest(`${context}.${extra} is not recognized`);
  if (raw.mode !== "auto" && raw.mode !== "required")
    return invalidRequest(`${context} mode must be 'auto' or 'required'`);
  const toolsResult = parseToolArray(raw.tools, `${context}.tools`, spec);
  if (!toolsResult.ok) return toolsResult;
  if (toolsResult.value.tools === undefined) return invalidRequest(`${context} tools must be a non-empty array`);
  return ok({
    choice: { type: raw.mode },
    subset: { mode: raw.mode, tools: toolsResult.value.tools },
    directCallerNames: [...toolsResult.value.directCallerNames],
  });
}
