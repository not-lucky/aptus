/**
 * @fileoverview Direction-aware capability preflight for translated requests and outcomes.
 *
 * Enforces capability matrix support tiers (T1, T2, T3) before provider dispatch or client
 * response emission. Requests and outcomes are verified across distinct policy domains:
 * tool definitions, generation controls, wire option sidecars, structured outputs, and
 * transcript structures. Unsupported features fail closed with their exact capability row ID.
 */

import type { Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { CHAT_TOOL_NAME_REGEX } from "./codecs/shared/controls.ts";
import { M_IMAGE_MEDIA_TYPES } from "./codecs/shared/media.ts";
import type { Direction, OutcomeWireOptions, RequestWireOptions } from "./contracts.ts";
import { unsupportedCapabilityFailure } from "./failures.ts";
import type { IrInputPart, IrOutcome, IrRequest } from "./ir.ts";
import type { MatrixRowId } from "./matrix.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "./result.ts";
import {
  validateMessagesObjectRoot,
  validateMessagesOutputSchema,
  validateMessagesStrictSchema,
  validateOpenAiStrictSchema,
} from "./schema-dialect.ts";

/** Metadata entry and length bounds declared by the `request-metadata` matrix row. */
const METADATA_MAX_ENTRIES = 16;
const METADATA_MAX_KEY_LENGTH = 64;
const METADATA_MAX_VALUE_LENGTH = 512;

/**
 * Validates direction feasibility for structured JSON schema outputs.
 *
 * @param req - Semantic IR request to check.
 * @param facts - Direction classification facts.
 * @returns Ok if schema controls are valid for target wire; otherwise unsupported capability failure.
 */
function preflightOutputFormat(req: IrRequest, facts: DirectionFacts): Result<void, NormalizedFailure> {
  const output = req.output;
  if (output === undefined || output.type !== "json_schema") return ok(undefined);
  const { isTargetMessages } = facts;

  if (isTargetMessages) {
    if (output.strict === true) {
      return unsupportedCapability("structured-strict-guarantee");
    }
    if (typeof output.description === "string" && output.description.length > 0) {
      return unsupportedCapability("structured-name-description");
    }
    return validateMessagesOutputSchema(output.schema, "structured-json-schema");
  }

  if (output.strict === true) {
    return validateOpenAiStrictSchema(output.schema, "structured-strict-guarantee");
  }
  if (output.schema.type !== "object") {
    return unsupportedCapability("structured-json-schema", "/: root type must be object");
  }
  return ok(undefined);
}

/**
 * Validates entry count and key/value string length limits for request metadata.
 *
 * @param metadata - Inbound metadata record to validate.
 * @returns Ok if within limits; otherwise invalid request failure.
 */
function validateMetadataLimits(metadata: Readonly<Record<string, string>>): Result<void, NormalizedFailure> {
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_ENTRIES) {
    return invalidRequest(`metadata supports at most ${METADATA_MAX_ENTRIES} entries`);
  }
  for (const [key, value] of entries) {
    if (key.length > METADATA_MAX_KEY_LENGTH) {
      return invalidRequest(`metadata key exceeds ${METADATA_MAX_KEY_LENGTH} characters`);
    }
    if (value.length > METADATA_MAX_VALUE_LENGTH) {
      return invalidRequest(`metadata['${key}'] value exceeds ${METADATA_MAX_VALUE_LENGTH} characters`);
    }
  }
  return ok(undefined);
}

/**
 * Closed set of immutable direction classification flags derived from a translation direction.
 */
export interface DirectionFacts {
  /** Client-side source protocol format. */
  readonly source: Protocol;
  /** Upstream provider-side target protocol format. */
  readonly target: Protocol;
  /** True when either source or target is `anthropic-messages`. */
  readonly involvesMessages: boolean;
  /** True when target protocol is `openai-chat`. */
  readonly isTargetChat: boolean;
  /** True when target protocol is `openai-responses`. */
  readonly isTargetResponses: boolean;
  /** True when target protocol is `anthropic-messages`. */
  readonly isTargetMessages: boolean;
  /** True when translation stays within the OpenAI family (Chat <-> Responses). */
  readonly isChatResponses: boolean;
  /** True when client-side source protocol is `anthropic-messages`. */
  readonly isSourceMessages: boolean;
}

