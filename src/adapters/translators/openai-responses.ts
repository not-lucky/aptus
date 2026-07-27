import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  Citation,
  ContentBlock,
  GatewayError,
  JsonValue,
  OutputConfiguration,
  ReasoningRequest,
  RoutingConstraints,
  SamplingParameters,
  ServiceTierConfiguration,
  StreamOptions,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../../domain/index.js";
import {
  createGatewayError,
  isSafeCanonicalResponse,
  redactDetails,
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

const PROTOCOL = "openai-responses" as const;
const RESPONSES_PATHS = ["/responses", "/v1/responses"] as const;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

type JsonObject = Record<string, JsonValue>;
type FailureCode =
  | "invalid_openai_responses_request"
  | "invalid_model"
  | "invalid_messages"
  | "invalid_message_content"
  | "invalid_media"
  | "invalid_tool_arguments"
  | "invalid_range"
  | "invalid_resume_metadata"
  | "invalid_translation_timestamp"
  | "unsupported_openai_responses_semantics"
  | "invalid_openai_responses_egress"
  | "missing_stream_response_metadata";

/** Construction options for the stateless OpenAI Responses translator family. */
export interface OpenAiResponsesTranslatorOptions {
  readonly now: () => string;
  readonly exposeReasoningText?: boolean;
  readonly maxEventBytes?: number;
}

/** Public immutable ingress/egress pair for OpenAI Responses. */
export interface OpenAiResponsesTranslatorFamily {
  readonly ingress: IngressTranslationAdapter;
  readonly egress: EgressTranslationAdapter;
}

interface TranslationState {
  readonly requestId: string;
  readonly consumed: Set<string>;
  readonly capabilities: Set<string>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object: JsonObject, key: string): boolean {
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

function invalidRequest(requestId: string, path: string): never {
  return fail(
    requestId,
    "invalid_openai_responses_request",
    "Expected a safe JSON request body.",
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
          const index =
            typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
              ? Number(key)
              : -1;
          const descriptor =
            typeof key === "string" ? descriptors[key] : undefined;
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== key ||
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            invalidRequest(requestId, path);
          }
        }
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            invalidRequest(requestId, `${path}[${index}]`);
          }
        }
        return current.map((entry, index) =>
          clone(entry, `${path}[${index}]`),
        );
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

function mark(state: TranslationState, path: string): void {
  state.consumed.add(path);
}

function markTree(state: TranslationState, path: string, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) mark(state, path);
    else
      value.forEach((entry, index) =>
        markTree(state, `${path}[${index}]`, entry),
      );
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

function depthFirstConsumedFields(
  root: JsonObject,
  consumed: ReadonlySet<string>,
): string[] {
  const fields: string[] = [];
  const visit = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0 && consumed.has(path)) fields.push(path);
      else
        value.forEach((entry, index) =>
          visit(entry, `${path}[${index}]`),
        );
      return;
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0 && consumed.has(path)) fields.push(path);
      else {
        for (const [key, entry] of entries) {
          visit(entry, childPath(path, key));
        }
      }
      return;
    }
    if (consumed.has(path)) fields.push(path);
  };
  visit(root, "");
  return fields;
}

function omitRetainedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "bearer" ||
    normalized === "token" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "idtoken" ||
    normalized === "authorizationtoken" ||
    normalized === "apikey" ||
    normalized === "secret" ||
    normalized === "secretref" ||
    normalized === "secretreference" ||
    normalized === "password" ||
    normalized === "passphrase" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "headers" ||
    normalized === "resolvedsecret" ||
    normalized === "provider" ||
    normalized === "providerdata"
  );
}

/**
 * Retains unknown fields in their original object/array position. Empty,
 * null-prototype objects are deliberate positional skeletons for consumed array
 * members; replay code addresses only retained leaves and never emits skeletons.
 */
function extensionBody(
  root: JsonObject,
  consumed: ReadonlySet<string>,
): JsonObject {
  const visit = (value: JsonValue, path: string): JsonValue | undefined => {
    if (consumed.has(path)) return undefined;
    if (Array.isArray(value)) {
      const entries = value.map((entry, index) =>
        visit(entry, `${path}[${index}]`),
      );
      if (entries.every((entry) => entry === undefined)) return undefined;
      return entries.map(
        (entry) => entry ?? (Object.create(null) as JsonObject),
      );
    }
    if (isPlainObject(value)) {
      const output: JsonObject = Object.create(null) as JsonObject;
      for (const [key, entry] of Object.entries(value)) {
        if (omitRetainedKey(key)) continue;
        const nextPath = childPath(path, key);
        const child = visit(entry, nextPath);
        if (child !== undefined) {
          Object.defineProperty(output, key, {
            value: child,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        }
      }
      return Object.keys(output).length === 0
        ? undefined
        : Object.freeze(output);
    }
    return value;
  };

  return (visit(root, "") as JsonObject | undefined) ?? Object.freeze({});
}

function freezeOwned<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeOwned(entry, seen);
  }
  return Object.freeze(value);
}

function requireObject(
  value: JsonValue | undefined,
  state: TranslationState,
  path: string,
  code: FailureCode = "invalid_openai_responses_request",
): JsonObject {
  if (!isPlainObject(value)) {
    fail(
      state.requestId,
      code,
      "Expected an object.",
      code === "unsupported_openai_responses_semantics" ? 422 : 400,
      path,
    );
  }
  return value;
}

function requireString(
  value: JsonValue | undefined,
  state: TranslationState,
  path: string,
  code: FailureCode,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(
      state.requestId,
      code,
      "Expected a non-empty string.",
      code === "unsupported_openai_responses_semantics" ? 422 : 400,
      path,
    );
  }
  mark(state, path);
  return value;
}

function optionalString(
  object: JsonObject,
  key: string,
  state: TranslationState,
  path: string,
): string | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  return requireString(
    object[key],
    state,
    childPath(path, key),
    "invalid_openai_responses_request",
  );
}

function optionalBoolean(
  object: JsonObject,
  key: string,
  state: TranslationState,
  path: string,
): boolean | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  const fieldPath = childPath(path, key);
  if (typeof object[key] !== "boolean") {
    fail(
      state.requestId,
      "invalid_openai_responses_request",
      "Expected a boolean.",
      400,
      fieldPath,
    );
  }
  mark(state, fieldPath);
  return object[key];
}

function optionalNumber(
  object: JsonObject,
  key: string,
  state: TranslationState,
  path: string,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  if (!hasOwn(object, key) || object[key] === null) return undefined;
  const fieldPath = childPath(path, key);
  const value = object[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    fail(
      state.requestId,
      "invalid_range",
      "Expected a value in range.",
      400,
      fieldPath,
    );
  }
  mark(state, fieldPath);
  return value;
}

