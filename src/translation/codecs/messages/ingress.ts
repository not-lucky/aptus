import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type {
  IngressDecoder,
  OutcomeDecodeResult,
  PromptCacheBreakpoint,
  RequestDecodeResult,
  RequestWireOptions,
} from "../../contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "../../failures.ts";
import type { IrGenerationControls, IrItem, IrOutputFormat, IrRequest, IrToolChoice, NonEmpty } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import {
  asNonEmptyStopSequences,
  firstUnknownKey,
  MESSAGES_SERVICE_TIERS,
  parseEnumLiteral,
  parseStopSequenceEntries,
  parseUnitIntervalControl,
} from "../shared/controls.ts";
import { MESSAGES_HOSTED_TOOL_TYPES } from "../shared/hosted-tools.ts";
import { parseToolArray, parseToolChoice, type ToolWireSpec } from "../shared/tool-parsing.ts";
import {
  decodeMessagesContent,
  messagesHostedBlockFailure,
  messagesRequestCitationsFailure,
  parseMessagesCacheControl,
} from "./content.ts";
import { parseMessagesOutcome } from "./outcome.ts";

const RECOGNIZED_MESSAGES_REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
  "container",
  "metadata",
  "top_k",
  "output_config",
  "service_tier",
  "inference_geo",
  "cache_control",
]);

/**
 * Classifies the `thinking` request control into its matrix-row failure: a
 * `budget_tokens` sub-field is the `reasoning-budget` trigger; every other
 * shape (`display`, bare `{type}` objects such as `{type:"disabled"}`,
 * unrecognized sub-fields) is the `anthropic-thinking-display` trigger. The
 * control is never admitted, so this always yields a failure.
 */
function parseMessagesThinking(value: unknown): NormalizedFailure {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (raw.budget_tokens !== undefined) {
      return unsupportedCapabilityFailure("reasoning-budget");
    }
  }
  return unsupportedCapabilityFailure("anthropic-thinking-display");
}

/**
 * Parses the Messages `output_config` request control: `effort` fails with
 * `reasoning-effort-common`; `format` is parsed into `IrOutputFormat`.
 */
function parseMessagesOutputConfig(value: unknown): Result<IrOutputFormat | undefined, NormalizedFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest("output_config must be an object");
  }
  const raw = value as Record<string, unknown>;
  const extra = firstUnknownKey(raw, ["effort", "format"]);
  if (extra !== undefined) return invalidRequest(`output_config.${extra} is not recognized`);
  if (raw.effort !== undefined) {
    return unsupportedCapability("reasoning-effort-common");
  }
  if (raw.format !== undefined) {
    const format = raw.format;
    if (typeof format !== "object" || format === null || Array.isArray(format)) {
      return invalidRequest("output_config.format must be an object");
    }
    const fmtObj = format as Record<string, unknown>;
    const fmtExtra = firstUnknownKey(fmtObj, ["type", "schema"]);
    if (fmtExtra !== undefined) return invalidRequest(`output_config.format.${fmtExtra} is not recognized`);
    const type = fmtObj.type;
    if (type !== "json_schema") {
      return unsupportedCapability("structured-json-schema");
    }
    const schema = fmtObj.schema;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      return invalidRequest("output_config.format.schema must be an object");
    }
    return ok({ type: "json_schema", schema: schema as JsonObject });
  }
  return invalidRequest("output_config must carry 'effort' or 'format'");
}

const MESSAGES_ALLOWED_CALLERS: ReadonlySet<string> = new Set([
  "direct",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
]);

