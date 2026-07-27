import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  Citation,
  ContentBlock,
  FinishReason,
  GatewayError,
  JsonValue,
  McpServerConnection,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../../domain/index.js";
import {
  createGatewayError,
  isSafeCanonicalResponse,
  validateBase64Media,
  validateCanonicalRequest,
  validateContentBlock,
  validateRfc3339Timestamp,
  validateToolCallArgumentsJson,
  validateUrl,
} from "../../domain/index.js";
import type {
  EgressTranslationAdapter,
  EgressValue,
  IngressTranslationAdapter,
  RawIngressInput,
  StreamTranslationState,
  TranslationContext,
} from "../../ports/index.js";

const PROTOCOL = "anthropic-messages" as const;
const PATHS = ["/messages", "/v1/messages"] as const;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

type JsonObject = Record<string, JsonValue>;
type FailureCode =
  | "invalid_anthropic_messages_request"
  | "invalid_anthropic_messages_egress"
  | "unsupported_anthropic_messages_feature"
  | "invalid_model"
  | "invalid_messages"
  | "invalid_message_content"
  | "invalid_media"
  | "invalid_tool_arguments"
  | "invalid_range"
  | "invalid_translation_timestamp";

/** Construction options for the stateless Anthropic Messages translator family. */
export interface AnthropicMessagesTranslatorOptions {
  readonly now: () => string;
  readonly exposeReasoningText?: boolean;
  readonly exposeReasoningSignatures?: boolean;
  readonly exposeRedactedThinking?: boolean;
  readonly maxEventBytes?: number;
}

/** Public immutable ingress/egress pair for Anthropic Messages. */
export interface AnthropicMessagesTranslatorFamily {
  readonly ingress: IngressTranslationAdapter;
  readonly egress: EgressTranslationAdapter;
}

interface ParseState {
  readonly requestId: string;
  readonly consumed: Set<string>;
  readonly capabilities: Set<string>;
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (!objectValue(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function fail(
  requestId: string,
  code: FailureCode,
  message: string,
  status: number,
  path?: string,
): never {
  throw createGatewayError({
    category: status >= 500 ? "internal" : "validation",
    code,
    message,
    status,
    retryable: false,
    requestId,
    ...(path === undefined ? {} : { details: { path, code } }),
  });
}

function invalidRequest(requestId: string, path = "body"): never {
  return fail(
    requestId,
    "invalid_anthropic_messages_request",
    "Expected a safe Anthropic Messages request.",
    400,
    path,
  );
}

function cloneJson(value: unknown, requestId: string): JsonValue {
  const active = new WeakSet<object>();
  const clone = (current: unknown, path: string): JsonValue => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidRequest(requestId, path);
      return current;
    }
    if (typeof current !== "object" || active.has(current)) {
      return invalidRequest(requestId, path);
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const descriptors = Object.getOwnPropertyDescriptors(current);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (key === "length") continue;
          const descriptor = typeof key === "string" ? descriptors[key] : undefined;
          const index =
            typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
              ? Number(key)
              : -1;
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor) ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== key
          ) {
            invalidRequest(requestId, path);
          }
        }
        const output = new Array<JsonValue>(current.length);
        for (let index = 0; index < current.length; index += 1) {
          if (hasOwn(current, String(index))) {
            output[index] = clone(current[index], `${path}[${index}]`);
          }
        }
        Object.freeze(output);
        return output;
      }
      if (!isPlainObject(current)) invalidRequest(requestId, path);
      const output: JsonObject = Object.create(null) as JsonObject;
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") invalidRequest(requestId, path);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          invalidRequest(requestId, childPath(path, key));
        }
        Object.defineProperty(output, key, {
          value: clone(
            descriptor.value,
            path === "body" ? key : childPath(path, key),
          ),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return Object.freeze(output);
    } finally {
      active.delete(current);
    }
  };
  return clone(value, "body");
}

function mark(state: ParseState, path: string): void {
  state.consumed.add(path);
}

function markTree(state: ParseState, path: string, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) mark(state, path);
    else value.forEach((entry, index) => markTree(state, `${path}[${index}]`, entry));
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) mark(state, path);
    else {
      for (const [key, entry] of entries) {
        markTree(state, childPath(path, key), entry);
      }
    }
    return;
  }
  mark(state, path);
}

function extensionBody(root: JsonObject, consumed: ReadonlySet<string>): JsonObject {
  const visit = (value: JsonValue, path: string): JsonValue | undefined => {
    if (consumed.has(path)) return undefined;
    if (Array.isArray(value)) {
      const entries = new Array<JsonValue>(value.length);
      let retained = false;
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, String(index))) continue;
        const mapped = visit(value[index] as JsonValue, `${path}[${index}]`);
        if (mapped !== undefined) {
          entries[index] = mapped;
          retained = true;
        } else {
          entries[index] = Object.create(null) as JsonObject;
        }
      }
      return retained ? entries : undefined;
    }
    if (isPlainObject(value)) {
      const output: JsonObject = Object.create(null) as JsonObject;
      for (const [key, entry] of Object.entries(value)) {
        const mapped = visit(entry, childPath(path, key));
        if (mapped !== undefined) output[key] = mapped;
      }
      return Object.keys(output).length === 0 ? undefined : output;
    }
    return value;
  };
  return (visit(root, "") as JsonObject | undefined) ?? {};
}

function sourceFields(root: JsonObject, consumed: ReadonlySet<string>): string[] {
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
      else for (const [key, entry] of entries) visit(entry, childPath(path, key));
      return;
    }
    if (consumed.has(path)) fields.push(path);
  };
  visit(root, "");
  return fields;
}

function freezeOwned<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeOwned(entry, seen);
  }
  return Object.freeze(value);
}

function requiredObject(
  value: JsonValue | undefined,
  state: ParseState,
  path: string,
): JsonObject {
  if (!isPlainObject(value)) invalidRequest(state.requestId, path);
  return value;
}

function requiredString(
  value: JsonValue | undefined,
  state: ParseState,
  path: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalidRequest(state.requestId, path);
  }
  mark(state, path);
  return value;
}

function optionalBoolean(
  object: JsonObject,
  key: string,
  state: ParseState,
  parent = "",
): boolean | undefined {
  if (!hasOwn(object, key)) return undefined;
  const path = childPath(parent, key);
  if (typeof object[key] !== "boolean") invalidRequest(state.requestId, path);
  mark(state, path);
  return object[key];
}

function cacheBreakpoint(
  object: JsonObject,
  state: ParseState,
  parent: string,
): { ttl?: string } | undefined {
  if (!hasOwn(object, "cache_control")) return undefined;
  const path = childPath(parent, "cache_control");
  if (object["cache_control"] === null) return undefined;
  const cache = requiredObject(object["cache_control"], state, path);
  if (cache["type"] !== "ephemeral") invalidRequest(state.requestId, `${path}.type`);
  mark(state, `${path}.type`);
  const ttl = cache["ttl"];
  if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") {
    invalidRequest(state.requestId, `${path}.ttl`);
  }
  if (ttl !== undefined) mark(state, `${path}.ttl`);
  return ttl === undefined ? {} : { ttl };
}