function safeProviderParameters(
  object: JsonObject,
  excluded: ReadonlySet<string>,
): JsonObject | undefined {
  const sanitize = (value: JsonValue): JsonValue | undefined => {
    if (Array.isArray(value)) {
      return freezeOwned(
        value.map((entry) => {
          const sanitized = sanitize(entry);
          return sanitized === undefined
            ? (Object.create(null) as JsonObject)
            : sanitized;
        }),
      );
    }
    if (!isPlainObject(value)) return value;
    const output: JsonObject = Object.create(null) as JsonObject;
    for (const [key, entry] of Object.entries(value)) {
      if (omitRetainedKey(key)) continue;
      const sanitized = sanitize(entry);
      if (sanitized !== undefined) {
        Object.defineProperty(output, key, {
          value: sanitized,
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
    }
    return Object.freeze(output);
  };

  const output: JsonObject = Object.create(null) as JsonObject;
  for (const [key, value] of Object.entries(object)) {
    if (excluded.has(key) || omitRetainedKey(key)) continue;
    const sanitized = sanitize(value);
    if (sanitized !== undefined) {
      Object.defineProperty(output, key, {
        value: sanitized,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
}

function parseAnnotations(
  value: JsonValue | undefined,
  state: TranslationState,
  path: string,
): Citation[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fail(
      state.requestId,
      "invalid_message_content",
      "Expected an annotation array.",
      400,
      path,
    );
  }
  return value.map((entry, index): Citation => {
    const itemPath = `${path}[${index}]`;
    const annotation = requireObject(
      entry,
      state,
      itemPath,
      "invalid_message_content",
    );
    const type = requireString(
      annotation["type"],
      state,
      `${itemPath}.type`,
      "invalid_message_content",
    );
    if (type === "url_citation") {
      const source = isPlainObject(annotation["url_citation"])
        ? annotation["url_citation"]
        : annotation;
      const sourcePath =
        source === annotation ? itemPath : `${itemPath}.url_citation`;
      const url = requireString(
        source["url"],
        state,
        `${sourcePath}.url`,
        "invalid_message_content",
      );
      if (!validateUrl(url).valid) {
        fail(
          state.requestId,
          "invalid_media",
          "Expected a safe citation URL.",
          400,
          `${sourcePath}.url`,
        );
      }
      const sourceTitle = optionalString(source, "title", state, sourcePath);
      const startIndex = optionalNumber(
        source,
        "start_index",
        state,
        sourcePath,
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
      const endIndex = optionalNumber(
        source,
        "end_index",
        state,
        sourcePath,
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
      return {
        kind: "url",
        url,
        ...(sourceTitle === undefined ? {} : { sourceTitle }),
        ...(startIndex === undefined ? {} : { startIndex }),
        ...(endIndex === undefined ? {} : { endIndex }),
      };
    }
    if (type === "file_citation") {
      const source = isPlainObject(annotation["file_citation"])
        ? annotation["file_citation"]
        : annotation;
      const sourcePath =
        source === annotation ? itemPath : `${itemPath}.file_citation`;
      const sourceId = requireString(
        source["file_id"],
        state,
        `${sourcePath}.file_id`,
        "invalid_message_content",
      );
      const citedText = optionalString(source, "quote", state, sourcePath);
      return {
        kind: "file",
        sourceId,
        ...(citedText === undefined ? {} : { citedText }),
      };
    }
    return fail(
      state.requestId,
      "unsupported_openai_responses_semantics",
      "Unsupported annotation semantics.",
      422,
      `${itemPath}.type`,
    );
  });
}

function parseDataUrl(
  value: string,
  state: TranslationState,
  path: string,
): { readonly mediaType: string; readonly data: string } {
  const match = DATA_URL.exec(value);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    !validateBase64Media(match[2], match[1]).valid
  ) {
    fail(
      state.requestId,
      "invalid_media",
      "Expected valid base64 media.",
      400,
      path,
    );
  }
  return { mediaType: match[1], data: match[2] };
}

function blockMetadata(
  object: JsonObject,
  state: TranslationState,
  path: string,
  excluded: ReadonlySet<string>,
): Pick<ContentBlock, "id" | "status" | "providerMetadata"> {
  const id = optionalString(object, "id", state, path);
  let status: ContentBlock["status"];
  if (hasOwn(object, "status") && object["status"] !== null) {
    const value = requireString(
      object["status"],
      state,
      `${path}.status`,
      "invalid_message_content",
    );
    if (
      value !== "in_progress" &&
      value !== "completed" &&
      value !== "incomplete"
    ) {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported item status.",
        422,
        `${path}.status`,
      );
    }
    status = value;
  }
  const providerMetadata = safeProviderParameters(object, excluded);
  return {
    ...(id === undefined ? {} : { id }),
    ...(status === undefined ? {} : { status }),
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  };
}

function parseContentBlock(
  value: JsonValue,
  state: TranslationState,
  path: string,
): ContentBlock {
  if (typeof value === "string") {
    mark(state, path);
    return { type: "text", text: value };
  }
  const object = requireObject(
    value,
    state,
    path,
    "invalid_message_content",
  );
  const type = requireString(
    object["type"],
    state,
    `${path}.type`,
    "invalid_message_content",
  );
  const baseExcluded = new Set(["type", "id", "status"]);

  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = requireString(
      object["text"],
      state,
      `${path}.text`,
      "invalid_message_content",
      true,
    );
    const citations = parseAnnotations(
      object["annotations"],
      state,
      `${path}.annotations`,
    );
    if (hasOwn(object, "annotations") && object["annotations"] === null) {
      mark(state, `${path}.annotations`);
    }
    let cacheBreakpoint: ContentBlock["cacheBreakpoint"];
    if (
      hasOwn(object, "prompt_cache_breakpoint") &&
      object["prompt_cache_breakpoint"] !== null
    ) {
      const cache = requireObject(
        object["prompt_cache_breakpoint"],
        state,
        `${path}.prompt_cache_breakpoint`,
        "invalid_message_content",
      );
      const ttl = optionalString(
        cache,
        "ttl",
        state,
        `${path}.prompt_cache_breakpoint`,
      );
      if (Object.keys(cache).length === 0) {
        mark(state, `${path}.prompt_cache_breakpoint`);
      }
      cacheBreakpoint = ttl === undefined ? {} : { ttl };
    }
    const metadata = blockMetadata(
      object,
      state,
      path,
      new Set([
        ...baseExcluded,
        "text",
        "annotations",
        "prompt_cache_breakpoint",
      ]),
    );
    if (citations !== undefined) state.capabilities.add("citations");
    return {
      type: "text",
      text,
      ...metadata,
      ...(citations === undefined ? {} : { citations }),
      ...(cacheBreakpoint === undefined ? {} : { cacheBreakpoint }),
    };
  }

  if (type === "refusal") {
    const refusal = requireString(
      object["refusal"],
      state,
      `${path}.refusal`,
      "invalid_message_content",
      true,
    );
    return {
      type: "refusal",
      refusal,
      ...blockMetadata(
        object,
        state,
        path,
        new Set([...baseExcluded, "refusal"]),
      ),
    };
  }

  if (type === "input_image" || type === "image") {
    const imageUrl =
      typeof object["image_url"] === "string"
        ? object["image_url"]
        : typeof object["url"] === "string"
          ? object["url"]
          : undefined;
    const fileId =
      typeof object["file_id"] === "string" ? object["file_id"] : undefined;
    if ((imageUrl === undefined) === (fileId === undefined)) {
      fail(
        state.requestId,
        "invalid_media",
        "Expected exactly one image source.",
        400,
        path,
      );
    }
    state.capabilities.add("vision");
    state.capabilities.add("multimodal");
    if (fileId !== undefined) {
      mark(state, `${path}.file_id`);
      return {
        type: "file_reference",
        fileId,
        ...blockMetadata(
          object,
          state,
          path,
          new Set([...baseExcluded, "file_id"]),
        ),
      };
    }
    if (imageUrl === undefined) {
      return fail(
        state.requestId,
        "invalid_media",
        "Expected exactly one image source.",
        400,
        path,
      );
    }
    const sourcePath =
      typeof object["image_url"] === "string"
        ? `${path}.image_url`
        : `${path}.url`;
    mark(state, sourcePath);
    if (imageUrl.startsWith("data:")) {
      const source = parseDataUrl(imageUrl, state, sourcePath);
      return {
        type: "image_base64",
        mediaType: source.mediaType,
        data: source.data,
        ...blockMetadata(
          object,
          state,
          path,
          new Set([...baseExcluded, "image_url", "url"]),
        ),
      };
    }
    if (!validateUrl(imageUrl).valid) {
      fail(
        state.requestId,
        "invalid_media",
        "Expected a safe image URL.",
        400,
        sourcePath,
      );
    }
    const detail = optionalString(object, "detail", state, path);
    if (
      detail !== undefined &&
      detail !== "auto" &&
      detail !== "low" &&
      detail !== "high"
    ) {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported image detail.",
        422,
        `${path}.detail`,
      );
    }
    return {
      type: "image_url",
      url: imageUrl,
      ...(detail === undefined ? {} : { detail }),
      ...blockMetadata(
        object,
        state,
        path,
        new Set([...baseExcluded, "image_url", "url", "detail"]),
      ),
    };
  }

  if (type === "input_file" || type === "file") {
    const fileId =
      typeof object["file_id"] === "string" ? object["file_id"] : undefined;
    const fileData =
      typeof object["file_data"] === "string"
        ? object["file_data"]
        : undefined;
    const fileUrl =
      typeof object["file_url"] === "string"
        ? object["file_url"]
        : undefined;
    const sources = [fileId, fileData, fileUrl].filter(
      (entry) => entry !== undefined,
    );
    if (sources.length !== 1) {
      fail(
        state.requestId,
        "invalid_media",
        "Expected exactly one file source.",
        400,
        path,
      );
    }
    state.capabilities.add("multimodal");
    const filename = optionalString(object, "filename", state, path);
    if (fileId !== undefined) {
      mark(state, `${path}.file_id`);
      return {
        type: "file_reference",
        fileId,
        ...(filename === undefined ? {} : { filename }),
        ...blockMetadata(
          object,
          state,
          path,
          new Set([
            ...baseExcluded,
            "file_id",
            "file_data",
            "file_url",
            "filename",
          ]),
        ),
      };
    }
    if (fileUrl !== undefined) {
      mark(state, `${path}.file_url`);
      if (!validateUrl(fileUrl).valid) {
        fail(
          state.requestId,
          "invalid_media",
          "Expected a safe file URL.",
          400,
          `${path}.file_url`,
        );
      }
      return {
        type: "document_url",
        url: fileUrl,
        ...(filename === undefined ? {} : { title: filename }),
        ...blockMetadata(
          object,
          state,
          path,
          new Set([
            ...baseExcluded,
            "file_id",
            "file_data",
            "file_url",
            "filename",
          ]),
        ),
      };
    }
    if (fileData === undefined) {
      return fail(
        state.requestId,
        "invalid_media",
        "Expected exactly one file source.",
        400,
        path,
      );
    }
    mark(state, `${path}.file_data`);
    const source = parseDataUrl(fileData, state, `${path}.file_data`);
    return {
      type: "document_base64",
      mediaType: source.mediaType,
      data: source.data,
      ...(filename === undefined ? {} : { title: filename }),
      ...blockMetadata(
        object,
        state,
        path,
        new Set([
          ...baseExcluded,
          "file_id",
          "file_data",
          "file_url",
          "filename",
        ]),
      ),
    };
  }

  if (type === "input_audio" || type === "audio") {
    const input = isPlainObject(object["input_audio"])
      ? object["input_audio"]
      : object;
    const inputPath = input === object ? path : `${path}.input_audio`;
    const data = requireString(
      input["data"],
      state,
      `${inputPath}.data`,
      "invalid_media",
    );
    const format = requireString(
      input["format"],
      state,
      `${inputPath}.format`,
      "invalid_media",
    );
    const mediaType =
      format === "wav"
        ? "audio/wav"
        : format === "mp3"
          ? "audio/mpeg"
          : fail(
              state.requestId,
              "invalid_media",
              "Unsupported audio format.",
              400,
              `${inputPath}.format`,
            );
    if (!validateBase64Media(data, mediaType).valid) {
      fail(
        state.requestId,
        "invalid_media",
        "Expected valid audio.",
        400,
        inputPath,
      );
    }
    state.capabilities.add("audio_input");
    state.capabilities.add("multimodal");
    return {
      type: "audio_base64",
      mediaType,
      data,
      ...blockMetadata(
        object,
        state,
        path,
        new Set([...baseExcluded, "input_audio", "data", "format"]),
      ),
    };
  }

  return fail(
    state.requestId,
    "unsupported_openai_responses_semantics",
    "Unsupported Responses content semantics.",
    422,
    `${path}.type`,
  );
}

function parseReasoningBlocks(
  object: JsonObject,
  state: TranslationState,
  path: string,
): ContentBlock[] {
  const base = blockMetadata(
    object,
    state,
    path,
    new Set([
      "type",
      "id",
      "status",
      "summary",
      "text",
      "signature",
      "redacted_data",
      "encrypted_content",
    ]),
  );
  const blocks: ContentBlock[] = [];
  const summary = object["summary"];
  if (Array.isArray(summary)) {
    summary.forEach((entry, index) => {
      const summaryPath = `${path}.summary[${index}]`;
      const part = requireObject(
        entry,
        state,
        summaryPath,
        "invalid_message_content",
      );
      if (hasOwn(part, "type")) {
        requireString(
          part["type"],
          state,
          `${summaryPath}.type`,
          "invalid_message_content",
        );
      }
      const text = requireString(
        part["text"],
        state,
        `${summaryPath}.text`,
        "invalid_message_content",
        true,
      );
      blocks.push({ type: "reasoning", text, ...base });
    });
  } else if (typeof summary === "string") {
    mark(state, `${path}.summary`);
    blocks.push({ type: "reasoning", text: summary, ...base });
  } else if (summary !== undefined && summary !== null) {
    fail(
      state.requestId,
      "invalid_message_content",
      "Expected reasoning summary text.",
      400,
      `${path}.summary`,
    );
  } else if (summary === null) {
    mark(state, `${path}.summary`);
  }

  const text = optionalString(object, "text", state, path);
  const signature = optionalString(object, "signature", state, path);
  const redactedData = optionalString(object, "redacted_data", state, path);
  const encryptedContent = optionalString(
    object,
    "encrypted_content",
    state,
    path,
  );
  if (
    text !== undefined ||
    signature !== undefined ||
    redactedData !== undefined ||
    encryptedContent !== undefined ||
    blocks.length === 0
  ) {
    blocks.push({
      type: "reasoning",
      ...base,
      ...(text === undefined ? {} : { text }),
      ...(signature === undefined ? {} : { signature }),
      ...(redactedData === undefined ? {} : { redactedData }),
      ...(encryptedContent === undefined ? {} : { encryptedContent }),
    });
  }
  state.capabilities.add("reasoning");
  return blocks;
}

function parseServerItem(
  object: JsonObject,
  type: string,
  state: TranslationState,
  path: string,
): ContentBlock {
  const callId = requireString(
    object["call_id"] ?? object["id"] ?? object["approval_request_id"],
    state,
    hasOwn(object, "call_id")
      ? `${path}.call_id`
      : hasOwn(object, "approval_request_id")
        ? `${path}.approval_request_id`
        : `${path}.id`,
    "invalid_message_content",
  );
  const excluded = new Set([
    "type",
    "id",
    "status",
    "call_id",
    "approval_request_id",
    "name",
    "server_label",
    "input",
    "arguments",
    "output",
    "result",
    "is_error",
    "approve",
    "approved",
    "reason",
  ]);
  const metadata = blockMetadata(object, state, path, excluded);
  const isResult =
    type.endsWith("_output") ||
    type.endsWith("_result") ||
    type === "mcp_list_tools";
  if (isResult) {
    const raw = object["output"] ?? object["result"];
    let content: ContentBlock[];
    if (typeof raw === "string") {
      mark(state, hasOwn(object, "output") ? `${path}.output` : `${path}.result`);
      content = [{ type: "text", text: raw }];
    } else if (Array.isArray(raw)) {
      content = raw.map((entry, index) =>
        parseContentBlock(
          entry,
          state,
          `${path}.${hasOwn(object, "output") ? "output" : "result"}[${index}]`,
        ),
      );
    } else if (raw === undefined || raw === null) {
      if (raw === null) {
        mark(state, hasOwn(object, "output") ? `${path}.output` : `${path}.result`);
      }
      content = [];
    } else {
      fail(
        state.requestId,
        "invalid_message_content",
        "Expected server tool output.",
        400,
        path,
      );
    }
    const isError = optionalBoolean(object, "is_error", state, path);
    state.capabilities.add("server_tools");
    if (type.includes("mcp")) state.capabilities.add("mcp");
    return {
      type: "server_tool_result",
      toolCallId: callId,
      toolKind: type,
      content,
      ...(isError === undefined ? {} : { isError }),
      ...metadata,
    };
  }

  const name = optionalString(object, "name", state, path);
  const serverName = optionalString(object, "server_label", state, path);
  const input = object["input"];
  if (input !== undefined) markTree(state, `${path}.input`, input);
  const argumentsJson = optionalString(object, "arguments", state, path);
  if (
    argumentsJson !== undefined &&
    !validateToolCallArgumentsJson(argumentsJson).valid
  ) {
    fail(
      state.requestId,
      "invalid_tool_arguments",
      "Expected object JSON arguments.",
      400,
      `${path}.arguments`,
    );
  }
  state.capabilities.add("server_tools");
  if (type.includes("mcp")) state.capabilities.add("mcp");
  return {
    type: "server_tool_call",
    toolCallId: callId,
    toolKind: type,
    ...(name === undefined ? {} : { name }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(input === undefined ? {} : { input }),
    ...(argumentsJson === undefined ? {} : { argumentsJson }),
    ...metadata,
  };
}

function parseInputItem(
  value: JsonValue,
  state: TranslationState,
  path: string,
): CanonicalMessage {
  const object = requireObject(value, state, path, "invalid_messages");
  const type =
    typeof object["type"] === "string" ? object["type"] : "message";

  if (type === "message" || hasOwn(object, "role")) {
    if (hasOwn(object, "type")) mark(state, `${path}.type`);
    const role = requireString(
      object["role"] ?? "user",
      state,
      `${path}.role`,
      "invalid_messages",
    );
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "developer"
    ) {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported message role.",
        422,
        `${path}.role`,
      );
    }
    const contentValue = object["content"];
    let content: ContentBlock[];
    if (typeof contentValue === "string") {
      mark(state, `${path}.content`);
      content = [{ type: "text", text: contentValue }];
    } else if (Array.isArray(contentValue) && contentValue.length > 0) {
      content = contentValue.map((entry, index) =>
        parseContentBlock(entry, state, `${path}.content[${index}]`),
      );
    } else {
      fail(
        state.requestId,
        "invalid_message_content",
        "Expected non-empty message content.",
        400,
        `${path}.content`,
      );
    }
    const id = optionalString(object, "id", state, path);
    const name = optionalString(object, "name", state, path);
    const phase = optionalString(object, "phase", state, path);
    const status = optionalString(object, "status", state, path);
    if (phase !== undefined || status !== undefined) {
      const first = content[0];
      if (first !== undefined) {
        content[0] = {
          ...first,
          providerMetadata: {
            ...(first.providerMetadata ?? {}),
            ...(phase === undefined ? {} : { phase }),
            ...(status === undefined ? {} : { status }),
          },
        };
      }
    }
    return {
      role,
      content,
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
    };
  }

  mark(state, `${path}.type`);
  if (type === "function_call") {
    const toolCallId = requireString(
      object["call_id"],
      state,
      `${path}.call_id`,
      "invalid_tool_arguments",
    );
    const name = requireString(
      object["name"],
      state,
      `${path}.name`,
      "invalid_tool_arguments",
    );
    const argumentsJson = requireString(
      object["arguments"],
      state,
      `${path}.arguments`,
      "invalid_tool_arguments",
      true,
    );
    if (!validateToolCallArgumentsJson(argumentsJson).valid) {
      fail(
        state.requestId,
        "invalid_tool_arguments",
        "Expected object JSON arguments.",
        400,
        `${path}.arguments`,
      );
    }
    const caller = optionalString(object, "caller", state, path);
    if (caller !== undefined && caller !== "model" && caller !== "program") {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported tool caller.",
        422,
        `${path}.caller`,
      );
    }
    const metadata = blockMetadata(
      object,
      state,
      path,
      new Set([
        "type",
        "id",
        "status",
        "call_id",
        "name",
        "arguments",
        "caller",
      ]),
    );
    state.capabilities.add("tools");
    return {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCallId,
          name,
          argumentsJson,
          ...(caller === undefined ? {} : { caller }),
          ...metadata,
        },
      ],
    };
  }

  if (type === "function_call_output") {
    const toolCallId = requireString(
      object["call_id"],
      state,
      `${path}.call_id`,
      "invalid_tool_arguments",
    );
    const output = object["output"];
    let content: ContentBlock[];
    if (typeof output === "string") {
      mark(state, `${path}.output`);
      content = [{ type: "text", text: output }];
    } else if (Array.isArray(output) && output.length > 0) {
      content = output.map((entry, index) =>
        parseContentBlock(entry, state, `${path}.output[${index}]`),
      );
    } else {
      fail(
        state.requestId,
        "invalid_message_content",
        "Expected function output.",
        400,
        `${path}.output`,
      );
    }
    const isError = optionalBoolean(object, "is_error", state, path);
    const metadata = blockMetadata(
      object,
      state,
      path,
      new Set([
        "type",
        "id",
        "status",
        "call_id",
        "output",
        "is_error",
      ]),
    );
    return {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId,
          content,
          ...(isError === undefined ? {} : { isError }),
          ...metadata,
        },
      ],
    };
  }

  if (type === "reasoning") {
    return {
      role: "assistant",
      content: parseReasoningBlocks(object, state, path),
    };
  }

  if (type.includes("approval")) {
    const approvedValue = object["approve"] ?? object["approved"];
    const approvalPath = hasOwn(object, "approve")
      ? `${path}.approve`
      : `${path}.approved`;
    const toolCallId = requireString(
      object["approval_request_id"] ?? object["call_id"] ?? object["id"],
      state,
      hasOwn(object, "approval_request_id")
        ? `${path}.approval_request_id`
        : hasOwn(object, "call_id")
          ? `${path}.call_id`
          : `${path}.id`,
      "invalid_message_content",
    );
    const metadata = blockMetadata(
      object,
      state,
      path,
      new Set([
        "type",
        "id",
        "status",
        "approval_request_id",
        "call_id",
        "approve",
        "approved",
        "reason",
      ]),
    );
    if (approvedValue !== undefined) {
      if (typeof approvedValue !== "boolean") {
        fail(
          state.requestId,
          "invalid_message_content",
          "Expected an approval decision.",
          400,
          approvalPath,
        );
      }
      mark(state, approvalPath);
      return {
        role: "user",
        content: [
          {
            type: "tool_approval_response",
            toolCallId,
            approved: approvedValue,
            ...metadata,
          },
        ],
      };
    }
    const reason = optionalString(object, "reason", state, path);
    return {
      role: "assistant",
      content: [
        {
          type: "tool_approval_request",
          toolCallId,
          toolKind: type,
          ...(reason === undefined ? {} : { reason }),
          ...metadata,
        },
      ],
    };
  }

  const serverLike =
    type.includes("mcp") ||
    type.includes("computer") ||
    type.includes("web_search") ||
    type.includes("code_interpreter") ||
    type.includes("file_search") ||
    type.includes("image_generation") ||
    hasOwn(object, "call_id");
  if (serverLike) {
    const block = parseServerItem(object, type, state, path);
    return {
      role: block.type === "server_tool_result" ? "tool" : "assistant",
      content: [block],
    };
  }

  return fail(
    state.requestId,
    "unsupported_openai_responses_semantics",
    "Unsupported Responses item semantics.",
    422,
    `${path}.type`,
  );
}

