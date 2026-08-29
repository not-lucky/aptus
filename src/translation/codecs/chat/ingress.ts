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
import type {
  IrAssistantPart,
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
import { invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import {
  asNonEmptyStopSequences,
  CHAT_TOOL_NAME_REGEX,
  firstUnknownKey,
  parseCustomCallInput,
  parseGrammarFields,
  parsePositiveSafeInteger,
  parseReasoningEffort,
  parseStopSequenceEntries,
  parseUnitIntervalControl,
  parseVerbosity,
} from "../shared/controls.ts";
import { parseFunctionArgumentsOnce } from "../shared/hosted-tools.ts";
import { inferExtensionMediaType, parseDataUri, validateHttpsUrl } from "../shared/media.ts";
import { parseToolArray, parseToolChoice, type ToolWireSpec } from "../shared/tool-parsing.ts";
import { parseChatUsage } from "../shared/usage.ts";
import { captureBreakpoint, captureOutcomeWireFacts, parseChatResponsesWireOptions } from "../shared/wire-options.ts";

const RECOGNIZED_CHAT_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_completion_tokens",
  "max_tokens",
  "stop",
  "verbosity",
  "reasoning_effort",
  "parallel_tool_calls",
  "n",
  "store",
  "metadata",
  "user",
  "seed",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "frequency_penalty",
  "presence_penalty",
  "moderation",
  "service_tier",
  "safety_identifier",
  "prediction",
  "stream_options",
  "functions",
  "function_call",
  "tools",
  "tool_choice",
  "web_search_options",
  "response_format",
  "audio",
  "modalities",
  "prompt_cache_key",
  "prompt_cache_options",
]);

type IrCustomToolFormat = Extract<IrTool, { type: "custom" }>["format"];

/**
 * Parses the nested Chat custom-tool `format` field: absent means text,
 * `{type:"text"}` is the documented literal, and grammar formats nest their
 * definition under `grammar` (research C:140).
 */
function parseChatCustomFormat(value: unknown, context: string): Result<IrCustomToolFormat, NormalizedFailure> {
  if (value === undefined) return ok({ type: "text" });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest(`${context}: format must be an object`);
  }
  const format = value as Record<string, unknown>;
  if (format.type === "text") {
    return ok({ type: "text" });
  }
  if (format.type !== "grammar") {
    return invalidRequest(`${context}: format type must be 'text' or 'grammar'`);
  }
  const grammar = format.grammar;
  if (typeof grammar !== "object" || grammar === null || Array.isArray(grammar)) {
    return invalidRequest(`${context}: grammar object is required`);
  }
  const grammarObj = grammar as Record<string, unknown>;
  const grammarResult = parseGrammarFields(grammarObj.syntax, grammarObj.definition, context);
  if (!grammarResult.ok) return grammarResult;
  return ok({ type: "grammar" as const, ...grammarResult.value });
}

/** Shared spec for the nested Chat client-tool definition and choice shapes. */
const CHAT_TOOL_SPEC: ToolWireSpec = {
  shape: "nested",
  schemaField: "parameters",
  requireObjectSchemaType: false,
  strictRequired: false,
  missingSchema: "unsupported",
  allowCallers: false,
  documentedCallers: new Set(),
  validateFunctionName: (value, context) =>
    typeof value === "string" && CHAT_TOOL_NAME_REGEX.test(value)
      ? ok(value)
      : invalidRequest(`${context} name must match [a-zA-Z0-9_-]{1,64}`),
  parseCustomFormat: parseChatCustomFormat,
};

/**
 * Parses one Chat tool-call entry (`{id, type:"function"|"custom", ...}`),
 * shared by request assistant messages and response messages. Call IDs are
 * required and never fabricated.
 */
