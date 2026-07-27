import type {
  CanonicalChoice,
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  Citation,
  ContentBlock,
  FinishReason,
  GatewayError,
  JsonValue,
  OutputConfiguration,
  ReasoningRequest,
  RoutingConstraints,
  SamplingParameters,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../../domain/index.js";
import {
  createGatewayError,
  redactDetails,
  validateBase64Media,
  validateCanonicalRequest,
  validateRfc3339Timestamp,
  validateToolCallArgumentsJson,
  validateUrl,
  isSafeCanonicalResponse,
} from "../../domain/index.js";
import type {
  EgressTranslationAdapter,
  EgressValue,
  IngressTranslationAdapter,
  RawIngressInput,
  TranslationContext,
} from "../../ports/index.js";

const PROTOCOL = "openai-chat" as const;
const CHAT_PATHS = ["/chat/completions", "/v1/chat/completions"] as const;
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;
const ROLES: Record<string, true> = { system: true, developer: true, user: true, assistant: true, tool: true };
const DETAILS: Record<string, true> = { auto: true, low: true, high: true };
const EFFORTS: Record<string, true> = { none: true, low: true, medium: true, high: true, max: true };
const FUTURE_EFFORTS: Record<string, true> = { minimal: true, xhigh: true };
const DISPLAYS: Record<string, true> = { summarized: true, omitted: true, auto: true, concise: true, detailed: true };
const PART_FIELDS: Record<string, true> = { type: true, text: true, refusal: true, image_url: true, input_audio: true, file: true, prompt_cache_breakpoint: true, annotations: true, signature: true, redacted_data: true, encrypted_content: true };
const IMAGE_FIELDS: Record<string, true> = { url: true, detail: true };
const AUDIO_FIELDS: Record<string, true> = { data: true, format: true };
const FILE_FIELDS: Record<string, true> = { file_id: true, file_data: true, filename: true };
const TOOL_CALL_FIELDS: Record<string, true> = { id: true, type: true, function: true };
const TOOL_FUNCTION_CALL_FIELDS: Record<string, true> = { name: true, arguments: true };
const ROUTING_FIELDS: Record<string, true> = { modelAlias: true, requiredCapabilities: true, preferredProviders: true, excludedProviders: true, overrideRoute: true, maxCostUsd: true, maxLatencyMs: true, dryRun: true };
const SERVICE_TIERS: Record<string, true> = { auto: true, default: true, priority: true, flex: true, scale: true };
const PERSISTENCE: Record<string, true> = { current_turn: true, all_turns: true };

/** Construction options for the stateless OpenAI Chat translator family. */
export interface OpenAiChatTranslatorOptions {
  /** Injected RFC 3339 timestamp factory used for owned canonical requests. */
  readonly now: () => string;
  /** Allows only reasoning text, never signatures or encrypted/redacted payloads, on egress. */
  readonly exposeReasoningText?: boolean;
}

/** Public ingress/egress pair for OpenAI Chat; both adapters are safe to share across requests. */
export interface OpenAiChatTranslatorFamily {
  /** Stateless request translator; returned requests own and freeze all translated values. */
  readonly ingress: IngressTranslationAdapter;
  /** Stateless response translator; unsafe canonical states fail with a typed safe error. */
  readonly egress: EgressTranslationAdapter;
}

type JsonObject = Record<string, JsonValue>;
type UnknownObject = Record<string, unknown>;
type FailureCode =
  | "invalid_openai_chat_request"
  | "invalid_model"
  | "invalid_messages"
  | "invalid_message_content"
  | "invalid_media"
  | "invalid_tool_arguments"
  | "invalid_range"
  | "unsupported_openai_chat_semantics"
  | "invalid_translation_timestamp"
  | "invalid_openai_chat_egress"
  | "missing_stream_response_metadata";

interface TranslationState {
  readonly requestId: string;
  readonly consumed: string[];
  readonly consumedSet: Set<string>;
  readonly capabilities: Set<string>;
  readonly cacheTtl?: string;
}

class ImmutablePathSet implements ReadonlySet<string> {
  readonly #values: Set<string>;

  constructor(values: readonly string[]) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[string, string]> {
    return this.#values.entries();
  }

  keys(): SetIterator<string> {
    return this.#values.keys();
  }

  values(): SetIterator<string> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is UnknownObject {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object: UnknownObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(
  requestId: string,
  code: FailureCode,
  message: string,
  status: number,
  path?: string,
): never {
  throw createGatewayError({
    category: code === "invalid_translation_timestamp" || code === "invalid_openai_chat_egress" || code === "missing_stream_response_metadata" ? "internal" : "validation",
    code,
    message,
    requestId,
    retryable: false,
    status,
    ...(path === undefined ? {} : { details: { path, code } }),
  });
}

function invalidRequest(requestId: string, path = "body"): never {
  return fail(requestId, "invalid_openai_chat_request", "Expected a JSON object request body.", 400, path);
}

function cloneJson(value: unknown, requestId: string): JsonValue {
  const active = new WeakSet<object>();

  const clone = (current: unknown, path: string): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidRequest(requestId, path);
      return current;
    }
    if (typeof current !== "object") invalidRequest(requestId, path);
    if (active.has(current)) invalidRequest(requestId, path);
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const keys = Reflect.ownKeys(descriptors);
        for (const key of keys) {
          if (key === "length") continue;
          const index = typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
          if (!Number.isSafeInteger(index) || index < 0 || index >= current.length || String(index) !== key) invalidRequest(requestId, path);
          const descriptor = descriptors[key];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidRequest(requestId, `${path}[${key}]`);
        }
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) invalidRequest(requestId, `${path}[${index}]`);
        }
        return current.map((item, index) => clone(item, `${path}[${index}]`));
      }
      if (!isPlainObject(current)) invalidRequest(requestId, path);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const output: JsonObject = Object.create(null) as JsonObject;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") invalidRequest(requestId, path);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidRequest(requestId, `${path}.${key}`);
        Object.defineProperty(output, key, { value: clone(descriptor.value, path === "body" ? key : `${path}.${key}`), enumerable: true, writable: false, configurable: false });
      }
      return Object.freeze(output);
    } finally {
      active.delete(current);
    }
  };

  return clone(value, "body");
}

function mark(state: TranslationState, path: string): void {
  if (state.consumedSet.has(path)) return;
  state.consumedSet.add(path);
  state.consumed.push(path);
}

function markTree(state: TranslationState, path: string, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) mark(state, path);
    else value.forEach((entry, index) => markTree(state, `${path}[${index}]`, entry));
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) mark(state, path);
    else for (const [key, entry] of entries) markTree(state, `${path}.${key}`, entry as JsonValue);
    return;
  }
  mark(state, path);
}

function depthFirstConsumedFields(root: JsonObject, consumed: ReadonlySet<string>): string[] {
  const fields: string[] = [];
  const visit = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0 && consumed.has(path)) fields.push(path);
      else value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0 && consumed.has(path)) fields.push(path);
      else for (const [key, entry] of entries) visit(entry as JsonValue, path === "" ? key : `${path}.${key}`);
      return;
    }
    if (consumed.has(path)) fields.push(path);
  };
  visit(root, "");
  return fields;
}

/**
 * Retains unknown fields in their original object/array position. Empty,
 * null-prototype objects are deliberate positional skeletons for consumed array
 * members; replay code addresses only retained leaves and never emits skeletons.
 */