/**
 * Decomposes a translation direction string into structured protocol classification flags.
 *
 * @param direction - Directed protocol conversion path.
 * @returns Cached boolean facts describing the direction endpoints.
 */
export function directionFacts(direction: Direction): DirectionFacts {
  const [source, target] = direction.split("->") as [Protocol, Protocol];
  const involvesMessages = source === "anthropic-messages" || target === "anthropic-messages";
  return {
    source,
    target,
    involvesMessages,
    isTargetChat: target === "openai-chat",
    isTargetResponses: target === "openai-responses",
    isTargetMessages: target === "anthropic-messages",
    isChatResponses: !involvesMessages,
    isSourceMessages: source === "anthropic-messages",
  };
}

/**
 * Resolves capability matrix rejection ID for outcomes terminating with a refusal finish reason.
 *
 * @param direction - Directed translation path.
 * @param hasRefusalPart - Whether the outcome contains an explicit refusal content part.
 * @returns Capability row ID to fail closed with, or `undefined` if admitted.
 */
export function refusalFinishCapability(
  direction: Direction,
  hasRefusalPart: boolean,
): "refusal-terminal-reason" | "refusal-content" | undefined {
  if (!hasRefusalPart) {
    return "refusal-terminal-reason";
  }
  const facts = directionFacts(direction);
  if (!facts.isChatResponses) {
    return "refusal-content";
  }
  return undefined;
}

/**
 * Validates tool definitions and parallelism controls against target protocol capabilities.
 *
 * @param req - Inbound semantic IR request.
 * @param facts - Direction classification flags.
 * @param requestWireOptions - Optional request-side wire options.
 * @returns Ok if tools are supported; otherwise unsupported capability failure.
 */
function preflightToolSurfaces(
  req: IrRequest,
  facts: DirectionFacts,
  requestWireOptions: RequestWireOptions | undefined,
): Result<void, NormalizedFailure> {
  const { involvesMessages, isTargetMessages, isTargetChat } = facts;

  // The allowed-tools subset sidecar re-emits its elements in the target wire
  // shape, so its tool definitions pass through the same per-target checks as
  // `req.tools`.
  for (const tool of [...(req.tools ?? []), ...(requestWireOptions?.allowedToolSubset?.tools ?? [])]) {
    if (tool.type === "custom") {
      if (involvesMessages) {
        return unsupportedCapability(tool.format.type === "grammar" ? "custom-grammar-tool" : "custom-text-tool");
      }
      continue;
    }
    if (isTargetMessages) {
      const rootResult = validateMessagesObjectRoot(tool.inputSchema);
      if (!rootResult.ok) return rootResult;
      if (tool.strict === true) {
        const strictResult = validateMessagesStrictSchema(tool.inputSchema);
        if (!strictResult.ok) return strictResult;
      }
    } else if (tool.strict === true) {
      const strictResult = validateOpenAiStrictSchema(tool.inputSchema);
      if (!strictResult.ok) return strictResult;
    }
    if (isTargetChat && !CHAT_TOOL_NAME_REGEX.test(tool.name)) {
      return unsupportedCapability("function-tool-definition");
    }
  }

  // disable_parallel_tool_use cannot attach to a none/absent choice: an
  // effective-none choice with the one-call restriction conflicts into M.
  if (req.parallelToolCalls === false && isTargetMessages) {
    const effectiveNone =
      req.toolChoice?.type === "none" ||
      (req.toolChoice === undefined && (req.tools === undefined || req.tools.length === 0));
    if (effectiveNone) {
      return unsupportedCapability("parallel-tool-calls");
    }
  }
  return ok(undefined);
}

/**
 * Validates sampling hyperparameters, verbosity, reasoning effort, and stop sequences.
 *
 * @param req - Inbound semantic IR request.
 * @param facts - Direction classification flags.
 * @returns Ok if generation controls are supported; otherwise unsupported capability failure.
 */
