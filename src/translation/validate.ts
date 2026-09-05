import type { Result } from "../domain/contracts.ts";
import { isPlainObject, jsonEqual } from "../domain/json.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { CHAT_TOOL_NAME_REGEX, firstUnknownKey } from "./codecs/shared/controls.ts";
import { base64DecodedLength, validateHttpsUrl } from "./codecs/shared/media.ts";
import type { RequestWireOptions } from "./contracts.ts";
import {
  GRAMMAR_SYNTAX_VALUES,
  type IrAssistantPart,
  type IrBinarySource,
  type IrCitation,
  type IrDocumentSource,
  type IrInputPart,
  type IrItem,
  type IrOutcome,
  type IrOutputFormat,
  type IrOutputPart,
  type IrRequest,
  type IrTool,
  type IrToolCall,
  type IrToolChoice,
  type IrUsage,
  REASONING_EFFORT_VALUES,
  VERBOSITY_VALUES,
} from "./ir.ts";
import { invalidRequest, ok } from "./result.ts";

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "refusal", "content_filter", "context_limit"]);

// Admitted control literals are defined once beside the codec parsers so the
// decode and validation layers can never drift apart.
const VERBOSITY_LITERALS = new Set<string>(VERBOSITY_VALUES);

const REASONING_EFFORT_LITERALS = new Set<string>(REASONING_EFFORT_VALUES);
const GRAMMAR_SYNTAX_LITERALS = new Set<string>(GRAMMAR_SYNTAX_VALUES);

function isNonNegativeSafeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function validateOutputFormat(
  output: IrOutputFormat | undefined,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  if (requestWireOptions?.legacyJsonObject === true && output !== undefined) {
    return invalidRequest("IrRequest.output must be unset when the legacyJsonObject sidecar is set");
  }
  if (output === undefined) return ok(undefined);
  if (output.type === "text") {
    const extra = firstUnknownKey(output, ["type"]);
    if (extra !== undefined) return invalidRequest(`IrOutputFormat (text): ${extra} is not recognized`);
    return ok(undefined);
  }
  if (output.type === "json_schema") {
    const extra = firstUnknownKey(output, ["type", "schema", "name", "description", "strict"]);
    if (extra !== undefined) return invalidRequest(`IrOutputFormat (json_schema): ${extra} is not recognized`);
    if (!isPlainObject(output.schema)) {
      return invalidRequest("IrOutputFormat (json_schema): schema must be a plain object");
    }
    if (output.name !== undefined) {
      if (typeof output.name !== "string" || !CHAT_TOOL_NAME_REGEX.test(output.name)) {
        return invalidRequest(`IrOutputFormat (json_schema): name must match ${CHAT_TOOL_NAME_REGEX}`);
      }
    }
    if (output.description !== undefined && typeof output.description !== "string") {
      return invalidRequest("IrOutputFormat (json_schema): description must be a string");
    }
    if (output.strict !== undefined && typeof output.strict !== "boolean") {
      return invalidRequest("IrOutputFormat (json_schema): strict must be a boolean");
    }
    return ok(undefined);
  }
  return invalidRequest("IrOutputFormat: type is not recognized");
}

/**
 * Validates a function tool call's authoritative argument text and optional
 * parsed object. Invalid JSON remains representable for OpenAI targets, but an
 * `arguments` field is legal only when the complete text parses to the same
 * non-null, non-array JSON object.
 */
function validateFunctionCallArguments(
  call: Extract<IrToolCall, { type: "function" }>,
  context: string,
): Result<void, NormalizedFailure> {
  if (typeof call.argumentsText !== "string") {
    return invalidRequest(`${context}: argumentsText must be a string`);
  }
  if (call.arguments === undefined) return ok(undefined);

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsText) as unknown;
  } catch {
    return invalidRequest(`${context}: arguments must parse from argumentsText as a JSON object`);
  }
  if (!isPlainObject(parsed)) {
    return invalidRequest(`${context}: argumentsText must parse to a JSON object when arguments is present`);
  }
  if (!jsonEqual(call.arguments, parsed)) {
    return invalidRequest(`${context}: arguments must deep-equal the parsed argumentsText object`);
  }
  return ok(undefined);
}

/** Validates one sampling control as a finite number within the IR range [0, 1]. */
function validateUnitInterval(value: unknown, fieldName: string): Result<void, NormalizedFailure> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return invalidRequest(`IrRequest.generation.${fieldName} must be a finite number within [0, 1]`);
  }
  return ok(undefined);
}