function extensionBody(root: JsonObject, consumed: ReadonlySet<string>): JsonObject {
  const visit = (value: JsonValue, path: string): JsonValue | undefined => {
    if (consumed.has(path)) return undefined;
    if (Array.isArray(value)) {
      const entries = value.map((entry, index) => visit(entry, `${path}[${index}]`));
      if (entries.every((entry) => entry === undefined)) return undefined;
      return entries.map((entry) => entry ?? (Object.create(null) as JsonObject));
    }
    if (isPlainObject(value)) {
      const output: JsonObject = Object.create(null) as JsonObject;
      for (const [key, entry] of Object.entries(value)) {
        const child = visit(entry as JsonValue, path === "" ? key : `${path}.${key}`);
        if (child !== undefined) Object.defineProperty(output, key, { value: child, enumerable: true, writable: false, configurable: false });
      }
      return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
    }
    return value;
  };
  return (visit(root, "") as JsonObject | undefined) ?? Object.freeze({});
}

function requireObject(value: JsonValue, state: TranslationState, path: string, code: FailureCode, message: string): JsonObject {
  if (!isPlainObject(value)) fail(state.requestId, code, message, code === "unsupported_openai_chat_semantics" ? 422 : 400, path);
  return value as JsonObject;
}

function requireString(value: JsonValue | undefined, state: TranslationState, path: string, code: FailureCode, message: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(state.requestId, code, message, code === "unsupported_openai_chat_semantics" ? 422 : 400, path);
  mark(state, path);
  return value;
}

function optionalString(object: JsonObject, key: string, state: TranslationState, path: string): string | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  const fieldPath = path === "" ? key : `${path}.${key}`;
  if (typeof object[key] !== "string") fail(state.requestId, "invalid_openai_chat_request", "Expected a string field.", 400, fieldPath);
  mark(state, fieldPath);
  return object[key] as string;
}

function optionalBoolean(object: JsonObject, key: string, state: TranslationState, path: string): boolean | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  const fieldPath = path === "" ? key : `${path}.${key}`;
  if (typeof object[key] !== "boolean") fail(state.requestId, "invalid_openai_chat_request", "Expected a boolean field.", 400, fieldPath);
  mark(state, fieldPath);
  return object[key] as boolean;
}