function parseTools(
  value: JsonValue,
  state: TranslationState,
  path: string,
): ToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      state.requestId,
      "invalid_openai_responses_request",
      "Expected non-empty tools.",
      400,
      path,
    );
  }
  state.capabilities.add("tools");
  return value.map((entry, index): ToolDefinition => {
    const itemPath = `${path}[${index}]`;
    const tool = requireObject(entry, state, itemPath);
    const type = requireString(
      tool["type"],
      state,
      `${itemPath}.type`,
      "invalid_openai_responses_request",
    );
    if (type === "function") {
      const name = requireString(
        tool["name"],
        state,
        `${itemPath}.name`,
        "invalid_openai_responses_request",
      );
      const description = optionalString(tool, "description", state, itemPath);
      const parameters = requireObject(
        tool["parameters"] ?? {},
        state,
        `${itemPath}.parameters`,
      );
      markTree(state, `${itemPath}.parameters`, parameters);
      const strict = optionalBoolean(tool, "strict", state, itemPath);
      return {
        kind: "function",
        name,
        ...(description === undefined ? {} : { description }),
        inputSchema: parameters,
        ...(strict === undefined ? {} : { strict }),
      };
    }
    state.capabilities.add("server_tools");
    if (type.includes("mcp")) state.capabilities.add("mcp");
    const name = optionalString(tool, "name", state, itemPath);
    const serverName = optionalString(tool, "server_label", state, itemPath);
    const providerParameters = safeProviderParameters(
      tool,
      new Set(["type", "name", "server_label"]),
    );
    for (const [key, entryValue] of Object.entries(tool)) {
      if (
        key !== "type" &&
        key !== "name" &&
        key !== "server_label" &&
        !omitRetainedKey(key)
      ) {
        markTree(state, `${itemPath}.${key}`, entryValue);
      }
    }
    return {
      kind: "server",
      serverType: type,
      ...(name === undefined ? {} : { name }),
      ...(serverName === undefined ? {} : { serverName }),
      ...(providerParameters === undefined ? {} : { providerParameters }),
    };
  });
}

