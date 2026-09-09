/**
 * @fileoverview Egress projection of client tool surfaces onto provider wire formats.
 *
 * Handles layout and naming differences across target protocols: OpenAI Chat nested tool wrappers,
 * OpenAI Responses flat structures, and Anthropic Messages typeless tools with `disable_parallel_tool_use`.
 * Also projects sidecar-captured `allowed_callers` facts and `allowed_tools` subsets.
 *
 * Used by complete and streaming egress encoders across OpenAI Chat, OpenAI Responses, and
 * Anthropic Messages to emit compliant tool definitions and choice structures.
 */

import type { RequestWireOptions } from "../../contracts.ts";
import type { IrRequest, IrTool, IrToolChoice, JsonObject, JsonValue } from "../../ir.ts";

/**
 * Builds the `allowed_callers` wire field for a tool if recorded as a direct caller.
 *
 * @param toolName - Name of the tool being projected.
 * @param allowedCallers - Captured list of direct-caller tool names from the sidecar.
 * @returns Object with `allowed_callers: ["direct"]` if matched, or empty object.
 */
function allowedCallersField(toolName: string, allowedCallers: ReadonlyArray<string> | undefined): JsonObject {
  return allowedCallers?.includes(toolName) === true ? { allowed_callers: ["direct"] } : {};
}

/**
 * Projects an IR tool choice onto the Chat `tool_choice` structure.
 *
 * @param choice - IR tool choice specification.
 * @param tools - Request tool definitions used to distinguish function vs custom tools.
 * @returns Chat `tool_choice` JSON value.
 */
function chatToolChoiceBody(choice: IrToolChoice, tools: readonly IrTool[] | undefined): JsonValue {
  if (choice.type === "named") {
    const tool = tools?.find((entry) => entry.name === choice.name);
    return tool?.type === "custom"
      ? { type: "custom", custom: { name: choice.name } }
      : { type: "function", function: { name: choice.name } };
  }
  return choice.type;
}

/**
 * Projects an IR tool onto a nested Chat `tools[]` entry.
 *
 * @param tool - IR tool to project.
 * @returns Nested Chat tool definition object.
 */
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
 * Projects IR tool definitions, choices, and parallel call settings onto Chat wire fields.
 *
 * @param request - IR request carrying tool configuration.
 * @param requestWireOptions - Optional request sidecar carrying allowed-tool subsets.
 * @returns Record of Chat wire fields (`tools`, `tool_choice`, `parallel_tool_calls`).
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

/**
 * Projects an IR tool onto a flat Responses `tools[]` entry.
 *
 * @param tool - IR tool to project.
 * @param allowedCallers - Captured direct-caller tool names from the sidecar.
 * @returns Flat Responses tool definition object.
 */
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

/**
 * Projects an IR tool choice onto the flat Responses `tool_choice` structure.
 *
 * @param choice - IR tool choice specification.
 * @param tools - Request tool definitions used to distinguish function vs custom tools.
 * @returns Responses `tool_choice` JSON value.
 */
function responsesToolChoiceBody(choice: IrToolChoice, tools: readonly IrTool[] | undefined): JsonValue {
  if (choice.type === "named") {
    const tool = tools?.find((entry) => entry.name === choice.name);
    return tool?.type === "custom" ? { type: "custom", name: choice.name } : { type: "function", name: choice.name };
  }
  return choice.type;
}

/**
 * Projects IR tool definitions, choices, and parallel call settings onto Responses wire fields.
 *
 * @param request - IR request carrying tool configuration.
 * @param requestWireOptions - Optional request sidecar carrying allowed callers and subsets.
 * @returns Record of Responses wire fields (`tools`, `tool_choice`, `parallel_tool_calls`).
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

/**
 * Projects an IR function tool onto a typeless Anthropic Messages `tools[]` entry.
 *
 * @param tool - IR function tool to project.
 * @param allowedCallers - Captured direct-caller tool names from the sidecar.
 * @returns Messages wire tool definition object.
 */
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

/**
 * Projects an IR tool choice onto the Anthropic Messages `tool_choice` object.
 *
 * @param choice - IR tool choice specification.
 * @param disableParallel - Whether parallel tool calls are disabled.
 * @returns Messages `tool_choice` JSON object.
 */
function messagesToolChoiceBody(choice: IrToolChoice, disableParallel: boolean): JsonObject {
  const body: JsonObject =
    choice.type === "required"
      ? { type: "any" }
      : choice.type === "named"
        ? { type: "tool", name: choice.name }
        : { type: choice.type };
  return disableParallel && choice.type !== "none" ? { ...body, disable_parallel_tool_use: true } : body;
}

/**
 * Projects IR tool definitions and choices onto Anthropic Messages wire fields.
 *
 * @param request - IR request carrying tool configuration.
 * @param requestWireOptions - Optional request sidecar carrying allowed callers.
 * @returns Record of Messages wire fields (`tools`, `tool_choice`).
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