function unknownMetadata(object: JsonObject, known: Readonly<Record<string, true>>, state: TranslationState, path: string): JsonObject | undefined {
  const output: JsonObject = Object.create(null) as JsonObject;
  for (const [key, value] of Object.entries(object)) {
    if (known[key] === true) continue;
    Object.defineProperty(output, key, { value, enumerable: true, writable: false, configurable: false });
    markTree(state, path === "" ? key : `${path}.${key}`, value);
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
}

function mergeMetadata(...entries: Array<JsonObject | undefined>): JsonObject | undefined {
  const output: JsonObject = Object.create(null) as JsonObject;
  for (const entry of entries) {
    if (entry === undefined) continue;
    for (const [key, value] of Object.entries(entry)) Object.defineProperty(output, key, { value, enumerable: true, writable: false, configurable: false });
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
}

function parseAnnotations(value: JsonValue | undefined, state: TranslationState, path: string): Citation[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(state.requestId, "invalid_message_content", "Expected an annotation array.", 400, path);
  const citations = value.map((entry, index): Citation => {
    const entryPath = `${path}[${index}]`;
    const annotation = requireObject(entry, state, entryPath, "invalid_message_content", "Expected an annotation object.");
    const type = requireString(annotation["type"], state, `${entryPath}.type`, "invalid_message_content", "Expected a supported annotation type.");
    if (type === "url_citation") {
      const data = requireObject(annotation["url_citation"] as JsonValue, state, `${entryPath}.url_citation`, "invalid_message_content", "Expected a URL citation object.");
      const url = requireString(data["url"], state, `${entryPath}.url_citation.url`, "invalid_message_content", "Expected a citation URL.");
      if (!validateUrl(url).valid) fail(state.requestId, "invalid_media", "Expected a safe citation URL.", 400, `${entryPath}.url_citation.url`);
      markTree(state, entryPath, annotation);
      return Object.freeze({
        kind: "url",
        url,
        ...(typeof data["title"] === "string" ? { sourceTitle: data["title"] } : {}),
        ...(Number.isInteger(data["start_index"]) ? { startIndex: data["start_index"] as number } : {}),
        ...(Number.isInteger(data["end_index"]) ? { endIndex: data["end_index"] as number } : {}),
        raw: annotation,
      });
    }
    if (type === "file_citation") {
      const data = requireObject(annotation["file_citation"] as JsonValue, state, `${entryPath}.file_citation`, "invalid_message_content", "Expected a file citation object.");
      const sourceId = requireString(data["file_id"], state, `${entryPath}.file_citation.file_id`, "invalid_message_content", "Expected a file citation identifier.");
      markTree(state, entryPath, annotation);
      return Object.freeze({ kind: "file", sourceId, ...(typeof data["quote"] === "string" ? { citedText: data["quote"] } : {}), raw: annotation });
    }
    fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported annotation semantics.", 422, `${entryPath}.type`);
  });
  return citations;
}

function parseDataUrl(value: string, state: TranslationState, path: string): { mediaType: string; data: string } {
  const match = DATA_URL.exec(value);
  if (match === null) fail(state.requestId, "invalid_media", "Expected a valid base64 data URL.", 400, path);
  const mediaType = match[1] ?? "";
  const data = match[2] ?? "";
  if (!validateBase64Media(data, mediaType).valid) fail(state.requestId, "invalid_media", "Expected valid base64 media.", 400, path);
  return { mediaType, data };
}

function parsePart(value: JsonValue, state: TranslationState, path: string): ContentBlock {
  const part = requireObject(value, state, path, "invalid_message_content", "Expected a content part object.");
  const type = requireString(part["type"], state, `${path}.type`, "invalid_message_content", "Expected a content part type.");
  const metadata = unknownMetadata(part, PART_FIELDS, state, path);
  const base = {
    ...(hasOwn(part, "prompt_cache_breakpoint") && part["prompt_cache_breakpoint"] !== null
      ? (markTree(state, `${path}.prompt_cache_breakpoint`, part["prompt_cache_breakpoint"] as JsonValue), { cacheBreakpoint: state.cacheTtl === undefined ? {} : { ttl: state.cacheTtl } })
      : {}),
    ...(metadata === undefined ? {} : { providerMetadata: metadata }),
  };
  if (type === "text") {
    const text = requireString(part["text"], state, `${path}.text`, "invalid_message_content", "Expected text content.", true);
    const citations = parseAnnotations(part["annotations"], state, `${path}.annotations`);
    return Object.freeze({ ...base, type: "text", text, ...(citations === undefined ? {} : { citations }) });
  }
  if (type === "refusal") {
    const refusal = requireString(part["refusal"], state, `${path}.refusal`, "invalid_message_content", "Expected refusal content.", true);
    const citations = parseAnnotations(part["annotations"], state, `${path}.annotations`);
    return Object.freeze({ ...base, type: "refusal", refusal, ...(citations === undefined ? {} : { citations }) });
  }
  if (type === "reasoning") {
    const text = optionalString(part, "text", state, path);
    const signature = optionalString(part, "signature", state, path);
    const redactedData = optionalString(part, "redacted_data", state, path);
    const encryptedContent = optionalString(part, "encrypted_content", state, path);
    if (text === undefined && signature === undefined && redactedData === undefined && encryptedContent === undefined) fail(state.requestId, "invalid_message_content", "Expected reasoning content.", 400, path);
    state.capabilities.add("reasoning");
    return Object.freeze({ ...base, type: "reasoning", ...(text === undefined ? {} : { text }), ...(signature === undefined ? {} : { signature }), ...(redactedData === undefined ? {} : { redactedData }), ...(encryptedContent === undefined ? {} : { encryptedContent }) });
  }
  if (type === "image_url") {
    const image = requireObject(part["image_url"] as JsonValue, state, `${path}.image_url`, "invalid_media", "Expected an image URL object.");
    const imageMetadata = unknownMetadata(image, IMAGE_FIELDS, state, `${path}.image_url`);
    const blockMetadata = mergeMetadata(metadata, imageMetadata === undefined ? undefined : { image_url: imageMetadata });
    const url = requireString(image["url"], state, `${path}.image_url.url`, "invalid_media", "Expected an image URL.");
    const detail = optionalString(image, "detail", state, `${path}.image_url`);
    if (detail !== undefined && DETAILS[detail] !== true) fail(state.requestId, "invalid_media", "Expected a supported image detail.", 400, `${path}.image_url.detail`);
    state.capabilities.add("vision");
    state.capabilities.add("multimodal");
    if (url.startsWith("data:")) {
      const media = parseDataUrl(url, state, `${path}.image_url.url`);
      return Object.freeze({ ...base, ...(blockMetadata === undefined ? {} : { providerMetadata: blockMetadata }), type: "image_base64", mediaType: media.mediaType, data: media.data });
    }
    if (!validateUrl(url).valid) fail(state.requestId, "invalid_media", "Expected a safe image URL.", 400, `${path}.image_url.url`);
    return Object.freeze({ ...base, ...(blockMetadata === undefined ? {} : { providerMetadata: blockMetadata }), type: "image_url", url, ...(detail === undefined ? {} : { detail: detail as "auto" | "low" | "high" }) });
  }
  if (type === "input_audio") {
    const audio = requireObject(part["input_audio"] as JsonValue, state, `${path}.input_audio`, "invalid_media", "Expected an input audio object.");
    const audioMetadata = unknownMetadata(audio, AUDIO_FIELDS, state, `${path}.input_audio`);
    const blockMetadata = mergeMetadata(metadata, audioMetadata === undefined ? undefined : { input_audio: audioMetadata });
    const data = requireString(audio["data"], state, `${path}.input_audio.data`, "invalid_media", "Expected audio data.");
    const format = requireString(audio["format"], state, `${path}.input_audio.format`, "invalid_media", "Expected an audio format.");
    const mediaType = format === "wav" ? "audio/wav" : format === "mp3" ? "audio/mpeg" : undefined;
    if (mediaType === undefined || !validateBase64Media(data, mediaType).valid) fail(state.requestId, "invalid_media", "Expected valid base64 audio.", 400, path);
    state.capabilities.add("audio_input");
    return Object.freeze({ ...base, ...(blockMetadata === undefined ? {} : { providerMetadata: blockMetadata }), type: "audio_base64", mediaType, data });
  }
  if (type === "file") {
    const file = requireObject(part["file"] as JsonValue, state, `${path}.file`, "invalid_message_content", "Expected a file object.");
    const fileMetadata = unknownMetadata(file, FILE_FIELDS, state, `${path}.file`);
    const blockMetadata = mergeMetadata(metadata, fileMetadata === undefined ? undefined : { file: fileMetadata });
    const fileId = optionalString(file, "file_id", state, `${path}.file`);
    const fileData = optionalString(file, "file_data", state, `${path}.file`);
    const filename = optionalString(file, "filename", state, `${path}.file`);
    if ((fileId === undefined) === (fileData === undefined)) fail(state.requestId, "unsupported_openai_chat_semantics", "Expected exactly one supported file source.", 422, `${path}.file`);
    state.capabilities.add("vision");
    state.capabilities.add("multimodal");
    if (fileId !== undefined) return Object.freeze({ ...base, ...(blockMetadata === undefined ? {} : { providerMetadata: blockMetadata }), type: "file_reference", fileId, ...(filename === undefined ? {} : { filename }) });
    if (!fileData!.startsWith("data:")) fail(state.requestId, "unsupported_openai_chat_semantics", "Raw file bytes require an explicit media type.", 422, `${path}.file.file_data`);
    const media = parseDataUrl(fileData!, state, `${path}.file.file_data`);
    return Object.freeze({ ...base, ...(blockMetadata === undefined ? {} : { providerMetadata: blockMetadata }), type: "document_base64", mediaType: media.mediaType, data: media.data, ...(filename === undefined ? {} : { title: filename }) });
  }
  fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported content part semantics.", 422, `${path}.type`);
}

function parseContent(value: JsonValue, state: TranslationState, path: string): ContentBlock[] {
  if (typeof value === "string") {
    mark(state, path);
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value) || value.length === 0) fail(state.requestId, "invalid_message_content", "Expected non-empty message content.", 400, path);
  return value.map((part, index) => parsePart(part, state, `${path}[${index}]`));
}

function parseToolCalls(value: JsonValue, state: TranslationState, path: string): ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) fail(state.requestId, "invalid_tool_arguments", "Expected non-empty tool calls.", 400, path);
  return value.map((entry, index): ContentBlock => {
    const entryPath = `${path}[${index}]`;
    const call = requireObject(entry, state, entryPath, "invalid_tool_arguments", "Expected a tool call object.");
    const type = requireString(call["type"], state, `${entryPath}.type`, "invalid_tool_arguments", "Expected a function tool call.");
    if (type !== "function") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported tool-call semantics.", 422, `${entryPath}.type`);
    const id = requireString(call["id"], state, `${entryPath}.id`, "invalid_tool_arguments", "Expected a tool-call identifier.");
    const fn = requireObject(call["function"] as JsonValue, state, `${entryPath}.function`, "invalid_tool_arguments", "Expected a tool-call function.");
    const name = requireString(fn["name"], state, `${entryPath}.function.name`, "invalid_tool_arguments", "Expected a tool-call name.");
    const argumentsJson = requireString(fn["arguments"], state, `${entryPath}.function.arguments`, "invalid_tool_arguments", "Expected JSON tool arguments.", true);
    if (!validateToolCallArgumentsJson(argumentsJson).valid) fail(state.requestId, "invalid_tool_arguments", "Expected JSON object tool arguments.", 400, `${entryPath}.function.arguments`);
    const callMetadata = unknownMetadata(call, TOOL_CALL_FIELDS, state, entryPath);
    const functionMetadata = unknownMetadata(fn, TOOL_FUNCTION_CALL_FIELDS, state, `${entryPath}.function`);
    const providerMetadata = mergeMetadata(callMetadata, functionMetadata === undefined ? undefined : { function: functionMetadata });
    state.capabilities.add("tools");
    return Object.freeze({ type: "tool_call", toolCallId: id, name, argumentsJson, ...(providerMetadata === undefined ? {} : { providerMetadata }) });
  });
}