function parseToolChoice(
  value: JsonValue,
  state: TranslationState,
  path: string,
): ToolChoice {
  if (typeof value === "string") {
    if (value !== "auto" && value !== "none" && value !== "required") {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported tool choice.",
        422,
        path,
      );
    }
    mark(state, path);
    return { mode: value };
  }
  const choice = requireObject(
    value,
    state,
    path,
    "unsupported_openai_responses_semantics",
  );
  const type = requireString(
    choice["type"],
    state,
    `${path}.type`,
    "unsupported_openai_responses_semantics",
  );
  if (type === "function") {
    const name = requireString(
      choice["name"],
      state,
      `${path}.name`,
      "unsupported_openai_responses_semantics",
    );
    return { mode: "named", name };
  }
  if (type === "allowed_tools") {
    const tools = choice["tools"];
    if (!Array.isArray(tools) || tools.length === 0) {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Expected allowed tool names.",
        422,
        `${path}.tools`,
      );
    }
    const names = tools.map((entry, index) => {
      if (typeof entry === "string") {
        mark(state, `${path}.tools[${index}]`);
        return entry;
      }
      const item = requireObject(
        entry,
        state,
        `${path}.tools[${index}]`,
        "unsupported_openai_responses_semantics",
      );
      return requireString(
        item["name"],
        state,
        `${path}.tools[${index}].name`,
        "unsupported_openai_responses_semantics",
      );
    });
    const mode = optionalString(choice, "mode", state, path);
    if (mode !== undefined && mode !== "auto" && mode !== "required") {
      fail(
        state.requestId,
        "unsupported_openai_responses_semantics",
        "Unsupported allowed-tools mode.",
        422,
        `${path}.mode`,
      );
    }
    return {
      mode: "allowed",
      names,
      ...(mode === undefined ? {} : { allowRequired: mode === "required" }),
    };
  }
  return fail(
    state.requestId,
    "unsupported_openai_responses_semantics",
    "Unsupported tool choice.",
    422,
    `${path}.type`,
  );
}

function parseReasoningRequest(
  body: JsonObject,
  state: TranslationState,
): ReasoningRequest | undefined {
  if (!hasOwn(body, "reasoning") || body["reasoning"] === null) return undefined;
  const object = requireObject(body["reasoning"], state, "reasoning");
  const effort = optionalString(object, "effort", state, "reasoning");
  if (
    effort !== undefined &&
    effort !== "none" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "max"
  ) {
    fail(
      state.requestId,
      "unsupported_openai_responses_semantics",
      "Unsupported reasoning effort.",
      422,
      "reasoning.effort",
    );
  }
  const summary = optionalString(object, "summary", state, "reasoning");
  if (
    summary !== undefined &&
    summary !== "auto" &&
    summary !== "concise" &&
    summary !== "detailed"
  ) {
    fail(
      state.requestId,
      "unsupported_openai_responses_semantics",
      "Unsupported reasoning summary mode.",
      422,
      "reasoning.summary",
    );
  }
  const budgetTokens = optionalNumber(
    object,
    "budget_tokens",
    state,
    "reasoning",
    1,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const encrypted = optionalBoolean(
    object,
    "request_encrypted_content",
    state,
    "reasoning",
  );
  const providerParameters = safeProviderParameters(
    object,
    new Set([
      "effort",
      "summary",
      "budget_tokens",
      "request_encrypted_content",
    ]),
  );
  state.capabilities.add("reasoning");
  return {
    mode: effort === "none" ? "disabled" : "enabled",
    ...(summary === undefined ? {} : { display: summary }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    ...(encrypted === undefined ? {} : { requestEncryptedContent: encrypted }),
    ...(providerParameters === undefined ? {} : { providerParameters }),
  };
}

function parseOutputConfiguration(
  body: JsonObject,
  state: TranslationState,
): OutputConfiguration | undefined {
  const text = isPlainObject(body["text"]) ? body["text"] : undefined;
  const responseFormat = isPlainObject(body["response_format"])
    ? body["response_format"]
    : undefined;
  if (body["text"] !== undefined && text === undefined && body["text"] !== null) {
    fail(
      state.requestId,
      "invalid_openai_responses_request",
      "Expected text configuration.",
      400,
      "text",
    );
  }
  const source = text ?? responseFormat;
  if (source === undefined) return undefined;
  const sourcePath = text === undefined ? "response_format" : "text";
  const verbosity = optionalString(source, "verbosity", state, sourcePath);
  if (
    verbosity !== undefined &&
    verbosity !== "low" &&
    verbosity !== "medium" &&
    verbosity !== "high"
  ) {
    fail(
      state.requestId,
      "unsupported_openai_responses_semantics",
      "Unsupported output verbosity.",
      422,
      `${sourcePath}.verbosity`,
    );
  }
  const formatSource = isPlainObject(source["format"])
    ? source["format"]
    : source;
  const formatPath = formatSource === source ? sourcePath : `${sourcePath}.format`;
  const rawFormat = optionalString(formatSource, "type", state, formatPath);
  let formatValue: OutputConfiguration["format"];
  if (
    rawFormat === "json_schema" ||
    rawFormat === "json_object" ||
    rawFormat === "text"
  ) {
    formatValue = rawFormat;
  } else if (rawFormat === undefined) {
    formatValue = undefined;
  } else {
    fail(
      state.requestId,
      "unsupported_openai_responses_semantics",
      "Unsupported output format.",
      422,
      `${formatPath}.type`,
    );
  }
  let jsonSchema: OutputConfiguration["jsonSchema"];
  if (formatValue === "json_schema") {
    const schema = requireObject(
      formatSource["schema"],
      state,
      `${formatPath}.schema`,
    );
    markTree(state, `${formatPath}.schema`, schema);
    const name = optionalString(formatSource, "name", state, formatPath);
    const description = optionalString(
      formatSource,
      "description",
      state,
      formatPath,
    );
    const strict = optionalBoolean(formatSource, "strict", state, formatPath);
    jsonSchema = {
      schema,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(strict === undefined ? {} : { strict }),
    };
    state.capabilities.add("structured_outputs");
  } else if (formatValue === "json_object") {
    state.capabilities.add("json");
  }
  return {
    ...(verbosity === undefined ? {} : { verbosity }),
    ...(formatValue === undefined ? {} : { format: formatValue }),
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
  };
}

function parseStreamOptions(
  body: JsonObject,
  state: TranslationState,
): StreamOptions | undefined {
  const value = body["stream_options"];
  const startingAfter = body["starting_after"];
  if (value === undefined || value === null) {
    if (startingAfter !== undefined && startingAfter !== null) {
      if (
        typeof startingAfter !== "number" ||
        !Number.isSafeInteger(startingAfter) ||
        startingAfter < 0
      ) {
        fail(
          state.requestId,
          "invalid_resume_metadata",
          "Expected valid resume metadata.",
          400,
          "starting_after",
        );
      }
    }
    return undefined;
  }
  const options = requireObject(value, state, "stream_options");
  const includeUsage = optionalBoolean(
    options,
    "include_usage",
    state,
    "stream_options",
  );
  let resumeFrom: string | undefined;
  if (hasOwn(options, "resume_from") && options["resume_from"] !== null) {
    const resume = options["resume_from"];
    if (
      typeof resume !== "number" ||
      !Number.isSafeInteger(resume) ||
      resume < 0
    ) {
      fail(
        state.requestId,
        "invalid_resume_metadata",
        "Expected valid resume metadata.",
        400,
        "stream_options.resume_from",
      );
    }
    mark(state, "stream_options.resume_from");
    resumeFrom = String(resume);
  }
  if (resumeFrom !== undefined && startingAfter !== undefined) {
    fail(
      state.requestId,
      "invalid_resume_metadata",
      "Conflicting resume metadata.",
      400,
      "starting_after",
    );
  }
  if (hasOwn(options, "include_obfuscation")) {
    const value = options["include_obfuscation"];
    if (typeof value !== "boolean" && value !== null) {
      fail(
        state.requestId,
        "invalid_openai_responses_request",
        "Expected a boolean.",
        400,
        "stream_options.include_obfuscation",
      );
    }
  }
  return {
    ...(includeUsage === undefined ? {} : { includeUsage }),
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  };
}

function parseServiceTier(
  body: JsonObject,
  state: TranslationState,
): ServiceTierConfiguration | undefined {
  if (!hasOwn(body, "service_tier") || body["service_tier"] === null) {
    return undefined;
  }
  const value = requireString(
    body["service_tier"],
    state,
    "service_tier",
    "invalid_openai_responses_request",
  );
  if (value === "auto") return { tier: "auto" };
  if (value === "priority") return { tier: "priority" };
  if (value === "default" || value === "flex" || value === "scale") {
    return { tier: "auto", providerParameters: { service_tier: value } };
  }
  return fail(
    state.requestId,
    "unsupported_openai_responses_semantics",
    "Unsupported service tier.",
    422,
    "service_tier",
  );
}

function inferRouting(
  body: JsonObject,
  state: TranslationState,
): RoutingConstraints {
  const routing = isPlainObject(body["routing"]) ? body["routing"] : undefined;
  if (body["routing"] !== undefined && routing === undefined) {
    fail(
      state.requestId,
      "invalid_openai_responses_request",
      "Expected routing configuration.",
      400,
      "routing",
    );
  }
  if (routing !== undefined) {
    const explicit = routing["required_capabilities"];
    if (Array.isArray(explicit)) {
      explicit.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          fail(
            state.requestId,
            "invalid_openai_responses_request",
            "Expected capability names.",
            400,
            `routing.required_capabilities[${index}]`,
          );
        }
        mark(state, `routing.required_capabilities[${index}]`);
        state.capabilities.add(entry);
      });
    }
  }
  return {
    requiredCapabilities: [...state.capabilities].sort(),
  };
}