function citationFromWire(value: JsonValue, state: ParseState, path: string): Citation {
  const citation = requiredObject(value, state, path);
  const type = requiredString(citation["type"], state, `${path}.type`);
  const raw = citation;
  const common = {
    ...(typeof citation["document_title"] === "string"
      ? { sourceTitle: citation["document_title"] }
      : {}),
    ...(typeof citation["cited_text"] === "string"
      ? { citedText: citation["cited_text"] }
      : {}),
    raw,
  };
  markTree(state, path, citation);
  if (type === "char_location") {
    return {
      kind: "char_span",
      ...common,
      ...(Number.isInteger(citation["start_char_index"])
        ? { startIndex: citation["start_char_index"] as number }
        : {}),
      ...(Number.isInteger(citation["end_char_index"])
        ? { endIndex: citation["end_char_index"] as number }
        : {}),
    };
  }
  if (type === "page_location") {
    return {
      kind: "page_span",
      ...common,
      ...(Number.isInteger(citation["start_page_number"])
        ? { pageStart: citation["start_page_number"] as number }
        : {}),
      ...(Number.isInteger(citation["end_page_number"])
        ? { pageEnd: citation["end_page_number"] as number }
        : {}),
    };
  }
  if (type === "content_block_location") {
    return {
      kind: "block_span",
      ...common,
      ...(Number.isInteger(citation["start_block_index"])
        ? { startIndex: citation["start_block_index"] as number }
        : {}),
      ...(Number.isInteger(citation["end_block_index"])
        ? { endIndex: citation["end_block_index"] as number }
        : {}),
    };
  }
  if (
    type === "search_result_location" ||
    type === "web_search_result_location"
  ) {
    return {
      kind: "search_result_span",
      ...common,
      ...(typeof citation["search_result_index"] === "number"
        ? { startIndex: citation["search_result_index"] }
        : {}),
      ...(typeof citation["url"] === "string" ? { url: citation["url"] } : {}),
      ...(typeof citation["source"] === "string"
        ? { sourceId: citation["source"] }
        : {}),
    };
  }
  invalidRequest(state.requestId, `${path}.type`);
}

function parseContentBlock(
  value: JsonValue,
  state: ParseState,
  path: string,
): ContentBlock {
  const block = requiredObject(value, state, path);
  const type = requiredString(block["type"], state, `${path}.type`);
  const cache = cacheBreakpoint(block, state, path);
  const base = cache === undefined ? {} : { cacheBreakpoint: cache };
  if (type === "text") {
    const text = requiredString(block["text"], state, `${path}.text`, true);
    let citations: Citation[] | undefined;
    if (hasOwn(block, "citations")) {
      if (!Array.isArray(block["citations"])) invalidRequest(state.requestId, `${path}.citations`);
      citations = block["citations"].map((entry, index) =>
        citationFromWire(entry, state, `${path}.citations[${index}]`),
      );
      state.capabilities.add("citations");
    }
    return { type: "text", text, ...(citations === undefined ? {} : { citations }), ...base };
  }
  if (type === "image" || type === "audio" || type === "document") {
    const sourcePath = `${path}.source`;
    const source = requiredObject(block["source"], state, sourcePath);
    const sourceType = requiredString(source["type"], state, `${sourcePath}.type`);
    if (sourceType === "url") {
      const url = requiredString(source["url"], state, `${sourcePath}.url`);
      if (!validateUrl(url).valid) {
        fail(state.requestId, "invalid_media", "Expected a safe media URL.", 400, `${sourcePath}.url`);
      }
      if (type === "image") {
        state.capabilities.add("vision");
        return { type: "image_url", url, ...base };
      }
      if (type === "audio") {
        state.capabilities.add("audio_input");
        const format = typeof source["format"] === "string" ? source["format"] : undefined;
        if (format !== undefined) mark(state, `${sourcePath}.format`);
        return { type: "audio_url", url, ...(format === undefined ? {} : { format }), ...base };
      }
      state.capabilities.add("multimodal");
      const title = typeof block["title"] === "string" ? block["title"] : undefined;
      if (title !== undefined) mark(state, `${path}.title`);
      return { type: "document_url", url, ...(title === undefined ? {} : { title }), ...base };
    }
    if (sourceType === "base64") {
      const mediaType = requiredString(source["media_type"], state, `${sourcePath}.media_type`);
      const data = requiredString(source["data"], state, `${sourcePath}.data`, true);
      if (!validateBase64Media(data, mediaType).valid) {
        fail(state.requestId, "invalid_media", "Expected valid base64 media.", 400, sourcePath);
      }
      if (type === "image") {
        state.capabilities.add("vision");
        return { type: "image_base64", mediaType, data, ...base };
      }
      if (type === "audio") {
        state.capabilities.add("audio_input");
        return { type: "audio_base64", mediaType, data, ...base };
      }
      state.capabilities.add("multimodal");
      const title = typeof block["title"] === "string" ? block["title"] : undefined;
      if (title !== undefined) mark(state, `${path}.title`);
      return { type: "document_base64", mediaType, data, ...(title === undefined ? {} : { title }), ...base };
    }
    if (type === "document" && (sourceType === "file" || sourceType === "file_id")) {
      const fileId = requiredString(source["file_id"], state, `${sourcePath}.file_id`);
      return { type: "file_reference", fileId, ...base };
    }
    invalidRequest(state.requestId, `${sourcePath}.type`);
  }
  if (type === "search_result") {
    state.capabilities.add("citations");
    const rawContent = block["content"];
    let text: string;
    if (typeof rawContent === "string") {
      text = requiredString(rawContent, state, `${path}.content`, true);
    } else if (
      Array.isArray(rawContent) &&
      rawContent.every(
        (entry) => isPlainObject(entry) && entry["type"] === "text" && typeof entry["text"] === "string",
      )
    ) {
      text = rawContent.map((entry) => (entry as JsonObject)["text"] as string).join("");
      markTree(state, `${path}.content`, rawContent);
    } else {
      invalidRequest(state.requestId, `${path}.content`);
    }
    const citationsValue = block["citations"];
    const citationsEnabled =
      typeof citationsValue === "boolean"
        ? citationsValue
        : isPlainObject(citationsValue) && typeof citationsValue["enabled"] === "boolean"
          ? citationsValue["enabled"]
          : undefined;
    if (citationsEnabled !== undefined) markTree(state, `${path}.citations`, citationsValue as JsonValue);
    return {
      type: "search_result",
      sourceId: requiredString(block["source"], state, `${path}.source`),
      title: requiredString(block["title"], state, `${path}.title`, true),
      text,
      ...(citationsEnabled === undefined ? {} : { citationsEnabled }),
      ...base,
    };
  }
  if (type === "thinking") {
    state.capabilities.add("reasoning");
    const text = requiredString(block["thinking"], state, `${path}.thinking`, true);
    const signature = typeof block["signature"] === "string" ? block["signature"] : undefined;
    if (signature !== undefined) mark(state, `${path}.signature`);
    return { type: "reasoning", text, ...(signature === undefined ? {} : { signature }), ...base };
  }
  if (type === "redacted_thinking") {
    state.capabilities.add("reasoning");
    return {
      type: "reasoning",
      redactedData: requiredString(block["data"], state, `${path}.data`, true),
      ...base,
    };
  }
  if (type === "tool_use") {
    state.capabilities.add("tools");
    const input = requiredObject(block["input"], state, `${path}.input`);
    markTree(state, `${path}.input`, input);
    const argumentsJson = JSON.stringify(input);
    if (!validateToolCallArgumentsJson(argumentsJson).valid) {
      fail(state.requestId, "invalid_tool_arguments", "Expected valid tool input.", 400, `${path}.input`);
    }
    return {
      type: "tool_call",
      toolCallId: requiredString(block["id"], state, `${path}.id`),
      name: requiredString(block["name"], state, `${path}.name`),
      argumentsJson,
      ...base,
    };
  }
  if (type === "tool_result") {
    state.capabilities.add("tools");
    const toolCallId = requiredString(block["tool_use_id"], state, `${path}.tool_use_id`);
    const contentValue = block["content"];
    let content: ContentBlock[];
    if (typeof contentValue === "string") {
      mark(state, `${path}.content`);
      content = [{ type: "text", text: contentValue }];
    } else if (Array.isArray(contentValue) && contentValue.length > 0) {
      content = contentValue.map((entry, index) => parseContentBlock(entry, state, `${path}.content[${index}]`));
    } else {
      invalidRequest(state.requestId, `${path}.content`);
    }
    return {
      type: "tool_result",
      toolCallId,
      content,
      ...(optionalBoolean(block, "is_error", state, path) === true ? { isError: true } : {}),
      ...base,
    };
  }
  if (type === "server_tool_use" || type === "mcp_tool_use" || type.endsWith("_tool_use")) {
    state.capabilities.add("server_tools");
    const input = hasOwn(block, "input") ? block["input"] : undefined;
    if (input !== undefined) markTree(state, `${path}.input`, input);
    return {
      type: "server_tool_call",
      toolCallId: requiredString(block["id"], state, `${path}.id`),
      toolKind: type === "server_tool_use" ? (typeof block["name"] === "string" ? block["name"] : type) : type.replace(/_tool_use$/, ""),
      ...(typeof block["name"] === "string" ? (mark(state, `${path}.name`), { name: block["name"] }) : {}),
      ...(typeof block["server_name"] === "string" ? (mark(state, `${path}.server_name`), { serverName: block["server_name"] }) : {}),
      ...(input === undefined ? {} : { input }),
      ...base,
    };
  }
  if (type === "mcp_tool_result" || type.endsWith("_tool_result")) {
    state.capabilities.add("server_tools");
    const toolCallId = requiredString(block["tool_use_id"], state, `${path}.tool_use_id`);
    const rawContent = block["content"];
    let content: ContentBlock[];
    if (typeof rawContent === "string") {
      mark(state, `${path}.content`);
      content = [{ type: "text", text: rawContent }];
    } else if (Array.isArray(rawContent) && rawContent.length > 0) {
      content = rawContent.map((entry, index) => parseContentBlock(entry, state, `${path}.content[${index}]`));
    } else {
      markTree(state, `${path}.content`, rawContent ?? null);
      content = [{ type: "text", text: JSON.stringify(rawContent ?? null) }];
    }
    return {
      type: "server_tool_result",
      toolCallId,
      toolKind: type.replace(/_tool_result$/, ""),
      content,
      ...(optionalBoolean(block, "is_error", state, path) === true ? { isError: true } : {}),
      ...base,
    };
  }
  return fail(
    state.requestId,
    "unsupported_anthropic_messages_feature",
    "Unsupported Anthropic content semantics.",
    400,
    `${path}.type`,
  );
}