function parseMessage(value: JsonValue, state: TranslationState, path: string): CanonicalMessage {
  const message = requireObject(value, state, path, "invalid_messages", "Expected a message object.");
  const role = requireString(message["role"], state, `${path}.role`, "invalid_messages", "Expected a supported message role.");
  if (ROLES[role] !== true) fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported message role.", 422, `${path}.role`);
  const name = optionalString(message, "name", state, path);
  if (role === "tool") {
    const toolCallId = requireString(message["tool_call_id"], state, `${path}.tool_call_id`, "invalid_message_content", "Expected a tool-call identifier.");
    if (!hasOwn(message, "content") || message["content"] === null) fail(state.requestId, "invalid_message_content", "Expected tool result content.", 400, `${path}.content`);
    const content = parseContent(message["content"] as JsonValue, state, `${path}.content`);
    const toolResult: ContentBlock = { type: "tool_result", toolCallId, content };
    return Object.freeze({ role: "tool", content: [toolResult], toolCallId, ...(name === undefined ? {} : { name }) });
  }
  const blocks: ContentBlock[] = [];
  if (hasOwn(message, "content") && message["content"] !== null) blocks.push(...parseContent(message["content"] as JsonValue, state, `${path}.content`));
  if (hasOwn(message, "refusal") && message["refusal"] !== null) {
    const refusal = requireString(message["refusal"], state, `${path}.refusal`, "invalid_message_content", "Expected refusal content.", true);
    blocks.push(Object.freeze({ type: "refusal", refusal }));
  }
  if (hasOwn(message, "tool_calls") && message["tool_calls"] !== null) {
    if (role !== "assistant") fail(state.requestId, "unsupported_openai_chat_semantics", "Only assistant messages may contain tool calls.", 422, `${path}.tool_calls`);
    blocks.push(...parseToolCalls(message["tool_calls"] as JsonValue, state, `${path}.tool_calls`));
  }
  if (blocks.length === 0) fail(state.requestId, "invalid_message_content", "Expected non-empty message content.", 400, `${path}.content`);
  return Object.freeze({ role: role as CanonicalMessage["role"], content: blocks, ...(name === undefined ? {} : { name }) });
}

function parseTools(value: JsonValue, state: TranslationState, path: string): ToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0) fail(state.requestId, "invalid_openai_chat_request", "Expected non-empty tools.", 400, path);
  state.capabilities.add("tools");
  return value.map((entry, index): ToolDefinition => {
    const entryPath = `${path}[${index}]`;
    const tool = requireObject(entry, state, entryPath, "invalid_openai_chat_request", "Expected a tool object.");
    const type = requireString(tool["type"], state, `${entryPath}.type`, "invalid_openai_chat_request", "Expected a function tool.");
    if (type !== "function") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported tool semantics.", 422, `${entryPath}.type`);
    const fn = requireObject(tool["function"] as JsonValue, state, `${entryPath}.function`, "invalid_openai_chat_request", "Expected a function definition.");
    const name = requireString(fn["name"], state, `${entryPath}.function.name`, "invalid_openai_chat_request", "Expected a function name.");
    const description = optionalString(fn, "description", state, `${entryPath}.function`);
    const parameters = requireObject(fn["parameters"] as JsonValue, state, `${entryPath}.function.parameters`, "invalid_openai_chat_request", "Expected an object function schema.");
    markTree(state, `${entryPath}.function.parameters`, parameters);
    const strict = optionalBoolean(fn, "strict", state, `${entryPath}.function`);
    const cache = hasOwn(tool, "prompt_cache_breakpoint") && tool["prompt_cache_breakpoint"] !== null
      ? (markTree(state, `${entryPath}.prompt_cache_breakpoint`, tool["prompt_cache_breakpoint"] as JsonValue), state.cacheTtl === undefined ? {} : { ttl: state.cacheTtl })
      : undefined;
    return Object.freeze({ kind: "function", name, ...(description === undefined ? {} : { description }), inputSchema: parameters, ...(strict === undefined ? {} : { strict }), ...(cache === undefined ? {} : { cacheBreakpoint: cache }) });
  });
}

function parseToolChoice(value: JsonValue, state: TranslationState, path: string): ToolChoice {
  if (typeof value === "string") {
    if (value !== "auto" && value !== "none" && value !== "required") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported tool choice.", 422, path);
    mark(state, path);
    return Object.freeze({ mode: value });
  }
  const choice = requireObject(value, state, path, "invalid_openai_chat_request", "Expected a tool choice.");
  const type = requireString(choice["type"], state, `${path}.type`, "invalid_openai_chat_request", "Expected a function tool choice.");
  if (type !== "function") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported tool choice.", 422, `${path}.type`);
  const fn = requireObject(choice["function"] as JsonValue, state, `${path}.function`, "invalid_openai_chat_request", "Expected a named function choice.");
  const name = requireString(fn["name"], state, `${path}.function.name`, "invalid_openai_chat_request", "Expected a function name.");
  return Object.freeze({ mode: "named", name });
}

function numberField(object: JsonObject, key: string, state: TranslationState, minimum: number, maximum: number, integer = false): number | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) fail(state.requestId, "invalid_range", "Expected a value in the supported range.", 400, key);
  mark(state, key);
  return value;
}

function parseSampling(body: JsonObject, state: TranslationState): SamplingParameters | undefined {
  const temperature = numberField(body, "temperature", state, 0, 2);
  const topP = numberField(body, "top_p", state, 0, 1);
  const frequencyPenalty = numberField(body, "frequency_penalty", state, -2, 2);
  const presencePenalty = numberField(body, "presence_penalty", state, -2, 2);
  const seed = numberField(body, "seed", state, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
  const maxTokens = numberField(body, "max_tokens", state, 1, Number.MAX_SAFE_INTEGER, true);
  const maxCompletionTokens = numberField(body, "max_completion_tokens", state, 1, Number.MAX_SAFE_INTEGER, true);
  if (maxTokens !== undefined && maxCompletionTokens !== undefined && maxTokens !== maxCompletionTokens) fail(state.requestId, "unsupported_openai_chat_semantics", "Conflicting token limits are unsupported.", 422, "max_completion_tokens");
  const n = numberField(body, "n", state, 1, Number.MAX_SAFE_INTEGER, true);
  let stop: string | string[] | undefined;
  if (hasOwn(body, "stop") && body["stop"] !== null) {
    const value = body["stop"];
    if (typeof value === "string" && value.length > 0) stop = value;
    else if (Array.isArray(value) && value.length <= 4 && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)) stop = Object.freeze([...value]) as string[];
    else fail(state.requestId, "invalid_range", "Expected one to four non-empty stop strings.", 400, "stop");
    markTree(state, "stop", value);
  }
  if (n !== undefined && n > 1) state.capabilities.add("multiple_choices");
  const normalizedMaxTokens = maxTokens ?? maxCompletionTokens;
  const sampling: SamplingParameters = { ...(temperature === undefined ? {} : { temperature }), ...(topP === undefined ? {} : { topP }), ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }), ...(presencePenalty === undefined ? {} : { presencePenalty }), ...(seed === undefined ? {} : { seed }), ...(normalizedMaxTokens === undefined ? {} : { maxTokens: normalizedMaxTokens }), ...(stop === undefined ? {} : { stop }), ...(n === undefined ? {} : { n }) };
  return Object.keys(sampling).length === 0 ? undefined : Object.freeze(sampling);
}