/**
 * Validates the normative invariants of decoded generation controls: sampling
 * controls are bounded to the IR range [0, 1], output limits are positive safe
 * integers, stop sequences are non-empty strings, and the verbosity/effort
 * unions carry only their admitted literals.
 */
function validateGenerationControls(generation: IrRequest["generation"]): Result<void, NormalizedFailure> {
  if (generation === undefined) return ok(undefined);
  if (generation.temperature !== undefined) {
    const temperatureResult = validateUnitInterval(generation.temperature, "temperature");
    if (!temperatureResult.ok) return temperatureResult;
  }
  if (generation.topP !== undefined) {
    const topPResult = validateUnitInterval(generation.topP, "topP");
    if (!topPResult.ok) return topPResult;
  }
  if (
    generation.maxOutputTokens !== undefined &&
    (typeof generation.maxOutputTokens !== "number" ||
      !Number.isSafeInteger(generation.maxOutputTokens) ||
      generation.maxOutputTokens <= 0)
  ) {
    return invalidRequest("IrRequest.generation.maxOutputTokens must be a positive safe integer");
  }
  if (generation.stopSequences !== undefined) {
    if (!Array.isArray(generation.stopSequences) || generation.stopSequences.length === 0) {
      return invalidRequest("IrRequest.generation.stopSequences must be a non-empty array when present");
    }
    for (let i = 0; i < generation.stopSequences.length; i++) {
      const sequence = generation.stopSequences[i];
      if (typeof sequence !== "string" || sequence.length === 0) {
        return invalidRequest(`IrRequest.generation.stopSequences[${i}] must be a non-empty string`);
      }
    }
  }
  if (generation.verbosity !== undefined && !VERBOSITY_LITERALS.has(generation.verbosity)) {
    return invalidRequest(`IrRequest.generation.verbosity must be one of: ${[...VERBOSITY_LITERALS].join(", ")}`);
  }
  if (generation.reasoning?.effort !== undefined && !REASONING_EFFORT_LITERALS.has(generation.reasoning.effort)) {
    return invalidRequest(
      `IrRequest.generation.reasoning.effort must be one of: ${[...REASONING_EFFORT_LITERALS].join(", ")}`,
    );
  }
  return ok(undefined);
}

function validateBinarySource(source: IrBinarySource, context: string): Result<void, NormalizedFailure> {
  if (source.type === "url") {
    if (!validateHttpsUrl(source.url)) {
      return invalidRequest(`${context}: URL source must be an absolute HTTPS URL`);
    }
    return ok(undefined);
  }
  if (source.type === "bytes") {
    if (typeof source.mediaType !== "string" || source.mediaType.trim() === "") {
      return invalidRequest(`${context}: mediaType must be a non-empty string`);
    }
    if (base64DecodedLength(source.base64) === undefined) {
      return invalidRequest(`${context}: base64 payload must be valid base64`);
    }
    return ok(undefined);
  }
  if (source.type === "gateway_file") {
    if (typeof source.fileId !== "string" || source.fileId.trim() === "") {
      return invalidRequest(`${context}: fileId must be a non-empty string`);
    }
    return ok(undefined);
  }
  return invalidRequest(`${context}: unknown binary source type`);
}

function validateDocumentSource(source: IrDocumentSource, context: string): Result<void, NormalizedFailure> {
  if (source.type === "text") {
    if (typeof source.text !== "string") {
      return invalidRequest(`${context}: text document source must contain string text`);
    }
    return ok(undefined);
  }
  return validateBinarySource(source, context);
}

function validateInputPart(part: IrInputPart, index: number): Result<void, NormalizedFailure> {
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return invalidRequest(`input part [${index}]: text must be a string`);
    }
    return ok(undefined);
  }
  if (part.type === "image") {
    if (part.detail !== undefined && part.detail !== "auto" && part.detail !== "low" && part.detail !== "high") {
      return invalidRequest(`input part [${index}] (image): detail must be 'auto', 'low', or 'high'`);
    }
    return validateBinarySource(part.source, `input part [${index}] (image)`);
  }
  if (part.type === "document") {
    if (typeof part.documentId !== "string" || part.documentId.trim() === "") {
      return invalidRequest(`input part [${index}] (document): documentId must be non-empty`);
    }
    if (part.name !== undefined && typeof part.name !== "string") {
      return invalidRequest(`input part [${index}] (document): name must be a string if present`);
    }
    return validateDocumentSource(part.source, `input part [${index}] (document)`);
  }
  return invalidRequest(`input part [${index}]: unknown input part type`);
}

