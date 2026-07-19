/** Stable category for a validation failure. */
export type ValidationIssueCode =
  | "invalid_request_id"
  | "invalid_timestamp"
  | "invalid_url"
  | "invalid_media"
  | "invalid_tool_arguments"
  | "invalid_content_block"
  | "invalid_canonical_request"
  | "invalid_extension";

/** Safe, path-qualified validation diagnostic that never echoes input data. */
export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

/** Result of a pure canonical-boundary validation. */
export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: ReadonlyArray<ValidationIssue> };

type Issue = ValidationIssue;
type JsonObject = Record<string, unknown>;

const VALID: ValidationResult = { valid: true };
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+%-]+|"[^"\r\n]*"))*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;
const ROLES: Record<string, true> = { system: true, developer: true, user: true, assistant: true, tool: true };
const PROTOCOLS: Record<string, true> = { "openai-chat": true, "openai-responses": true, "anthropic-messages": true, custom: true };

function invalid(code: ValidationIssueCode, path: string, message: string): ValidationResult {
  return { valid: false, issues: [{ code, path, message }] };
}

function objectValue(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(object: JsonObject, key: string, path: string, issues: Issue[]): void {
  if (typeof object[key] !== "string") {
    issues.push({ code: "invalid_content_block", path: `${path}.${key}`, message: "Expected a string." });
  }
}

function appendResult(issues: Issue[], result: ValidationResult): void {
  if (!result.valid) issues.push(...result.issues);
}

function finish(issues: Issue[]): ValidationResult {
  return issues.length === 0 ? VALID : { valid: false, issues };
}

/** Validate a safe 1-128 character ASCII request identifier. */
export function validateRequestId(value: unknown): ValidationResult {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? VALID
    : invalid("invalid_request_id", "requestId", "Expected a safe ASCII request identifier.");
}

/** Validate a real RFC 3339 calendar timestamp, rejecting leap seconds. */
export function validateRfc3339Timestamp(value: unknown): ValidationResult {
  if (typeof value !== "string") {
    return invalid("invalid_timestamp", "timestamp", "Expected an RFC 3339 timestamp.");
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return invalid("invalid_timestamp", "timestamp", "Expected an RFC 3339 timestamp.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = month >= 1 && month <= 12 ? monthLengths[month - 1] ?? 0 : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return invalid("invalid_timestamp", "timestamp", "Expected a real RFC 3339 date and time.");
  }
  return VALID;
}

/** Validate an HTTP(S) URL without fetching it or exposing credentials. */
export function validateUrl(value: unknown): ValidationResult {
  if (typeof value !== "string") {
    return invalid("invalid_url", "url", "Expected an HTTP or HTTPS URL.");
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return invalid("invalid_url", "url", "Expected an HTTP or HTTPS URL without credentials.");
    }
  } catch {
    return invalid("invalid_url", "url", "Expected an HTTP or HTTPS URL.");
  }
  return VALID;
}

/** Validate non-empty standard RFC 4648 base64 and a syntactic media type. */
export function validateBase64Media(data: unknown, mediaType: unknown): ValidationResult {
  const issues: Issue[] = [];
  if (typeof data !== "string" || !BASE64_PATTERN.test(data)) {
    issues.push({ code: "invalid_media", path: "data", message: "Expected non-empty standard base64 data." });
  }
  if (typeof mediaType !== "string" || !MEDIA_TYPE_PATTERN.test(mediaType)) {
    issues.push({ code: "invalid_media", path: "mediaType", message: "Expected a valid media type." });
  }
  return finish(issues);
}

/** Validate a JSON string whose parsed top level is an object, preserving text. */
export function validateToolCallArgumentsJson(value: unknown): ValidationResult {
  if (typeof value !== "string") {
    return invalid("invalid_tool_arguments", "argumentsJson", "Expected a JSON object string.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return objectValue(parsed)
      ? VALID
      : invalid("invalid_tool_arguments", "argumentsJson", "Expected a JSON object string.");
  } catch {
    return invalid("invalid_tool_arguments", "argumentsJson", "Expected a JSON object string.");
  }
}

function validateUrlAt(value: unknown, path: string, issues: Issue[]): void {
  const result = validateUrl(value);
  if (!result.valid) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path })));
  }
}