function parseOutput(body: JsonObject, state: TranslationState): OutputConfiguration | undefined {
  const output: OutputConfiguration = {};
  if (hasOwn(body, "response_format") && body["response_format"] !== null) {
    const format = requireObject(body["response_format"] as JsonValue, state, "response_format", "invalid_openai_chat_request", "Expected a response format object.");
    const type = requireString(format["type"], state, "response_format.type", "invalid_openai_chat_request", "Expected a response format type.");
    if (type !== "text" && type !== "json_object" && type !== "json_schema") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported response format.", 422, "response_format.type");
    output.format = type;
    if (type === "json_schema") {
      const schemaContainer = requireObject(format["json_schema"] as JsonValue, state, "response_format.json_schema", "invalid_openai_chat_request", "Expected a JSON schema configuration.");
      const name = requireString(schemaContainer["name"], state, "response_format.json_schema.name", "invalid_openai_chat_request", "Expected a non-empty schema name.");
      const description = optionalString(schemaContainer, "description", state, "response_format.json_schema");
      const schema = requireObject(schemaContainer["schema"] as JsonValue, state, "response_format.json_schema.schema", "invalid_openai_chat_request", "Expected an object JSON schema.");
      markTree(state, "response_format.json_schema.schema", schema);
      const strict = optionalBoolean(schemaContainer, "strict", state, "response_format.json_schema");
      output.jsonSchema = Object.freeze({ name, ...(description === undefined ? {} : { description }), schema, ...(strict === undefined ? {} : { strict }) });
      state.capabilities.add("structured_outputs");
    }
  }
  const logprobs = optionalBoolean(body, "logprobs", state, "");
  const topLogprobs = numberField(body, "top_logprobs", state, 0, 20, true);
  if (topLogprobs !== undefined && logprobs !== true) fail(state.requestId, "invalid_range", "top_logprobs requires logprobs.", 400, "top_logprobs");
  if (logprobs !== undefined) {
    output.logprobs = Object.freeze({ enabled: logprobs, ...(topLogprobs === undefined ? {} : { topLogprobs }) });
    if (logprobs) state.capabilities.add("logprobs");
  }
  if (hasOwn(body, "reasoning_effort") && body["reasoning_effort"] !== null) {
    const effort = body["reasoning_effort"];
    if (typeof effort !== "string" || (EFFORTS[effort] !== true && FUTURE_EFFORTS[effort] !== true)) fail(state.requestId, "invalid_openai_chat_request", "Expected a supported reasoning effort value.", 400, "reasoning_effort");
    state.capabilities.add("reasoning");
    if (EFFORTS[effort] === true) {
      mark(state, "reasoning_effort");
      output.effort = effort as "none" | "low" | "medium" | "high" | "max";
    }
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
}

function parseReasoning(body: JsonObject, state: TranslationState): ReasoningRequest | undefined {
  if (!hasOwn(body, "reasoning") || body["reasoning"] === null) return undefined;
  const reasoning = requireObject(body["reasoning"] as JsonValue, state, "reasoning", "invalid_openai_chat_request", "Expected a reasoning object.");
  const mode = requireString(reasoning["mode"], state, "reasoning.mode", "invalid_openai_chat_request", "Expected a reasoning mode.");
  if (mode !== "disabled" && mode !== "adaptive" && mode !== "enabled") fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported reasoning mode.", 422, "reasoning.mode");
  const budgetTokens = hasOwn(reasoning, "budget_tokens") && reasoning["budget_tokens"] !== null
    ? (() => { const value = reasoning["budget_tokens"]; if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) fail(state.requestId, "invalid_range", "Expected a positive reasoning budget.", 400, "reasoning.budget_tokens"); mark(state, "reasoning.budget_tokens"); return value; })()
    : undefined;
  if (budgetTokens !== undefined && mode !== "enabled") fail(state.requestId, "unsupported_openai_chat_semantics", "A reasoning budget requires enabled mode.", 422, "reasoning.budget_tokens");
  const display = optionalString(reasoning, "display", state, "reasoning");
  if (display !== undefined && DISPLAYS[display] !== true) fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported reasoning display.", 422, "reasoning.display");
  const persistAcrossTurns = optionalString(reasoning, "persist_across_turns", state, "reasoning");
  if (persistAcrossTurns !== undefined && PERSISTENCE[persistAcrossTurns] !== true) fail(state.requestId, "unsupported_openai_chat_semantics", "Unsupported reasoning persistence.", 422, "reasoning.persist_across_turns");
  const requestEncryptedContent = optionalBoolean(reasoning, "request_encrypted_content", state, "reasoning");
  state.capabilities.add("reasoning");
  const result: ReasoningRequest = { mode, ...(budgetTokens === undefined ? {} : { budgetTokens }), ...(display === undefined ? {} : { display: display as NonNullable<ReasoningRequest["display"]> }), ...(persistAcrossTurns === undefined ? {} : { persistAcrossTurns: persistAcrossTurns as NonNullable<ReasoningRequest["persistAcrossTurns"]> }), ...(requestEncryptedContent === undefined ? {} : { requestEncryptedContent }) };
  return Object.freeze(result);
}

function stringArray(value: JsonValue, state: TranslationState, path: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) fail(state.requestId, "invalid_openai_chat_request", "Expected a string array.", 400, path);
  markTree(state, path, value);
  return [...value] as string[];
}

function parseRouting(body: JsonObject, state: TranslationState): RoutingConstraints {
  const routing: RoutingConstraints = {};
  if (hasOwn(body, "routing") && body["routing"] !== null) {
    const source = requireObject(body["routing"] as JsonValue, state, "routing", "invalid_openai_chat_request", "Expected a routing object.");
    for (const key of Object.keys(source)) if (ROUTING_FIELDS[key] !== true) continue;
    for (const key of ["modelAlias", "overrideRoute"] as const) {
      const value = optionalString(source, key, state, "routing");
      if (value !== undefined) routing[key] = value;
    }
    for (const key of ["requiredCapabilities", "preferredProviders", "excludedProviders"] as const) {
      if (hasOwn(source, key) && source[key] !== null) routing[key] = stringArray(source[key] as JsonValue, state, `routing.${key}`);
    }
    if (hasOwn(source, "maxCostUsd") && source["maxCostUsd"] !== null) {
      const value = source["maxCostUsd"];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(state.requestId, "invalid_range", "Expected a non-negative routing cost.", 400, "routing.maxCostUsd");
      mark(state, "routing.maxCostUsd"); routing.maxCostUsd = value;
    }
    if (hasOwn(source, "maxLatencyMs") && source["maxLatencyMs"] !== null) {
      const value = source["maxLatencyMs"];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) fail(state.requestId, "invalid_range", "Expected a positive routing latency.", 400, "routing.maxLatencyMs");
      mark(state, "routing.maxLatencyMs"); routing.maxLatencyMs = value;
    }
    const dryRun = optionalBoolean(source, "dryRun", state, "routing");
    if (dryRun !== undefined) routing.dryRun = dryRun;
  }
  const required = [...(routing.requiredCapabilities ?? []), ...state.capabilities];
  if (required.length > 0) routing.requiredCapabilities = [...new Set(required)];
  return Object.freeze(routing);
}

function freezeOwned<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeOwned(entry, seen);
  return Object.freeze(value);
}