function validateCitation(citation: IrCitation, context: string): Result<void, NormalizedFailure> {
  if (typeof citation !== "object" || citation === null) {
    return invalidRequest(`${context}: citation must be an object`);
  }
  if (citation.quotedText !== undefined && typeof citation.quotedText !== "string") {
    return invalidRequest(`${context}: citation quotedText must be a string if present`);
  }
  const source = citation.source;
  if (typeof source !== "object" || source === null) {
    return invalidRequest(`${context}: citation source must be an object`);
  }
  if (source.type === "url") {
    if (!validateHttpsUrl(source.url)) {
      return invalidRequest(`${context}: citation URL source must be an absolute HTTPS URL`);
    }
    if (source.title !== undefined && typeof source.title !== "string") {
      return invalidRequest(`${context}: citation title must be a string if present`);
    }
    return ok(undefined);
  }
  if (source.type === "gateway_file") {
    if (typeof source.fileId !== "string" || source.fileId.trim() === "") {
      return invalidRequest(`${context}: citation gateway_file must have non-empty fileId`);
    }
    if (source.name !== undefined && typeof source.name !== "string") {
      return invalidRequest(`${context}: citation name must be a string if present`);
    }
    return ok(undefined);
  }
  if (source.type === "input_document") {
    if (typeof source.documentId !== "string" || source.documentId.trim() === "") {
      return invalidRequest(`${context}: citation input_document must have non-empty documentId`);
    }
    if (source.name !== undefined && typeof source.name !== "string") {
      return invalidRequest(`${context}: citation name must be a string if present`);
    }
    return ok(undefined);
  }
  return invalidRequest(`${context}: unknown citation source type`);
}

function validateAssistantPart(part: IrAssistantPart, index: number): Result<void, NormalizedFailure> {
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return invalidRequest(`assistant part [${index}]: text must be a string`);
    }
    if (part.citations !== undefined) {
      if (!Array.isArray(part.citations)) {
        return invalidRequest(`assistant part [${index}] (text): citations must be an array`);
      }
      for (let cIdx = 0; cIdx < part.citations.length; cIdx++) {
        const cit = part.citations[cIdx];
        if (cit !== undefined) {
          const citRes = validateCitation(cit, `assistant part [${index}] citation [${cIdx}]`);
          if (!citRes.ok) return citRes;
        }
      }
    }
    return ok(undefined);
  }
  if (part.type === "refusal") {
    if (part.text !== undefined && typeof part.text !== "string") {
      return invalidRequest(`assistant part [${index}] (refusal): text must be a string if present`);
    }
    return ok(undefined);
  }
  return invalidRequest(`assistant part [${index}]: unknown assistant part type`);
}

function validateItem(
  item: IrItem,
  index: number,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  if (item.type === "instruction") {
    if (item.authority !== "system" && item.authority !== "developer") {
      return invalidRequest(`item [${index}] (instruction): authority must be system or developer`);
    }
    if (item.separation !== "advisory" && item.separation !== "required") {
      return invalidRequest(`item [${index}] (instruction): separation must be advisory or required`);
    }
    if (typeof item.text !== "string") {
      return invalidRequest(`item [${index}] (instruction): text must be a string`);
    }
    return ok(undefined);
  }

  if (item.type === "message") {
    if (item.role === "user") {
      if (!Array.isArray(item.content)) {
        return invalidRequest(`item [${index}] (user message): content must be an array`);
      }
      if (item.content.length === 0) {
        const hasMatchingRef = requestWireOptions?.providerFileRefs?.some((ref) => ref.itemIndex === index);
        if (!hasMatchingRef) {
          return invalidRequest(`item [${index}] (user message): content must be a non-empty array`);
        }
      }
      for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
        const part = item.content[pIdx];
        if (part !== undefined) {
          const partResult = validateInputPart(part, pIdx);
          if (!partResult.ok) return partResult;
        }
      }
      return ok(undefined);
    }

    if (item.role === "assistant") {
      if (!Array.isArray(item.content) || item.content.length === 0) {
        return invalidRequest(`item [${index}] (assistant message): content must be a non-empty array`);
      }
      for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
        const part = item.content[pIdx];
        if (part !== undefined) {
          const partResult = validateAssistantPart(part, pIdx);
          if (!partResult.ok) return partResult;
        }
      }
      return ok(undefined);
    }

    return invalidRequest(`item [${index}] (message): invalid role`);
  }

  if (item.type === "tool_call") {
    const call = item.call;
    if (
      !call ||
      typeof call.callId !== "string" ||
      call.callId.trim() === "" ||
      typeof call.name !== "string" ||
      call.name.trim() === ""
    ) {
      return invalidRequest(`item [${index}] (tool_call): callId and name must be non-empty strings`);
    }
    if (call.type === "custom") {
      if (typeof call.inputText !== "string") {
        return invalidRequest(`item [${index}] (tool_call): custom inputText must be a string`);
      }
      return ok(undefined);
    }
    return validateFunctionCallArguments(call, `item [${index}] (tool_call)`);
  }

  if (item.type === "tool_result") {
    if (
      typeof item.callId !== "string" ||
      item.callId.trim() === "" ||
      typeof item.isError !== "boolean" ||
      !Array.isArray(item.content)
    ) {
      return invalidRequest(
        `item [${index}] (tool_result): callId must be a non-empty string, isError a boolean, and content an array`,
      );
    }
    for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
      const part = item.content[pIdx];
      if (part !== undefined) {
        const partResult = validateInputPart(part, pIdx);
        if (!partResult.ok) return partResult;
      }
    }
    return ok(undefined);
  }

  return invalidRequest(`item [${index}]: unknown item type`);
}