function parseMessageContent(
  value: JsonValue,
  state: ParseState,
  path: string,
): ContentBlock[] {
  if (typeof value === "string") {
    mark(state, path);
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    fail(state.requestId, "invalid_message_content", "Expected non-empty message content.", 400, path);
  }
  return value.map((entry, index) => parseContentBlock(entry, state, `${path}[${index}]`));
}

function parseSystemContent(
  value: JsonValue,
  state: ParseState,
  path: string,
): ContentBlock[] {
  if (typeof value === "string") {
    mark(state, path);
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value) || value.length === 0) invalidRequest(state.requestId, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const block = requiredObject(entry, state, itemPath);
    if (block["type"] !== "text") invalidRequest(state.requestId, `${itemPath}.type`);
    return parseContentBlock(entry, state, itemPath);
  });
}

function parseMessages(body: JsonObject, state: ParseState): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  if (hasOwn(body, "system")) {
    messages.push({ role: "system", content: parseSystemContent(body["system"] as JsonValue, state, "system") });
  }
  const wire = body["messages"];
  if (!Array.isArray(wire) || wire.length === 0) {
    fail(state.requestId, "invalid_messages", "Expected non-empty messages.", 400, "messages");
  }
  wire.forEach((entry, messageIndex) => {
    const path = `messages[${messageIndex}]`;
    const message = requiredObject(entry, state, path);
    const role = requiredString(message["role"], state, `${path}.role`);
    if (role !== "user" && role !== "assistant" && role !== "system") {
      invalidRequest(state.requestId, `${path}.role`);
    }
    const content = message["content"];
    if (content === undefined) invalidRequest(state.requestId, `${path}.content`);
    if (!Array.isArray(content)) {
      messages.push({ role, content: parseMessageContent(content, state, `${path}.content`) });
      return;
    }
    let segment: ContentBlock[] = [];
    const flush = (): void => {
      if (segment.length > 0) messages.push({ role, content: segment });
      segment = [];
    };
    content.forEach((blockValue, blockIndex) => {
      const blockPath = `${path}.content[${blockIndex}]`;
      if (isPlainObject(blockValue) && blockValue["type"] === "mid_conv_system") {
        mark(state, `${blockPath}.type`);
        flush();
        let systemValue: JsonValue | undefined;
        if (hasOwn(blockValue, "content")) {
          systemValue = blockValue["content"];
        } else if (hasOwn(blockValue, "text") && blockValue["text"] !== undefined) {
          const wireText: JsonObject = { type: "text", text: blockValue["text"] };
          if (hasOwn(blockValue, "cache_control") && blockValue["cache_control"] !== undefined) wireText["cache_control"] = blockValue["cache_control"];
          systemValue = [wireText];
        }
        if (systemValue === undefined) invalidRequest(state.requestId, blockPath);
        messages.push({ role: "system", content: parseSystemContent(systemValue, state, hasOwn(blockValue, "content") ? `${blockPath}.content` : blockPath) });
      } else {
        segment.push(parseContentBlock(blockValue, state, blockPath));
      }
    });
    flush();
  });
  return messages;
}

function parseTools(body: JsonObject, state: ParseState): ToolDefinition[] | undefined {
  if (!hasOwn(body, "tools")) return undefined;
  if (!Array.isArray(body["tools"]) || body["tools"].length === 0) invalidRequest(state.requestId, "tools");
  state.capabilities.add("tools");
  return body["tools"].map((entry, index): ToolDefinition => {
    const path = `tools[${index}]`;
    const tool = requiredObject(entry, state, path);
    const cache = cacheBreakpoint(tool, state, path);
    if (hasOwn(tool, "input_schema")) {
      const name = requiredString(tool["name"], state, `${path}.name`);
      const inputSchema = requiredObject(tool["input_schema"], state, `${path}.input_schema`);
      markTree(state, `${path}.input_schema`, inputSchema);
      const description = typeof tool["description"] === "string" ? tool["description"] : undefined;
      if (description !== undefined) mark(state, `${path}.description`);
      const strict = optionalBoolean(tool, "strict", state, path);
      return { kind: "function", name, ...(description === undefined ? {} : { description }), inputSchema, ...(strict === undefined ? {} : { strict }), ...(cache === undefined ? {} : { cacheBreakpoint: cache }) };
    }
    const serverType = requiredString(tool["type"], state, `${path}.type`);
    const providerParameters: JsonObject = {};
    for (const [key, value] of Object.entries(tool)) {
      if (key === "type" || key === "name" || key === "cache_control") continue;
      providerParameters[key] = value;
      markTree(state, `${path}.${key}`, value);
    }
    const name = typeof tool["name"] === "string" ? tool["name"] : undefined;
    if (name !== undefined) mark(state, `${path}.name`);
    if (serverType === "mcp_toolset") state.capabilities.add("mcp"); else state.capabilities.add("server_tools");
    return { kind: "server", serverType, ...(name === undefined ? {} : { name }), ...(typeof tool["mcp_server_name"] === "string" ? { serverName: tool["mcp_server_name"] } : {}), ...(Object.keys(providerParameters).length === 0 ? {} : { providerParameters }), ...(cache === undefined ? {} : { cacheBreakpoint: cache }) };
  });
}

function parseMcpServers(body: JsonObject, state: ParseState): McpServerConnection[] | undefined {
  if (!hasOwn(body, "mcp_servers")) return undefined;
  if (!Array.isArray(body["mcp_servers"]) || body["mcp_servers"].length === 0) invalidRequest(state.requestId, "mcp_servers");
  state.capabilities.add("mcp");
  return body["mcp_servers"].map((entry, index) => {
    const path = `mcp_servers[${index}]`;
    const server = requiredObject(entry, state, path);
    const name = requiredString(server["name"], state, `${path}.name`);
    const url = requiredString(server["url"], state, `${path}.url`);
    if (!validateUrl(url).valid) invalidRequest(state.requestId, `${path}.url`);
    if (hasOwn(server, "type") && server["type"] !== "url") invalidRequest(state.requestId, `${path}.type`);
    const authorizationToken = typeof server["authorization_token"] === "string" ? server["authorization_token"] : undefined;
    if (authorizationToken !== undefined) mark(state, `${path}.authorization_token`);
    const result: McpServerConnection = { name, url, ...(authorizationToken === undefined ? {} : { authorizationToken }) };
    const toolset = Array.isArray(body["tools"]) ? body["tools"].find((tool) => isPlainObject(tool) && tool["type"] === "mcp_toolset" && tool["mcp_server_name"] === name) : undefined;
    if (!isPlainObject(toolset)) invalidRequest(state.requestId, `${path}.name`);
    if (hasOwn(toolset, "default_config")) {
      const config = requiredObject(toolset["default_config"], state, "tools.default_config");
      if (typeof config["enabled"] !== "boolean") invalidRequest(state.requestId, "tools.default_config.enabled");
      result.toolsEnabled = config["enabled"];
    }
    if (hasOwn(toolset, "allowed_tools")) {
      if (!Array.isArray(toolset["allowed_tools"]) || !toolset["allowed_tools"].every((item) => typeof item === "string")) invalidRequest(state.requestId, "tools.allowed_tools");
      result.allowedTools = [...toolset["allowed_tools"]];
    }
    return result;
  });
}