function preflightGenerationControls(req: IrRequest, facts: DirectionFacts): Result<void, NormalizedFailure> {
  // Sampling controls are already bounded to [0, 1] at decode; verbosity and
  // common reasoning effort are C<->R-only; stop sequences have per-direction
  // target constraints.
  const generation = req.generation;
  if (generation !== undefined) {
    if (generation.verbosity !== undefined && !facts.isChatResponses) {
      return unsupportedCapability("text-verbosity");
    }
    if (generation.reasoning?.effort !== undefined && !facts.isChatResponses) {
      return unsupportedCapability("reasoning-effort-common");
    }
    if (generation.stopSequences !== undefined && generation.stopSequences.length > 0) {
      // Responses has no request stop parameter: every direction targeting R rejects.
      if (facts.isTargetResponses) {
        return unsupportedCapability("stop-sequence-request");
      }
      // M->C: Chat admits at most 4 entries; larger sets reject.
      if (facts.isSourceMessages && generation.stopSequences.length > 4) {
        return unsupportedCapability("stop-sequence-request");
      }
    }
  }
  return ok(undefined);
}

/** Request wire option keys that cannot cross an Anthropic Messages boundary. */
const MESSAGES_FORBIDDEN_REQUEST_OPTIONS: ReadonlyArray<readonly [keyof RequestWireOptions, MatrixRowId]> = [
  ["store", "responses-storage"],
  ["promptCacheKey", "prompt-cache-key"],
  ["promptCacheMode", "prompt-cache-mode"],
  ["promptCacheTtl", "prompt-cache-ttl"],
  ["safetyIdentifier", "safety-identifier"],
  ["moderation", "moderation-policy-result"],
  ["allowedToolSubset", "allowed-tool-subset"],
  ["legacyJsonObject", "legacy-json-object"],
];

/**
 * Validates direction feasibility for request-side wire options (storage, caching, metadata, callers).
 *
 * @param req - Inbound semantic IR request.
 * @param facts - Direction classification flags.
 * @param requestWireOptions - Optional request wire options captured at ingress.
 * @returns Ok if wire options are supported; otherwise unsupported capability failure.
 */
function preflightRequestWireOptions(
  req: IrRequest,
  facts: DirectionFacts,
  requestWireOptions: RequestWireOptions | undefined,
): Result<void, NormalizedFailure> {
  const { involvesMessages, isTargetChat } = facts;

  if (requestWireOptions !== undefined) {
    // C<->R-only rows: every M direction is T3.
    if (involvesMessages) {
      for (const [key, capability] of MESSAGES_FORBIDDEN_REQUEST_OPTIONS) {
        if (requestWireOptions[key] !== undefined) return unsupportedCapability(capability);
      }
      // Service tier maps into/out of M only at the documented `auto` intersection.
      if (
        requestWireOptions.serviceTier !== undefined &&
        requestWireOptions.serviceTier !== null &&
        requestWireOptions.serviceTier !== "auto"
      ) {
        return unsupportedCapability("service-tier");
      }
    }
    // Chat has no caller surface at all, so any surviving caller entry fails closed.
    if (requestWireOptions.toolAllowedCallers !== undefined && isTargetChat) {
      return unsupportedCapability("allowed-callers");
    }
    // request-metadata is T2 in every direction: enforce declared C/R limits.
    if (requestWireOptions.metadata !== undefined) {
      const metadataResult = validateMetadataLimits(requestWireOptions.metadata);
      if (!metadataResult.ok) return metadataResult;
    }
    // provider-file-id / provider-image-id: C<->R only.
    if (requestWireOptions.providerFileRefs !== undefined && requestWireOptions.providerFileRefs.length > 0) {
      if (involvesMessages) {
        for (const ref of requestWireOptions.providerFileRefs) {
          if (ref.mediaKind === "image") {
            return unsupportedCapability("provider-image-id");
          }
          if (ref.mediaKind === "document") {
            return unsupportedCapability("provider-file-id");
          }
        }
      }
    }
    // prompt-cache-breakpoints: Responses rejects markers re-emitted on assistant output parts,
    // and neither OpenAI wire supports markers on tool call or tool result entries.
    if (requestWireOptions.promptCacheBreakpoints !== undefined) {
      const targetResponses = facts.isTargetResponses;
      for (const entry of requestWireOptions.promptCacheBreakpoints) {
        const anchored = req.items[entry.itemIndex];
        if (anchored === undefined) continue;
        if (anchored.type === "message" && anchored.role === "assistant" && targetResponses) {
          return unsupportedCapability("prompt-cache-breakpoint");
        }
        if (anchored.type === "tool_call" && (isTargetChat || targetResponses)) {
          return unsupportedCapability("prompt-cache-breakpoint");
        }
        if (anchored.type === "tool_result" && targetResponses) {
          return unsupportedCapability("prompt-cache-breakpoint");
        }
      }
    }
  }
  return ok(undefined);
}