function translateRequest(
  input: RawIngressInput,
  context: TranslationContext,
  now: () => string,
): CanonicalRequest {
  const cloned = cloneJson(input.body, context.requestId);
  if (!isPlainObject(cloned)) {
    fail(
      context.requestId,
      "invalid_openai_responses_request",
      "Expected a JSON object request body.",
      400,
      "body",
    );
  }
  let receivedAt: string;
  try {
    receivedAt = now();
  } catch {
    return fail(
      context.requestId,
      "invalid_translation_timestamp",
      "Translation timestamp generation failed.",
      500,
    );
  }
  if (!validateRfc3339Timestamp(receivedAt).valid) {
    fail(
      context.requestId,
      "invalid_translation_timestamp",
      "Translation timestamp generation failed.",
      500,
    );
  }

  const state: TranslationState = {
    requestId: context.requestId,
    consumed: new Set<string>(),
    capabilities: new Set<string>(),
  };
  const model = requireString(
    cloned["model"],
    state,
    "model",
    "invalid_model",
  );
  const inputValue = cloned["input"];
  let messages: CanonicalMessage[];
  if (typeof inputValue === "string") {
    if (inputValue.length === 0) {
      fail(
        context.requestId,
        "invalid_messages",
        "Expected non-empty input.",
        400,
        "input",
      );
    }
    mark(state, "input");
    messages = [{ role: "user", content: [{ type: "text", text: inputValue }] }];
  } else if (Array.isArray(inputValue) && inputValue.length > 0) {
    messages = inputValue.map((entry, index) =>
      parseInputItem(entry, state, `input[${index}]`),
    );
  } else {
    fail(
      context.requestId,
      "invalid_messages",
      "Expected non-empty input.",
      400,
      "input",
    );
  }

  const stream = optionalBoolean(cloned, "stream", state, "") ?? false;
  const sampling: SamplingParameters = {};
  const maxTokens = optionalNumber(
    cloned,
    "max_output_tokens",
    state,
    "",
    1,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const temperature = optionalNumber(
    cloned,
    "temperature",
    state,
    "",
    0,
    2,
  );
  const topP = optionalNumber(cloned, "top_p", state, "", 0, 1);
  if (maxTokens !== undefined) sampling.maxTokens = maxTokens;
  if (temperature !== undefined) sampling.temperature = temperature;
  if (topP !== undefined) sampling.topP = topP;
  if (hasOwn(cloned, "top_k") && cloned["top_k"] !== null) {
    fail(
      context.requestId,
      "unsupported_openai_responses_semantics",
      "Responses does not support top_k.",
      422,
      "top_k",
    );
  }
  if (hasOwn(cloned, "n") && cloned["n"] !== null) {
    const n = cloned["n"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
      fail(
        context.requestId,
        "invalid_range",
        "Expected a positive integer.",
        400,
        "n",
      );
    }
    mark(state, "n");
    if (n > 1) {
      fail(
        context.requestId,
        "unsupported_openai_responses_semantics",
        "Responses supports exactly one choice.",
        422,
        "n",
      );
    }
    sampling.n = 1;
  }

  const tools =
    cloned["tools"] === undefined || cloned["tools"] === null
      ? undefined
      : parseTools(cloned["tools"], state, "tools");
  const toolChoice =
    cloned["tool_choice"] === undefined || cloned["tool_choice"] === null
      ? undefined
      : parseToolChoice(cloned["tool_choice"], state, "tool_choice");
  const parallelToolCalls = optionalBoolean(
    cloned,
    "parallel_tool_calls",
    state,
    "",
  );
  const reasoning = parseReasoningRequest(cloned, state);
  const output = parseOutputConfiguration(cloned, state);
  const serviceTier = parseServiceTier(cloned, state);
  const streamOptions = parseStreamOptions(cloned, state);

  const store = optionalBoolean(cloned, "store", state, "");
  const zeroDataRetention = optionalBoolean(
    cloned,
    "zero_data_retention",
    state,
    "",
  );
  const previousResponseId = optionalString(
    cloned,
    "previous_response_id",
    state,
    "",
  );
  let conversationId: string | undefined;
  if (typeof cloned["conversation"] === "string") {
    conversationId = requireString(
      cloned["conversation"],
      state,
      "conversation",
      "invalid_openai_responses_request",
    );
  } else if (isPlainObject(cloned["conversation"])) {
    conversationId = requireString(
      cloned["conversation"]["id"],
      state,
      "conversation.id",
      "invalid_openai_responses_request",
    );
  } else if (cloned["conversation"] !== undefined && cloned["conversation"] !== null) {
    fail(
      context.requestId,
      "invalid_openai_responses_request",
      "Expected a conversation identifier.",
      400,
      "conversation",
    );
  }
  if (previousResponseId !== undefined && conversationId !== undefined) {
    fail(
      context.requestId,
      "invalid_openai_responses_request",
      "Conversation fields are mutually exclusive.",
      400,
      "conversation",
    );
  }

  const background = optionalBoolean(cloned, "background", state, "");
  let callbackUrl: string | undefined;
  if (isPlainObject(cloned["execution"])) {
    callbackUrl = optionalString(cloned["execution"], "callback_url", state, "execution");
    if (callbackUrl !== undefined && !validateUrl(callbackUrl).valid) {
      fail(
        context.requestId,
        "invalid_openai_responses_request",
        "Expected a safe callback URL.",
        400,
        "execution.callback_url",
      );
    }
  }
  if (background === true) state.capabilities.add("background_execution");

  const include = cloned["include"];
  if (Array.isArray(include)) {
    include.forEach((entry, index) => {
      if (entry === "reasoning.encrypted_content") {
        mark(state, `include[${index}]`);
      }
    });
  }
  const requestEncryptedContent =
    Array.isArray(include) && include.includes("reasoning.encrypted_content");
  const routing = inferRouting(cloned, state);

  const wireInstructions = optionalString(cloned, "instructions", state, "");
  let leadingInstructionCount = 0;
  while (leadingInstructionCount < messages.length) {
    const message = messages[leadingInstructionCount];
    if (
      message === undefined ||
      (message.role !== "system" && message.role !== "developer") ||
      !message.content.every(
        (block) =>
          block.type === "text" &&
          block.cacheBreakpoint === undefined &&
          block.citations === undefined,
      )
    ) {
      break;
    }
    leadingInstructionCount += 1;
  }
  const collapsedInstructions =
    wireInstructions ??
    (leadingInstructionCount === 0
      ? undefined
      : messages
          .slice(0, leadingInstructionCount)
          .flatMap((message) =>
            message.content.map((block) =>
              block.type === "text" ? block.text : "",
            ),
          )
          .join("\n"));
  if (collapsedInstructions !== undefined) {
    state.capabilities.add("instructions");
  }
  const body = extensionBody(cloned, state.consumed);
  const sourceFields = depthFirstConsumedFields(cloned, state.consumed);
  const request: CanonicalRequest = {
    requestId: context.requestId,
    receivedAt,
    source: { adapter: PROTOCOL, protocol: PROTOCOL, path: input.path },
    model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(Object.keys(sampling).length === 0 ? {} : { sampling }),
    ...(reasoning === undefined && !requestEncryptedContent
      ? {}
      : {
          reasoning: {
            ...(reasoning ?? { mode: "enabled" as const }),
            ...(requestEncryptedContent
              ? { requestEncryptedContent: true }
              : {}),
          },
        }),
    ...(output === undefined ? {} : { output }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(store === undefined && zeroDataRetention === undefined
      ? {}
      : {
          persistence: {
            ...(store === undefined ? {} : { store }),
            ...(zeroDataRetention === undefined
              ? {}
              : { zeroDataRetention }),
          },
        }),
    ...(previousResponseId === undefined && conversationId === undefined
      ? {}
      : {
          conversation: {
            ...(previousResponseId === undefined
              ? {}
              : { previousResponseId }),
            ...(conversationId === undefined ? {} : { conversationId }),
          },
        }),
    ...(background !== true && callbackUrl === undefined
      ? {}
      : {
          execution: {
            mode: background === true ? "background" : "sync",
            ...(callbackUrl === undefined ? {} : { callbackUrl }),
          },
        }),
    routing,
    stream,
    ...(streamOptions === undefined ? {} : { streamOptions }),
    ...(collapsedInstructions === undefined
      ? {}
      : { metadata: { instructions: collapsedInstructions } }),
    extensions: {
      protocols: {
        [PROTOCOL]: {
          protocol: PROTOCOL,
          body,
          headers: {},
          sourceFields,
        },
      },
    },
  };
  const validation = validateCanonicalRequest(request);
  if (!validation.valid) {
    fail(
      context.requestId,
      "invalid_openai_responses_request",
      "Canonical request validation failed.",
      400,
      validation.issues[0]?.path,
    );
  }
  return freezeOwned(request);
}

function unixTimestamp(timestamp: string, requestId: string): number {
  if (!validateRfc3339Timestamp(timestamp).valid) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Canonical response cannot be encoded safely.",
      500,
      "createdAt",
    );
  }
  return Math.floor(Date.parse(timestamp) / 1000);
}

function encodeCitation(citation: Citation): JsonObject | undefined {
  if (citation.kind === "url" && citation.url !== undefined) {
    return {
      type: "url_citation",
      url: citation.url,
      ...(citation.sourceTitle === undefined
        ? {}
        : { title: citation.sourceTitle }),
      ...(citation.startIndex === undefined
        ? {}
        : { start_index: citation.startIndex }),
      ...(citation.endIndex === undefined
        ? {}
        : { end_index: citation.endIndex }),
    };
  }
  if (citation.kind === "file" && citation.sourceId !== undefined) {
    return {
      type: "file_citation",
      file_id: citation.sourceId,
      ...(citation.citedText === undefined ? {} : { quote: citation.citedText }),
    };
  }
  return undefined;
}