/**
 * Validates tool definitions: names must be non-empty and unique, function
 * tools must carry a JSON object schema, and custom tool formats must be text
 * or a grammar with a recognized syntax and non-empty definition.
 */
function validateTools(tools: readonly IrTool[]): Result<void, NormalizedFailure> {
  const seenNames = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (tool === undefined) continue;
    if (typeof tool.name !== "string" || tool.name.trim() === "") {
      return invalidRequest(`tools[${i}]: name must be a non-empty string`);
    }
    if (seenNames.has(tool.name)) {
      return invalidRequest(`tools contains duplicate tool name '${tool.name}'`);
    }
    seenNames.add(tool.name);
    if (tool.type === "function") {
      if (!isPlainObject(tool.inputSchema)) {
        return invalidRequest(`tools[${i}] (${tool.name}): inputSchema must be a JSON object`);
      }
      continue;
    }
    const format = tool.format;
    if (format.type === "text") continue;
    const context = `tools[${i}] (${tool.name})`;
    if (format.syntax === undefined) {
      return invalidRequest(`${context}: grammar syntax is required`);
    }
    if (typeof format.syntax !== "string" || !GRAMMAR_SYNTAX_LITERALS.has(format.syntax)) {
      return invalidRequest(`syntax must be one of: ${GRAMMAR_SYNTAX_VALUES.join("|")}`);
    }
    if (typeof format.definition !== "string" || format.definition === "") {
      return invalidRequest(`${context}: grammar definition must be a non-empty string`);
    }
  }
  return ok(undefined);
}

/**
 * Validates tool choice against the tool list: `required` and `named` require
 * at least one tool definition, and `named` must name a declared tool (tool
 * names are unique, so "declared" and "exactly one" are the same condition).
 */
function validateToolChoice(
  toolChoice: IrToolChoice,
  tools: readonly IrTool[] | undefined,
): Result<void, NormalizedFailure> {
  if (toolChoice.type === "required" || toolChoice.type === "named") {
    if (tools === undefined || tools.length === 0) {
      return invalidRequest(`toolChoice '${toolChoice.type}' requires at least one tool definition`);
    }
  }
  if (toolChoice.type === "named") {
    if (!tools?.some((tool) => tool.name === toolChoice.name)) {
      return invalidRequest(`toolChoice names unknown tool '${toolChoice.name}'`);
    }
  }
  return ok(undefined);
}

/**
 * Validates tool transcript correlation in one ordered pass: every tool result
 * must reference a preceding call exactly once, and call IDs are unique across
 * function and custom calls alike.
 */