function validateMediaAt(data: unknown, mediaType: unknown, path: string, issues: Issue[]): void {
  const result = validateBase64Media(data, mediaType);
  if (!result.valid) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path: `${path}.${issue.path}` })));
  }
}

function validateArgumentsAt(value: unknown, path: string, issues: Issue[]): void {
  const result = validateToolCallArgumentsJson(value);
  if (!result.valid) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path })));
  }
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function optionalType(object: JsonObject, key: string, type: "string" | "boolean", path: string, issues: Issue[]): void {
  if (hasOwn(object, key) && typeof object[key] !== type) {
    issues.push({ code: "invalid_content_block", path: `${path}.${key}`, message: `Expected a ${type}.` });
  }
}

function optionalEnum(object: JsonObject, key: string, values: Record<string, true>, path: string, issues: Issue[]): void {
  if (hasOwn(object, key) && values[String(object[key])] !== true) {
    issues.push({ code: "invalid_content_block", path: `${path}.${key}`, message: "Expected a supported literal value." });
  }
}

function validateCitation(value: unknown, path: string, issues: Issue[]): void {
  if (!objectValue(value)) {
    issues.push({ code: "invalid_content_block", path, message: "Expected a citation object." });
    return;
  }
  const kinds: Record<string, true> = { char_span: true, page_span: true, block_span: true, search_result_span: true, url: true, file: true };
  if (kinds[String(value["kind"])] !== true) issues.push({ code: "invalid_content_block", path: `${path}.kind`, message: "Expected a supported citation kind." });
  for (const key of ["sourceId", "sourceTitle", "citedText"] as const) optionalType(value, key, "string", path, issues);
  for (const key of ["startIndex", "endIndex", "pageStart", "pageEnd"] as const) {
    if (hasOwn(value, key) && typeof value[key] !== "number") issues.push({ code: "invalid_content_block", path: `${path}.${key}`, message: "Expected a number." });
  }
  if (hasOwn(value, "url")) validateUrlAt(value["url"], `${path}.url`, issues);
  if (hasOwn(value, "raw") && !isJsonValue(value["raw"])) issues.push({ code: "invalid_content_block", path: `${path}.raw`, message: "Expected a JSON value." });
}

function validateBlockBase(value: JsonObject, path: string, issues: Issue[]): void {
  optionalType(value, "id", "string", path, issues);
  optionalEnum(value, "status", { in_progress: true, completed: true, incomplete: true }, path, issues);
  const cache = value["cacheBreakpoint"];
  if (hasOwn(value, "cacheBreakpoint")) {
    if (!objectValue(cache)) issues.push({ code: "invalid_content_block", path: `${path}.cacheBreakpoint`, message: "Expected a cache breakpoint object." });
    else optionalType(cache, "ttl", "string", `${path}.cacheBreakpoint`, issues);
  }
  const metadata = value["providerMetadata"];
  if (hasOwn(value, "providerMetadata") && (!objectValue(metadata) || !isJsonValue(metadata))) issues.push({ code: "invalid_content_block", path: `${path}.providerMetadata`, message: "Expected a JSON object." });
}

/**
 * Recursively validate a canonical content block without changing or copying it.
 * Unknown fields remain untouched for lossless provider round trips.
 */