function validateUsage(usage: TokenUsage, requestId: string): void {
  if (!isPlainObject(usage)) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Canonical usage cannot be encoded safely.",
      500,
      "usage",
    );
  }
  const required = ["inputTokens", "outputTokens", "totalTokens"] as const;
  const optional = [
    "reasoningTokens",
    "audioInputTokens",
    "audioOutputTokens",
    "cachedInputTokens",
    "acceptedPredictionTokens",
    "rejectedPredictionTokens",
  ] as const;
  const invalidCounter = (value: unknown): boolean =>
    typeof value !== "number" || !Number.isFinite(value) || value < 0;
  if (
    required.some((key) => invalidCounter(usage[key])) ||
    optional.some(
      (key) => usage[key] !== undefined && invalidCounter(usage[key]),
    )
  ) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Canonical usage cannot be encoded safely.",
      500,
      "usage",
    );
  }
  const breakdown: unknown = usage.cacheWriteBreakdown;
  if (
    breakdown !== undefined &&
    (!Array.isArray(breakdown) ||
      breakdown.some(
        (entry: unknown) =>
          !isPlainObject(entry) ||
          invalidCounter(entry["tokens"]) ||
          invalidCounter(entry["ttlSeconds"]),
      ))
  ) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Canonical usage cannot be encoded safely.",
      500,
      "usage.cacheWriteBreakdown",
    );
  }
}

function encodeUsage(usage: TokenUsage, requestId: string): JsonObject {
  validateUsage(usage, requestId);
  const inputDetails: JsonObject = {};
  if (usage.cachedInputTokens !== undefined) {
    inputDetails["cached_tokens"] = usage.cachedInputTokens;
  }
  if (usage.audioInputTokens !== undefined) {
    inputDetails["audio_tokens"] = usage.audioInputTokens;
  }
  if (usage.cacheWriteBreakdown !== undefined) {
    inputDetails["cache_write_tokens"] = usage.cacheWriteBreakdown.reduce(
      (total, entry) => total + entry.tokens,
      0,
    );
  }
  const outputDetails: JsonObject = {};
  if (usage.reasoningTokens !== undefined) {
    outputDetails["reasoning_tokens"] = usage.reasoningTokens;
  }
  if (usage.audioOutputTokens !== undefined) {
    outputDetails["audio_tokens"] = usage.audioOutputTokens;
  }
  if (usage.acceptedPredictionTokens !== undefined) {
    outputDetails["accepted_prediction_tokens"] =
      usage.acceptedPredictionTokens;
  }
  if (usage.rejectedPredictionTokens !== undefined) {
    outputDetails["rejected_prediction_tokens"] =
      usage.rejectedPredictionTokens;
  }
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(Object.keys(inputDetails).length === 0
      ? {}
      : { input_tokens_details: inputDetails }),
    ...(Object.keys(outputDetails).length === 0
      ? {}
      : { output_tokens_details: outputDetails }),
  };
}

function encodeNestedResultContent(
  blocks: readonly ContentBlock[],
  requestId: string,
): JsonValue {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  return blocks.map((block) => encodeOutputBlock(block, false, requestId));
}

function encodeOutputBlock(
  block: ContentBlock,
  exposeReasoningText: boolean,
  requestId: string,
): JsonObject {
  const common: JsonObject = {
    ...(block.id === undefined ? {} : { id: block.id }),
    ...(block.status === undefined ? {} : { status: block.status }),
  };
  switch (block.type) {
    case "text": {
      const annotations = block.citations?.map((citation, index) => {
        const encoded = encodeCitation(citation);
        if (encoded === undefined) {
          fail(
            requestId,
            "invalid_openai_responses_egress",
            "Citation cannot be represented safely.",
            500,
            `citations[${index}]`,
          );
        }
        return encoded;
      });
      return {
        ...common,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: block.text,
            ...(block.cacheBreakpoint === undefined
              ? {}
              : { prompt_cache_breakpoint: block.cacheBreakpoint }),
            ...(annotations === undefined ? {} : { annotations }),
          },
        ],
      };
    }
    case "refusal":
      return {
        ...common,
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: block.refusal }],
      };
    case "reasoning":
      return {
        ...common,
        type: "reasoning",
        ...(exposeReasoningText && block.text !== undefined
          ? { summary: [{ type: "summary_text", text: block.text }] }
          : {}),
      };
    case "tool_call":
      if (!validateToolCallArgumentsJson(block.argumentsJson).valid) {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Canonical tool arguments cannot be encoded safely.",
          500,
          "argumentsJson",
        );
      }
      return {
        ...common,
        type: "function_call",
        call_id: block.toolCallId,
        name: block.name,
        arguments: block.argumentsJson,
        ...(block.caller === undefined ? {} : { caller: block.caller }),
      };
    case "tool_result":
      return {
        ...common,
        type: "function_call_output",
        call_id: block.toolCallId,
        output: encodeNestedResultContent(block.content, requestId),
        ...(block.isError === true ? { status: "failed" } : {}),
      };
    case "server_tool_call":
      return {
        ...common,
        type: block.toolKind,
        call_id: block.toolCallId,
        ...(block.name === undefined ? {} : { name: block.name }),
        ...(block.serverName === undefined
          ? {}
          : { server_label: block.serverName }),
        ...(block.input === undefined ? {} : { input: block.input }),
        ...(block.argumentsJson === undefined
          ? {}
          : { arguments: block.argumentsJson }),
        ...(block.caller === undefined ? {} : { caller: block.caller }),
      };
    case "server_tool_result":
      return {
        ...common,
        type: block.toolKind.endsWith("_output")
          ? block.toolKind
          : `${block.toolKind}_output`,
        call_id: block.toolCallId,
        output: encodeNestedResultContent(block.content, requestId),
        ...(block.isError === true ? { status: "failed" } : {}),
      };
    case "tool_approval_request":
      return {
        ...common,
        type: "mcp_approval_request",
        approval_request_id: block.toolCallId,
        ...(block.reason === undefined ? {} : { reason: block.reason }),
      };
    case "tool_approval_response":
      return {
        ...common,
        type: "mcp_approval_response",
        approval_request_id: block.toolCallId,
        approve: block.approved,
      };
    case "generated_image":
      return {
        ...common,
        type: "image_generation_call",
        result: block.data,
      };
    case "audio_output":
      return {
        ...common,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_audio",
            ...(block.data === undefined ? {} : { data: block.data }),
            ...(block.transcript === undefined
              ? {}
              : { transcript: block.transcript }),
          },
        ],
      };
    default:
      return fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical output cannot be represented safely.",
        500,
        "output",
      );
  }
}

function isPlainCanonicalResponseShape(value: unknown): value is CanonicalResponse {
  if (!isPlainObject(value)) return false;
  if (!Array.isArray(value["choices"]) || !isPlainObject(value["usage"])) {
    return false;
  }
  return value["choices"].every(
    (choice) =>
      isPlainObject(choice) &&
      Array.isArray(choice["output"]) &&
      choice["output"].every((block) => isPlainObject(block)),
  );
}

function encodeResponse(
  response: CanonicalResponse,
  exposeReasoningText: boolean,
): EgressValue {
  if (
    !isPlainCanonicalResponseShape(response) ||
    !isSafeCanonicalResponse(response) ||
    response.responseId.length === 0 ||
    response.model.length === 0 ||
    response.choices.length !== 1 ||
    response.choices[0]?.index !== 0
  ) {
    fail(
      response.requestId,
      "invalid_openai_responses_egress",
      "Canonical response cannot be encoded safely.",
      500,
      "response",
    );
  }
  return {
    id: response.responseId,
    object: "response",
    created_at: unixTimestamp(response.createdAt, response.requestId),
    status: response.status,
    model: response.model,
    output: response.choices[0].output.map((block) =>
      encodeOutputBlock(block, exposeReasoningText, response.requestId),
    ),
    usage: encodeUsage(response.usage, response.requestId),
  };
}

function safeErrorFields(error: GatewayError): JsonObject {
  const details = redactDetails(error.details);
  return {
    code: error.code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    status: error.status,
    requestId: error.requestId,
    ...(error.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: error.retryAfterMs }),
    ...(details === undefined ? {} : { details: details as JsonValue }),
  };
}

function encodeError(error: GatewayError): JsonObject {
  return { error: safeErrorFields(error) };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function namedEvent(
  type: string,
  sequenceNumber: number,
  payload: JsonObject,
  maxEventBytes: number,
  requestId: string,
): string {
  const output = `event: ${type}\ndata: ${JSON.stringify({
    type,
    sequence_number: sequenceNumber,
    ...payload,
  })}\n\n`;
  if (utf8Bytes(output) > maxEventBytes) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Stream event exceeds the configured bound.",
      500,
      "event",
    );
  }
  return output;
}

function maxSequence(state: StreamTranslationState): number {
  let maximum = 0;
  for (const sequence of state.emittedSequences) {
    if (sequence > maximum) maximum = sequence;
  }
  return maximum;
}

function reserveSequence(
  state: StreamTranslationState | undefined,
  supplied: number | undefined,
  key: string,
  requestId: string,
): number {
  if (supplied !== undefined) {
    if (!Number.isSafeInteger(supplied) || supplied <= 0) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Invalid stream sequence number.",
        500,
        "sequenceNumber",
      );
    }
    if (
      state !== undefined &&
      (state.emittedSequences.has(supplied) || supplied <= maxSequence(state))
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Stream sequence numbers must be monotonic and non-reused.",
        500,
        "sequenceNumber",
      );
    }
    if (state !== undefined) {
      state.sequenceNumbers.set(key, supplied);
      state.emittedSequences.add(supplied);
    }
    return supplied;
  }
  if (state === undefined) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Request-owned stream state is required for sequence allocation.",
      500,
      "streamState",
    );
  }
  const sequence = maxSequence(state) + 1;
  state.sequenceNumbers.set(key, sequence);
  state.emittedSequences.add(sequence);
  return sequence;
}

function reserveAdditionalSequence(
  state: StreamTranslationState | undefined,
  previous: number,
  key: string,
  requestId: string,
): number {
  const sequence = previous + 1;
  if (!Number.isSafeInteger(sequence)) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Invalid stream sequence number.",
      500,
      "sequenceNumber",
    );
  }
  if (state !== undefined) {
    if (
      state.emittedSequences.has(sequence) ||
      sequence <= maxSequence(state)
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Stream sequence numbers must be monotonic and non-reused.",
        500,
        "sequenceNumber",
      );
    }
    state.sequenceNumbers.set(key, sequence);
    state.emittedSequences.add(sequence);
  }
  return sequence;
}

