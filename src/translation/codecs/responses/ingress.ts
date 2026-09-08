import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  IngressDecoder,
  OutcomeDecodeResult,
  PromptCacheBreakpoint,
  ProviderFileRef,
  RequestDecodeResult,
} from "../../contracts.ts";
import {
  parseRetryAfterHeaderSeconds,
  truncateProviderErrorString,
  unsupportedCapabilityFailure,
} from "../../failures.ts";
import type {
  IrAssistantPart,
  IrCitation,
  IrFinishReason,
  IrGenerationControls,
  IrInputPart,
  IrItem,
  IrOutcome,
  IrOutputFormat,
  IrOutputPart,
  IrRequest,
  IrTool,
  IrToolCall,
  IrToolChoice,
  NonEmpty,
} from "../../ir.ts";
import type { MatrixRowId } from "../../matrix.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import {
  CHAT_TOOL_NAME_REGEX,
  firstUnknownKey,
  parseCustomCallInput,
  parseGrammarFields,
  parsePositiveSafeInteger,
  parseReasoningEffort,
  parseUnitIntervalControl,
  parseVerbosity,
} from "../shared/controls.ts";
import {
  parseFunctionArgumentsOnce,
  RESPONSES_HOSTED_OUTPUT_ITEMS,
  RESPONSES_HOSTED_TOOL_TYPES,
  responsesReasoningItemFailure,
} from "../shared/hosted-tools.ts";
import { inferExtensionMediaType, isBase64Valid, parseDataUri, validateHttpsUrl } from "../shared/media.ts";
import { parseToolArray, parseToolChoice, type ToolWireSpec } from "../shared/tool-parsing.ts";
import { parseResponsesUsage } from "../shared/usage.ts";
import { captureBreakpoint, captureOutcomeWireFacts, parseChatResponsesWireOptions } from "../shared/wire-options.ts";

const RECOGNIZED_RESPONSES_REQUEST_FIELDS = new Set([
  "model",
  "input",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "instructions",
  "previous_response_id",
  "conversation",
  "background",
  "tools",
  "tool_choice",
  "max_tool_calls",
  "include",
  "reasoning",
  "store",
  "metadata",
  "safety_identifier",
  "moderation",
  "service_tier",
  "truncation",
  "prompt_cache_key",
  "prompt_cache_options",
  "user",
  "context_management",
  "prompt",
  "top_logprobs",
  "audio",
  "modalities",
]);

const RESPONSES_ALLOWED_CALLERS: ReadonlySet<string> = new Set(["direct", "programmatic"]);

/**
 * Resolves the owning matrix row for a hosted/provider Responses item:
 * `web_search_call` refines on its action type, computer items refine on
 * their safety-check fields, and every other entry rejects on type alone.
 * Shared by replayed input items and output items.
 */
function responsesHostedItemCapability(itemObj: Record<string, unknown>): MatrixRowId | undefined {
  const type = itemObj.type;
  if (typeof type !== "string") return undefined;
  if (type === "web_search_call") {
    const action = itemObj.action;
    return typeof action === "object" && action !== null && (action as Record<string, unknown>).type === "open_page"
      ? "hosted-web-fetch"
      : "hosted-web-search";
  }
  if (type === "computer_call") {
    return Array.isArray(itemObj.pending_safety_checks) && itemObj.pending_safety_checks.length > 0
      ? "hosted-tool-safety-checks"
      : "hosted-computer-use";
  }
  if (type === "computer_call_output") {
    return Array.isArray(itemObj.acknowledged_safety_checks) && itemObj.acknowledged_safety_checks.length > 0
      ? "hosted-tool-safety-checks"
      : "hosted-computer-use";
  }
  return RESPONSES_HOSTED_OUTPUT_ITEMS[type];
}

/** Parses the flat Responses custom-tool format. */
function parseResponsesCustomFormat(
  value: unknown,
  context: string,
): Result<Extract<IrTool, { type: "custom" }>["format"], NormalizedFailure> {
  if (value === undefined) return ok({ type: "text" });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest(`${context}: format must be an object`);
  }
  const format = value as Record<string, unknown>;
  if (format.type === "text") return ok({ type: "text" });
  if (format.type !== "grammar") {
    return invalidRequest(`${context}: format type must be 'text' or 'grammar'`);
  }
  const grammarResult = parseGrammarFields(format.syntax, format.definition, context);
  if (!grammarResult.ok) return grammarResult;
  return ok({ type: "grammar", ...grammarResult.value });
}

function rejectResponsesToolNative(raw: Record<string, unknown>): NormalizedFailure | undefined {
  if (raw.vector_store_ids !== undefined) return unsupportedCapabilityFailure("provider-vector-store");
  if (typeof raw.type === "string") {
    const hostedCapability = RESPONSES_HOSTED_TOOL_TYPES[raw.type];
    if (hostedCapability !== undefined) return unsupportedCapabilityFailure(hostedCapability);
  }
  if (raw.output_schema !== undefined) return unsupportedCapabilityFailure("tool-output-schema");
  if (raw.defer_loading !== undefined) return unsupportedCapabilityFailure("deferred-tools");
  return undefined;
}

const RESPONSES_TOOL_SPEC: ToolWireSpec = {
  shape: "flat",
  schemaField: "parameters",
  requireObjectSchemaType: false,
  strictRequired: true,
  requireType: true,
  missingSchema: "invalid",
  allowCallers: true,
  documentedCallers: RESPONSES_ALLOWED_CALLERS,
  parseCustomFormat: parseResponsesCustomFormat,
  rejectNative: rejectResponsesToolNative,
};