function rejectMessagesToolNative(raw: Record<string, unknown>, context: string): NormalizedFailure | undefined {
  const type = raw.type;
  if (type !== undefined && type !== "custom") {
    if (typeof type !== "string") return invalidRequestFailure(`${context}: type must be a string`);
    const hostedCapability = MESSAGES_HOSTED_TOOL_TYPES[type];
    return hostedCapability === undefined
      ? invalidRequestFailure(`${context}: type '${type}' is not recognized`)
      : unsupportedCapabilityFailure(hostedCapability);
  }
  // Capability rejections precede the unknown-field scan so recognized native
  // facts report their exact row rather than being hidden as unknown fields.
  if (raw.cache_control !== undefined) return unsupportedCapabilityFailure("prompt-cache-breakpoint");
  if (raw.defer_loading !== undefined) return unsupportedCapabilityFailure("deferred-tools");
  if (raw.input_examples !== undefined) return unsupportedCapabilityFailure("tool-input-examples");
  if (raw.eager_input_streaming !== undefined) return unsupportedCapabilityFailure("eager-tool-streaming");
  return undefined;
}

const MESSAGES_TOOL_SPEC: ToolWireSpec = {
  shape: "messages",
  schemaField: "input_schema",
  requireObjectSchemaType: true,
  strictRequired: false,
  choiceShape: "messages",
  missingSchema: "invalid",
  allowCallers: true,
  documentedCallers: MESSAGES_ALLOWED_CALLERS,
  rejectNative: rejectMessagesToolNative,
};

/**
 * Parses a Messages request body shared verbatim by the complete ingress
 * decoder and the streaming request decoder. The cache-control, thinking,
 * and output_config rules also live here so both paths cannot drift.
 */