function includeRecord(
  record: string,
  sequenceNumber: number,
  state: StreamTranslationState | undefined,
): string {
  if (state?.resumeFrom !== undefined && sequenceNumber <= state.resumeFrom) {
    return "";
  }
  if (state !== undefined) state.bytesEmitted = true;
  return record;
}

function assertCombinedBound(
  output: string,
  maxEventBytes: number,
  requestId: string,
): string {
  if (utf8Bytes(output) > maxEventBytes) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Combined stream output exceeds the configured bound.",
      500,
      "event",
    );
  }
  return output;
}

function streamIdentity(
  chunk: CanonicalChunk,
  context: TranslationContext,
): { readonly responseId: string; readonly model: string; readonly createdAt: string } | undefined {
  if (chunk.type === "response_start") {
    return {
      responseId: chunk.responseId,
      model: chunk.model,
      createdAt: chunk.createdAt,
    };
  }
  return context.streamState?.response ?? context.streamResponse;
}

function identitiesEqual(
  left: { readonly responseId: string; readonly model: string; readonly createdAt: string },
  right: { readonly responseId: string; readonly model: string; readonly createdAt: string },
): boolean {
  return (
    left.responseId === right.responseId &&
    left.model === right.model &&
    left.createdAt === right.createdAt
  );
}

function partialOutputItem(block: {
  readonly type: ContentBlock["type"];
  readonly id?: string;
  readonly name?: string;
  readonly toolKind?: string;
  readonly serverName?: string;
}): JsonObject {
  if (block.type === "text" || block.type === "refusal") {
    return {
      type: "message",
      role: "assistant",
      content: [],
      ...(block.id === undefined ? {} : { id: block.id }),
      status: "in_progress",
    };
  }
  if (block.type === "tool_call") {
    return {
      type: "function_call",
      ...(block.id === undefined ? {} : { id: block.id, call_id: block.id }),
      ...(block.name === undefined ? {} : { name: block.name }),
      arguments: "",
      status: "in_progress",
    };
  }
  if (block.type === "server_tool_call") {
    return {
      type: block.toolKind ?? "server_tool_call",
      ...(block.id === undefined ? {} : { id: block.id, call_id: block.id }),
      ...(block.name === undefined ? {} : { name: block.name }),
      ...(block.serverName === undefined
        ? {}
        : { server_label: block.serverName }),
      status: "in_progress",
    };
  }
  return {
    type: block.type,
    ...(block.id === undefined ? {} : { id: block.id }),
    status: "in_progress",
  };
}

function partialContentPart(
  block: { readonly type: ContentBlock["type"] },
): JsonObject {
  if (block.type === "text") return { type: "output_text", text: "", annotations: [] };
  if (block.type === "refusal") return { type: "refusal", refusal: "" };
  if (block.type === "reasoning") return { type: "summary_text", text: "" };
  if (block.type === "audio_output") return { type: "output_audio" };
  return { type: block.type };
}

function completedContentPart(
  block: ContentBlock | undefined,
  exposeReasoningText: boolean,
): JsonObject {
  if (block === undefined) return {};
  if (block.type === "text") {
    const annotations = block.citations
      ?.map(encodeCitation)
      .filter((value): value is JsonObject => value !== undefined);
    return {
      type: "output_text",
      text: block.text,
      ...(annotations === undefined ? {} : { annotations }),
      ...(block.cacheBreakpoint === undefined
        ? {}
        : { prompt_cache_breakpoint: block.cacheBreakpoint }),
    };
  }
  if (block.type === "refusal") {
    return { type: "refusal", refusal: block.refusal };
  }
  if (block.type === "reasoning") {
    return {
      type: "summary_text",
      text: exposeReasoningText ? (block.text ?? "") : "",
    };
  }
  if (block.type === "audio_output") {
    return {
      type: "output_audio",
      ...(block.data === undefined ? {} : { data: block.data }),
      ...(block.transcript === undefined
        ? {}
        : { transcript: block.transcript }),
    };
  }
  return { type: block.type };
}

function validateChunkPreflight(
  value: unknown,
  requestId: string,
): asserts value is CanonicalChunk {
  if (!isPlainObject(value) || typeof value["type"] !== "string") {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Canonical stream chunk is malformed.",
      500,
      "chunk",
    );
  }
  const sequence = value["sequenceNumber"];
  if (
    sequence !== undefined &&
    (typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0)
  ) {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Invalid stream sequence number.",
      500,
      "sequenceNumber",
    );
  }
  const type = value["type"];
  const addressTypes: ReadonlySet<string> = new Set([
    "content_block_start",
    "text_delta",
    "refusal_delta",
    "reasoning_delta",
    "audio_delta",
    "tool_call_delta",
    "citation_added",
    "content_block_stop",
  ]);
  if (addressTypes.has(type)) {
    const address = value["address"];
    if (
      !isPlainObject(address) ||
      typeof address["outputIndex"] !== "number" ||
      !Number.isSafeInteger(address["outputIndex"]) ||
      address["outputIndex"] < 0 ||
      (address["choiceIndex"] !== undefined &&
        (typeof address["choiceIndex"] !== "number" ||
          !Number.isSafeInteger(address["choiceIndex"]) ||
          address["choiceIndex"] < 0)) ||
      (address["contentIndex"] !== undefined &&
        (typeof address["contentIndex"] !== "number" ||
          !Number.isSafeInteger(address["contentIndex"]) ||
          address["contentIndex"] < 0))
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical stream address is malformed.",
        500,
        "chunk.address",
      );
    }
  }
  if (type === "response_start") {
    if (
      typeof value["responseId"] !== "string" ||
      value["responseId"].length === 0 ||
      typeof value["model"] !== "string" ||
      value["model"].length === 0 ||
      !validateRfc3339Timestamp(value["createdAt"]).valid
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical response start is malformed.",
        500,
        "chunk",
      );
    }
  } else if (type === "content_block_start") {
    const block = value["block"];
    if (!isPlainObject(block) || typeof block["type"] !== "string") {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical content-block start is malformed.",
        500,
        "chunk.block",
      );
    }
  } else if (type === "text_delta" || type === "refusal_delta") {
    if (typeof value["text"] !== "string") {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical text delta is malformed.",
        500,
        "chunk.text",
      );
    }
  } else if (type === "reasoning_delta") {
    for (const key of [
      "text",
      "signatureDelta",
      "redactedDataDelta",
      "encryptedContentDelta",
    ] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Canonical reasoning delta is malformed.",
          500,
          `chunk.${key}`,
        );
      }
    }
  } else if (type === "audio_delta") {
    for (const key of ["audioBase64", "transcriptDelta"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Canonical audio delta is malformed.",
          500,
          `chunk.${key}`,
        );
      }
    }
  } else if (type === "tool_call_delta") {
    for (const key of ["id", "name", "argumentsDelta"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Canonical tool-call delta is malformed.",
          500,
          `chunk.${key}`,
        );
      }
    }
  } else if (type === "citation_added") {
    if (!isPlainObject(value["citation"])) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical citation chunk is malformed.",
        500,
        "chunk.citation",
      );
    }
  } else if (type === "content_block_stop") {
    if (
      value["block"] !== undefined &&
      !validateContentBlock(value["block"], "chunk.block").valid
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical content-block stop is malformed.",
        500,
        "chunk.block",
      );
    }
  } else if (type === "usage") {
    if (!isPlainObject(value["usage"])) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical usage chunk is malformed.",
        500,
        "chunk.usage",
      );
    }
  } else if (type === "choice_end") {
    if (
      value["choiceIndex"] !== undefined &&
      (typeof value["choiceIndex"] !== "number" ||
        !Number.isSafeInteger(value["choiceIndex"]) ||
        value["choiceIndex"] < 0)
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical choice end is malformed.",
        500,
        "chunk.choiceIndex",
      );
    }
    if (typeof value["finishReason"] !== "string") {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical choice end is malformed.",
        500,
        "chunk.finishReason",
      );
    }
  } else if (type === "response_end") {
    if (typeof value["status"] !== "string") {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical response end is malformed.",
        500,
        "chunk.status",
      );
    }
  } else if (type === "error") {
    const error = value["error"];
    if (
      !isPlainObject(error) ||
      typeof error["code"] !== "string" ||
      typeof error["message"] !== "string" ||
      typeof error["category"] !== "string" ||
      typeof error["retryable"] !== "boolean" ||
      typeof error["status"] !== "number" ||
      !Number.isInteger(error["status"]) ||
      typeof error["requestId"] !== "string"
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Canonical error chunk is malformed.",
        500,
        "chunk.error",
      );
    }
  } else if (type !== "ping") {
    fail(
      requestId,
      "invalid_openai_responses_egress",
      "Unsupported canonical stream chunk.",
      500,
      "chunk.type",
    );
  }
}