function parseChatToolCallEntry(entry: unknown, context: string): Result<IrToolCall, NormalizedFailure> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return invalidRequest(`${context} must be an object`);
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return invalidRequest(`${context}: id must be a non-empty string`);
  }
  if (raw.type === "function") {
    const fn = raw.function;
    if (typeof fn !== "object" || fn === null || Array.isArray(fn)) {
      return invalidRequest(`${context}: function object is required`);
    }
    const fnObj = fn as Record<string, unknown>;
    if (typeof fnObj.name !== "string" || fnObj.name.trim() === "") {
      return invalidRequest(`${context}: function name must be a non-empty string`);
    }
    if (typeof fnObj.arguments !== "string") {
      return invalidRequest(`${context}: function arguments must be a string`);
    }
    const parsedArguments = parseFunctionArgumentsOnce(fnObj.arguments);
    return ok({
      type: "function",
      callId: raw.id,
      name: fnObj.name,
      argumentsText: fnObj.arguments,
      ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
    });
  }
  if (raw.type === "custom") {
    const custom = raw.custom;
    if (typeof custom !== "object" || custom === null || Array.isArray(custom)) {
      return invalidRequest(`${context}: custom object is required`);
    }
    const customObj = custom as Record<string, unknown>;
    if (typeof customObj.name !== "string" || customObj.name.trim() === "") {
      return invalidRequest(`${context}: custom name must be a non-empty string`);
    }
    const inputResult = parseCustomCallInput(customObj.input, `${context}.custom`);
    if (!inputResult.ok) return inputResult;
    return ok({ type: "custom", callId: raw.id, name: customObj.name, inputText: inputResult.value });
  }
  return invalidRequest(`${context}: type must be 'function' or 'custom'`);
}

/**
 * Parses a Chat request body shared verbatim by the complete ingress decoder
 * and the streaming request decoder: capability rejections, sidecar capture,
 * transcript items, and generation controls are defined exactly once.
 */
