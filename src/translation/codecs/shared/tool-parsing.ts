import type { Result } from "../../../domain/contracts.ts";
import { isPlainObject } from "../../../domain/json.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { IrTool, IrToolChoice } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { firstUnknownKey, parseAllowedCallers } from "./controls.ts";

/** The two OpenAI tool-definition wire layouts plus the Messages client shape. */
export type ToolWireShape = "nested" | "flat" | "messages";

type CustomToolFormat = Extract<IrTool, { type: "custom" }>["format"];

/**
 * The small set of facts that differs between client-tool definition wires.
 * The parser owns all common validation; protocol codecs provide only shape and
 * native-capability hooks. This keeps a matrix correction in one place without
 * turning the module into a protocol framework.
 */
export interface ToolWireSpec {
  readonly shape: ToolWireShape;
  readonly schemaField: "parameters" | "input_schema";
  readonly requireObjectSchemaType: boolean;
  readonly strictRequired: boolean;
  readonly requireType?: boolean;
  readonly choiceShape?: "openai" | "messages";
  readonly missingSchema: "invalid" | "unsupported";
  readonly allowCallers: boolean;
  readonly documentedCallers: ReadonlySet<string>;
  readonly validateFunctionName?: (value: unknown, context: string) => Result<string, NormalizedFailure>;
  readonly validateCustomName?: (value: unknown, context: string) => Result<string, NormalizedFailure>;
  readonly parseCustomFormat?: (value: unknown, context: string) => Result<CustomToolFormat, NormalizedFailure>;
  /**
   * Protocol-owned rejection hook. It runs before generic type/field checks so
   * recognized hosted/provider facts retain their exact matrix row.
   */
  readonly rejectNative?: (raw: Record<string, unknown>, context: string) => NormalizedFailure | undefined;
}

interface ParsedToolEntry {
  readonly tool: IrTool;
  readonly directCallerName?: string;
}

export interface ParsedToolArray {
  readonly tools?: readonly IrTool[];
  readonly directCallerNames: readonly string[];
}

export interface ToolChoiceDecode {
  readonly choice?: IrToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly subset?: { readonly mode: "auto" | "required"; readonly tools: readonly IrTool[] };
  readonly directCallerNames: readonly string[];
}

function nonEmptyName(value: unknown, context: string): Result<string, NormalizedFailure> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidRequest(`${context} name must be a non-empty string`);
  }
  return ok(value);
}

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

/** Parses a `tools` array and returns allowed-caller facts as data, never a sink. */
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

/** Parses the shared OpenAI `tool_choice` grammar, including allowed-tools subsets. */
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