/**
 * Parses the shared content rules for `function_call_output` and
 * `custom_tool_call_output` payloads: a string is one text part; array
 * elements admit text blocks and fail closed on images, uploaded files, and
 * inline documents.
 */
function parseResponsesToolOutputPayload(value: unknown, context: string): Result<IrInputPart[], NormalizedFailure> {
  if (typeof value === "string") {
    return ok([{ type: "text", text: value }]);
  }
  if (!Array.isArray(value)) {
    return invalidRequest(`${context}: output must be a string or an array`);
  }
  const parts: IrInputPart[] = [];
  for (let pIdx = 0; pIdx < value.length; pIdx++) {
    const p = value[pIdx] as Record<string, unknown>;
    if ((p?.type === "text" || p?.type === "input_text") && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p?.type === "image" || p?.type === "input_image") {
      const res = parseResponsesImagePart(p, `${context} part [${pIdx}] (image)`);
      if (!res.ok) return res;
      if (res.value.kind === "ref") {
        return unsupportedCapability("provider-image-id");
      }
      parts.push(res.value.part);
    } else if (p?.type === "file" || p?.type === "input_file") {
      if (p.file_id !== undefined) {
        return unsupportedCapability("provider-uploaded-file");
      }
      const res = parseResponsesFilePart(p, `${context} part [${pIdx}] (file)`);
      if (!res.ok) return res;
      if (res.value.kind === "ref") {
        return unsupportedCapability("provider-uploaded-file");
      }
      parts.push(res.value.part);
    } else {
      return unsupportedCapability("unknown-content-item");
    }
  }
  return ok(parts);
}

type ResponsesImageParseResult =
  | { readonly kind: "part"; readonly part: IrInputPart }
  | { readonly kind: "ref"; readonly fileId: string; readonly detail?: "auto" | "low" | "high" };

function parseResponsesImagePart(
  p: Record<string, unknown>,
  context: string,
): Result<ResponsesImageParseResult, NormalizedFailure> {
  const hasUrl = p.image_url !== undefined;
  const hasId = p.file_id !== undefined;
  if ((hasUrl && hasId) || (!hasUrl && !hasId)) {
    return invalidRequest(`${context}: exactly one of image_url or file_id must be provided`);
  }
  let detail: "auto" | "low" | "high" | undefined;
  if (p.detail === "original") {
    return unsupportedCapability("image-detail-original");
  }
  if (p.detail !== undefined) {
    if (p.detail !== "auto" && p.detail !== "low" && p.detail !== "high") {
      return invalidRequest(`${context}: detail must be 'auto', 'low', or 'high'`);
    }
    detail = p.detail;
  }
  if (hasId) {
    if (typeof p.file_id !== "string" || p.file_id.trim() === "") {
      return invalidRequest(`${context}: file_id must be a non-empty string`);
    }
    return ok({ kind: "ref", fileId: p.file_id, ...(detail !== undefined ? { detail } : {}) });
  }
  if (typeof p.image_url !== "string") {
    return invalidRequest(`${context}: image_url must be a string`);
  }
  if (p.image_url.startsWith("data:")) {
    const parsed = parseDataUri(p.image_url);
    if (!parsed?.mediaType.startsWith("image/")) {
      return invalidRequest(`${context}: invalid image data URI`);
    }
    return ok({
      kind: "part",
      part: {
        type: "image",
        source: { type: "bytes", mediaType: parsed.mediaType, base64: parsed.base64 },
        ...(detail !== undefined ? { detail } : {}),
      },
    });
  }
  if (!validateHttpsUrl(p.image_url)) {
    return invalidRequest(`${context}: image_url must be an absolute HTTPS URL`);
  }
  return ok({
    kind: "part",
    part: {
      type: "image",
      source: { type: "url", url: p.image_url },
      ...(detail !== undefined ? { detail } : {}),
    },
  });
}

type ResponsesFileParseResult =
  | { readonly kind: "part"; readonly part: IrInputPart }
  | { readonly kind: "ref"; readonly fileId: string; readonly filename?: string };