/**
 * Validates media source constraints (URLs, inline bytes, gateway references) for an input part.
 *
 * @param part - Input media part to validate.
 * @param facts - Direction classification flags.
 * @returns Ok if media format is supported; otherwise unsupported capability failure.
 */
function checkMediaPart(part: IrInputPart, facts: DirectionFacts): Result<void, NormalizedFailure> {
  if (part.type === "image") {
    if (part.source.type === "gateway_file") {
      return unsupportedCapability("gateway-file-reference");
    }
    if (facts.isTargetMessages) {
      if (part.detail !== undefined) {
        return unsupportedCapability("image-detail-auto-low-high");
      }
      if (part.source.type === "bytes" && !M_IMAGE_MEDIA_TYPES.has(part.source.mediaType)) {
        return unsupportedCapability("image-inline-bytes");
      }
    }
  } else if (part.type === "document") {
    if (part.source.type === "gateway_file") {
      return unsupportedCapability("gateway-file-reference");
    }
    if (part.source.type === "url" && facts.isTargetChat) {
      return unsupportedCapability("document-url");
    }
    if (part.source.type === "text" && facts.isTargetChat) {
      return unsupportedCapability("document-inline-text");
    }
    if (part.source.type === "bytes" && facts.isTargetMessages && part.source.mediaType !== "application/pdf") {
      return unsupportedCapability("document-inline-bytes");
    }
  }
  return ok(undefined);
}

/**
 * Validates conversation transcript items, instruction placement, citations, and tool calls.
 *
 * @param req - Inbound semantic IR request.
 * @param facts - Direction classification flags.
 * @returns Ok if transcript items are supported; otherwise unsupported capability failure.
 */
function preflightTranscript(req: IrRequest, facts: DirectionFacts): Result<void, NormalizedFailure> {
  const { involvesMessages, isTargetMessages, isTargetChat, isSourceMessages } = facts;

  let sawNonInstruction = false;

  for (const item of req.items) {
    if (item.type === "instruction") {
      if (isTargetMessages) {
        if (sawNonInstruction) {
          return unsupportedCapability("mid-conversation-instruction");
        }
        if (item.separation === "required") {
          return unsupportedCapability(
            item.authority === "developer" ? "developer-instruction" : "mixed-instruction-authority",
          );
        }
      }
      if (isSourceMessages && item.authority === "developer") {
        return unsupportedCapability("developer-instruction");
      }
    } else {
      sawNonInstruction = true;
    }

    if (item.type === "tool_call") {
      if (item.call.type === "custom" && involvesMessages) {
        return unsupportedCapability("custom-text-tool");
      }
      if (item.call.type === "function" && isTargetMessages && item.call.arguments === undefined) {
        return unsupportedCapability("invalid-function-json");
      }
    }
    if (item.type === "tool_result") {
      if (item.isError) {
        return unsupportedCapability("tool-result-error");
      }
      // Chat tool content is a single text string: empty, multipart, or non-text results cannot map onto C.
      if (isTargetChat && !(item.content.length === 1 && item.content[0]?.type === "text")) {
        return unsupportedCapability("tool-result-multipart");
      }
      for (const part of item.content) {
        const mediaResult = checkMediaPart(part, facts);
        if (!mediaResult.ok) return mediaResult;
      }
    }

    if (item.type === "message") {
      if (item.role === "user") {
        for (const part of item.content) {
          const mediaResult = checkMediaPart(part, facts);
          if (!mediaResult.ok) return mediaResult;
        }
      } else if (item.role === "assistant") {
        for (const part of item.content) {
          if (part.type === "refusal") {
            return unsupportedCapability("refusal-content");
          }
          if (part.type === "text" && part.citations !== undefined && part.citations.length > 0) {
            const firstCit = part.citations[0];
            if (firstCit === undefined) continue;
            if (isTargetChat) {
              return unsupportedCapability(
                firstCit.source.type === "url" ? "url-citation-source" : "file-document-citation-source",
              );
            }
            if (facts.isTargetResponses) {
              return unsupportedCapability("citation-output-span");
            }
            if (isTargetMessages) {
              return unsupportedCapability(
                firstCit.source.type === "url" ? "url-citation-source" : "citation-document-location",
              );
            }
          }
        }
      }
    }
  }

  return ok(undefined);
}