function translateRequest(input: RawIngressInput, context: TranslationContext, now: () => string): CanonicalRequest {
  if (!isObject(input.body) || Array.isArray(input.body)) invalidRequest(context.requestId);
  const cloned = cloneJson(input.body, context.requestId);
  if (!isPlainObject(cloned)) invalidRequest(context.requestId);
  const body = cloned as JsonObject;
  let receivedAt: string;
  try { receivedAt = now(); } catch { return fail(context.requestId, "invalid_translation_timestamp", "Translation timestamp generation failed.", 500); }
  if (!validateRfc3339Timestamp(receivedAt).valid) fail(context.requestId, "invalid_translation_timestamp", "Translation timestamp generation failed.", 500);
  let cacheTtl: string | undefined;
  if (hasOwn(body, "prompt_cache_options") && body["prompt_cache_options"] !== null) {
    const options = body["prompt_cache_options"];
    if (isPlainObject(options) && typeof options["ttl"] === "string") cacheTtl = options["ttl"];
  }
  const state: TranslationState = { requestId: context.requestId, consumed: [], consumedSet: new Set(), capabilities: new Set(), ...(cacheTtl === undefined ? {} : { cacheTtl }) };
  if (cacheTtl !== undefined) mark(state, "prompt_cache_options.ttl");
  const model = requireString(body["model"], state, "model", "invalid_model", "Expected a non-empty model.");
  const rawMessages = body["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) fail(context.requestId, "invalid_messages", "Expected a non-empty messages array.", 400, "messages");
  const messages = rawMessages.map((message, index) => parseMessage(message, state, `messages[${index}]`));
  const tools = hasOwn(body, "tools") && body["tools"] !== null ? parseTools(body["tools"] as JsonValue, state, "tools") : undefined;
  const toolChoice = hasOwn(body, "tool_choice") && body["tool_choice"] !== null ? parseToolChoice(body["tool_choice"] as JsonValue, state, "tool_choice") : undefined;
  const parallelToolCalls = optionalBoolean(body, "parallel_tool_calls", state, "");
  const sampling = parseSampling(body, state);
  const output = parseOutput(body, state);
  const reasoning = parseReasoning(body, state);
  const metadata = hasOwn(body, "metadata") && body["metadata"] !== null
    ? requireObject(body["metadata"] as JsonValue, state, "metadata", "invalid_openai_chat_request", "Expected a metadata object.")
    : undefined;
  if (metadata !== undefined) markTree(state, "metadata", metadata);
  const store = optionalBoolean(body, "store", state, "");
  const stream = optionalBoolean(body, "stream", state, "") ?? false;
  let streamOptions: { includeUsage?: boolean } | undefined;
  if (hasOwn(body, "stream_options") && body["stream_options"] !== null) {
    const options = requireObject(body["stream_options"] as JsonValue, state, "stream_options", "invalid_openai_chat_request", "Expected stream options.");
    const includeUsage = optionalBoolean(options, "include_usage", state, "stream_options");
    if (includeUsage !== undefined) streamOptions = Object.freeze({ includeUsage });
  }
  let serviceTier: CanonicalRequest["serviceTier"];
  if (hasOwn(body, "service_tier") && body["service_tier"] !== null) {
    const tier = body["service_tier"];
    if (typeof tier !== "string" || SERVICE_TIERS[tier] !== true) fail(context.requestId, "invalid_openai_chat_request", "Expected a supported service tier.", 400, "service_tier");
    if (tier === "auto" || tier === "default" || tier === "priority") {
      mark(state, "service_tier");
      serviceTier = Object.freeze({ tier: tier === "default" ? "standard" : tier });
    }
  }
  const routing = parseRouting(body, state);
  const extensionsBody = extensionBody(body, state.consumedSet);
  const request: CanonicalRequest = {
    requestId: context.requestId,
    receivedAt,
    source: Object.freeze({ adapter: PROTOCOL, protocol: PROTOCOL, path: input.path }),
    model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(sampling === undefined ? {} : { sampling }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(output === undefined ? {} : { output }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(store === undefined ? {} : { persistence: Object.freeze({ store }) }),
    routing,
    stream,
    ...(streamOptions === undefined ? {} : { streamOptions }),
    ...(metadata === undefined ? {} : { metadata }),
    extensions: Object.freeze({ protocols: Object.freeze({ [PROTOCOL]: Object.freeze({ protocol: PROTOCOL, body: extensionsBody, headers: Object.freeze({}), sourceFields: Object.freeze(depthFirstConsumedFields(body, state.consumedSet)) }) }) }),
  };
  const validation = validateCanonicalRequest(request);
  if (!validation.valid) fail(context.requestId, "invalid_openai_chat_request", "Canonical request validation failed.", 400, validation.issues[0]?.path ?? "request");
  return freezeOwned(request);
}

function unixTimestamp(timestamp: string, requestId: string): number {
  if (!validateRfc3339Timestamp(timestamp).valid) fail(requestId, "invalid_openai_chat_egress", "Canonical response cannot be encoded safely.", 500, "createdAt");
  return Math.floor(Date.parse(timestamp) / 1000);
}

function mapCitation(citation: Citation): JsonObject | undefined {
  if (citation.kind === "url" && citation.url !== undefined) return { type: "url_citation", url_citation: { url: citation.url, ...(citation.sourceTitle === undefined ? {} : { title: citation.sourceTitle }), ...(citation.startIndex === undefined ? {} : { start_index: citation.startIndex }), ...(citation.endIndex === undefined ? {} : { end_index: citation.endIndex }) } };
  if (citation.kind === "file" && citation.sourceId !== undefined) return { type: "file_citation", file_citation: { file_id: citation.sourceId, ...(citation.citedText === undefined ? {} : { quote: citation.citedText }) } };
  return undefined;
}

function mapFinishReason(reason: FinishReason, hasRefusal: boolean, requestId: string): string {
  if (reason === "stop") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "content_filter") return "content_filter";
  if (reason === "refusal" && hasRefusal) return "stop";
  return fail(requestId, "invalid_openai_chat_egress", "Canonical finish reason cannot be encoded safely.", 500, "finishReason");
}

function mapLogprobs(choice: CanonicalChoice): JsonValue {
  if (choice.logprobs === undefined) return null;
  return { content: choice.logprobs.map((token) => ({ token: token.token, logprob: token.logprob, ...(token.bytes === undefined ? {} : { bytes: token.bytes }), top_logprobs: (token.topAlternatives ?? []).map((entry) => ({ token: entry.token, logprob: entry.logprob, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })) })) };
}

function mapUsage(usage: TokenUsage): JsonObject {
  const promptDetails: JsonObject = {};
  if (usage.cachedInputTokens !== undefined) promptDetails["cached_tokens"] = usage.cachedInputTokens;
  if (usage.audioInputTokens !== undefined) promptDetails["audio_tokens"] = usage.audioInputTokens;
  if (usage.cacheWriteBreakdown !== undefined) promptDetails["cache_write_tokens"] = usage.cacheWriteBreakdown.reduce((total, item) => total + item.tokens, 0);
  const completionDetails: JsonObject = {};
  if (usage.reasoningTokens !== undefined) completionDetails["reasoning_tokens"] = usage.reasoningTokens;
  if (usage.audioOutputTokens !== undefined) completionDetails["audio_tokens"] = usage.audioOutputTokens;
  if (usage.acceptedPredictionTokens !== undefined) completionDetails["accepted_prediction_tokens"] = usage.acceptedPredictionTokens;
  if (usage.rejectedPredictionTokens !== undefined) completionDetails["rejected_prediction_tokens"] = usage.rejectedPredictionTokens;
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens, ...(Object.keys(promptDetails).length === 0 ? {} : { prompt_tokens_details: promptDetails }), ...(Object.keys(completionDetails).length === 0 ? {} : { completion_tokens_details: completionDetails }) };
}
function replayOutput(blocks: readonly ContentBlock[], exposeReasoningText: boolean, requestId: string): JsonValue[] | undefined {
  const requiresReplay = blocks.some((block) => block.type === "reasoning" || block.cacheBreakpoint !== undefined || ((block.type === "text" || block.type === "refusal") && block.citations !== undefined)) || blocks.some((block, index) => index > 0 && block.type !== blocks[index - 1]?.type);
  if (!requiresReplay) return undefined;
  return blocks.map((block): JsonValue => {
    const common = { ...(block.id === undefined ? {} : { id: block.id }), ...(block.cacheBreakpoint === undefined ? {} : { prompt_cache_breakpoint: block.cacheBreakpoint }) };
    if (block.type === "text") return { ...common, type: "text", text: block.text, ...(block.citations === undefined ? {} : { annotations: block.citations.map(mapCitation).filter((value): value is JsonObject => value !== undefined) }) };
    if (block.type === "reasoning") return { ...common, type: "reasoning", ...(exposeReasoningText && block.text !== undefined ? { text: block.text } : {}) };
    if (block.type === "refusal") return { ...common, type: "refusal", refusal: block.refusal, ...(block.citations === undefined ? {} : { annotations: block.citations.map(mapCitation).filter((value): value is JsonObject => value !== undefined) }) };
    if (block.type === "tool_call") return { ...common, type: "tool_call", id: block.toolCallId, name: block.name, arguments: block.argumentsJson };
    if (block.type === "audio_output") return { ...common, type: "audio", ...(block.data === undefined ? {} : { data: block.data }), ...(block.transcript === undefined ? {} : { transcript: block.transcript }), ...(block.expiresAt === undefined ? {} : { expires_at: block.expiresAt }) };
    return fail(requestId, "invalid_openai_chat_egress", "Canonical output block cannot be encoded safely.", 500, "choices.output");
  });
}

function mapChoice(choice: CanonicalChoice, exposeReasoningText: boolean, requestId: string): JsonObject {
  const text: string[] = [];
  const refusals: string[] = [];
  const toolCalls: JsonValue[] = [];
  const annotations: JsonValue[] = [];
  let audio: JsonObject | undefined;
  for (const block of choice.output) {
    if (block.type === "text") {
      text.push(block.text);
      for (const citation of block.citations ?? []) { const mapped = mapCitation(citation); if (mapped !== undefined) annotations.push(mapped); }
    } else if (block.type === "refusal") {
      refusals.push(block.refusal);
      for (const citation of block.citations ?? []) { const mapped = mapCitation(citation); if (mapped !== undefined) annotations.push(mapped); }
    } else if (block.type === "tool_call") {
      if (!validateToolCallArgumentsJson(block.argumentsJson).valid) fail(requestId, "invalid_openai_chat_egress", "Canonical tool arguments cannot be encoded safely.", 500, "choices.output.argumentsJson");
      toolCalls.push({ id: block.toolCallId, type: "function", function: { name: block.name, arguments: block.argumentsJson } });
    } else if (block.type === "audio_output") {
      if (audio !== undefined) fail(requestId, "invalid_openai_chat_egress", "Multiple audio outputs cannot be represented safely.", 500, "choices.output");
      audio = { ...(block.data === undefined ? {} : { data: block.data }), ...(block.transcript === undefined ? {} : { transcript: block.transcript }), ...(block.expiresAt === undefined ? {} : { expires_at: block.expiresAt }) };
    } else if (block.type !== "reasoning") fail(requestId, "invalid_openai_chat_egress", "Canonical output block cannot be encoded safely.", 500, "choices.output");
  }
  const replay = replayOutput(choice.output, exposeReasoningText, requestId);
  const message: JsonObject = { role: "assistant", content: text.length === 0 ? null : text.join(""), ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }), ...(refusals.length === 0 ? {} : { refusal: refusals.join("") }), ...(annotations.length === 0 ? {} : { annotations }), ...(audio === undefined ? {} : { audio }) };
  return { index: choice.index, message, logprobs: mapLogprobs(choice), finish_reason: mapFinishReason(choice.finishReason, refusals.length > 0, requestId), ...(replay === undefined ? {} : { output: replay }) };
}