function parseResponsesFilePart(
  p: Record<string, unknown>,
  context: string,
): Result<ResponsesFileParseResult, NormalizedFailure> {
  const count =
    (p.file_data !== undefined ? 1 : 0) + (p.file_url !== undefined ? 1 : 0) + (p.file_id !== undefined ? 1 : 0);
  if (count !== 1) {
    return invalidRequest(`${context}: exactly one of file_data, file_url, or file_id must be provided`);
  }
  const filename = typeof p.filename === "string" ? p.filename : undefined;
  if (p.file_id !== undefined) {
    if (typeof p.file_id !== "string" || p.file_id.trim() === "") {
      return invalidRequest(`${context}: file_id must be a non-empty string`);
    }
    return ok({ kind: "ref", fileId: p.file_id, ...(filename !== undefined ? { filename } : {}) });
  }
  if (p.file_url !== undefined) {
    if (typeof p.file_url !== "string" || !validateHttpsUrl(p.file_url)) {
      return invalidRequest(`${context}: file_url must be an absolute HTTPS URL`);
    }
    return ok({
      kind: "part",
      part: {
        type: "document",
        documentId: randomUUID(),
        source: { type: "url", url: p.file_url },
        ...(filename !== undefined ? { name: filename } : {}),
      },
    });
  }
  if (typeof p.file_data !== "string" || p.file_data.trim() === "") {
    return invalidRequest(`${context}: file_data must be a non-empty base64 string`);
  }
  const inferred = inferExtensionMediaType(filename);
  if (inferred?.kind === "text") {
    // A text document source is UTF-8 text/plain by IR definition, so a payload
    // that is not valid base64 or not valid UTF-8 cannot be represented
    // faithfully. Node's base64 decoder skips illegal characters and a lenient
    // UTF-8 decode emits U+FFFD, so both are checked explicitly instead of
    // dispatching garbled text.
    if (!isBase64Valid(p.file_data)) {
      return invalidRequest(`${context}: file_data must be valid base64`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(p.file_data, "base64"));
    } catch {
      return invalidRequest(`${context}: file_data must decode to UTF-8 text`);
    }
    return ok({
      kind: "part",
      part: {
        type: "document",
        documentId: randomUUID(),
        source: { type: "text", mediaType: "text/plain", text },
        ...(filename !== undefined ? { name: filename } : {}),
      },
    });
  }
  return ok({
    kind: "part",
    part: {
      type: "document",
      documentId: randomUUID(),
      source: {
        type: "bytes",
        mediaType: inferred?.mediaType ?? "application/octet-stream",
        base64: p.file_data,
      },
      ...(filename !== undefined ? { name: filename } : {}),
    },
  });
}

/**
 * Parses one Responses output-text annotation into an IR citation. This is the
 * single authority for annotation citation semantics, shared by the
 * complete-outcome decoder and the stream decoder so the two paths cannot
 * drift: only a `url_citation` carrying a `url` yields a citation; every other
 * annotation fails closed with its owning capability row and never silently
 * drops provider-supplied citation content.
 *
 * Callers reject `container_file_citation` before calling: it is the
 * provider-container row's cited-file surface (research R:193) and fails with
 * `provider-container` regardless of surrounding decoder state.
 */
export function parseResponsesAnnotation(annot: Record<string, unknown>): Result<IrCitation, NormalizedFailure> {
  if (annot.type === "url_citation") {
    if (typeof annot.url !== "string") {
      return unsupportedCapability("url-citation-source");
    }
    return ok({
      source: {
        type: "url",
        url: annot.url,
        ...(typeof annot.title === "string" ? { title: annot.title } : {}),
      },
    });
  }
  if (annot.type === "file_citation" && typeof annot.file_id === "string") {
    // Provider file citations cannot resolve to gateway files and cannot be
    // translated without locator reconstruction.
    return unsupportedCapability("file-document-citation-source");
  }
  // A url-less `url_citation`, a `file_citation` without `file_id`, and any
  // unrecognized annotation type all belong to the url-citation rows.
  return unsupportedCapability("url-citation-source");
}

/**
 * Validates the two fields every Responses tool-call item carries. Shared by
 * replayed request items and outcome output items so the two decode paths
 * cannot drift.
 */
function parseResponsesCallIdentity(
  itemObj: Record<string, unknown>,
  context: string,
): Result<{ readonly callId: string; readonly name: string }, NormalizedFailure> {
  if (typeof itemObj.call_id !== "string" || itemObj.call_id.trim() === "") {
    return invalidRequest(`${context}: call_id must be a non-empty string`);
  }
  if (typeof itemObj.name !== "string" || itemObj.name.trim() === "") {
    return invalidRequest(`${context}: name must be a non-empty string`);
  }
  return ok({ callId: itemObj.call_id, name: itemObj.name });
}

/** Parses a Responses `function_call` item (request replay or outcome output). */
function parseResponsesFunctionCall(
  itemObj: Record<string, unknown>,
  context: string,
): Result<IrToolCall, NormalizedFailure> {
  const identityResult = parseResponsesCallIdentity(itemObj, context);
  if (!identityResult.ok) return identityResult;
  if (typeof itemObj.arguments !== "string") {
    return invalidRequest(`${context}: arguments must be a string`);
  }
  if (itemObj.namespace !== undefined) {
    return unsupportedCapability("tool-namespaces");
  }
  if (itemObj.caller !== undefined) {
    return unsupportedCapability("programmatic-tools");
  }
  if (itemObj.status !== undefined && itemObj.status !== "completed") {
    return invalidRequest(`${context}: status must be 'completed' when present`);
  }
  const parsedArguments = parseFunctionArgumentsOnce(itemObj.arguments);
  return ok({
    type: "function",
    ...identityResult.value,
    argumentsText: itemObj.arguments,
    ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
  });
}

/** Parses a Responses `custom_tool_call` item (request replay or outcome output). */
function parseResponsesCustomCall(
  itemObj: Record<string, unknown>,
  context: string,
): Result<IrToolCall, NormalizedFailure> {
  const identityResult = parseResponsesCallIdentity(itemObj, context);
  if (!identityResult.ok) return identityResult;
  const inputResult = parseCustomCallInput(itemObj.input, context);
  if (!inputResult.ok) return inputResult;
  if (itemObj.status !== undefined && itemObj.status !== "completed") {
    return invalidRequest(`${context}: status must be 'completed' when present`);
  }
  return ok({ type: "custom", ...identityResult.value, inputText: inputResult.value });
}

