import type { RequestWireOptions } from "../../contracts.ts";
import type { IrRequest, IrTool, IrToolChoice, JsonObject, JsonValue } from "../../ir.ts";

/**
 * Egress projection of client tool surfaces onto each target wire.
 *
 * One builder per target wire, because the wires genuinely disagree on shape:
 * Chat nests tool definitions under `function`/`custom`, Responses keeps them
 * flat, and Messages emits them typeless. Each builder is otherwise a direct
 * projection of the IR — a target's spelling of a field lives in exactly one
 * place, and only fields the wire actually carries are emitted (Responses
 * always emits `strict` because its wire requires the field; Chat and Messages
 * omit it when it is not set, because theirs default it).
 */

/** The `allowed_callers` field for a tool the sidecar recorded a direct caller for. */
function allowedCallersField(toolName: string, allowedCallers: ReadonlyArray<string> | undefined): JsonObject {
  return allowedCallers?.includes(toolName) === true ? { allowed_callers: ["direct"] } : {};
}

/** One IR tool choice onto its Chat `tool_choice` value. */
function chatToolChoiceBody(choice: IrToolChoice, tools: readonly IrTool[] | undefined): JsonValue {
  if (choice.type === "named") {
    const tool = tools?.find((entry) => entry.name === choice.name);
    return tool?.type === "custom"
      ? { type: "custom", custom: { name: choice.name } }
      : { type: "function", function: { name: choice.name } };
  }
  return choice.type;
}

/** One IR tool onto its nested Chat `tools[]` entry. */
function chatToolEntry(tool: IrTool): JsonObject {
  if (tool.type === "function") {
    const fn: JsonObject = {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
      ...(tool.strict === true ? { strict: true } : {}),
    };
    return { type: "function", function: fn };
  }
  const custom: JsonObject = {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.format.type === "grammar"
      ? {
          format: {
            type: "grammar",
            grammar: { definition: tool.format.definition, syntax: tool.format.syntax },
          },
        }
      : {}),
  };
  return { type: "custom", custom };
}

/**
 * Projects IR tool surfaces onto OpenAI Chat wire fields (nested shapes):
 * `tools`, `tool_choice`, `parallel_tool_calls`. Strict is emitted only when
 * true, text custom formats are omitted, and `parallel_tool_calls` only when
 * false (true is the provider default). An allowed-tools subset sidecar
 * replaces the plain choice with the nested `allowed_tools` spelling.
 */
export function chatToolFields(
  request: IrRequest,
  requestWireOptions: RequestWireOptions | undefined,
): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  const tools = request.tools;
  if (tools !== undefined && tools.length > 0) {
    fields.tools = tools.map(chatToolEntry);
  }
  const subset = requestWireOptions?.allowedToolSubset;
  if (subset !== undefined) {
    // Nested subset control: the C wire nests mode/tools under `allowed_tools`,
    // and `allowed_tools.tools` reuses the `tools[]` entry shape
    // (research C:90/141/142).
    fields.tool_choice = {
      type: "allowed_tools",
      allowed_tools: {
        mode: subset.mode,
        tools: subset.tools.map(chatToolEntry),
      },
    };
  } else if (request.toolChoice !== undefined) {
    fields.tool_choice = chatToolChoiceBody(request.toolChoice, tools);
  }
  if (request.parallelToolCalls === false) fields.parallel_tool_calls = false;
  return fields;
}

/** One IR tool onto its flat Responses `tools[]` entry. */
function responsesToolEntry(tool: IrTool, allowedCallers: ReadonlyArray<string> | undefined): JsonObject {
  const callersField = allowedCallersField(tool.name, allowedCallers);
  if (tool.type === "function") {
    return {
      type: "function",
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
      strict: tool.strict ?? false,
      ...callersField,
    };
  }
  return {
    type: "custom",
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.format.type === "grammar"
      ? { format: { type: "grammar", definition: tool.format.definition, syntax: tool.format.syntax } }
      : {}),
    ...callersField,
  };
}