function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateResponseForEgress(response: CanonicalResponse): void {
  const requestId = response.requestId;
  const safeCanonical = isSafeCanonicalResponse(response as unknown);
  if (!safeCanonical) fail(requestId, "invalid_openai_chat_egress", "Canonical response cannot be encoded safely.", 500, "response");
  if (response.responseId.length === 0 || response.model.length === 0) fail(response.requestId, "invalid_openai_chat_egress", "Canonical response cannot be encoded safely.", 500, "response");
  for (const [choiceIndex, choice] of response.choices.entries()) {
    for (const [blockIndex, block] of choice.output.entries()) {
      if (block.id !== undefined && block.id.length === 0) fail(response.requestId, "invalid_openai_chat_egress", "Canonical output identifier cannot be encoded safely.", 500, `choices[${choiceIndex}].output[${blockIndex}].id`);
      if (block.type === "tool_call" && (block.toolCallId.length === 0 || block.name.length === 0)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical tool call cannot be encoded safely.", 500, `choices[${choiceIndex}].output[${blockIndex}]`);
      if (block.type === "audio_output" && block.expiresAt !== undefined && !validateRfc3339Timestamp(block.expiresAt).valid) fail(response.requestId, "invalid_openai_chat_egress", "Canonical audio output cannot be encoded safely.", 500, `choices[${choiceIndex}].output[${blockIndex}].expiresAt`);
      if (block.type === "text" || block.type === "refusal") {
        for (const [citationIndex, citation] of (block.citations ?? []).entries()) {
          if (citation.kind !== "url" && citation.kind !== "file") fail(response.requestId, "invalid_openai_chat_egress", "Canonical citation cannot be represented safely.", 500, `choices[${choiceIndex}].output[${blockIndex}].citations[${citationIndex}]`);
          if (citation.kind === "url" && citation.url === undefined) fail(response.requestId, "invalid_openai_chat_egress", "Canonical citation cannot be encoded safely.", 500, `choices[${choiceIndex}].output[${blockIndex}].citations[${citationIndex}]`);
          if (citation.kind === "file" && (citation.sourceId === undefined || citation.sourceId.length === 0)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical citation cannot be encoded safely.", 500, `choices[${choiceIndex}].output[${blockIndex}].citations[${citationIndex}]`);
        }
      }
    }
    if (!Number.isSafeInteger(choice.index) || choice.index < 0) fail(response.requestId, "invalid_openai_chat_egress", "Canonical choice cannot be encoded safely.", 500, `choices[${choiceIndex}].index`);
    for (const [tokenIndex, token] of (choice.logprobs ?? []).entries()) {
      if (token.token.length === 0 || typeof token.logprob !== "number" || !Number.isFinite(token.logprob)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical log probabilities cannot be encoded safely.", 500, `choices[${choiceIndex}].logprobs[${tokenIndex}]`);
      for (const byte of token.bytes ?? []) if (!Number.isInteger(byte) || byte < 0 || byte > 255) fail(response.requestId, "invalid_openai_chat_egress", "Canonical log probabilities cannot be encoded safely.", 500, `choices[${choiceIndex}].logprobs[${tokenIndex}].bytes`);
      for (const alternative of token.topAlternatives ?? []) {
        if (alternative.token.length === 0 || typeof alternative.logprob !== "number" || !Number.isFinite(alternative.logprob)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical log probabilities cannot be encoded safely.", 500, `choices[${choiceIndex}].logprobs[${tokenIndex}].topAlternatives`);
        for (const byte of alternative.bytes ?? []) if (!Number.isInteger(byte) || byte < 0 || byte > 255) fail(response.requestId, "invalid_openai_chat_egress", "Canonical log probabilities cannot be encoded safely.", 500, `choices[${choiceIndex}].logprobs[${tokenIndex}].topAlternatives.bytes`);
      }
    }
  }
  for (const [key, value] of Object.entries(response.usage)) {
    if (key === "cacheWriteBreakdown" || key === "serverToolUsage") continue;
    if (!finiteNonNegative(value)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical usage cannot be encoded safely.", 500, `usage.${key}`);
  }
  for (const [index, item] of (response.usage.cacheWriteBreakdown ?? []).entries()) if (!finiteNonNegative(item.tokens) || !finiteNonNegative(item.ttlSeconds)) fail(response.requestId, "invalid_openai_chat_egress", "Canonical usage cannot be encoded safely.", 500, `usage.cacheWriteBreakdown[${index}]`);
}

function encodeResponse(response: CanonicalResponse, exposeReasoningText: boolean): EgressValue {
  validateResponseForEgress(response);
  const created = unixTimestamp(response.createdAt, response.requestId);
  return { id: response.responseId, object: "chat.completion", created, model: response.model, choices: response.choices.map((choice) => mapChoice(choice, exposeReasoningText, response.requestId)), usage: mapUsage(response.usage) };
}

function safeError(error: GatewayError): JsonObject {
  const details = redactDetails(error.details);
  return { error: { code: error.code, message: error.message, category: error.category, retryable: error.retryable, status: error.status, requestId: error.requestId, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }), ...(details === undefined ? {} : { details: details as JsonValue }) } };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chunkMetadata(chunk: CanonicalChunk, context: TranslationContext): { responseId: string; model: string; createdAt: string } {
  if (chunk.type === "response_start") return chunk;
  if (context.streamResponse === undefined) fail(context.requestId, "missing_stream_response_metadata", "Stream response metadata is required.", 500);
  return context.streamResponse;
}

function chunkEnvelope(chunk: CanonicalChunk, context: TranslationContext, choices: JsonValue[], usage?: TokenUsage): JsonObject {
  const metadata = chunkMetadata(chunk, context);
  return { id: metadata.responseId, object: "chat.completion.chunk", created: unixTimestamp(metadata.createdAt, context.requestId), model: metadata.model, choices, ...(usage === undefined ? {} : { usage: mapUsage(usage) }) };
}

function deltaChoice(index: number, delta: JsonObject, finishReason: JsonValue = null): JsonObject {
  return { index, delta, logprobs: null, finish_reason: finishReason };
}

function mapChunk(chunk: CanonicalChunk, context: TranslationContext, exposeReasoningText: boolean): string {
  if (chunk.type === "error") return `${sse(safeError(chunk.error))}data: [DONE]\n\n`;
  if (chunk.type === "response_start") return sse(chunkEnvelope(chunk, context, [deltaChoice(0, { role: "assistant", content: "" })]));
  if (chunk.type === "ping") return sse(chunkEnvelope(chunk, context, []));
  if (chunk.type === "usage") return sse(chunkEnvelope(chunk, context, [], chunk.usage));
  if (chunk.type === "response_end") return `${sse(chunkEnvelope(chunk, context, []))}data: [DONE]\n\n`;
  if (chunk.type === "choice_end") return sse(chunkEnvelope(chunk, context, [deltaChoice(chunk.choiceIndex ?? 0, {}, mapFinishReason(chunk.finishReason, chunk.finishReason === "refusal", context.requestId))]));
  const index = chunk.address.choiceIndex ?? 0;
  if (chunk.type === "content_block_start") {
    const delta: JsonObject = {};
    if (chunk.block.type === "tool_call") delta["tool_calls"] = [{ index: chunk.address.outputIndex, ...(chunk.block.id === undefined ? {} : { id: chunk.block.id }), type: "function", function: { ...(chunk.block.name === undefined ? {} : { name: chunk.block.name }), arguments: "" } }];
    return sse(chunkEnvelope(chunk, context, [deltaChoice(index, delta)]));
  }
  if (chunk.type === "content_block_stop") return sse(chunkEnvelope(chunk, context, [deltaChoice(index, {})]));
  if (chunk.type === "text_delta") return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { content: chunk.text })]));
  if (chunk.type === "refusal_delta") return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { refusal: chunk.text })]));
  if (chunk.type === "reasoning_delta") {
    if (!exposeReasoningText || chunk.text === undefined) return sse(chunkEnvelope(chunk, context, []));
    return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { reasoning: chunk.text })]));
  }
  if (chunk.type === "audio_delta") return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { audio: { ...(chunk.audioBase64 === undefined ? {} : { data: chunk.audioBase64 }), ...(chunk.transcriptDelta === undefined ? {} : { transcript: chunk.transcriptDelta }) } })]));
  if (chunk.type === "tool_call_delta") return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { tool_calls: [{ index: chunk.address.outputIndex, ...(chunk.id === undefined ? {} : { id: chunk.id }), type: "function", function: { ...(chunk.name === undefined ? {} : { name: chunk.name }), ...(chunk.argumentsDelta === undefined ? {} : { arguments: chunk.argumentsDelta }) } }] })]));
  const citation = mapCitation(chunk.citation);
  if (citation === undefined) fail(context.requestId, "invalid_openai_chat_egress", "Canonical citation cannot be encoded safely.", 500, "citation");
  return sse(chunkEnvelope(chunk, context, [deltaChoice(index, { annotations: [citation] })]));
}