function parseToolChoice(body: JsonObject, state: ParseState): ToolChoice | undefined {
  if (!hasOwn(body, "tool_choice")) return undefined;
  const choice = requiredObject(body["tool_choice"], state, "tool_choice");
  const type = requiredString(choice["type"], state, "tool_choice.type");
  let result: ToolChoice;
  if (type === "auto" || type === "none" || type === "any") result = { mode: type === "any" ? "required" : type };
  else if (type === "tool") result = { mode: "named", name: requiredString(choice["name"], state, "tool_choice.name") };
  else invalidRequest(state.requestId, "tool_choice.type");
  if (hasOwn(choice, "disable_parallel_tool_use")) {
    if (typeof choice["disable_parallel_tool_use"] !== "boolean") invalidRequest(state.requestId, "tool_choice.disable_parallel_tool_use");
    mark(state, "tool_choice.disable_parallel_tool_use");
  }
  return result;
}

function translateRequest(input: RawIngressInput, context: TranslationContext, now: () => string): CanonicalRequest {
  const cloned = cloneJson(input.body, context.requestId);
  if (!isPlainObject(cloned)) invalidRequest(context.requestId);
  const body = cloned;
  let receivedAt: string;
  try { receivedAt = now(); } catch { return fail(context.requestId, "invalid_translation_timestamp", "Translation timestamp generation failed.", 500); }
  if (!validateRfc3339Timestamp(receivedAt).valid) fail(context.requestId, "invalid_translation_timestamp", "Translation timestamp generation failed.", 500);
  const state: ParseState = { requestId: context.requestId, consumed: new Set(), capabilities: new Set() };
  const model = requiredString(body["model"], state, "model");
  const maxTokens = body["max_tokens"];
  if (!Number.isInteger(maxTokens) || (maxTokens as number) < 1) fail(context.requestId, "invalid_range", "Expected positive max_tokens.", 400, "max_tokens");
  mark(state, "max_tokens");
  const messages = parseMessages(body, state);
  const tools = parseTools(body, state);
  const mcpServers = parseMcpServers(body, state);
  const toolChoice = parseToolChoice(body, state);
  const stream = optionalBoolean(body, "stream", state) ?? false;
  const sampling: NonNullable<CanonicalRequest["sampling"]> = { maxTokens: maxTokens as number };
  for (const [wire, canonical] of [["temperature", "temperature"], ["top_p", "topP"]] as const) {
    if (!hasOwn(body, wire)) continue;
    const value = body[wire];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(context.requestId, "invalid_range", "Expected a sampling value from zero to one.", 400, wire);
    sampling[canonical] = value;
    mark(state, wire);
  }
  if (hasOwn(body, "top_k")) {
    if (!Number.isInteger(body["top_k"]) || (body["top_k"] as number) < 0) fail(context.requestId, "invalid_range", "Expected non-negative top_k.", 400, "top_k");
    sampling.topK = body["top_k"] as number;
    mark(state, "top_k");
  }
  if (hasOwn(body, "stop_sequences")) {
    if (!Array.isArray(body["stop_sequences"]) || !body["stop_sequences"].every((item) => typeof item === "string")) invalidRequest(context.requestId, "stop_sequences");
    sampling.stop = [...body["stop_sequences"]];
    markTree(state, "stop_sequences", body["stop_sequences"]);
  }
  let reasoning: CanonicalRequest["reasoning"];
  if (hasOwn(body, "thinking")) {
    const thinking = requiredObject(body["thinking"], state, "thinking");
    const type = requiredString(thinking["type"], state, "thinking.type");
    if (type !== "adaptive" && type !== "enabled" && type !== "disabled") return fail(context.requestId, "unsupported_anthropic_messages_feature", "Unsupported Anthropic thinking mode.", 400, "thinking.type");
    reasoning = { mode: type };
    if (type === "enabled") {
      const budget = thinking["budget_tokens"];
      if (!Number.isInteger(budget) || (budget as number) < 1024 || (budget as number) >= (maxTokens as number)) fail(context.requestId, "invalid_range", "Expected a valid thinking budget.", 400, "thinking.budget_tokens");
      reasoning.budgetTokens = budget as number;
      mark(state, "thinking.budget_tokens");
    }
    if (hasOwn(thinking, "display")) {
      const display = thinking["display"];
      if (display !== "summarized" && display !== "omitted" && display !== null) invalidRequest(context.requestId, "thinking.display");
      if (display !== null) reasoning.display = display;
      mark(state, "thinking.display");
    }
    const providerParameters: JsonObject = {};
    for (const [key, value] of Object.entries(thinking)) {
      if (key === "type" || key === "budget_tokens" || key === "display") continue;
      providerParameters[key] = value;
      markTree(state, `thinking.${key}`, value);
    }
    if (Object.keys(providerParameters).length > 0) reasoning.providerParameters = providerParameters;
    state.capabilities.add("reasoning");
  }
  let output: CanonicalRequest["output"];
  if (hasOwn(body, "output_config")) {
    const config = requiredObject(body["output_config"], state, "output_config");
    output = {};
    if (hasOwn(config, "effort")) {
      const effort = config["effort"];
      if (effort !== "none" && effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh") invalidRequest(context.requestId, "output_config.effort");
      output.effort = effort === "xhigh" ? "max" : effort;
      if (effort !== "xhigh") mark(state, "output_config.effort");
    }
    if (hasOwn(config, "format")) {
      const format = config["format"];
      if (format === "text") output.format = "text";
      else if (isPlainObject(format) && format["type"] === "json_schema" && isPlainObject(format["schema"])) { output.format = "json_schema"; output.jsonSchema = { schema: format["schema"] }; }
      else invalidRequest(context.requestId, "output_config.format");
      markTree(state, "output_config.format", format);
      state.capabilities.add("structured_outputs");
    }
    const providerParameters: JsonObject = {};
    for (const [key, value] of Object.entries(config)) {
      if (key === "format") continue;
      if (key === "effort" && value !== "xhigh") continue;
      providerParameters[key] = value;
      markTree(state, `output_config.${key}`, value);
    }
    if (Object.keys(providerParameters).length > 0) {
      output.providerParameters = providerParameters;
    }
  }
  let serviceTier: CanonicalRequest["serviceTier"];
  if (hasOwn(body, "service_tier")) {
    const tier = body["service_tier"];
    if (tier !== "auto" && tier !== "standard_only" && tier !== "priority") invalidRequest(context.requestId, "service_tier");
    serviceTier = { tier };
    mark(state, "service_tier");
  }
  let metadata: JsonObject | undefined;
  if (hasOwn(body, "metadata") && body["metadata"] !== null) { metadata = requiredObject(body["metadata"], state, "metadata"); markTree(state, "metadata", metadata); }
  const disableParallel = isPlainObject(body["tool_choice"]) && typeof body["tool_choice"]["disable_parallel_tool_use"] === "boolean" ? body["tool_choice"]["disable_parallel_tool_use"] : undefined;
  const request: CanonicalRequest = {
    requestId: context.requestId,
    receivedAt,
    source: { adapter: PROTOCOL, protocol: PROTOCOL, path: input.path },
    model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(disableParallel === undefined ? {} : { parallelToolCalls: !disableParallel }),
    sampling,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(output === undefined ? {} : { output }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    routing: { modelAlias: model, ...(state.capabilities.size === 0 ? {} : { requiredCapabilities: [...state.capabilities] }) },
    stream,
    ...(metadata === undefined ? {} : { metadata }),
    extensions: { protocols: { [PROTOCOL]: { protocol: PROTOCOL, body: extensionBody(body, state.consumed), headers: {}, sourceFields: sourceFields(body, state.consumed) } } },
  };
  const validation = validateCanonicalRequest(request);
  if (!validation.valid) invalidRequest(context.requestId, validation.issues[0]?.path ?? "request");
  return freezeOwned(request);
}

function safeJsonObject(value: unknown, requestId: string, path: string): JsonObject {
  try {
    const cloned = cloneJson(value, requestId);
    if (!isPlainObject(cloned)) throw new Error("not object");
    return cloned;
  } catch {
    return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response cannot be encoded safely.", 500, path);
  }
}

const FINISH_REASON: Partial<Record<FinishReason, string>> = {
  stop: "end_turn",
  max_tokens: "max_tokens",
  tool_calls: "tool_use",
  pause_turn: "pause_turn",
  refusal: "refusal",
  stop_sequence: "stop_sequence",
};

function mapFinishReason(reason: FinishReason, requestId: string, response?: CanonicalResponse): string {
  const mapped = FINISH_REASON[reason];
  if (mapped !== undefined) return mapped;
  const body = response?.extensions?.protocols?.[PROTOCOL]?.body;
  const providerReason = isPlainObject(body) && isPlainObject(body["body"]) ? body["body"]["stop_reason"] : isPlainObject(body) ? body["stop_reason"] : undefined;
  if (typeof providerReason === "string" && providerReason.length > 0) return providerReason;
  return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical finish reason is not supported by Anthropic Messages.", 500, "finishReason");
}

function mapCitation(citation: Citation, requestId: string): JsonObject {
  if (citation.raw !== undefined) return safeJsonObject(citation.raw, requestId, "citation.raw");
  if (citation.kind === "char_span") return { type: "char_location", ...(citation.sourceTitle === undefined ? {} : { document_title: citation.sourceTitle }), ...(citation.citedText === undefined ? {} : { cited_text: citation.citedText }), ...(citation.startIndex === undefined ? {} : { start_char_index: citation.startIndex }), ...(citation.endIndex === undefined ? {} : { end_char_index: citation.endIndex }) };
  if (citation.kind === "page_span") return { type: "page_location", ...(citation.sourceTitle === undefined ? {} : { document_title: citation.sourceTitle }), ...(citation.citedText === undefined ? {} : { cited_text: citation.citedText }), ...(citation.pageStart === undefined ? {} : { start_page_number: citation.pageStart }), ...(citation.pageEnd === undefined ? {} : { end_page_number: citation.pageEnd }) };
  if (citation.kind === "block_span") return { type: "content_block_location", ...(citation.sourceTitle === undefined ? {} : { document_title: citation.sourceTitle }), ...(citation.citedText === undefined ? {} : { cited_text: citation.citedText }), ...(citation.startIndex === undefined ? {} : { start_block_index: citation.startIndex }), ...(citation.endIndex === undefined ? {} : { end_block_index: citation.endIndex }) };
  if (citation.kind === "search_result_span") return { type: "search_result_location", ...(citation.sourceId === undefined ? {} : { source: citation.sourceId }), ...(citation.sourceTitle === undefined ? {} : { title: citation.sourceTitle }), ...(citation.citedText === undefined ? {} : { cited_text: citation.citedText }), ...(citation.startIndex === undefined ? {} : { search_result_index: citation.startIndex }), ...(citation.url === undefined ? {} : { url: citation.url }) };
  return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical citation is not supported by Anthropic Messages.", 500, "citation.kind");
}

function encodeBlock(block: ContentBlock, requestId: string): JsonObject {
  if (!validateContentBlock(block).valid) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical content cannot be encoded safely.", 500, "content");
  const cache = block.cacheBreakpoint === undefined ? {} : { cache_control: { type: "ephemeral", ...(block.cacheBreakpoint.ttl === undefined ? {} : { ttl: block.cacheBreakpoint.ttl }) } };
  if (block.type === "text") return { type: "text", text: block.text, ...(block.citations === undefined ? {} : { citations: block.citations.map((citation) => mapCitation(citation, requestId)) }), ...cache };
  if (block.type === "reasoning") return fail(requestId, "unsupported_anthropic_messages_feature", "Reasoning requires an explicit exposure policy.", 500, "content.reasoning");
  if (block.type === "tool_call") {
    if (!validateToolCallArgumentsJson(block.argumentsJson).valid) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical tool input cannot be encoded safely.", 500, "content.argumentsJson");
    const parsed = JSON.parse(block.argumentsJson) as unknown;
    if (!isPlainObject(parsed)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical tool input must be an object.", 500, "content.argumentsJson");
    return { type: "tool_use", id: block.toolCallId, name: block.name, input: safeJsonObject(parsed, requestId, "content.argumentsJson"), ...cache };
  }
  if (block.type === "tool_result") return fail(requestId, "unsupported_anthropic_messages_feature", "Client tool results cannot appear in a successful Anthropic response.", 500, "content.tool_result");
  if (block.type === "server_tool_call") return { type: block.toolKind === "mcp" ? "mcp_tool_use" : "server_tool_use", id: block.toolCallId, ...(block.name === undefined ? {} : { name: block.name }), ...(block.serverName === undefined ? {} : { server_name: block.serverName }), input: block.input === undefined ? {} : block.input, ...cache };
  if (block.type === "server_tool_result") return { type: `${block.toolKind}_tool_result`, tool_use_id: block.toolCallId, content: block.content.map((entry) => encodeBlock(entry, requestId)), ...(block.isError === undefined ? {} : { is_error: block.isError }), ...cache };
  if (block.type === "file_reference" && block.providerMetadata?.["type"] === "container_upload") return { type: "container_upload", file_id: block.fileId, ...cache };
  return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical output block is not supported by Anthropic Messages.", 500, `content.${block.type}`);
}

function encodeReasoningBlocks(block: Extract<ContentBlock, { type: "reasoning" }>, requestId: string, exposeText: boolean, exposeSignatures: boolean, exposeRedacted: boolean): JsonObject[] {
  if (block.encryptedContent !== undefined && block.text === undefined && block.signature === undefined && block.redactedData === undefined) return fail(requestId, "unsupported_anthropic_messages_feature", "Encrypted-only reasoning cannot be exposed.", 500, "content.reasoning");
  const blocks: JsonObject[] = [];
  if (exposeText || exposeSignatures) blocks.push({ type: "thinking", thinking: exposeText ? (block.text ?? "") : "", ...(exposeSignatures && block.signature !== undefined ? { signature: block.signature } : {}) });
  if (exposeRedacted && block.redactedData !== undefined) blocks.push({ type: "redacted_thinking", data: block.redactedData });
  return blocks;
}

function validateUsage(usage: TokenUsage, requestId: string): void {
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) if (!Number.isInteger(usage[key]) || usage[key] < 0) fail(requestId, "invalid_anthropic_messages_egress", "Canonical usage cannot be encoded safely.", 500, `usage.${key}`);
}

function encodeUsage(usage: TokenUsage, requestId: string): JsonObject {
  validateUsage(usage, requestId);
  let creation = 0;
  const detail: JsonObject = {};
  for (const entry of usage.cacheWriteBreakdown ?? []) {
    if (!Number.isInteger(entry.tokens) || entry.tokens < 0 || (entry.ttlSeconds !== 300 && entry.ttlSeconds !== 3600)) fail(requestId, "invalid_anthropic_messages_egress", "Canonical cache usage cannot be encoded safely.", 500, "usage.cacheWriteBreakdown");
    creation += entry.tokens;
    const key = entry.ttlSeconds === 300 ? "ephemeral_5m_input_tokens" : "ephemeral_1h_input_tokens";
    detail[key] = ((detail[key] as number | undefined) ?? 0) + entry.tokens;
  }
  const server: JsonObject = {};
  if (usage.serverToolUsage !== undefined) {
    for (const [key, value] of Object.entries(usage.serverToolUsage)) {
      if (!Number.isInteger(value) || value < 0) fail(requestId, "invalid_anthropic_messages_egress", "Canonical server tool usage cannot be encoded safely.", 500, `usage.serverToolUsage.${key}`);
      if (key === "web_fetch") server["web_fetch_requests"] = value;
      if (key === "web_search") server["web_search_requests"] = value;
    }
  }
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, ...(usage.cachedInputTokens === undefined ? {} : { cache_read_input_tokens: usage.cachedInputTokens }), ...(creation === 0 ? {} : { cache_creation_input_tokens: creation, cache_creation: detail }), ...(usage.reasoningTokens === undefined ? {} : { output_tokens_details: { thinking_tokens: usage.reasoningTokens } }), ...(Object.keys(server).length === 0 ? {} : { server_tool_use: server }) };
}

function encodeResponse(response: CanonicalResponse, context: TranslationContext, exposeText: boolean, exposeSignatures: boolean, exposeRedacted: boolean): JsonObject {
  const requestId = context.requestId;
  if (!isSafeCanonicalResponse(response, requestId)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response cannot be encoded safely.", 500, "response");
  if (response.choices.length !== 1 || response.choices[0]?.index !== 0) return fail(requestId, "unsupported_anthropic_messages_feature", "Anthropic Messages requires exactly one choice.", 500, "choices");
  safeJsonObject(response.usage, requestId, "usage");
  const choice = response.choices[0];
  const content: JsonObject[] = [];
  for (const block of choice.output) {
    if (block.type === "reasoning") {
      content.push(
        ...encodeReasoningBlocks(
          block,
          requestId,
          exposeText,
          exposeSignatures,
          exposeRedacted,
        ),
      );
    } else content.push(encodeBlock(block, requestId));
  }
  return { id: response.responseId, type: "message", role: "assistant", content, model: response.model, stop_reason: mapFinishReason(choice.finishReason, requestId, response), stop_sequence: choice.stopSequence ?? null, usage: encodeUsage(response.usage, requestId) };
}

function namedRecord(event: string, data: JsonObject, maxBytes: number, requestId: string): string {
  const record = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (encoder.encode(record).byteLength > maxBytes) return fail(requestId, "invalid_anthropic_messages_egress", "Anthropic stream event exceeds the configured byte limit.", 500, "chunk");
  return record;
}

function boundedRecords(records: string[], maxBytes: number, requestId: string): string {
  const result = records.join("");
  if (encoder.encode(result).byteLength > maxBytes) return fail(requestId, "invalid_anthropic_messages_egress", "Anthropic stream output exceeds the configured byte limit.", 500, "chunk");
  return result;
}

function addressKey(address: { choiceIndex?: number; outputIndex: number; contentIndex?: number }, requestId: string): string {
  const choice = address.choiceIndex ?? 0;
  if (choice !== 0 || !Number.isInteger(address.outputIndex) || address.outputIndex < 0 || (address.contentIndex !== undefined && (!Number.isInteger(address.contentIndex) || address.contentIndex < 0))) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream address cannot be encoded safely.", 500, "chunk.address");
  return `choice:${choice}/output:${address.outputIndex}/content:${address.contentIndex === undefined ? "-" : address.contentIndex}`;
}

function cloneUsage(usage: TokenUsage): TokenUsage {
  return { ...usage, ...(usage.cacheWriteBreakdown === undefined ? {} : { cacheWriteBreakdown: usage.cacheWriteBreakdown.map((entry) => ({ ...entry })) }), ...(usage.serverToolUsage === undefined ? {} : { serverToolUsage: { ...usage.serverToolUsage } }) };
}

function cloneStreamState(source: StreamTranslationState): StreamTranslationState {
  return {
    sequenceNumbers: new Map(source.sequenceNumbers),
    emittedSequences: new Set(source.emittedSequences),
    ...(source.resumeFrom === undefined ? {} : { resumeFrom: source.resumeFrom }),
    ...(source.response === undefined ? {} : { response: { ...source.response } }),
    ...(source.usage === undefined ? {} : { usage: cloneUsage(source.usage) }),
    blockIndexes: new Map(source.blockIndexes ?? []),
    openBlocks: new Map([...source.openBlocks ?? []].map(([key, value]) => [key, { ...value }])),
    nextBlockIndex: source.nextBlockIndex ?? 0,
    ...(source.finishReason === undefined ? {} : { finishReason: source.finishReason }),
    ...(source.stopSequence === undefined ? {} : { stopSequence: source.stopSequence }),
    emittedCitationKeys: new Set(source.emittedCitationKeys ?? []),
    terminal: source.terminal,
    bytesEmitted: source.bytesEmitted,
  };
}

function commitStreamState(target: StreamTranslationState, source: StreamTranslationState): void {
  target.sequenceNumbers.clear(); for (const [key, value] of source.sequenceNumbers) target.sequenceNumbers.set(key, value);
  target.emittedSequences.clear(); for (const value of source.emittedSequences) target.emittedSequences.add(value);
  if (source.response === undefined) delete target.response; else target.response = { ...source.response };
  if (source.usage === undefined) delete target.usage; else target.usage = cloneUsage(source.usage);
  target.blockIndexes ??= new Map(); target.blockIndexes.clear(); for (const [key, value] of source.blockIndexes ?? []) target.blockIndexes.set(key, value);
  target.openBlocks ??= new Map(); target.openBlocks.clear(); for (const [key, value] of source.openBlocks ?? []) target.openBlocks.set(key, { ...value });
  if (source.nextBlockIndex === undefined) delete target.nextBlockIndex;
  else target.nextBlockIndex = source.nextBlockIndex;
  if (source.finishReason === undefined) delete target.finishReason; else target.finishReason = source.finishReason;
  if (source.stopSequence === undefined) delete target.stopSequence; else target.stopSequence = source.stopSequence;
  target.emittedCitationKeys ??= new Set(); target.emittedCitationKeys.clear(); for (const key of source.emittedCitationKeys ?? []) target.emittedCitationKeys.add(key);
  target.terminal = source.terminal;
  target.bytesEmitted = source.bytesEmitted;
}

function openBlock(state: StreamTranslationState, key: string, requestId: string): NonNullable<StreamTranslationState["openBlocks"]> extends Map<string, infer V> ? V : never {
  const block = state.openBlocks?.get(key);
  if (block === undefined) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream block is not open.", 500, "chunk.address");
  return block;
}

function startBlockValue(block: Extract<CanonicalChunk, { type: "content_block_start" }>["block"], requestId: string, exposeReasoning: boolean): { kind: string; emitted: boolean; value?: JsonObject } {
  if (block.type === "text") return { kind: "text", emitted: true, value: { type: "text", text: "" } };
  if (block.type === "reasoning") return exposeReasoning ? { kind: "reasoning", emitted: true, value: { type: "thinking", thinking: "" } } : { kind: "reasoning", emitted: false };
  if (block.type === "tool_call") {
    if (typeof block.id !== "string" || block.id.length === 0 || typeof block.name !== "string" || block.name.length === 0) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical tool block metadata is incomplete.", 500, "chunk.block");
    return { kind: "tool_call", emitted: true, value: { type: "tool_use", id: block.id, name: block.name, input: {} } };
  }
  if (block.type === "server_tool_call") {
    if (typeof block.id !== "string" || block.id.length === 0 || typeof block.toolKind !== "string" || block.toolKind.length === 0) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical server tool metadata is incomplete.", 500, "chunk.block");
    return { kind: "server_tool_call", emitted: true, value: { type: block.toolKind === "mcp" ? "mcp_tool_use" : "server_tool_use", id: block.id, ...(block.name === undefined ? {} : { name: block.name }), ...(block.serverName === undefined ? {} : { server_name: block.serverName }), input: {} } };
  }
  if (block.type === "server_tool_result") {
    if (typeof block.id !== "string" || block.id.length === 0 || typeof block.toolKind !== "string" || block.toolKind.length === 0) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical server result metadata is incomplete.", 500, "chunk.block");
    return { kind: "server_tool_result", emitted: true, value: { type: `${block.toolKind}_tool_result`, tool_use_id: block.id, content: [] } };
  }
  if (block.type === "file_reference" && typeof block.id === "string") return { kind: "file_reference", emitted: true, value: { type: "container_upload", file_id: block.id } };
  return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical stream block is not supported by Anthropic Messages.", 500, `chunk.block.${block.type}`);
}

function encodePublicError(error: GatewayError): JsonObject {
  const categoryType: Record<GatewayError["category"], string> = {
    validation: "invalid_request_error",
    routing: "invalid_request_error",
    authentication: "authentication_error",
    authorization: "permission_error",
    rate_limit: "rate_limit_error",
    timeout: "timeout_error",
    upstream: error.retryable && error.status >= 500 ? "overloaded_error" : "api_error",
    internal: "api_error",
  };
  return { type: "error", error: { type: categoryType[error.category], message: error.message } };
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function encodeChunkWorking(chunk: CanonicalChunk, context: TranslationContext, exposeText: boolean, exposeSignatures: boolean, exposeRedacted: boolean, maxBytes: number): string {
  const state = context.streamState;
  const requestId = context.requestId;
  if (state === undefined) return fail(requestId, "invalid_anthropic_messages_egress", "Anthropic streaming requires request-owned translation state.", 500, "streamState");
  safeJsonObject(chunk, requestId, "chunk");
  if (state.terminal) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream is already terminal.", 500, "chunk");
  const records: string[] = [];
  if (chunk.type === "response_start") {
    if (!validateRfc3339Timestamp(chunk.createdAt).valid || chunk.responseId.length === 0 || chunk.model.length === 0) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response metadata cannot be encoded safely.", 500, "chunk");
    const identity = { responseId: chunk.responseId, model: chunk.model, createdAt: chunk.createdAt };
    const fallback = context.streamResponse;
    if (fallback !== undefined && (fallback.responseId !== identity.responseId || fallback.model !== identity.model || fallback.createdAt !== identity.createdAt)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response metadata conflicts with stream context.", 500, "chunk");
    const existing = state.response;
    if (existing !== undefined && (existing.responseId !== identity.responseId || existing.model !== identity.model || existing.createdAt !== identity.createdAt)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response metadata conflicts with stream state.", 500, "chunk");
    if (existing !== undefined) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response start is duplicated.", 500, "chunk");
    state.response = identity;
    records.push(namedRecord("message_start", { type: "message_start", message: { id: identity.responseId, type: "message", role: "assistant", content: [], model: identity.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }, maxBytes, requestId));
  } else if (chunk.type === "content_block_start") {
    const key = addressKey(chunk.address, requestId);
    if (state.openBlocks?.has(key) || state.blockIndexes?.has(key)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream block start is duplicated.", 500, "chunk.address");
    const started = startBlockValue(chunk.block, requestId, exposeText || exposeSignatures || exposeRedacted);
    let index: number | undefined;
    if (started.emitted) {
      index = state.nextBlockIndex ?? 0;
      state.nextBlockIndex = index + 1;
      state.blockIndexes?.set(key, index);
      records.push(namedRecord("content_block_start", { type: "content_block_start", index, content_block: started.value as JsonObject }, maxBytes, requestId));
    }
    state.openBlocks?.set(key, { kind: started.kind, emitted: started.emitted, ...(index === undefined ? {} : { index }) });
  } else if (chunk.type === "text_delta") {
    const key = addressKey(chunk.address, requestId);
    const block = openBlock(state, key, requestId);
    if (block.kind !== "text") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream delta does not match its block.", 500, "chunk");
    if (block.emitted) records.push(namedRecord("content_block_delta", { type: "content_block_delta", index: block.index as number, delta: { type: "text_delta", text: chunk.text } }, maxBytes, requestId));
  } else if (chunk.type === "reasoning_delta") {
    const key = addressKey(chunk.address, requestId);
    const block = openBlock(state, key, requestId);
    if (block.kind !== "reasoning") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical reasoning delta does not match its block.", 500, "chunk");
    if (block.emitted && exposeText && chunk.text !== undefined) records.push(namedRecord("content_block_delta", { type: "content_block_delta", index: block.index as number, delta: { type: "thinking_delta", thinking: chunk.text } }, maxBytes, requestId));
    if (block.emitted && exposeSignatures && chunk.signatureDelta !== undefined) records.push(namedRecord("content_block_delta", { type: "content_block_delta", index: block.index as number, delta: { type: "signature_delta", signature: chunk.signatureDelta } }, maxBytes, requestId));
  } else if (chunk.type === "tool_call_delta") {
    const key = addressKey(chunk.address, requestId);
    const block = openBlock(state, key, requestId);
    if (block.kind !== "tool_call" && block.kind !== "server_tool_call") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical tool delta does not match its block.", 500, "chunk");
    if (chunk.argumentsDelta !== undefined && block.emitted) records.push(namedRecord("content_block_delta", { type: "content_block_delta", index: block.index as number, delta: { type: "input_json_delta", partial_json: chunk.argumentsDelta } }, maxBytes, requestId));
  } else if (chunk.type === "citation_added") {
    const key = addressKey(chunk.address, requestId);
    const block = openBlock(state, key, requestId);
    if (block.kind !== "text") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical citation does not address a text block.", 500, "chunk");
    const citation = mapCitation(chunk.citation, requestId);
    const citationKey = `${key}:${JSON.stringify(citation)}`;
    if (state.emittedCitationKeys?.has(citationKey)) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical citation is duplicated.", 500, "chunk");
    state.emittedCitationKeys?.add(citationKey);
    if (block.emitted) records.push(namedRecord("content_block_delta", { type: "content_block_delta", index: block.index as number, delta: { type: "citations_delta", citation } }, maxBytes, requestId));
  } else if (chunk.type === "content_block_stop") {
    const key = addressKey(chunk.address, requestId);
    const block = openBlock(state, key, requestId);
    if (chunk.block !== undefined && chunk.block.type !== block.kind && !(block.kind === "server_tool_call" && chunk.block.type === "server_tool_call") && !(block.kind === "server_tool_result" && chunk.block.type === "server_tool_result")) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical block stop does not match its start.", 500, "chunk");
    state.openBlocks?.delete(key);
    if (block.emitted) records.push(namedRecord("content_block_stop", { type: "content_block_stop", index: block.index as number }, maxBytes, requestId));
  } else if (chunk.type === "choice_end") {
    if ((chunk.choiceIndex ?? 0) !== 0 || state.finishReason !== undefined) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical choice end is invalid or duplicated.", 500, "chunk");
    if (FINISH_REASON[chunk.finishReason] === undefined) return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical finish reason is not supported by Anthropic Messages.", 500, "chunk.finishReason");
    state.finishReason = chunk.finishReason;
    if (chunk.stopSequence !== undefined) state.stopSequence = chunk.stopSequence;
  } else if (chunk.type === "usage") {
    validateUsage(chunk.usage, requestId);
    state.usage = cloneUsage(chunk.usage);
  } else if (chunk.type === "response_end") {
    if (chunk.status !== "completed" && chunk.status !== "incomplete") return fail(requestId, "invalid_anthropic_messages_egress", "Failed or cancelled streams require a canonical error.", 500, "chunk.status");
    if ((state.openBlocks?.size ?? 0) !== 0 || state.finishReason === undefined) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream ended before required closure.", 500, "chunk");
    records.push(namedRecord("message_delta", { type: "message_delta", delta: { stop_reason: mapFinishReason(state.finishReason, requestId), stop_sequence: state.stopSequence ?? null }, usage: encodeUsage(state.usage ?? zeroUsage(), requestId) }, maxBytes, requestId));
    records.push(namedRecord("message_stop", { type: "message_stop" }, maxBytes, requestId));
    state.terminal = true;
  } else if (chunk.type === "ping") {
    records.push(namedRecord("ping", { type: "ping" }, maxBytes, requestId));
  } else if (chunk.type === "error") {
    records.push(namedRecord("error", encodePublicError(chunk.error), maxBytes, requestId));
    const emitted = [...state.openBlocks?.entries() ?? []].filter((entry) => entry[1].emitted).sort((left, right) => (left[1].index as number) - (right[1].index as number));
    for (const [, block] of emitted) records.push(namedRecord("content_block_stop", { type: "content_block_stop", index: block.index as number }, maxBytes, requestId));
    state.openBlocks?.clear();
    records.push(namedRecord("message_delta", { type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: encodeUsage(state.usage ?? zeroUsage(), requestId) }, maxBytes, requestId));
    records.push(namedRecord("message_stop", { type: "message_stop" }, maxBytes, requestId));
    state.terminal = true;
  } else {
    return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical stream chunk is not supported by Anthropic Messages.", 500, "chunk.type");
  }
  const output = boundedRecords(records, maxBytes, requestId);
  if (output.length > 0) state.bytesEmitted = true;
  return output;
}

function validateChunkPreflight(value: unknown, requestId: string): asserts value is CanonicalChunk {
  if (!isPlainObject(value) || typeof value["type"] !== "string") {
    return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream chunk is malformed.", 500, "chunk");
  }
  if (value["sequenceNumber"] !== undefined && (!Number.isSafeInteger(value["sequenceNumber"]) || (value["sequenceNumber"] as number) <= 0)) {
    return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream sequence is malformed.", 500, "chunk.sequenceNumber");
  }
  const addressed = new Set(["content_block_start", "text_delta", "reasoning_delta", "tool_call_delta", "citation_added", "content_block_stop"]);
  if (addressed.has(value["type"])) {
    const address = value["address"];
    if (!isPlainObject(address) || !Number.isSafeInteger(address["outputIndex"]) || (address["outputIndex"] as number) < 0 || (address["choiceIndex"] !== undefined && (!Number.isSafeInteger(address["choiceIndex"]) || (address["choiceIndex"] as number) < 0)) || (address["contentIndex"] !== undefined && (!Number.isSafeInteger(address["contentIndex"]) || (address["contentIndex"] as number) < 0))) {
      return fail(requestId, "invalid_anthropic_messages_egress", "Canonical stream address is malformed.", 500, "chunk.address");
    }
  }
  const type = value["type"];
  if (type === "response_start") {
    if (typeof value["responseId"] !== "string" || value["responseId"].length === 0 || typeof value["model"] !== "string" || value["model"].length === 0 || !validateRfc3339Timestamp(value["createdAt"]).valid) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response start is malformed.", 500, "chunk");
  } else if (type === "content_block_start") {
    if (!isPlainObject(value["block"]) || typeof value["block"]["type"] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical block start is malformed.", 500, "chunk.block");
  } else if (type === "text_delta") {
    if (typeof value["text"] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical text delta is malformed.", 500, "chunk.text");
  } else if (type === "reasoning_delta") {
    for (const key of ["text", "signatureDelta", "redactedDataDelta", "encryptedContentDelta"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical reasoning delta is malformed.", 500, `chunk.${key}`);
  } else if (type === "tool_call_delta") {
    for (const key of ["id", "name", "argumentsDelta"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical tool delta is malformed.", 500, `chunk.${key}`);
  } else if (type === "citation_added") {
    if (!isPlainObject(value["citation"])) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical citation is malformed.", 500, "chunk.citation");
  } else if (type === "content_block_stop") {
    if (value["block"] !== undefined && !validateContentBlock(value["block"], "chunk.block").valid) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical block stop is malformed.", 500, "chunk.block");
  } else if (type === "usage") {
    if (!isPlainObject(value["usage"])) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical usage is malformed.", 500, "chunk.usage");
    validateUsage(value["usage"] as unknown as TokenUsage, requestId);
  } else if (type === "choice_end") {
    if ((value["choiceIndex"] !== undefined && (!Number.isSafeInteger(value["choiceIndex"]) || (value["choiceIndex"] as number) < 0)) || typeof value["finishReason"] !== "string" || (value["stopSequence"] !== undefined && typeof value["stopSequence"] !== "string")) return fail(requestId, "invalid_anthropic_messages_egress", "Canonical choice end is malformed.", 500, "chunk");
  } else if (type === "response_end") {
    if (typeof value["status"] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical response end is malformed.", 500, "chunk.status");
  } else if (type === "error") {
    const error = value["error"];
    if (!isPlainObject(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string" || typeof error["category"] !== "string" || typeof error["retryable"] !== "boolean" || !Number.isInteger(error["status"]) || typeof error["requestId"] !== "string") return fail(requestId, "invalid_anthropic_messages_egress", "Canonical error chunk is malformed.", 500, "chunk.error");
  } else if (type !== "ping") {
    return fail(requestId, "unsupported_anthropic_messages_feature", "Canonical stream chunk is not supported by Anthropic Messages.", 500, "chunk.type");
  }
}

function encodeChunk(chunk: CanonicalChunk, context: TranslationContext, exposeText: boolean, exposeSignatures: boolean, exposeRedacted: boolean, maxBytes: number): string {
  validateChunkPreflight(chunk, context.requestId);
  if (context.streamState === undefined) return fail(context.requestId, "invalid_anthropic_messages_egress", "Anthropic streaming requires request-owned translation state.", 500, "streamState");
  const working = cloneStreamState(context.streamState);
  const output = encodeChunkWorking(chunk, { ...context, streamState: working }, exposeText, exposeSignatures, exposeRedacted, maxBytes);
  commitStreamState(context.streamState, working);
  return output;
}

class ImmutablePathSet implements ReadonlySet<string> {
  readonly #values = new Set<string>(PATHS);
  get size(): number { return this.#values.size; }
  has(value: string): boolean { return this.#values.has(value); }
  entries(): SetIterator<[string, string]> { return this.#values.entries(); }
  keys(): SetIterator<string> { return this.#values.keys(); }
  values(): SetIterator<string> { return this.#values.values(); }
  forEach(callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void { for (const value of this.#values) callbackfn.call(thisArg, value, value, this); }
  [Symbol.iterator](): SetIterator<string> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "Set"; }
}

/** Creates a stateless Anthropic Messages translator family. */
export function createAnthropicMessagesTranslatorFamily(options: AnthropicMessagesTranslatorOptions): AnthropicMessagesTranslatorFamily {
  const maxBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxEventBytes must be a positive integer.");
  const exposeText = options.exposeReasoningText ?? false;
  const exposeSignatures = options.exposeReasoningSignatures ?? false;
  const exposeRedacted = options.exposeRedactedThinking ?? false;
  const paths = Object.freeze(new ImmutablePathSet());
  const ingress: IngressTranslationAdapter = Object.freeze({
    protocol: PROTOCOL,
    paths,
    canTranslate(path: string, body: unknown): boolean { return paths.has(path) && isPlainObject(body); },
    translate(input: RawIngressInput, context: TranslationContext): CanonicalRequest { if (!paths.has(input.path)) invalidRequest(context.requestId, "path"); return translateRequest(input, context, options.now); },
  });
  const egress: EgressTranslationAdapter = Object.freeze({
    protocol: PROTOCOL,
    encodeResponse(response: CanonicalResponse, context: TranslationContext): EgressValue { return encodeResponse(response, context, exposeText, exposeSignatures, exposeRedacted); },
    encodeChunk(chunk: CanonicalChunk, context: TranslationContext): EgressValue { return encodeChunk(chunk, context, exposeText, exposeSignatures, exposeRedacted, maxBytes); },
    encodeError(error: GatewayError, _context: TranslationContext): EgressValue { return encodePublicError(error); },
  });
  return Object.freeze({ ingress, egress });
}