function validateToolTranscript(items: readonly IrItem[]): Result<void, NormalizedFailure> {
  const declaredCallIds = new Set<string>();
  const resultedCallIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.type === "tool_call") {
      if (declaredCallIds.has(item.call.callId)) {
        return invalidRequest(`item [${i}] (tool_call): duplicate callId '${item.call.callId}'`);
      }
      declaredCallIds.add(item.call.callId);
      continue;
    }
    if (item.type === "tool_result") {
      if (!declaredCallIds.has(item.callId)) {
        return invalidRequest(`item [${i}] (tool_result): references undeclared callId '${item.callId}'`);
      }
      if (resultedCallIds.has(item.callId)) {
        return invalidRequest(`item [${i}] (tool_result): duplicate result for callId '${item.callId}'`);
      }
      resultedCallIds.add(item.callId);
    }
  }
  return ok(undefined);
}

/**
 * Validates invariant properties of an {@link IrRequest}.
 *
 * Enforces normative request invariants:
 * - Items must be non-empty.
 * - At least one user or assistant message must be present (instruction-only is rejected).
 * - Source order and content parts must satisfy semantic constraints.
 * - Tool definitions, tool choice, and tool call/result correlation must be well-formed.
 * - Delivery mode must be either "complete" or "stream".
 */
export function validateIrRequest(
  req: IrRequest,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  if (typeof req.model !== "string" || req.model.trim() === "") {
    return invalidRequest("IrRequest.model must be a non-empty string");
  }

  if (req.delivery !== "complete" && req.delivery !== "stream") {
    return invalidRequest("IrRequest.delivery must be 'complete' or 'stream'");
  }

  const generationResult = validateGenerationControls(req.generation);
  if (!generationResult.ok) return generationResult;

  if (!Array.isArray(req.items) || req.items.length === 0) {
    return invalidRequest("IrRequest.items must be a non-empty array");
  }

  let hasMessage = false;
  for (let i = 0; i < req.items.length; i++) {
    const item = req.items[i];
    if (item === undefined) continue;
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      hasMessage = true;
    }
    const itemResult = validateItem(item, i, requestWireOptions);
    if (!itemResult.ok) return itemResult;
  }

  if (!hasMessage) {
    return invalidRequest("IrRequest must contain at least one user or assistant message turn");
  }

  if (req.tools !== undefined) {
    const toolsResult = validateTools(req.tools);
    if (!toolsResult.ok) return toolsResult;
  }

  // The sidecar subset is projected independently at egress, so every entry
  // must refer to a tool declared on the canonical request surface.
  const subsetTools = requestWireOptions?.allowedToolSubset?.tools;
  if (subsetTools !== undefined) {
    const subsetResult = validateTools(subsetTools);
    if (!subsetResult.ok) return subsetResult;

    const declaredToolNames = new Set<string>();
    for (const tool of req.tools ?? []) {
      if (tool !== undefined) declaredToolNames.add(tool.name);
    }
    for (let i = 0; i < subsetTools.length; i++) {
      const tool = subsetTools[i];
      if (tool !== undefined && !declaredToolNames.has(tool.name)) {
        return invalidRequest(`allowedToolSubset.tools[${i}] references undeclared tool '${tool.name}'`);
      }
    }
  }

  if (req.toolChoice !== undefined) {
    const choiceResult = validateToolChoice(req.toolChoice, req.tools);
    if (!choiceResult.ok) return choiceResult;
  }

  const outputResult = validateOutputFormat(req.output, requestWireOptions);
  if (!outputResult.ok) return outputResult;

  const transcriptResult = validateToolTranscript(req.items);
  if (!transcriptResult.ok) return transcriptResult;

  return ok(undefined);
}

function validateOutputPart(part: IrOutputPart, index: number): Result<void, NormalizedFailure> {
  if (typeof part.partId !== "string" || part.partId.trim() === "") {
    return invalidRequest(`output part [${index}]: partId must be a non-empty string`);
  }

  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return invalidRequest(`output part [${index}] (text): text must be a string`);
    }
    if (part.citations !== undefined) {
      if (!Array.isArray(part.citations)) {
        return invalidRequest(`output part [${index}] (text): citations must be an array`);
      }
      for (let cIdx = 0; cIdx < part.citations.length; cIdx++) {
        const cit = part.citations[cIdx];
        if (cit !== undefined) {
          const citRes = validateCitation(cit, `output part [${index}] citation [${cIdx}]`);
          if (!citRes.ok) return citRes;
        }
      }
    }
    return ok(undefined);
  }

  if (part.type === "refusal") {
    if (part.text !== undefined && typeof part.text !== "string") {
      return invalidRequest(`output part [${index}] (refusal): text must be a string if present`);
    }
    return ok(undefined);
  }

  if (part.type === "tool_call") {
    const call = part.call;
    if (
      !call ||
      typeof call.callId !== "string" ||
      call.callId.trim() === "" ||
      typeof call.name !== "string" ||
      call.name.trim() === ""
    ) {
      return invalidRequest(`output part [${index}] (tool_call): callId and name must be non-empty strings`);
    }
    if (call.type === "custom") {
      if (typeof call.inputText !== "string") {
        return invalidRequest(`output part [${index}] (tool_call): custom inputText must be a string`);
      }
      return ok(undefined);
    }
    return validateFunctionCallArguments(call, `output part [${index}] (tool_call)`);
  }

  return invalidRequest(`output part [${index}]: unknown output part type`);
}