function encodeChunk(
  chunk: CanonicalChunk,
  context: TranslationContext,
  exposeReasoningText: boolean,
  maxEventBytes: number,
): string {
  validateChunkPreflight(chunk, context.requestId);
  const state = context.streamState;
  const requestId = context.requestId;
  if (chunk.type === "ping") return "";
  if (state?.terminal === true) return "";

  const identity = streamIdentity(chunk, context);
  if (identity === undefined) {
    fail(
      requestId,
      "missing_stream_response_metadata",
      "Stream response metadata is required.",
      500,
      "streamResponse",
    );
  }

  if (chunk.type === "response_start") {
    if (
      (state?.response !== undefined && !identitiesEqual(state.response, identity)) ||
      (context.streamResponse !== undefined &&
        !identitiesEqual(context.streamResponse, identity))
    ) {
      fail(
        requestId,
        "invalid_openai_responses_egress",
        "Conflicting stream response identity.",
        500,
        "streamResponse",
      );
    }
    if (state !== undefined) state.response = identity;
    const created = reserveSequence(
      state,
      chunk.sequenceNumber,
      "response.created",
      requestId,
    );
    const inProgress = reserveAdditionalSequence(
      state,
      created,
      "response.in_progress",
      requestId,
    );
    const response = {
      id: identity.responseId,
      object: "response",
      created_at: unixTimestamp(identity.createdAt, requestId),
      status: "in_progress",
      model: identity.model,
      output: [],
      usage: null,
    };
    const first = includeRecord(
      namedEvent(
        "response.created",
        created,
        { response },
        maxEventBytes,
        requestId,
      ),
      created,
      state,
    );
    const second = includeRecord(
      namedEvent(
        "response.in_progress",
        inProgress,
        { response },
        maxEventBytes,
        requestId,
      ),
      inProgress,
      state,
    );
    return assertCombinedBound(first + second, maxEventBytes, requestId);
  }

  const primary = reserveSequence(
    state,
    chunk.sequenceNumber,
    chunk.type,
    requestId,
  );

  if (chunk.type === "usage") {
    validateUsage(chunk.usage, requestId);
    if (state !== undefined) state.usage = freezeOwned({ ...chunk.usage });
    return "";
  }
  if (chunk.type === "choice_end") return "";
  if (chunk.type === "reasoning_delta" && !exposeReasoningText) return "";

  if (chunk.type === "error") {
    if (state !== undefined) state.terminal = true;
    const record = includeRecord(
      namedEvent(
        "error",
        primary,
        { error: safeErrorFields(chunk.error) },
        maxEventBytes,
        requestId,
      ),
      primary,
      state,
    );
    return assertCombinedBound(
      record + "data: [DONE]\n\n",
      maxEventBytes,
      requestId,
    );
  }

  if (chunk.type === "content_block_start") {
    const secondary = reserveAdditionalSequence(
      state,
      primary,
      "response.content_part.added",
      requestId,
    );
    const outputIndex = chunk.address.outputIndex;
    const contentIndex = chunk.address.contentIndex ?? 0;
    const item = partialOutputItem(chunk.block);
    const part = partialContentPart(chunk.block);
    const first = includeRecord(
      namedEvent(
        "response.output_item.added",
        primary,
        { output_index: outputIndex, item },
        maxEventBytes,
        requestId,
      ),
      primary,
      state,
    );
    const second = includeRecord(
      namedEvent(
        "response.content_part.added",
        secondary,
        { output_index: outputIndex, content_index: contentIndex, part },
        maxEventBytes,
        requestId,
      ),
      secondary,
      state,
    );
    return assertCombinedBound(first + second, maxEventBytes, requestId);
  }

  if (chunk.type === "content_block_stop") {
    const secondary = reserveAdditionalSequence(
      state,
      primary,
      "response.output_item.done",
      requestId,
    );
    const outputIndex = chunk.address.outputIndex;
    const contentIndex = chunk.address.contentIndex ?? 0;
    const part = completedContentPart(chunk.block, exposeReasoningText);
    const item =
      chunk.block === undefined
        ? {}
        : encodeOutputBlock(chunk.block, exposeReasoningText, requestId);
    const first = includeRecord(
      namedEvent(
        "response.content_part.done",
        primary,
        { output_index: outputIndex, content_index: contentIndex, part },
        maxEventBytes,
        requestId,
      ),
      primary,
      state,
    );
    const second = includeRecord(
      namedEvent(
        "response.output_item.done",
        secondary,
        { output_index: outputIndex, item },
        maxEventBytes,
        requestId,
      ),
      secondary,
      state,
    );
    return assertCombinedBound(first + second, maxEventBytes, requestId);
  }

  let type: string;
  let payload: JsonObject;
  switch (chunk.type) {
    case "text_delta":
      type = "response.output_text.delta";
      payload = {
        output_index: chunk.address.outputIndex,
        content_index: chunk.address.contentIndex ?? 0,
        delta: chunk.text,
      };
      break;
    case "refusal_delta":
      type = "response.refusal.delta";
      payload = {
        output_index: chunk.address.outputIndex,
        content_index: chunk.address.contentIndex ?? 0,
        delta: chunk.text,
      };
      break;
    case "reasoning_delta":
      if (chunk.text === undefined) return "";
      type = "response.reasoning_summary_text.delta";
      payload = {
        output_index: chunk.address.outputIndex,
        summary_index: chunk.address.contentIndex ?? 0,
        delta: chunk.text,
      };
      break;
    case "tool_call_delta":
      type = "response.function_call_arguments.delta";
      payload = {
        output_index: chunk.address.outputIndex,
        ...(chunk.id === undefined ? {} : { item_id: chunk.id }),
        delta: chunk.argumentsDelta ?? "",
      };
      break;
    case "audio_delta":
      if (
        (chunk.audioBase64 === undefined) ===
        (chunk.transcriptDelta === undefined)
      ) {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Expected exactly one supported audio delta.",
          500,
          "audio_delta",
        );
      }
      type =
        chunk.audioBase64 === undefined
          ? "response.output_audio_transcript.delta"
          : "response.output_audio.delta";
      payload = {
        output_index: chunk.address.outputIndex,
        content_index: chunk.address.contentIndex ?? 0,
        delta: chunk.audioBase64 ?? chunk.transcriptDelta ?? "",
      };
      break;
    case "citation_added": {
      const annotation = encodeCitation(chunk.citation);
      if (annotation === undefined) {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Citation cannot be represented safely.",
          500,
          "citation",
        );
      }
      type = "response.output_text.annotation.added";
      payload = {
        output_index: chunk.address.outputIndex,
        content_index: chunk.address.contentIndex ?? 0,
        annotation,
      };
      break;
    }
    case "response_end": {
      if (
        chunk.status !== "completed" &&
        chunk.status !== "incomplete" &&
        chunk.status !== "failed"
      ) {
        fail(
          requestId,
          "invalid_openai_responses_egress",
          "Unsupported terminal response status.",
          500,
          "status",
        );
      }
      if (state !== undefined) state.terminal = true;
      type =
        chunk.status === "completed"
          ? "response.completed"
          : chunk.status === "incomplete"
            ? "response.incomplete"
            : "response.failed";
      payload = {
        response: {
          id: identity.responseId,
          object: "response",
          created_at: unixTimestamp(identity.createdAt, requestId),
          status: chunk.status,
          model: identity.model,
          output: [],
          usage:
            state?.usage === undefined
              ? null
              : encodeUsage(state.usage, requestId),
        },
      };
      const record = includeRecord(
        namedEvent(type, primary, payload, maxEventBytes, requestId),
        primary,
        state,
      );
      return assertCombinedBound(
        record + "data: [DONE]\n\n",
        maxEventBytes,
        requestId,
      );
    }
    default:
      return fail(
        requestId,
        "invalid_openai_responses_egress",
        "Unsupported canonical stream chunk.",
        500,
        "chunk",
      );
  }

  const record = includeRecord(
    namedEvent(type, primary, payload, maxEventBytes, requestId),
    primary,
    state,
  );
  return assertCombinedBound(record, maxEventBytes, requestId);
}

function cloneStreamState(
  source: StreamTranslationState,
): StreamTranslationState {
  return {
    sequenceNumbers: new Map(source.sequenceNumbers),
    emittedSequences: new Set(source.emittedSequences),
    ...(source.resumeFrom === undefined ? {} : { resumeFrom: source.resumeFrom }),
    ...(source.response === undefined
      ? {}
      : { response: { ...source.response } }),
    ...(source.usage === undefined ? {} : { usage: { ...source.usage } }),
    terminal: source.terminal,
    bytesEmitted: source.bytesEmitted,
  };
}

function commitStreamState(
  target: StreamTranslationState,
  source: StreamTranslationState,
): void {
  target.sequenceNumbers.clear();
  for (const [key, value] of source.sequenceNumbers) {
    target.sequenceNumbers.set(key, value);
  }
  target.emittedSequences.clear();
  for (const value of source.emittedSequences) {
    target.emittedSequences.add(value);
  }
  if (source.response === undefined) delete target.response;
  else target.response = source.response;
  if (source.usage === undefined) delete target.usage;
  else target.usage = source.usage;
  target.terminal = source.terminal;
  target.bytesEmitted = source.bytesEmitted;
}

function encodeChunkAtomically(
  chunk: CanonicalChunk,
  context: TranslationContext,
  exposeReasoningText: boolean,
  maxEventBytes: number,
): string {
  if (context.streamState === undefined) {
    return encodeChunk(chunk, context, exposeReasoningText, maxEventBytes);
  }
  const workingState = cloneStreamState(context.streamState);
  const output = encodeChunk(
    chunk,
    { ...context, streamState: workingState },
    exposeReasoningText,
    maxEventBytes,
  );
  commitStreamState(context.streamState, workingState);
  return output;
}

class ImmutablePathSet implements ReadonlySet<string> {
  readonly #values: Set<string> = new Set(RESPONSES_PATHS);

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
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.#values[Symbol.iterator]();
  }
}

class OpenAiResponsesIngressAdapter implements IngressTranslationAdapter {
  readonly protocol = PROTOCOL;
  readonly paths: ReadonlySet<string> = new ImmutablePathSet();
  readonly #now: () => string;

  constructor(now: () => string) {
    this.#now = now;
    Object.freeze(this);
  }

  canTranslate(path: string, body: unknown): boolean {
    return this.paths.has(path) && isPlainObject(body);
  }

  translate(
    input: RawIngressInput,
    context: TranslationContext,
  ): CanonicalRequest {
    return translateRequest(input, context, this.#now);
  }
}

class OpenAiResponsesEgressAdapter implements EgressTranslationAdapter {
  readonly protocol = PROTOCOL;
  readonly #exposeReasoningText: boolean;
  readonly #maxEventBytes: number;

  constructor(exposeReasoningText: boolean, maxEventBytes: number) {
    this.#exposeReasoningText = exposeReasoningText;
    this.#maxEventBytes = maxEventBytes;
    Object.freeze(this);
  }

  encodeResponse(response: CanonicalResponse): EgressValue {
    return encodeResponse(response, this.#exposeReasoningText);
  }

  encodeChunk(chunk: CanonicalChunk, context: TranslationContext): EgressValue {
    return encodeChunkAtomically(
      chunk,
      context,
      this.#exposeReasoningText,
      this.#maxEventBytes,
    );
  }

  encodeError(error: GatewayError): EgressValue {
    return encodeError(error);
  }
}

/** Creates one immutable, stateless OpenAI Responses translator family. */
export function createOpenAiResponsesTranslatorFamily(
  options: OpenAiResponsesTranslatorOptions,
): OpenAiResponsesTranslatorFamily {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
    throw new TypeError("maxEventBytes must be a positive finite integer");
  }
  return Object.freeze({
    ingress: new OpenAiResponsesIngressAdapter(options.now),
    egress: new OpenAiResponsesEgressAdapter(
      options.exposeReasoningText ?? false,
      maxEventBytes,
    ),
  });
}