export function parseMessagesRequestBody(
  body: JsonObject,
  delivery: "complete" | "stream",
): Result<RequestDecodeResult, NormalizedFailure> {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return invalidRequest("Messages request missing required string property 'model'");
  }

  // Anthropic Messages wire format requires max_tokens as a positive integer
  if (typeof body.max_tokens !== "number" || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) {
    return invalidRequest("Messages request missing required positive safe integer property 'max_tokens'");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidRequest("Messages request missing required non-empty array property 'messages'");
  }

  // Decoder-level capability rejections for recognized native-only facts.
  // The top-level `container` reuse param is the anthropic-container-reuse
  // row; the hosted code-execution resource (container_upload block) is the
  // separate provider-container row owned by client tools.
  if (body.container !== undefined) {
    return unsupportedCapability("anthropic-container-reuse");
  }
  if (body.inference_geo !== undefined) {
    return unsupportedCapability("inference-geography");
  }
  if (body.top_k !== undefined) {
    return unsupportedCapability("top-k");
  }
  if (body.thinking !== undefined) {
    return failure(parseMessagesThinking(body.thinking));
  }
  let output: IrOutputFormat | undefined;
  if (body.output_config !== undefined) {
    const outputResult = parseMessagesOutputConfig(body.output_config);
    if (!outputResult.ok) return outputResult;
    output = outputResult.value;
  }

  // Check for unknown request fields outside recognized schema
  for (const key of Object.keys(body)) {
    if (!RECOGNIZED_MESSAGES_REQUEST_FIELDS.has(key)) {
      return unsupportedCapability("unknown-request-field");
    }
  }

  // ---- Wire-only sidecar capture (T2-admitted fields) ----
  const breakpoints: PromptCacheBreakpoint[] = [];

  // metadata accepts only the user_id kv entry. The M wire documents no
  // other key, so a foreign key is malformed M wire (`invalid_request`) —
  // not a capability rejection, because the `request-metadata` row itself is
  // T2-admitted in every M direction.
  let metadata: Record<string, string> | undefined;
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)) {
      return invalidRequest("metadata must be an object when present");
    }
    const rawMetadata = body.metadata as Record<string, unknown>;
    const extra = firstUnknownKey(rawMetadata, ["user_id"]);
    if (extra !== undefined) {
      return invalidRequest(`metadata supports only the 'user_id' key on the Messages wire, got '${extra}'`);
    }
    const userId = rawMetadata.user_id;
    if (userId !== undefined) {
      if (typeof userId !== "string") {
        return invalidRequest("metadata.user_id must be a string");
      }
      metadata = { user_id: userId };
    }
  }

  // service_tier admits auto|standard_only; only `auto` ever maps across.
  const tierResult = parseEnumLiteral("service_tier", body.service_tier, MESSAGES_SERVICE_TIERS);
  if (!tierResult.ok) return tierResult;

  // Top-level cache_control auto-marker: a sentinel breakpoint anchored to
  // the final content block of the request (resolved once items are decoded).
  let hasTopLevelMarker = false;
  if (body.cache_control !== undefined) {
    const markerResult = parseMessagesCacheControl("request", body.cache_control);
    if (!markerResult.ok) return markerResult;
    hasTopLevelMarker = true;
  }

  // ---- Client tool surfaces (definitions, choice, parallelism) ----
  const toolsResult = parseToolArray(body.tools, "tools", MESSAGES_TOOL_SPEC);
  if (!toolsResult.ok) return toolsResult;
  const tools = toolsResult.value.tools;

  let toolChoice: IrToolChoice | undefined;
  let parallelToolCalls: boolean | undefined;
  if (body.tool_choice !== undefined) {
    const choiceResult = parseToolChoice(body.tool_choice, "tool_choice", MESSAGES_TOOL_SPEC);
    if (!choiceResult.ok) return choiceResult;
    toolChoice = choiceResult.value.choice;
    parallelToolCalls = choiceResult.value.parallelToolCalls;
  }

  const items: IrItem[] = [];

  // System instruction blocks
  if (typeof body.system === "string" && body.system.trim() !== "") {
    items.push({
      type: "instruction",
      authority: "system",
      separation: "advisory",
      text: body.system,
    });
  } else if (Array.isArray(body.system)) {
    for (let bIdx = 0; bIdx < body.system.length; bIdx++) {
      const block = body.system[bIdx];
      if (typeof block === "string") {
        items.push({
          type: "instruction",
          authority: "system",
          separation: "advisory",
          text: block,
        });
      } else if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          // A system text block's own keys are provider wire keys, exactly
          // like message text blocks: an encryption marker on one is a hosted
          // payload, never translatable instruction text.
          const hosted = messagesHostedBlockFailure(b);
          if (hosted !== undefined) return failure(hosted);
          const citationsFailure = messagesRequestCitationsFailure(`system block [${bIdx}]`, b.citations);
          if (citationsFailure !== undefined) return failure(citationsFailure);
          items.push({
            type: "instruction",
            authority: "system",
            separation: "advisory",
            text: b.text,
          });
          if (b.cache_control !== undefined) {
            const markerResult = parseMessagesCacheControl(`system block [${bIdx}]`, b.cache_control);
            if (!markerResult.ok) return markerResult;
            breakpoints.push({ itemIndex: items.length - 1 });
          }
        } else {
          // System blocks are the same provider wire-key container as message
          // content blocks: recognized hosted/provider block types report
          // their exact row instead of a generic unknown-structure error.
          const hosted = messagesHostedBlockFailure(b);
          if (hosted !== undefined) return failure(hosted);
          return unsupportedCapability("unknown-content-item");
        }
      } else {
        return invalidRequest(`system block [${bIdx}] must be a string or object`);
      }
    }
  }

  // Decode messages
  for (let i = 0; i < body.messages.length; i++) {
    const rawMsg = body.messages[i];
    if (typeof rawMsg !== "object" || rawMsg === null) {
      return invalidRequest(`Messages message [${i}] must be an object`);
    }
    const msgObj = rawMsg as Record<string, unknown>;
    const role = msgObj.role;

    // M schema accepts `mid_conv_system`, but official prose prohibits a
    // system message role: the `mid-conversation-instruction` Blocked
    // Capability applies to every M direction (the IR contract).
    if (role === "mid_conv_system") {
      return unsupportedCapability("mid-conversation-instruction");
    }

    if (role === "user") {
      if (typeof msgObj.content === "string") {
        items.push({ type: "message", role: "user", content: [{ type: "text", text: msgObj.content }] });
        continue;
      }
      const contentResult = decodeMessagesContent(msgObj.content, "user", i, items, breakpoints);
      if (!contentResult.ok) return contentResult;
      continue;
    }

    if (role === "assistant") {
      if (typeof msgObj.content === "string") {
        items.push({ type: "message", role: "assistant", content: [{ type: "text", text: msgObj.content }] });
        continue;
      }
      const contentResult = decodeMessagesContent(msgObj.content, "assistant", i, items, breakpoints);
      if (!contentResult.ok) return contentResult;
      continue;
    }

    return invalidRequest(`Messages message [${i}] has unrecognized role '${String(role)}'`);
  }

  // Anchor the top-level auto-marker sentinel to the final content block.
  if (hasTopLevelMarker) {
    const lastIndex = items.length - 1;
    const lastItem = items[lastIndex];
    if (lastItem !== undefined) {
      if (lastItem.type === "message") {
        breakpoints.push({ itemIndex: lastIndex, partIndex: lastItem.content.length - 1 });
      } else {
        // Turn splitting lets the request end on a tool_call or tool_result
        // item; both carry their markers item-only.
        breakpoints.push({ itemIndex: lastIndex });
      }
    }
  }

  const wireOptions: RequestWireOptions = {
    ...(metadata !== undefined ? { metadata } : {}),
    ...(tierResult.value !== undefined ? { serviceTier: tierResult.value } : {}),
    ...(breakpoints.length > 0 ? { promptCacheBreakpoints: breakpoints } : {}),
    ...(toolsResult.value.directCallerNames.length > 0
      ? { toolAllowedCallers: toolsResult.value.directCallerNames }
      : {}),
  };

  // ---- Generation controls (strict bounds; never clamped, never dropped) ----
  const temperatureResult = parseUnitIntervalControl("temperature", body.temperature, "temperature-0-1");
  if (!temperatureResult.ok) return temperatureResult;
  const topPResult = parseUnitIntervalControl("top_p", body.top_p, "top-p-0-1");
  if (!topPResult.ok) return topPResult;

  let stopSequences: NonEmpty<string> | undefined;
  if (body.stop_sequences !== undefined && body.stop_sequences !== null) {
    if (!Array.isArray(body.stop_sequences)) {
      return invalidRequest("stop_sequences must be an array of strings");
    }
    // The IR admits stop sequences only as a non-empty set (the IR contract).
    // so an empty array is invalid M wire rather than absence.
    if (body.stop_sequences.length === 0) {
      return invalidRequest("stop_sequences must contain at least one entry when present");
    }
    const entriesResult = parseStopSequenceEntries("stop_sequences", body.stop_sequences);
    if (!entriesResult.ok) return entriesResult;
    stopSequences = asNonEmptyStopSequences(entriesResult.value);
  }

  // M requires max_tokens, so the resolved output limit always exists for an
  // M source; M→C/R translation preserves the caller's limit through the IR.
  const generation: IrGenerationControls = {
    ...(temperatureResult.value !== undefined ? { temperature: temperatureResult.value } : {}),
    ...(topPResult.value !== undefined ? { topP: topPResult.value } : {}),
    maxOutputTokens: body.max_tokens,
    ...(stopSequences !== undefined ? { stopSequences } : {}),
  };

  const irRequest: IrRequest = {
    model: body.model,
    delivery,
    items,
    generation,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    ...(output !== undefined ? { output } : {}),
  };

  return ok({ irRequest, requestWireOptions: wireOptions });
}

/**
 * Ingress decoder for Anthropic Messages requests and responses.
 *
 * Request decoding delegates to {@link parseMessagesRequestBody}, which
 * projects admitted generation controls (including the required `max_tokens`
 * output limit) into the IR and captures the T2 wire-only facts
 * (metadata.user_id subset, service tier, cache-control breakpoints) into the
 * request wire-options sidecar; native-only state fails closed with its exact
 * matrix capability ID.
 */
export class MessagesIngressDecoder implements IngressDecoder {
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure> {
    return parseMessagesRequestBody(body, body.stream === true ? "stream" : "complete");
  }

  decodeOutcome(status: number, _headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure> {
    return parseMessagesOutcome(status, body);
  }
}