export function validateUsage(usage: IrUsage): Result<void, NormalizedFailure> {
  if (!isNonNegativeSafeInteger(usage.input)) {
    return invalidRequest("IrUsage.input must be a non-negative safe integer");
  }
  if (!isNonNegativeSafeInteger(usage.output)) {
    return invalidRequest("IrUsage.output must be a non-negative safe integer");
  }
  if (usage.total !== undefined && !isNonNegativeSafeInteger(usage.total)) {
    return invalidRequest("IrUsage.total must be a non-negative safe integer if present");
  }
  if (usage.cacheReadInput !== undefined && !isNonNegativeSafeInteger(usage.cacheReadInput)) {
    return invalidRequest("IrUsage.cacheReadInput must be a non-negative safe integer if present");
  }
  if (usage.cacheWriteInput !== undefined && !isNonNegativeSafeInteger(usage.cacheWriteInput)) {
    return invalidRequest("IrUsage.cacheWriteInput must be a non-negative safe integer if present");
  }
  if (usage.reasoningOutput !== undefined && !isNonNegativeSafeInteger(usage.reasoningOutput)) {
    return invalidRequest("IrUsage.reasoningOutput must be a non-negative safe integer if present");
  }

  const cachedInputSum = (usage.cacheReadInput ?? 0) + (usage.cacheWriteInput ?? 0);
  if (usage.input < cachedInputSum) {
    return invalidRequest("IrUsage.input must be the canonical total and cannot be less than cached input");
  }

  if (usage.total !== undefined && usage.total < usage.input + usage.output) {
    return invalidRequest("IrUsage.total cannot be less than input + output tokens");
  }

  return ok(undefined);
}

/**
 * Validates invariant properties of an {@link IrOutcome}.
 *
 * Enforces normative outcome and accounting invariants:
 * - `responseId` and `model` must be non-empty strings.
 * - `parts` preserves semantic order and may be empty; part IDs must be unique.
 * - `finish.reason` must belong to the normative finish reason union.
 * - `usage` counters must be non-negative finite safe integers.
 */
export function validateIrOutcome(out: IrOutcome): Result<void, NormalizedFailure> {
  if (typeof out.responseId !== "string" || out.responseId.trim() === "") {
    return invalidRequest("IrOutcome.responseId must be a non-empty string");
  }

  if (typeof out.model !== "string" || out.model.trim() === "") {
    return invalidRequest("IrOutcome.model must be a non-empty string");
  }

  if (!Array.isArray(out.parts)) {
    return invalidRequest("IrOutcome.parts must be an array");
  }

  const seenPartIds = new Set<string>();
  const seenCallIds = new Set<string>();
  for (let i = 0; i < out.parts.length; i++) {
    const part = out.parts[i];
    if (part !== undefined) {
      const partResult = validateOutputPart(part, i);
      if (!partResult.ok) return partResult;
      if (seenPartIds.has(part.partId)) {
        return invalidRequest(`IrOutcome.parts contains duplicate partId '${part.partId}' at index [${i}]`);
      }
      seenPartIds.add(part.partId);
      if (part.type === "tool_call" && seenCallIds.has(part.call.callId)) {
        return invalidRequest(`IrOutcome.parts contains duplicate tool callId '${part.call.callId}' at index [${i}]`);
      }
      if (part.type === "tool_call") {
        seenCallIds.add(part.call.callId);
      }
    }
  }

  if (!out.finish || !FINISH_REASONS.has(out.finish.reason)) {
    return invalidRequest(`IrOutcome.finish.reason must be one of: ${[...FINISH_REASONS].join(", ")}`);
  }

  if (out.usage !== undefined) {
    const usageResult = validateUsage(out.usage);
    if (!usageResult.ok) return usageResult;
  }

  return ok(undefined);
}