export function validateContentBlock(value: unknown, path = "contentBlock"): ValidationResult {
  if (!objectValue(value) || typeof value["type"] !== "string") {
    return invalid("invalid_content_block", path, "Expected a discriminated content block object.");
  }
  const issues: Issue[] = [];
  const type = value["type"];
  validateBlockBase(value, path, issues);
  switch (type) {
    case "text": {
      requiredString(value, "text", path, issues);
      const citations = value["citations"];
      if (hasOwn(value, "citations")) {
        if (!Array.isArray(citations)) issues.push({ code: "invalid_content_block", path: `${path}.citations`, message: "Expected a citation array." });
        else citations.forEach((citation, index) => validateCitation(citation, `${path}.citations[${index}]`, issues));
      }
      break;
    }
    case "refusal":
      requiredString(value, "refusal", path, issues);
      break;
    case "image_url":
      validateUrlAt(value["url"], `${path}.url`, issues);
      optionalEnum(value, "detail", { auto: true, low: true, high: true }, path, issues);
      break;
    case "audio_url":
      validateUrlAt(value["url"], `${path}.url`, issues);
      optionalType(value, "format", "string", path, issues);
      break;
    case "document_url":
      validateUrlAt(value["url"], `${path}.url`, issues);
      optionalType(value, "mediaType", "string", path, issues);
      optionalType(value, "title", "string", path, issues);
      optionalType(value, "citationsEnabled", "boolean", path, issues);
      break;
    case "image_base64":
    case "audio_base64":
      validateMediaAt(value["data"], value["mediaType"], path, issues);
      break;
    case "generated_image":
      validateMediaAt(value["data"], value["mediaType"], path, issues);
      optionalType(value, "revisedPrompt", "string", path, issues);
      optionalType(value, "size", "string", path, issues);
      optionalEnum(value, "background", { transparent: true, opaque: true, auto: true }, path, issues);
      break;
    case "document_base64":
      validateMediaAt(value["data"], value["mediaType"], path, issues);
      optionalType(value, "title", "string", path, issues);
      optionalType(value, "citationsEnabled", "boolean", path, issues);
      break;
    case "audio_output":
      requiredString(value, "mediaType", path, issues);
      if (hasOwn(value, "data")) validateMediaAt(value["data"], value["mediaType"], path, issues);
      optionalType(value, "transcript", "string", path, issues);
      optionalType(value, "expiresAt", "string", path, issues);
      break;
    case "file_reference":
      requiredString(value, "fileId", path, issues);
      optionalType(value, "mediaType", "string", path, issues);
      optionalType(value, "filename", "string", path, issues);
      break;
    case "search_result":
      requiredString(value, "sourceId", path, issues);
      requiredString(value, "title", path, issues);
      requiredString(value, "text", path, issues);
      optionalType(value, "citationsEnabled", "boolean", path, issues);
      break;
    case "reasoning":
      for (const key of ["text", "signature", "redactedData", "encryptedContent"] as const) optionalType(value, key, "string", path, issues);
      break;
    case "tool_call":
      requiredString(value, "toolCallId", path, issues);
      requiredString(value, "name", path, issues);
      validateArgumentsAt(value["argumentsJson"], `${path}.argumentsJson`, issues);
      optionalEnum(value, "caller", { model: true, program: true }, path, issues);
      break;
    case "tool_result":
    case "server_tool_result": {
      requiredString(value, "toolCallId", path, issues);
      if (type === "server_tool_result") requiredString(value, "toolKind", path, issues);
      optionalType(value, "isError", "boolean", path, issues);
      const content = value["content"];
      if (!Array.isArray(content)) {
        issues.push({ code: "invalid_content_block", path: `${path}.content`, message: "Expected a content block array." });
      } else {
        content.forEach((block, index) => appendResult(issues, validateContentBlock(block, `${path}.content[${index}]`)));
      }
      break;
    }
    case "server_tool_call":
      requiredString(value, "toolCallId", path, issues);
      requiredString(value, "toolKind", path, issues);
      if (hasOwn(value, "argumentsJson")) validateArgumentsAt(value["argumentsJson"], `${path}.argumentsJson`, issues);
      optionalType(value, "name", "string", path, issues);
      optionalType(value, "serverName", "string", path, issues);
      if (hasOwn(value, "input") && !isJsonValue(value["input"])) issues.push({ code: "invalid_content_block", path: `${path}.input`, message: "Expected a JSON value." });
      optionalEnum(value, "caller", { model: true, program: true }, path, issues);
      break;
    case "tool_approval_request":
      requiredString(value, "toolCallId", path, issues);
      optionalType(value, "toolKind", "string", path, issues);
      optionalType(value, "reason", "string", path, issues);
      break;
    case "tool_approval_response":
      requiredString(value, "toolCallId", path, issues);
      if (typeof value["approved"] !== "boolean") {
        issues.push({ code: "invalid_content_block", path: `${path}.approved`, message: "Expected a boolean." });
      }
      break;
    default:
      issues.push({ code: "invalid_content_block", path: `${path}.type`, message: "Unknown content block type." });
  }
  return finish(issues);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return objectValue(value) && Object.values(value).every(isJsonValue);
}