/**
 * Parses the `reasoning` request object: `effort` is the only admitted
 * sub-field (common five-literal set); summary controls, style/context modes,
 * and unrecognized sub-fields fail closed with their exact matrix capability
 * IDs instead of a blanket rejection. Shared by the complete and stream
 * request decoders.
 */
function parseResponsesReasoning(
  value: unknown,
): Result<"low" | "medium" | "high" | "xhigh" | "max" | undefined, NormalizedFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("reasoning must be an object when present");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === "effort") continue;
    if (key === "summary" || key === "generate_summary") {
      // `generate_summary` is the deprecated boolean spelling of the same
      // summary control and is owned by the same row.
      return unsupportedCapability("responses-reasoning-summary");
    }
    if (key === "context" || key === "mode") {
      return unsupportedCapability("reasoning-style-context-mode");
    }
    return invalidRequest(`reasoning.${key} is not recognized`);
  }
  return parseReasoningEffort(raw.effort);
}

/**
 * Parses a Responses request body shared verbatim by the complete ingress
 * decoder and the streaming request decoder.
 */
export function parseResponsesRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return invalidRequest("Responses request missing required string property 'model'");
  }

  if (body.input === undefined || body.input === null) {
    return invalidRequest("Responses request missing required property 'input'");
  }

  // Decoder-level capability rejections for recognized native-only facts.
  if (body.prompt_cache_retention !== undefined) {
    return unsupportedCapability("openai-prompt-cache-retention");
  }
  if (body.multi_agent !== undefined || body.agents !== undefined) {
    return unsupportedCapability("responses-preview-multi-agent");
  }
  if (body.previous_response_id !== undefined) {
    return unsupportedCapability("responses-previous-id");
  }
  if (body.conversation !== undefined) {
    return unsupportedCapability("responses-conversation");
  }
  if (body.background !== undefined) {
    return unsupportedCapability("responses-background");
  }
  if (body.context_management !== undefined) {
    return unsupportedCapability("responses-compaction");
  }
  if (body.prompt !== undefined) {
    return unsupportedCapability("responses-reusable-prompt");
  }
  if (body.top_logprobs !== undefined) {
    return unsupportedCapability("token-logprobs");
  }
  if (body.max_tool_calls !== undefined) {
    return unsupportedCapability("responses-max-tool-calls");
  }
  if (body.include !== undefined) {
    return unsupportedCapability("responses-include");
  }
  if (body.truncation !== undefined) {
    return unsupportedCapability("truncation-policy");
  }
  if (body.audio !== undefined || body.modalities !== undefined) {
    // Audio is T3 native-only across all directions; fail closed with exact
    // capability attribution matching Chat ingress.
    if (body.stream === true) {
      return unsupportedCapability("audio-streaming");
    }
    return unsupportedCapability("audio-output");
  }

  let output: IrOutputFormat | undefined;
  let legacyJsonObject: boolean | undefined;
  const textConfig = body.text as Record<string, unknown> | undefined;
  if (textConfig !== undefined) {
    if (typeof textConfig !== "object" || textConfig === null || Array.isArray(textConfig)) {
      return invalidRequest("text must be an object when present");
    }
    const extra = firstUnknownKey(textConfig, ["format", "verbosity"]);
    if (extra !== undefined) return invalidRequest(`text.${extra} is not recognized`);
    if (textConfig.format !== undefined) {
      const format = textConfig.format;
      if (typeof format !== "object" || format === null || Array.isArray(format)) {
        return invalidRequest("text.format must be an object");
      }
      const fmtObj = format as Record<string, unknown>;
      const type = fmtObj.type;
      if (type === "text") {
        const fmtExtra = firstUnknownKey(fmtObj, ["type"]);
        if (fmtExtra !== undefined) return invalidRequest(`text.format.${fmtExtra} is not recognized`);
        output = { type: "text" };
      } else if (type === "json_object") {
        const fmtExtra = firstUnknownKey(fmtObj, ["type"]);
        if (fmtExtra !== undefined) return invalidRequest(`text.format.${fmtExtra} is not recognized`);
        legacyJsonObject = true;
      } else if (type === "json_schema") {
        const fmtExtra = firstUnknownKey(fmtObj, ["type", "name", "schema", "description", "strict"]);
        if (fmtExtra !== undefined) return invalidRequest(`text.format.${fmtExtra} is not recognized`);
        const name = fmtObj.name;
        if (typeof name !== "string" || !CHAT_TOOL_NAME_REGEX.test(name)) {
          return invalidRequest(`text.format.name must match ${CHAT_TOOL_NAME_REGEX}`);
        }
        const schema = fmtObj.schema;
        if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
          return invalidRequest("text.format.schema must be an object");
        }
        let description: string | undefined;
        if (fmtObj.description !== undefined) {
          if (typeof fmtObj.description !== "string") {
            return invalidRequest("text.format.description must be a string");
          }
          description = fmtObj.description;
        }
        let strict: boolean | undefined;
        if (fmtObj.strict !== undefined) {
          if (typeof fmtObj.strict !== "boolean") {
            return invalidRequest("text.format.strict must be a boolean");
          }
          strict = fmtObj.strict;
        }
        output = {
          type: "json_schema",
          schema: schema as JsonObject,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(strict !== undefined ? { strict } : {}),
        };
      } else {
        return invalidRequest(`text.format.type '${String(type)}' is not recognized`);
      }
    }
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_RESPONSES_REQUEST_FIELDS.has(key)) {
      return unsupportedCapability("unknown-request-field");
    }
  }

  // ---- Wire-only sidecar capture (admitted fields, verbatim) ----
  const breakpoints: PromptCacheBreakpoint[] = [];
  const providerFileRefs: ProviderFileRef[] = [];
  const sidecarResult = parseChatResponsesWireOptions(body);
  if (!sidecarResult.ok) return sidecarResult;
  let wireOptions = sidecarResult.value;
  if (legacyJsonObject === true) {
    wireOptions = { ...wireOptions, legacyJsonObject: true };
  }

  // ---- Client tool surfaces (definitions, choice, parallelism) ----
  const toolsResult = parseToolArray(body.tools, "tools", RESPONSES_TOOL_SPEC);
  if (!toolsResult.ok) return toolsResult;
  const tools = toolsResult.value.tools;
  const directCallerNames = [...toolsResult.value.directCallerNames];

  let toolChoice: IrToolChoice | undefined;
  if (body.tool_choice !== undefined) {
    const choiceResult = parseToolChoice(body.tool_choice, "tool_choice", RESPONSES_TOOL_SPEC);
    if (!choiceResult.ok) return choiceResult;
    toolChoice = choiceResult.value.choice;
    directCallerNames.push(...choiceResult.value.directCallerNames);
    if (choiceResult.value.subset !== undefined) {
      wireOptions = { ...wireOptions, allowedToolSubset: choiceResult.value.subset };
    }
  }
  if (directCallerNames.length > 0) {
    wireOptions = { ...wireOptions, toolAllowedCallers: directCallerNames };
  }

  let parallelToolCalls: boolean | undefined;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") {
      return invalidRequest("parallel_tool_calls must be a boolean when present");
    }
    parallelToolCalls = body.parallel_tool_calls;
  }

  const items: IrItem[] = [];

  // Optional top-level instructions parameter
  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    items.push({
      type: "instruction",
      authority: "system",
      separation: "advisory",
      text: body.instructions,
    });
  }

  // Decode input
  if (typeof body.input === "string") {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "text", text: body.input }],
    });
  } else if (Array.isArray(body.input)) {
    if (body.input.length === 0 && items.length === 0) {
      return invalidRequest("Responses input array is empty");
    }

    for (let i = 0; i < body.input.length; i++) {
      const rawItem = body.input[i];
      if (typeof rawItem !== "object" || rawItem === null) {
        if (typeof rawItem === "string") {
          items.push({
            type: "message",
            role: "user",
            content: [{ type: "text", text: rawItem }],
          });
          continue;
        }
        return invalidRequest(`Responses input item [${i}] must be an object or string`);
      }

      const itemObj = rawItem as Record<string, unknown>;

      if (itemObj.type === "input_audio") {
        return unsupportedCapability("audio-input");
      }

      // A transcript-replay `reasoning` input item is provider-owned reasoning
      // state (readable text or encrypted content) and fails closed. The
      // reasoning-handle rows own the whole item including its status field,
      // so this re-ID must run before the generic phase/status check.
      if (itemObj.type === "reasoning") {
        return failure(responsesReasoningItemFailure(itemObj));
      }

      // Hosted/provider replayed items reject with their owning row before the
      // phase/status gate: replayed output items legitimately carry `status`,
      // so type recognition must run first.
      const hostedCapability = responsesHostedItemCapability(itemObj);
      if (hostedCapability !== undefined) {
        return unsupportedCapability(hostedCapability);
      }

      if (itemObj.previous_response_id !== undefined) {
        return unsupportedCapability("responses-previous-id");
      }
      if (itemObj.type === "item_reference") {
        return unsupportedCapability("responses-item-reference");
      }
      if (itemObj.type === "input_image") {
        const itemIndex = items.length;
        const res = parseResponsesImagePart(itemObj, `Responses input item [${i}] (input_image)`);
        if (!res.ok) return res;
        if (res.value.kind === "ref") {
          providerFileRefs.push({
            itemIndex,
            partIndex: 0,
            mediaKind: "image",
            fileId: res.value.fileId,
            ...(res.value.detail !== undefined ? { detail: res.value.detail } : {}),
          });
          items.push({ type: "message", role: "user", content: [] as unknown as NonEmpty<IrInputPart> });
        } else {
          items.push({ type: "message", role: "user", content: [res.value.part] as unknown as NonEmpty<IrInputPart> });
        }
        if (itemObj.prompt_cache_breakpoint !== undefined) {
          const markerResult = captureBreakpoint(`input item [${i}]`, itemObj.prompt_cache_breakpoint, itemIndex, 0);
          if (!markerResult.ok) return markerResult;
          breakpoints.push(markerResult.value);
        }
        continue;
      }
      if (itemObj.type === "input_file") {
        const itemIndex = items.length;
        const res = parseResponsesFilePart(itemObj, `Responses input item [${i}] (input_file)`);
        if (!res.ok) return res;
        if (res.value.kind === "ref") {
          providerFileRefs.push({
            itemIndex,
            partIndex: 0,
            mediaKind: "document",
            fileId: res.value.fileId,
            ...(res.value.filename !== undefined ? { filename: res.value.filename } : {}),
          });
          items.push({ type: "message", role: "user", content: [] as unknown as NonEmpty<IrInputPart> });
        } else {
          items.push({ type: "message", role: "user", content: [res.value.part] as unknown as NonEmpty<IrInputPart> });
        }
        if (itemObj.prompt_cache_breakpoint !== undefined) {
          const markerResult = captureBreakpoint(`input item [${i}]`, itemObj.prompt_cache_breakpoint, itemIndex, 0);
          if (!markerResult.ok) return markerResult;
          breakpoints.push(markerResult.value);
        }
        continue;
      }

      if (itemObj.type === "function_call") {
        const callResult = parseResponsesFunctionCall(itemObj, `Responses input item [${i}] (function_call)`);
        if (!callResult.ok) return callResult;
        items.push({ type: "tool_call", call: callResult.value });
        continue;
      }

      // The R custom-call item shapes are a documented inference (research
      // R:233 names the types without fields); they mirror the
      // function_call/function_call_output field pattern.
      if (itemObj.type === "custom_tool_call") {
        const callResult = parseResponsesCustomCall(itemObj, `Responses input item [${i}] (custom_tool_call)`);
        if (!callResult.ok) return callResult;
        items.push({ type: "tool_call", call: callResult.value });
        continue;
      }

      if (itemObj.type === "function_call_output" || itemObj.type === "custom_tool_call_output") {
        const context = `Responses input item [${i}] (${itemObj.type})`;
        if (typeof itemObj.call_id !== "string" || itemObj.call_id.trim() === "") {
          return invalidRequest(`${context}: call_id must be a non-empty string`);
        }
        const payloadResult = parseResponsesToolOutputPayload(itemObj.output, `${context} output`);
        if (!payloadResult.ok) return payloadResult;
        items.push({ type: "tool_result", callId: itemObj.call_id, isError: false, content: payloadResult.value });
        continue;
      }

      // Item index this input item's IR item will occupy.
      const itemIndex = items.length;

      const role = itemObj.role;

      // The phase/status replay gate applies to message items only; tool and
      // hosted items above carry their own documented status fields.
      const isMessageItem =
        itemObj.type === "message" ||
        role === "system" ||
        role === "developer" ||
        role === "user" ||
        role === "assistant";
      if (isMessageItem && (itemObj.phase !== undefined || itemObj.status !== undefined)) {
        return unsupportedCapability("responses-message-phase");
      }

      if (role === "system" || role === "developer") {
        let text = "";
        if (typeof itemObj.content === "string") {
          text = itemObj.content;
        } else if (Array.isArray(itemObj.content)) {
          for (const part of itemObj.content) {
            const p = part as Record<string, unknown>;
            if (p?.type === "input_text" && typeof p.text === "string") {
              text += p.text;
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(`input item [${i}] part`, p.prompt_cache_breakpoint, itemIndex);
                if (!markerResult.ok) return markerResult;
                breakpoints.push(markerResult.value);
              }
            }
          }
        }
        items.push({
          type: "instruction",
          authority: role,
          separation: "advisory",
          text,
        });
        continue;
      }

      if (role === "user" || (itemObj.type === "message" && (role === undefined || role === "user"))) {
        const parts: IrInputPart[] = [];
        if (typeof itemObj.content === "string") {
          parts.push({ type: "text", text: itemObj.content });
        } else if (Array.isArray(itemObj.content)) {
          for (let pIdx = 0; pIdx < itemObj.content.length; pIdx++) {
            const p = itemObj.content[pIdx] as Record<string, unknown>;
            if (p?.type === "input_text" && typeof p.text === "string") {
              parts.push({ type: "text", text: p.text });
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(
                  `input item [${i}] part [${pIdx}]`,
                  p.prompt_cache_breakpoint,
                  itemIndex,
                  pIdx,
                );
                if (!markerResult.ok) return markerResult;
                breakpoints.push(markerResult.value);
              }
            } else if (p?.type === "input_image") {
              const res = parseResponsesImagePart(p, `input item [${i}] part [${pIdx}] (input_image)`);
              if (!res.ok) return res;
              if (res.value.kind === "ref") {
                providerFileRefs.push({
                  itemIndex,
                  partIndex: pIdx,
                  mediaKind: "image",
                  fileId: res.value.fileId,
                  ...(res.value.detail !== undefined ? { detail: res.value.detail } : {}),
                });
              } else {
                parts.push(res.value.part);
              }
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(
                  `input item [${i}] part [${pIdx}]`,
                  p.prompt_cache_breakpoint,
                  itemIndex,
                  pIdx,
                );
                if (!markerResult.ok) return markerResult;
                breakpoints.push(markerResult.value);
              }
            } else if (p?.type === "input_file") {
              const res = parseResponsesFilePart(p, `input item [${i}] part [${pIdx}] (input_file)`);
              if (!res.ok) return res;
              if (res.value.kind === "ref") {
                providerFileRefs.push({
                  itemIndex,
                  partIndex: pIdx,
                  mediaKind: "document",
                  fileId: res.value.fileId,
                  ...(res.value.filename !== undefined ? { filename: res.value.filename } : {}),
                });
              } else {
                parts.push(res.value.part);
              }
              if (p.prompt_cache_breakpoint !== undefined) {
                const markerResult = captureBreakpoint(
                  `input item [${i}] part [${pIdx}]`,
                  p.prompt_cache_breakpoint,
                  itemIndex,
                  pIdx,
                );
                if (!markerResult.ok) return markerResult;
                breakpoints.push(markerResult.value);
              }
            } else if (p?.type === "input_audio") {
              return unsupportedCapability("audio-input");
            } else {
              return unsupportedCapability("unknown-content-item");
            }
          }
        }
        if (parts.length === 0) {
          const hasMatchingRef = providerFileRefs.some((r) => r.itemIndex === itemIndex);
          if (!hasMatchingRef) {
            return invalidRequest(`Responses input item [${i}] has empty content`);
          }
        }
        items.push({
          type: "message",
          role: "user",
          content: parts as unknown as NonEmpty<IrInputPart>,
        });
        continue;
      }

      if (role === "assistant") {
        const parts: IrAssistantPart[] = [];
        if (typeof itemObj.content === "string") {
          parts.push({ type: "text", text: itemObj.content });
        } else if (Array.isArray(itemObj.content)) {
          for (let pIdx = 0; pIdx < itemObj.content.length; pIdx++) {
            const p = itemObj.content[pIdx] as Record<string, unknown>;
            if (p?.type === "output_text" && typeof p.text === "string") {
              parts.push({ type: "text", text: p.text });
              // The R wire documents breakpoints only on input_text/input_image/
              // input_file blocks; the provider 400s a marker on output_text,
              // so the decode rejects the unsupported placement fail-closed.
              if (p.prompt_cache_breakpoint !== undefined) {
                return invalidRequest(
                  `input item [${i}] part [${pIdx}] prompt_cache_breakpoint is not supported on output_text blocks`,
                );
              }
            } else if (p?.type === "refusal") {
              return unsupportedCapability("refusal-content");
            } else {
              return unsupportedCapability("unknown-content-item");
            }
          }
        }
        if (parts.length === 0) {
          return invalidRequest(`Responses input item [${i}] has empty content`);
        }
        items.push({
          type: "message",
          role: "assistant",
          content: parts as unknown as NonEmpty<IrAssistantPart>,
        });
        continue;
      }

      return invalidRequest(`Responses input item [${i}] has unrecognized structure`);
    }
  } else {
    return invalidRequest("Responses input must be a string or array");
  }

  if (breakpoints.length > 0) {
    wireOptions = { ...wireOptions, promptCacheBreakpoints: breakpoints };
  }
  if (providerFileRefs.length > 0) {
    wireOptions = { ...wireOptions, providerFileRefs };
  }

  // ---- Generation controls (strict bounds; never clamped, never dropped) ----
  const temperatureResult = parseUnitIntervalControl("temperature", body.temperature, "temperature-0-1");
  if (!temperatureResult.ok) return temperatureResult;
  const topPResult = parseUnitIntervalControl("top_p", body.top_p, "top-p-0-1");
  if (!topPResult.ok) return topPResult;
  const maxTokensResult = parsePositiveSafeInteger("max_output_tokens", body.max_output_tokens);
  if (!maxTokensResult.ok) return maxTokensResult;
  const verbosityResult = parseVerbosity(textConfig?.verbosity);
  if (!verbosityResult.ok) return verbosityResult;
  const effortResult = parseResponsesReasoning(body.reasoning);
  if (!effortResult.ok) return effortResult;

  const generation: IrGenerationControls | undefined =
    temperatureResult.value !== undefined ||
    topPResult.value !== undefined ||
    maxTokensResult.value !== undefined ||
    verbosityResult.value !== undefined ||
    effortResult.value !== undefined
      ? {
          ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
          ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
          ...(maxTokensResult.value !== undefined ? { maxOutputTokens: maxTokensResult.value } : {}),
          ...(verbosityResult.value !== undefined ? { verbosity: verbosityResult.value } : {}),
          ...(effortResult.value !== undefined ? { reasoning: { effort: effortResult.value } } : {}),
        }
      : undefined;

  const irRequest: IrRequest = {
    model: body.model,
    delivery,
    items,
    ...(generation !== undefined ? { generation } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    ...(output !== undefined ? { output } : {}),
  };

  return ok({ irRequest, requestWireOptions: wireOptions });
}