class OpenAiChatIngressAdapter implements IngressTranslationAdapter {
  readonly protocol = PROTOCOL;
  readonly paths: ReadonlySet<string> = new ImmutablePathSet(CHAT_PATHS);
  readonly #now: () => string;

  constructor(now: () => string) {
    this.#now = now;
    Object.freeze(this);
  }

  canTranslate(path: string, body: unknown): boolean {
    return this.paths.has(path) && isObject(body);
  }

  translate(input: RawIngressInput, context: TranslationContext): CanonicalRequest {
    return translateRequest(input, context, this.#now);
  }
}

class OpenAiChatEgressAdapter implements EgressTranslationAdapter {
  readonly protocol = PROTOCOL;
  readonly #exposeReasoningText: boolean;

  constructor(exposeReasoningText: boolean) {
    this.#exposeReasoningText = exposeReasoningText;
    Object.freeze(this);
  }

  encodeResponse(response: CanonicalResponse, _context: TranslationContext): EgressValue {
    return encodeResponse(response, this.#exposeReasoningText);
  }

  encodeChunk(chunk: CanonicalChunk, context: TranslationContext): EgressValue {
    return mapChunk(chunk, context, this.#exposeReasoningText);
  }

  encodeError(error: GatewayError, _context: TranslationContext): EgressValue {
    return safeError(error);
  }
}

/**
 * Creates one immutable, stateless OpenAI Chat ingress/egress family.
 *
 * The caller owns the injected clock. Synchronous translation failures are typed,
 * body-free {@link GatewayError} values; adapters retain no request or stream state.
 */
export function createOpenAiChatTranslatorFamily(options: OpenAiChatTranslatorOptions): OpenAiChatTranslatorFamily {
  return Object.freeze({ ingress: new OpenAiChatIngressAdapter(options.now), egress: new OpenAiChatEgressAdapter(options.exposeReasoningText ?? false) });
}