/**
 * Evaluates shared preflight policy domains in fixed order: tools, controls, sidecar, output, transcript.
 */
function preflightPlainTextRequestFeatures(
  req: IrRequest,
  facts: DirectionFacts,
  requestWireOptions: RequestWireOptions | undefined,
): Result<void, NormalizedFailure> {
  const toolsResult = preflightToolSurfaces(req, facts, requestWireOptions);
  if (!toolsResult.ok) return toolsResult;
  const generationResult = preflightGenerationControls(req, facts);
  if (!generationResult.ok) return generationResult;
  const sidecarResult = preflightRequestWireOptions(req, facts, requestWireOptions);
  if (!sidecarResult.ok) return sidecarResult;
  const outputResult = preflightOutputFormat(req, facts);
  if (!outputResult.ok) return outputResult;

  return preflightTranscript(req, facts);
}

/**
 * Evaluates semantic capability feasibility for an admitted complete {@link IrRequest}
 * given the specific translation direction.
 *
 * @param req - Validated semantic IR request.
 * @param direction - Directed protocol conversion path.
 * @param requestWireOptions - Wire-only sidecar captured by source ingress.
 * @returns Ok if eligible for translation; otherwise fail-closed normalized failure.
 */
export function preflightRequest(
  req: IrRequest,
  direction: Direction,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  if (req.delivery !== "complete") {
    return unsupportedCapability("semantic-stream-lifecycle");
  }

  const facts = directionFacts(direction);
  return preflightPlainTextRequestFeatures(req, facts, requestWireOptions);
}

/**
 * Evaluates semantic capability feasibility for an admitted streaming {@link IrRequest}
 * given the specific translation direction.
 *
 * @param req - Validated semantic IR request.
 * @param direction - Directed protocol conversion path.
 * @param requestWireOptions - Wire-only sidecar captured by source ingress.
 * @returns Ok if eligible for translation; otherwise fail-closed normalized failure.
 */
export function preflightStreamRequest(
  req: IrRequest,
  direction: Direction,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  if (req.delivery !== "stream") {
    return unsupportedCapability("semantic-stream-lifecycle");
  }

  // Custom tools are permanently blocked in translated streams.
  const hasCustomToolSurface =
    req.tools?.some((tool) => tool.type === "custom") ||
    requestWireOptions?.allowedToolSubset?.tools?.some((tool) => tool.type === "custom") ||
    req.items.some((item) => item.type === "tool_call" && item.call.type === "custom");
  if (hasCustomToolSurface) {
    return unsupportedCapability("custom-tool-streaming");
  }

  const facts = directionFacts(direction);
  return preflightPlainTextRequestFeatures(req, facts, requestWireOptions);
}

/**
 * Returns normalized failure if response-side wire options are inadmissible for client protocol.
 *
 * @param clientProtocol - Target client protocol.
 * @param outcomeWireOptions - Response-side wire options from provider.
 * @returns Normalized failure if unsupported, otherwise `undefined`.
 */
export function outcomeWireOptionsFailure(
  clientProtocol: Protocol,
  outcomeWireOptions: OutcomeWireOptions | undefined,
): NormalizedFailure | undefined {
  if (outcomeWireOptions?.moderation !== undefined && clientProtocol === "anthropic-messages") {
    return unsupportedCapabilityFailure("moderation-policy-result");
  }
  return undefined;
}