/** One IR tool choice onto its Responses `tool_choice` value. */
function responsesToolChoiceBody(choice: IrToolChoice, tools: readonly IrTool[] | undefined): JsonValue {
  if (choice.type === "named") {
    const tool = tools?.find((entry) => entry.name === choice.name);
    return tool?.type === "custom" ? { type: "custom", name: choice.name } : { type: "function", name: choice.name };
  }
  return choice.type;
}

/**
 * Projects IR tool surfaces onto OpenAI Responses wire fields (flat shapes):
 * `tools`, `tool_choice`, `parallel_tool_calls`. Function entries always carry
 * `strict` (required on the R wire, defaulting false), grammar formats stay
 * flat, sidecar caller entries re-emit as `allowed_callers: ["direct"]` (the
 * only R↔M intersection), and `parallel_tool_calls` only when false.
 */
export function responsesToolFields(
  request: IrRequest,
  requestWireOptions: RequestWireOptions | undefined,
): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  const tools = request.tools;
  const allowedCallers = requestWireOptions?.toolAllowedCallers;
  if (tools !== undefined && tools.length > 0) {
    fields.tools = tools.map((tool) => responsesToolEntry(tool, allowedCallers));
  }
  const subset = requestWireOptions?.allowedToolSubset;
  if (subset !== undefined) {
    fields.tool_choice = {
      type: "allowed_tools",
      mode: subset.mode,
      tools: subset.tools.map((tool) => responsesToolEntry(tool, allowedCallers)),
    };
  } else if (request.toolChoice !== undefined) {
    fields.tool_choice = responsesToolChoiceBody(request.toolChoice, tools);
  }
  if (request.parallelToolCalls === false) fields.parallel_tool_calls = false;
  return fields;
}

/** One IR tool onto its Messages `tools[]` entry (client tools, no type). */
function messagesToolEntry(
  tool: Extract<IrTool, { type: "function" }>,
  allowedCallers: ReadonlyArray<string> | undefined,
): JsonObject {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
    ...(tool.strict === true ? { strict: true } : {}),
    ...allowedCallersField(tool.name, allowedCallers),
  };
}

/** One IR tool choice onto its Messages `tool_choice` object. */
function messagesToolChoiceBody(choice: IrToolChoice, disableParallel: boolean): JsonObject {
  const body: JsonObject =
    choice.type === "required"
      ? { type: "any" }
      : choice.type === "named"
        ? { type: "tool", name: choice.name }
        : { type: choice.type };
  // Preflight rejects the disable-parallel + none conflict, so the flag only
  // ever attaches to auto/any/tool choices.
  return disableParallel && choice.type !== "none" ? { ...body, disable_parallel_tool_use: true } : body;
}

/**
 * Projects IR tool surfaces onto Anthropic Messages wire fields: `tools` and
 * `tool_choice`. Client tools emit without a `type` field, strict only when
 * true, sidecar caller entries re-emit as `allowed_callers: ["direct"]`.
 * `disable_parallel_tool_use` attaches to auto/any/tool choices when parallel
 * calls are disabled, and a disabled-parallel request with tools but no
 * explicit choice synthesizes the documented `{type:"auto"}` carrier.
 */
export function messagesToolFields(
  request: IrRequest,
  requestWireOptions: RequestWireOptions | undefined,
): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  const tools = request.tools;
  const allowedCallers = requestWireOptions?.toolAllowedCallers;
  const hasTools = tools !== undefined && tools.length > 0;
  if (hasTools) {
    // Preflight rejects custom tools for M targets before encoding, so only
    // function tools reach this projection.
    fields.tools = tools
      .filter((tool): tool is Extract<IrTool, { type: "function" }> => tool.type === "function")
      .map((tool) => messagesToolEntry(tool, allowedCallers));
  }
  const disableParallel = request.parallelToolCalls === false;
  if (request.toolChoice !== undefined) {
    fields.tool_choice = messagesToolChoiceBody(request.toolChoice, disableParallel);
  } else if (disableParallel && hasTools) {
    fields.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  return fields;
}