function validateStringRecord(value: unknown): boolean {
  return objectValue(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateExtensions(value: unknown, path: string): ValidationResult {
  if (!objectValue(value)) return invalid("invalid_extension", path, "Expected an extension object.");
  const issues: Issue[] = [];
  const protocols = value["protocols"];
  if (hasOwn(value, "protocols")) {
    if (!objectValue(protocols)) {
      issues.push({ code: "invalid_extension", path: `${path}.protocols`, message: "Expected a protocol extension record." });
    } else {
      for (const [name, entry] of Object.entries(protocols)) {
        const entryPath = `${path}.protocols.${name}`;
        if (!objectValue(entry)) {
          issues.push({ code: "invalid_extension", path: entryPath, message: "Expected a protocol parameter set." });
          continue;
        }
        if (PROTOCOLS[String(entry["protocol"])] !== true) issues.push({ code: "invalid_extension", path: `${entryPath}.protocol`, message: "Expected a known canonical protocol." });
        if (!objectValue(entry["body"]) || !isJsonValue(entry["body"])) issues.push({ code: "invalid_extension", path: `${entryPath}.body`, message: "Expected a JSON object." });
        if (!validateStringRecord(entry["headers"])) issues.push({ code: "invalid_extension", path: `${entryPath}.headers`, message: "Expected a string header record." });
        if (!Array.isArray(entry["sourceFields"]) || !entry["sourceFields"].every((field) => typeof field === "string")) issues.push({ code: "invalid_extension", path: `${entryPath}.sourceFields`, message: "Expected a string array." });
      }
    }
  }
  const providers = value["providers"];
  if (hasOwn(value, "providers")) {
    if (!objectValue(providers)) {
      issues.push({ code: "invalid_extension", path: `${path}.providers`, message: "Expected a provider extension record." });
    } else {
      for (const [name, entry] of Object.entries(providers)) {
        const entryPath = `${path}.providers.${name}`;
        if (!objectValue(entry)) {
          issues.push({ code: "invalid_extension", path: entryPath, message: "Expected a provider parameter set." });
          continue;
        }
        if (typeof entry["provider"] !== "string") issues.push({ code: "invalid_extension", path: `${entryPath}.provider`, message: "Expected a provider name." });
        if (!objectValue(entry["body"]) || !isJsonValue(entry["body"])) issues.push({ code: "invalid_extension", path: `${entryPath}.body`, message: "Expected a JSON object." });
        if (!validateStringRecord(entry["headers"])) issues.push({ code: "invalid_extension", path: `${entryPath}.headers`, message: "Expected a string header record." });
      }
    }
  }
  if (hasOwn(value, "custom") && (!objectValue(value["custom"]) || !isJsonValue(value["custom"]))) {
    issues.push({ code: "invalid_extension", path: `${path}.custom`, message: "Expected a JSON object." });
  }
  return finish(issues);
}

/**
 * Validate the transport-free canonical request boundary in place. This is a
 * read-only check: it never normalizes values, resolves secrets, or performs I/O.
 */
export function validateCanonicalRequest(value: unknown): ValidationResult {
  if (!objectValue(value)) {
    return invalid("invalid_canonical_request", "request", "Expected a canonical request object.");
  }
  const issues: Issue[] = [];
  const requestId = validateRequestId(value["requestId"]);
  if (!requestId.valid) issues.push(...requestId.issues);
  const timestamp = validateRfc3339Timestamp(value["receivedAt"]);
  if (!timestamp.valid) issues.push(...timestamp.issues.map((issue) => ({ ...issue, path: "receivedAt" })));
  if (typeof value["model"] !== "string" || value["model"].length === 0) {
    issues.push({ code: "invalid_canonical_request", path: "model", message: "Expected a non-empty model name." });
  }
  const source = value["source"];
  if (!objectValue(source)) {
    issues.push({ code: "invalid_canonical_request", path: "source", message: "Expected a source object." });
  } else {
    if (typeof source["adapter"] !== "string" || source["adapter"].length === 0) issues.push({ code: "invalid_canonical_request", path: "source.adapter", message: "Expected a non-empty adapter name." });
    if (PROTOCOLS[String(source["protocol"])] !== true) issues.push({ code: "invalid_canonical_request", path: "source.protocol", message: "Expected a known canonical protocol." });
    if (typeof source["path"] !== "string" || source["path"].length === 0) issues.push({ code: "invalid_canonical_request", path: "source.path", message: "Expected a non-empty source path." });
  }
  const messages = value["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    issues.push({ code: "invalid_canonical_request", path: "messages", message: "Expected a non-empty message array." });
  } else {
    messages.forEach((message, messageIndex) => {
      const messagePath = `messages[${messageIndex}]`;
      if (!objectValue(message)) {
        issues.push({ code: "invalid_canonical_request", path: messagePath, message: "Expected a message object." });
        return;
      }
      if (ROLES[String(message["role"])] !== true) issues.push({ code: "invalid_canonical_request", path: `${messagePath}.role`, message: "Expected a canonical message role." });
      if (!Array.isArray(message["content"]) || message["content"].length === 0) {
        issues.push({ code: "invalid_canonical_request", path: `${messagePath}.content`, message: "Expected a non-empty content block array." });
      } else {
        message["content"].forEach((block, blockIndex) => appendResult(issues, validateContentBlock(block, `${messagePath}.content[${blockIndex}]`)));
      }
    });
  }
  const routing = value["routing"];
  if (!objectValue(routing)) {
    issues.push({ code: "invalid_canonical_request", path: "routing", message: "Expected a routing object." });
  } else {
    for (const key of ["modelAlias", "overrideRoute"] as const) {
      if (hasOwn(routing, key) && typeof routing[key] !== "string") issues.push({ code: "invalid_canonical_request", path: `routing.${key}`, message: "Expected a string." });
    }
    for (const key of ["requiredCapabilities", "preferredProviders", "excludedProviders"] as const) {
      const entry = routing[key];
      if (hasOwn(routing, key) && (!Array.isArray(entry) || !entry.every((item) => typeof item === "string"))) issues.push({ code: "invalid_canonical_request", path: `routing.${key}`, message: "Expected a string array." });
    }
    for (const key of ["maxCostUsd", "maxLatencyMs"] as const) {
      if (hasOwn(routing, key) && (typeof routing[key] !== "number" || !Number.isFinite(routing[key]))) issues.push({ code: "invalid_canonical_request", path: `routing.${key}`, message: "Expected a finite number." });
    }
    if (hasOwn(routing, "dryRun") && typeof routing["dryRun"] !== "boolean") issues.push({ code: "invalid_canonical_request", path: "routing.dryRun", message: "Expected a boolean." });
  }
  if (typeof value["stream"] !== "boolean") issues.push({ code: "invalid_canonical_request", path: "stream", message: "Expected a stream boolean." });
  if (hasOwn(value, "extensions")) appendResult(issues, validateExtensions(value["extensions"], "extensions"));
  return finish(issues);
}