/**
 * Ingress decoder for OpenAI Responses requests and responses.
 *
 * Request decoding delegates to {@link parseResponsesRequestBody}, which
 * projects admitted generation controls (including the `reasoning.effort`
 * sub-field) into the IR and captures matrix-admitted wire-only fields into
 * the request wire-options sidecar; native-only state and diagnostic facts
 * fail closed with their exact matrix capability ID.
 */
export class ResponsesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseResponsesRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(status: number, headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure> {
    if (typeof body !== "object" || body === null) {
      return invalidRequest("Responses response body must be an object");
    }

    const retryAfterSeconds = parseRetryAfterHeaderSeconds(headers["retry-after"]);

    if (body.status === "failed") {
      const err = (body.error ?? {}) as Record<string, unknown>;
      const rawMessage = typeof err.message === "string" ? err.message : "Responses provider returned failed status";
      const rawCode = typeof err.code === "string" ? err.code : undefined;
      return failure({
        category: "provider",
        message: truncateProviderErrorString(rawMessage),
        code: rawCode !== undefined ? truncateProviderErrorString(rawCode) : undefined,
        retryable: false,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    }

    if (status >= 400) {
      const err = (body.error ?? {}) as Record<string, unknown>;
      const rawMessage = typeof err.message === "string" ? err.message : `Responses provider error HTTP ${status}`;
      const rawCode = typeof err.code === "string" ? err.code : undefined;
      return failure({
        category: "provider",
        message: truncateProviderErrorString(rawMessage),
        code: rawCode !== undefined ? truncateProviderErrorString(rawCode) : undefined,
        retryable: false,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    }

    const parts: IrOutputPart[] = [];
    if (Array.isArray(body.output)) {
      for (const item of body.output) {
        const itemObj = item as Record<string, unknown>;
        // Provider-owned reasoning output items fail closed: readable reasoning
        // text or encrypted content is never translated or fabricated.
        if (itemObj?.type === "reasoning") {
          return failure(responsesReasoningItemFailure(itemObj));
        }
        if (itemObj?.type === "message" && Array.isArray(itemObj.content)) {
          for (const contentPart of itemObj.content) {
            const cp = contentPart as Record<string, unknown>;
            if (cp?.type === "output_text") {
              // `container_file_citation` is the provider-container row's
              // cited-file surface (research R:193); it never crosses
              // protocols and never silently drops. Other annotation types
              // belong to the citation rows.
              if (
                Array.isArray(cp.annotations) &&
                cp.annotations.some(
                  (a) => (a as Record<string, unknown> | undefined)?.type === "container_file_citation",
                )
              ) {
                return unsupportedCapability("provider-container");
              }
              if (typeof cp.text !== "string") {
                return invalidRequest("Responses output_text part: text must be a string");
              }
              const citations: IrCitation[] = [];
              if (Array.isArray(cp.annotations)) {
                for (const a of cp.annotations) {
                  const annot = a as Record<string, unknown> | undefined;
                  if (annot === null || typeof annot !== "object") {
                    return invalidRequest("Responses output_text part: annotations entries must be objects");
                  }
                  const parsed = parseResponsesAnnotation(annot as Record<string, unknown>);
                  if (!parsed.ok) return parsed;
                  citations.push(parsed.value);
                }
              }
              parts.push({
                type: "text",
                partId: randomUUID(),
                text: cp.text,
                ...(citations.length > 0 ? { citations } : {}),
              });
            } else if (cp?.type === "refusal") {
              // A refusal part with present-but-malformed text fabricates
              // nothing: non-string values fail closed, and a refusal part
              // carrying no text at all is malformed provider output.
              if (cp.refusal !== undefined && typeof cp.refusal !== "string") {
                return invalidRequest("Responses refusal part: refusal must be a string when present");
              }
              if (cp.text !== undefined && typeof cp.text !== "string") {
                return invalidRequest("Responses refusal part: text must be a string when present");
              }
              if (typeof cp.refusal !== "string" && typeof cp.text !== "string") {
                return invalidRequest("Responses refusal part: refusal or text must be a string");
              }
              const refusalText = typeof cp.refusal === "string" ? cp.refusal : (cp.text as string);
              parts.push({
                type: "refusal",
                partId: randomUUID(),
                text: refusalText,
              });
            } else {
              // Unknown inner content parts never vanish behind a success
              // terminator; parity with the stream decoder's rejection.
              return unsupportedCapability("unknown-content-item");
            }
          }
        } else if (itemObj?.type === "function_call" || itemObj?.type === "custom_tool_call") {
          const context = `Responses output ${itemObj.type}`;
          const callResult =
            itemObj.type === "function_call"
              ? parseResponsesFunctionCall(itemObj, context)
              : parseResponsesCustomCall(itemObj, context);
          if (!callResult.ok) return callResult;
          parts.push({ type: "tool_call", partId: randomUUID(), call: callResult.value });
        } else {
          const hostedOutCapability =
            typeof itemObj === "object" && itemObj !== null ? responsesHostedItemCapability(itemObj) : undefined;
          if (hostedOutCapability !== undefined) {
            return unsupportedCapability(hostedOutCapability);
          }
          if (itemObj?.type === "item_reference") {
            return unsupportedCapability("responses-item-reference");
          }
          // Unknown output items never vanish behind a success terminator;
          // parity with the stream decoder's unknown-item rejection.
          return unsupportedCapability("unknown-content-item");
        }
      }
    }

    let finishReason: IrFinishReason = "stop";
    if (body.status === "incomplete") {
      const details = (body.incomplete_details ?? {}) as Record<string, unknown>;
      if (details.reason === "max_output_tokens") {
        finishReason = "length";
      } else if (details.reason === "content_filter") {
        finishReason = "content_filter";
      } else {
        return unsupportedCapability("finish-other-unknown");
      }
    } else if (body.status === "completed") {
      finishReason = parts.some((part) => part.type === "refusal")
        ? "refusal"
        : parts.some((part) => part.type === "tool_call")
          ? "tool_calls"
          : "stop";
    } else {
      return unsupportedCapability("finish-other-unknown");
    }

    // Usage counters plus the cache/reasoning subdivisions; parsed once in
    // shared/usage.ts so the complete and stream paths cannot drift. Subdivisions are
    // observations and never re-added to totals.
    const usageResult = parseResponsesUsage(body.usage);
    if (!usageResult.ok) return usageResult;
    const usage = usageResult.value;

    // Response-side wire-only facts: the moderation result (stored in normal,
    // unwrapped form — Responses already carries singular verdicts) and the
    // effective service-tier echo.
    const factsResult = captureOutcomeWireFacts(body, {}, "Responses");
    if (!factsResult.ok) return factsResult;

    const outcome: IrOutcome = {
      responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      ...(usage !== undefined ? { usage } : {}),
    };

    return ok({ irOutcome: outcome, outcomeWireOptions: factsResult.value });
  }
}