export function parseChatRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return invalidRequest("Chat request missing required string property 'model'");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidRequest("Chat request missing required non-empty array property 'messages'");
  }

  // Decoder-level capability rejections for recognized non-admitted wire facts.
  // Admitted wire-only fields (store, metadata/user, moderation, service_tier,
  // safety_identifier, prompt-cache controls) are captured into the sidecar
  // below instead of rejected — the decoder has no direction, so it must not
  // decide T1 vs T2 vs T3.
  if (body.n !== undefined && body.n !== 1) {
    return unsupportedCapability("multiple-candidates");
  }
  if (body.seed !== undefined) {
    return unsupportedCapability("seed-determinism");
  }
  if (body.logit_bias !== undefined) {
    return unsupportedCapability("token-logit-bias");
  }
  if (body.logprobs !== undefined || body.top_logprobs !== undefined) {
    return unsupportedCapability("token-logprobs");
  }
  if (body.frequency_penalty !== undefined) {
    return unsupportedCapability("frequency-penalty");
  }
  if (body.presence_penalty !== undefined) {
    return unsupportedCapability("presence-penalty");
  }
  if (body.prediction !== undefined) {
    return unsupportedCapability("chat-predicted-outputs");
  }
  // Complete-path requests reject the stream usage carrier outright
  // (`stream-final-usage` row); the streaming request decoder parses
  // `stream_options.include_usage` instead.
  if (delivery === "complete" && body.stream_options !== undefined) {
    return unsupportedCapability("stream-final-usage");
  }
  if (body.functions !== undefined || body.function_call !== undefined) {
    return unsupportedCapability("chat-legacy-functions");
  }
  if (body.max_tokens !== undefined) {
    return unsupportedCapability("chat-legacy-max-tokens");
  }
  if (body.web_search_options !== undefined) {
    return unsupportedCapability("hosted-web-search");
  }

  let output: IrOutputFormat | undefined;
  let legacyJsonObject: boolean | undefined;
  if (body.response_format !== undefined) {
    const rf = body.response_format;
    if (typeof rf !== "object" || rf === null || Array.isArray(rf)) {
      return invalidRequest("response_format must be an object");
    }
    const rfObj = rf as Record<string, unknown>;
    const type = rfObj.type;
    if (type === "text") {
      const extra = firstUnknownKey(rfObj, ["type"]);
      if (extra !== undefined) return invalidRequest(`response_format.${extra} is not recognized`);
      output = { type: "text" };
    } else if (type === "json_object") {
      const extra = firstUnknownKey(rfObj, ["type"]);
      if (extra !== undefined) return invalidRequest(`response_format.${extra} is not recognized`);
      legacyJsonObject = true;
    } else if (type === "json_schema") {
      const extra = firstUnknownKey(rfObj, ["type", "json_schema"]);
      if (extra !== undefined) return invalidRequest(`response_format.${extra} is not recognized`);
      const jsonSchema = rfObj.json_schema;
      if (typeof jsonSchema !== "object" || jsonSchema === null || Array.isArray(jsonSchema)) {
        return invalidRequest("response_format.json_schema must be an object");
      }
      const jsObj = jsonSchema as Record<string, unknown>;
      const schemaExtra = firstUnknownKey(jsObj, ["name", "schema", "description", "strict"]);
      if (schemaExtra !== undefined)
        return invalidRequest(`response_format.json_schema.${schemaExtra} is not recognized`);
      const name = jsObj.name;
      if (typeof name !== "string" || !CHAT_TOOL_NAME_REGEX.test(name)) {
        return invalidRequest(`response_format.json_schema.name must match ${CHAT_TOOL_NAME_REGEX}`);
      }
      const schema = jsObj.schema;
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return invalidRequest("response_format.json_schema.schema must be an object");
      }
      let description: string | undefined;
      if (jsObj.description !== undefined) {
        if (typeof jsObj.description !== "string") {
          return invalidRequest("response_format.json_schema.description must be a string");
        }
        description = jsObj.description;
      }
      let strict: boolean | undefined;
      if (jsObj.strict !== undefined) {
        if (typeof jsObj.strict !== "boolean") {
          return invalidRequest("response_format.json_schema.strict must be a boolean");
        }
        strict = jsObj.strict;
      }
      output = {
        type: "json_schema",
        schema: schema as JsonObject,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(strict !== undefined ? { strict } : {}),
      };
    } else {
      return invalidRequest(`response_format.type '${String(type)}' is not recognized`);
    }
  }
  if (body.audio !== undefined || body.modalities !== undefined) {
    if (body.stream === true) {
      return unsupportedCapability("audio-streaming");
    }
    return unsupportedCapability("audio-output");
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_CHAT_REQUEST_FIELDS.has(key)) {
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
  const toolsResult = parseToolArray(body.tools, "tools", CHAT_TOOL_SPEC);
  if (!toolsResult.ok) return toolsResult;
  const tools = toolsResult.value.tools;

  let toolChoice: IrToolChoice | undefined;
  if (body.tool_choice !== undefined) {
    const choiceResult = parseToolChoice(body.tool_choice, "tool_choice", CHAT_TOOL_SPEC);
    if (!choiceResult.ok) return choiceResult;
    toolChoice = choiceResult.value.choice;
    if (choiceResult.value.subset !== undefined) {
      wireOptions = { ...wireOptions, allowedToolSubset: choiceResult.value.subset };
    }
  }

  let parallelToolCalls: boolean | undefined;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") {
      return invalidRequest("parallel_tool_calls must be a boolean when present");
    }
    parallelToolCalls = body.parallel_tool_calls;
  }

  // Decode messages
  const items: IrItem[] = [];
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (typeof msg !== "object" || msg === null) {
      return invalidRequest(`Chat message [${i}] must be an object`);
    }
    const rawMsg = msg as Record<string, unknown>;
    const role = rawMsg.role;

    if (rawMsg.name !== undefined && rawMsg.name !== null && String(rawMsg.name).trim() !== "") {
      return unsupportedCapability("message-name");
    }

    // Item index this message's IR item will occupy; breakpoint anchors on
    // its content parts refer to this position.
    const itemIndex = items.length;

    if (role === "system" || role === "developer") {
      let text = "";
      if (typeof rawMsg.content === "string") {
        text = rawMsg.content;
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const part = rawMsg.content[pIdx] as Record<string, unknown>;
          if (part?.type === "text" && typeof part.text === "string") {
            text += part.text;
            if (part.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                `message [${i}] part [${pIdx}]`,
                part.prompt_cache_breakpoint,
                itemIndex,
              );
              if (!markerResult.ok) return markerResult;
              breakpoints.push(markerResult.value);
            }
          } else {
            return unsupportedCapability("unknown-content-item");
          }
        }
      } else {
        return invalidRequest(`Instruction message [${i}] missing string or array content`);
      }
      items.push({
        type: "instruction",
        authority: role,
        separation: "advisory",
        text,
      });
      continue;
    }

    if (role === "user") {
      const parts: IrInputPart[] = [];
      if (typeof rawMsg.content === "string") {
        parts.push({ type: "text", text: rawMsg.content });
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const rawPart = rawMsg.content[pIdx] as Record<string, unknown>;
          if (rawPart?.type === "text" && typeof rawPart.text === "string") {
            parts.push({ type: "text", text: rawPart.text });
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
              breakpoints.push(markerResult.value);
            }
          } else if (rawPart?.type === "image_url") {
            const imgObj = rawPart.image_url;
            let url: string;
            let detail: "auto" | "low" | "high" | undefined;
            // Chat pins image_url to the {url, detail?} object form; the bare
            // string spelling belongs to Responses input_image, not this wire.
            if (
              typeof imgObj === "object" &&
              imgObj !== null &&
              typeof (imgObj as Record<string, unknown>).url === "string"
            ) {
              const rec = imgObj as Record<string, unknown>;
              url = rec.url as string;
              if (rec.detail !== undefined) {
                if (rec.detail !== "auto" && rec.detail !== "low" && rec.detail !== "high") {
                  return invalidRequest(`message [${i}] part [${pIdx}]: image detail must be 'auto', 'low', or 'high'`);
                }
                detail = rec.detail;
              }
            } else {
              return invalidRequest(`message [${i}] part [${pIdx}]: image_url must contain url string`);
            }
            if (url.startsWith("data:")) {
              const parsed = parseDataUri(url);
              if (!parsed?.mediaType.startsWith("image/")) {
                return invalidRequest(`message [${i}] part [${pIdx}]: invalid image data URI`);
              }
              parts.push({
                type: "image",
                source: { type: "bytes", mediaType: parsed.mediaType, base64: parsed.base64 },
                ...(detail !== undefined ? { detail } : {}),
              });
            } else {
              if (!validateHttpsUrl(url)) {
                return invalidRequest(`message [${i}] part [${pIdx}]: image URL must be an absolute HTTPS URL`);
              }
              parts.push({
                type: "image",
                source: { type: "url", url },
                ...(detail !== undefined ? { detail } : {}),
              });
            }
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
              breakpoints.push(markerResult.value);
            }
          } else if (rawPart?.type === "input_audio") {
            return unsupportedCapability("audio-input");
          } else if (rawPart?.type === "file") {
            const file = rawPart.file as Record<string, unknown> | undefined;
            if (typeof file !== "object" || file === null) {
              return invalidRequest(`message [${i}] part [${pIdx}]: file part must contain file object`);
            }
            const hasFileId = file.file_id !== undefined;
            const hasFileData = file.file_data !== undefined;
            if ((hasFileId && hasFileData) || (!hasFileId && !hasFileData)) {
              return invalidRequest(
                `message [${i}] part [${pIdx}]: file part must contain exactly one of file_id or file_data`,
              );
            }
            const filename = typeof file.filename === "string" ? file.filename : undefined;
            if (hasFileId) {
              if (typeof file.file_id !== "string" || file.file_id.trim() === "") {
                return invalidRequest(`message [${i}] part [${pIdx}]: file_id must be a non-empty string`);
              }
              providerFileRefs.push({
                itemIndex,
                partIndex: pIdx,
                mediaKind: "document",
                fileId: file.file_id,
                ...(filename !== undefined ? { filename } : {}),
              });
            } else {
              if (typeof file.file_data !== "string" || file.file_data.trim() === "") {
                return invalidRequest(`message [${i}] part [${pIdx}]: file_data must be a non-empty base64 string`);
              }
              // A Chat file part is a bytes part: `file_data` crosses to
              // Responses byte-verbatim (the document-inline-bytes T1 cell) and
              // into Messages only as PDF, so the filename infers a media type
              // and never selects a text representation. Text-source documents
              // are reachable only from Responses and Messages ingress.
              const inferred = inferExtensionMediaType(filename);
              parts.push({
                type: "document",
                documentId: randomUUID(),
                source: {
                  type: "bytes",
                  mediaType: inferred?.mediaType ?? "application/octet-stream",
                  base64: file.file_data,
                },
                ...(filename !== undefined ? { name: filename } : {}),
              });
            }
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
              breakpoints.push(markerResult.value);
            }
          } else {
            return unsupportedCapability("unknown-content-item");
          }
        }
      } else {
        return invalidRequest(`User message [${i}] missing string or array content`);
      }
      if (parts.length === 0) {
        const hasMatchingRef = providerFileRefs.some((r) => r.itemIndex === itemIndex);
        if (!hasMatchingRef) {
          return invalidRequest(`User message [${i}] has empty content`);
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
      if (rawMsg.function_call !== undefined && rawMsg.function_call !== null) {
        return unsupportedCapability("chat-legacy-functions");
      }
      if (rawMsg.audio !== undefined) {
        return unsupportedCapability("audio-continuation-id");
      }

      const parts: IrAssistantPart[] = [];
      if (typeof rawMsg.content === "string") {
        parts.push({ type: "text", text: rawMsg.content });
      } else if (Array.isArray(rawMsg.content)) {
        for (let pIdx = 0; pIdx < rawMsg.content.length; pIdx++) {
          const rawPart = rawMsg.content[pIdx] as Record<string, unknown>;
          if (rawPart?.type === "text" && typeof rawPart.text === "string") {
            parts.push({ type: "text", text: rawPart.text });
            if (rawPart.prompt_cache_breakpoint !== undefined) {
              const markerResult = captureBreakpoint(
                `message [${i}] part [${pIdx}]`,
                rawPart.prompt_cache_breakpoint,
                itemIndex,
                pIdx,
              );
              if (!markerResult.ok) return markerResult;
              breakpoints.push(markerResult.value);
            }
          } else if (rawPart?.type === "refusal") {
            return unsupportedCapability("refusal-content");
          } else {
            return unsupportedCapability("unknown-content-item");
          }
        }
      } else if (rawMsg.refusal !== undefined && rawMsg.refusal !== null) {
        return unsupportedCapability("refusal-content");
      } else if (rawMsg.content !== undefined && rawMsg.content !== null) {
        return invalidRequest(`Assistant message [${i}] missing string or array content`);
      }

      const toolCalls: IrToolCall[] = [];
      if (rawMsg.tool_calls !== undefined) {
        if (!Array.isArray(rawMsg.tool_calls)) {
          return invalidRequest(`Assistant message [${i}] tool_calls must be an array`);
        }
        for (let tIdx = 0; tIdx < rawMsg.tool_calls.length; tIdx++) {
          const callResult = parseChatToolCallEntry(rawMsg.tool_calls[tIdx], `message [${i}] tool_calls[${tIdx}]`);
          if (!callResult.ok) return callResult;
          toolCalls.push(callResult.value);
        }
      }

      if (parts.length === 0 && toolCalls.length === 0) {
        return invalidRequest(
          rawMsg.content === undefined || rawMsg.content === null
            ? `Assistant message [${i}] missing string or array content`
            : `Assistant message [${i}] has empty content`,
        );
      }
      if (parts.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: parts as unknown as NonEmpty<IrAssistantPart>,
        });
      }
      for (const call of toolCalls) {
        items.push({ type: "tool_call", call });
      }
      continue;
    }

    if (role === "function") {
      return unsupportedCapability("chat-legacy-function-role");
    }
    if (role === "tool") {
      if (typeof rawMsg.tool_call_id !== "string" || rawMsg.tool_call_id.trim() === "") {
        return invalidRequest(`Tool message [${i}] missing required non-empty tool_call_id`);
      }
      const parts: IrInputPart[] = [];
      if (typeof rawMsg.content === "string") {
        parts.push({ type: "text", text: rawMsg.content });
      } else if (Array.isArray(rawMsg.content)) {
        // Chat tool content is text-only: multi-element arrays are multipart
        // results originating from Chat and fail closed at decode time.
        if (rawMsg.content.length >= 2) {
          return unsupportedCapability("tool-result-multipart");
        }
        if (rawMsg.content.length === 1) {
          const rawPart = rawMsg.content[0] as Record<string, unknown>;
          if (rawPart?.type !== "text" || typeof rawPart.text !== "string") {
            return invalidRequest(`Tool message [${i}] array content must be a single text part`);
          }
          parts.push({ type: "text", text: rawPart.text });
          if (rawPart.prompt_cache_breakpoint !== undefined) {
            const markerResult = captureBreakpoint(`message [${i}]`, rawPart.prompt_cache_breakpoint, itemIndex);
            if (!markerResult.ok) return markerResult;
            breakpoints.push(markerResult.value);
          }
        }
      } else {
        return invalidRequest(`Tool message [${i}] missing string or array content`);
      }
      items.push({
        type: "tool_result",
        callId: rawMsg.tool_call_id,
        isError: false,
        content: parts,
      });
      continue;
    }

    return invalidRequest(`Unknown role '${String(role)}' in Chat message [${i}]`);
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
  const maxTokensResult = parsePositiveSafeInteger("max_completion_tokens", body.max_completion_tokens);
  if (!maxTokensResult.ok) return maxTokensResult;
  const verbosityResult = parseVerbosity(body.verbosity);
  if (!verbosityResult.ok) return verbosityResult;
  const effortResult = parseReasoningEffort(body.reasoning_effort);
  if (!effortResult.ok) return effortResult;

  let stopSequences: NonEmpty<string> | undefined;
  if (typeof body.stop === "string") {
    if (body.stop.length === 0) {
      return invalidRequest("stop must be a non-empty string or non-empty array");
    }
    stopSequences = [body.stop];
  } else if (Array.isArray(body.stop)) {
    // The Chat schema admits 1-4 entries; larger sets are invalid Chat wire.
    // (The >4 stop-sequence-request rejection applies to M-origin sets only.)
    if (body.stop.length === 0 || body.stop.length > 4) {
      return invalidRequest("stop must contain between 1 and 4 entries");
    }
    const entriesResult = parseStopSequenceEntries("stop", body.stop);
    if (!entriesResult.ok) return entriesResult;
    stopSequences = asNonEmptyStopSequences(entriesResult.value);
  } else if (body.stop !== undefined && body.stop !== null) {
    return invalidRequest("stop must be a string or an array of strings");
  }

  const generation: IrGenerationControls | undefined =
    temperatureResult.value !== undefined ||
    topPResult.value !== undefined ||
    maxTokensResult.value !== undefined ||
    verbosityResult.value !== undefined ||
    effortResult.value !== undefined ||
    stopSequences !== undefined
      ? {
          ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
          ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
          ...(maxTokensResult.value !== undefined ? { maxOutputTokens: maxTokensResult.value } : {}),
          ...(verbosityResult.value !== undefined ? { verbosity: verbosityResult.value } : {}),
          ...(effortResult.value !== undefined ? { reasoning: { effort: effortResult.value } } : {}),
          ...(stopSequences !== undefined ? { stopSequences } : {}),
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
 * Ingress decoder for OpenAI Chat Completions requests and responses.
 *
 * Request decoding delegates to {@link parseChatRequestBody}, which projects
 * admitted generation controls into the IR and captures matrix-admitted
 * wire-only fields (storage, prompt-cache controls, metadata, safety identity,
 * moderation, service tier) into the request wire-options sidecar; direction
 * feasibility for those fields is decided later by preflight, not here.
 * Recognized native-only facts fail closed immediately with their exact matrix
 * capability ID.
 */
export class ChatIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseChatRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(
    _status: number,
    _headers: HeaderMap,
    body: JsonObject,
  ): Result<OutcomeDecodeResult, NormalizedFailure> {
    if (typeof body !== "object" || body === null) {
      return invalidRequest("Chat response body must be an object");
    }

    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      return invalidRequest("Chat response missing choices array");
    }

    const choice = body.choices[0] as Record<string, unknown>;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return invalidRequest("Chat response choice is missing the required 'message' object");
    }
    const parts: IrOutputPart[] = [];

    if (
      (message.function_call !== undefined && message.function_call !== null) ||
      choice?.finish_reason === "function_call"
    ) {
      return unsupportedCapability("chat-legacy-functions");
    }

    if (message.refusal !== undefined && message.refusal !== null) {
      parts.push({
        type: "refusal",
        partId: randomUUID(),
        text: String(message.refusal),
      });
    } else {
      if (typeof message.content === "string") {
        parts.push({ type: "text", partId: randomUUID(), text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (let i = 0; i < message.tool_calls.length; i++) {
          const callResult = parseChatToolCallEntry(message.tool_calls[i], `Chat response tool_calls[${i}]`);
          if (!callResult.ok) return callResult;
          parts.push({ type: "tool_call", partId: randomUUID(), call: callResult.value });
        }
      }
      if (parts.length === 0) {
        parts.push({ type: "text", partId: randomUUID(), text: "" });
      }
    }

    let finishReason: IrFinishReason = "stop";
    const rawReason = choice?.finish_reason;
    if (rawReason === "stop") {
      finishReason = "stop";
    } else if (rawReason === "length") {
      finishReason = "length";
    } else if (rawReason === "tool_calls") {
      finishReason = "tool_calls";
    } else if (rawReason === "content_filter") {
      finishReason = "content_filter";
    } else if (rawReason !== null && rawReason !== undefined) {
      finishReason = "other";
    }

    // Usage counters plus the cache/reasoning subdivisions (`usage-cache-read`,
    // `usage-cache-write`, `usage-reasoning`), parsed once in shared/usage.ts so the
    // complete and stream paths cannot drift. Subdivisions are observations and
    // are never re-added to totals; absence of the whole usage object stays
    // absence (never fabricated as zeros).
    const usageResult = parseChatUsage(body.usage);
    if (!usageResult.ok) return usageResult;
    const usage = usageResult.value;

    // Response-side wire-only facts: the moderation result (stored in normal,
    // unwrapped form) and the effective service-tier echo.
    const factsResult = captureOutcomeWireFacts(body, {}, "Chat response");
    if (!factsResult.ok) return factsResult;

    const outcome: IrOutcome = {
      responseId: randomUUID(),
      model: typeof body.model === "string" ? body.model : "unknown",
      parts,
      finish: { reason: finishReason },
      ...(usage !== undefined ? { usage } : {}),
    };

    return ok({ irOutcome: outcome, outcomeWireOptions: factsResult.value });
  }
}