/**
 * Normalizes outcome wire options for a translation direction before client encoding.
 *
 * @param options - Outcome wire options from provider.
 * @param clientProtocol - Client protocol receiving the response.
 * @param providerProtocol - Upstream provider protocol that generated the outcome.
 * @returns Filtered wire options appropriate for the client protocol.
 */
export function normalizeOutcomeWireOptions(
  options: OutcomeWireOptions,
  clientProtocol: Protocol,
  providerProtocol: Protocol,
): OutcomeWireOptions {
  const touchesMessages = clientProtocol === "anthropic-messages" || providerProtocol === "anthropic-messages";
  if (!touchesMessages || options.serviceTier === undefined) return options;
  return options.moderation !== undefined ? { moderation: options.moderation } : {};
}

/**
 * Evaluates semantic capability feasibility for an upstream provider {@link IrOutcome}.
 *
 * @param out - Validated semantic IR outcome from upstream provider.
 * @param direction - Directed protocol conversion path.
 * @param outcomeWireOptions - Wire-only sidecar captured by provider ingress.
 * @returns Ok if eligible for client translation; otherwise fail-closed normalized failure.
 */
export function preflightOutcome(
  out: IrOutcome,
  direction: Direction,
  outcomeWireOptions?: OutcomeWireOptions,
): Result<void, NormalizedFailure> {
  if (out.finish.reason === "tool_calls" && !out.parts.some((part) => part.type === "tool_call")) {
    return invalidRequest("Outcome with finish reason 'tool_calls' must contain at least one tool_call part");
  }
  const facts = directionFacts(direction);

  const hasRefusalPart = out.parts.some((p) => p.type === "refusal");
  if (hasRefusalPart && out.finish.reason !== "refusal") {
    return invalidRequest("Outcome carries a refusal part but finish reason is not refusal");
  }
  if (hasRefusalPart && out.parts.some((p) => p.type === "tool_call")) {
    return invalidRequest("Outcome carries both a refusal part and tool_call parts");
  }

  if (out.finish.reason === "content_filter") {
    if (!facts.isChatResponses) return unsupportedCapability("finish-content-filter");
  } else if (out.finish.reason === "context_limit") {
    return unsupportedCapability("finish-context-limit");
  } else if (out.finish.reason === "refusal") {
    const refusalCapability = refusalFinishCapability(direction, hasRefusalPart);
    if (refusalCapability !== undefined) {
      return unsupportedCapability(refusalCapability);
    }
  }

  const wireOptionsFailure = outcomeWireOptionsFailure(facts.source, outcomeWireOptions);
  if (wireOptionsFailure !== undefined) return failure(wireOptionsFailure);

  const clientIsMessages = facts.source === "anthropic-messages";
  const clientIsChat = facts.source === "openai-chat";
  const clientIsResponses = facts.source === "openai-responses";

  for (const part of out.parts) {
    if (part.type === "refusal") {
      if (!facts.isChatResponses) {
        return unsupportedCapability("refusal-content");
      }
    }
    if (part.type === "tool_call") {
      if (part.call.type === "custom" && clientIsMessages) {
        return unsupportedCapability("custom-text-tool");
      }
      if (part.call.type === "function" && clientIsMessages && part.call.arguments === undefined) {
        return invalidRequest("function call arguments must be a valid JSON object for an Anthropic Messages client");
      }
    }
    if (part.type === "text" && part.citations !== undefined && part.citations.length > 0) {
      const firstCit = part.citations[0];
      if (firstCit === undefined) continue;
      if (clientIsChat) {
        return unsupportedCapability(
          firstCit.source.type === "url" ? "url-citation-source" : "file-document-citation-source",
        );
      }
      if (clientIsResponses) {
        return unsupportedCapability("citation-output-span");
      }
      if (clientIsMessages) {
        return unsupportedCapability(
          firstCit.source.type === "url" ? "url-citation-source" : "citation-document-location",
        );
      }
    }
  }

  return ok(undefined);
}
