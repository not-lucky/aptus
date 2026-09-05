import type { Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { CHAT_TOOL_NAME_REGEX } from "./codecs/shared/controls.ts";
import { M_IMAGE_MEDIA_TYPES } from "./codecs/shared/media.ts";
import type { Direction, OutcomeWireOptions, RequestWireOptions } from "./contracts.ts";
import { unsupportedCapabilityFailure } from "./failures.ts";
import type { IrInputPart, IrOutcome, IrRequest } from "./ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "./result.ts";
import {
  validateMessagesObjectRoot,
  validateMessagesOutputSchema,
  validateMessagesStrictSchema,
  validateOpenAiStrictSchema,
} from "./schema-dialect.ts";

/** C/R metadata limits (`request-metadata` declared subset). */
const METADATA_MAX_ENTRIES = 16;
const METADATA_MAX_KEY_LENGTH = 64;
const METADATA_MAX_VALUE_LENGTH = 512;

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
 * Validates the C/R metadata size/count subset: at most 16 entries, keys ≤64
 * chars, values ≤512 chars. Violations fail `invalid_request` per the
 * `request-metadata` row's declared subset.
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

/** Closed facts for each supported translation direction. */
export interface DirectionFacts {
  readonly source: Protocol;
  readonly target: Protocol;
  readonly involvesMessages: boolean;
  readonly isTargetChat: boolean;
  readonly isTargetResponses: boolean;
  readonly isTargetMessages: boolean;
  readonly isChatResponses: boolean;
  readonly isSourceMessages: boolean;
}

/**
 * Derives the closed set of per-direction facts shared by every
 * direction-gated capability check. `isChatResponses` is the single spelling
 * of "this direction stays between OpenAI Chat and Responses"; the stream
 * state machine and both capability helpers must consume it rather than
 * recomparing protocol strings inline.
 *
 * @param direction - Directed conversion path (source is the client).
 * @returns The direction's immutable fact set.
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
 * Computes the refusal capability rejection for a translated outcome with a
 * refusal finish reason, or `undefined` when the direction admits it.
 *
 * A refusal finish without a refusal part can only originate from a Messages
 * provider (the sole wire with a refusal stop reason and no refusal content
 * block), so it reports `refusal-terminal-reason`. Any other refusal crossing
 * a Messages boundary reports `refusal-content`. C/R directions admit both.
 * Shared by the complete-path preflight and the stream state machine so the
 * two paths cannot drift.
 *
 * @param direction - Directed protocol conversion path (source is the client,
 * target is the upstream provider the outcome was decoded from).
 * @param hasRefusalPart - Whether the outcome carries a refusal part.
 * @returns Capability ID to reject with, or `undefined` when admitted.
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
 * Validates per-target feasibility of every client tool surface on the request:
 * `req.tools` plus the allowed-tools subset sidecar, whose elements re-emit in
 * the target wire shape and so face the same per-target checks.
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
 * Validates direction feasibility of the admitted generation controls: verbosity
 * and common reasoning effort are C/R-only, and stop sequences carry
 * per-direction target constraints. Sampling bounds are enforced at decode, so
 * out-of-range values never reach preflight unclamped.
 */
function preflightGenerationControls(req: IrRequest, facts: DirectionFacts): Result<void, NormalizedFailure> {
  // Sampling controls are already bounded to [0, 1] at decode; verbosity and
  // common reasoning effort are C↔R-only; stop sequences have per-direction
  // target constraints. Out-of-range values never reach preflight unclamped —
  // the decoders reject them first.
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
      // M→C: Chat admits at most 4 entries; larger (valid M) sets reject.
      if (facts.isSourceMessages && generation.stopSequences.length > 4) {
        return unsupportedCapability("stop-sequence-request");
      }
    }
  }
  return ok(undefined);
}

/**
 * Validates direction feasibility of the request wire-only sidecar before any
 * dispatch: the decoder has no direction, so every per-row T1/T2/T3 rule for a
 * captured field is enforced here.
 */
const MESSAGES_FORBIDDEN_REQUEST_OPTIONS: ReadonlyArray<readonly [keyof RequestWireOptions, string]> = [
  ["store", "responses-storage"],
  ["promptCacheKey", "prompt-cache-key"],
  ["promptCacheMode", "prompt-cache-mode"],
  ["promptCacheTtl", "prompt-cache-ttl"],
  ["safetyIdentifier", "safety-identifier"],
  ["moderation", "moderation-policy-result"],
  ["allowedToolSubset", "allowed-tool-subset"],
  ["legacyJsonObject", "legacy-json-object"],
];

function preflightRequestWireOptions(
  req: IrRequest,
  facts: DirectionFacts,
  requestWireOptions: RequestWireOptions | undefined,
): Result<void, NormalizedFailure> {
  const { involvesMessages, isTargetChat } = facts;

  if (requestWireOptions !== undefined) {
    // C↔R-only rows: every M direction is T3.
    if (involvesMessages) {
      for (const [key, capability] of MESSAGES_FORBIDDEN_REQUEST_OPTIONS) {
        if (requestWireOptions[key] !== undefined) return unsupportedCapability(capability);
      }
      // Service tier maps into/out of M only at the documented `auto`
      // intersection. Explicit null is the sidecar's deliberately-preserved
      // "no tier requested" fact and is treated as unspecified for M.
      if (
        requestWireOptions.serviceTier !== undefined &&
        requestWireOptions.serviceTier !== null &&
        requestWireOptions.serviceTier !== "auto"
      ) {
        return unsupportedCapability("service-tier");
      }
    }
    // Chat has no caller surface at all, so any surviving caller entry fails
    // closed here; decode has already rejected every non-"direct" literal.
    if (requestWireOptions.toolAllowedCallers !== undefined && isTargetChat) {
      return unsupportedCapability("allowed-callers");
    }
    // request-metadata is T2 in every direction: enforce the declared C/R
    // size/count subset and let the egress subset into M (user_id only).
    if (requestWireOptions.metadata !== undefined) {
      const metadataResult = validateMetadataLimits(requestWireOptions.metadata);
      if (!metadataResult.ok) return metadataResult;
    }
    // provider-file-id / provider-image-id: C↔R only, every M direction is T3.
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
    // prompt-cache-breakpoints: C↔R is direct and into/out of M is marker-only
    // with declared TTL loss (egress-side), except breakpoints anchored to
    // assistant content cannot target Responses: R egress would re-emit the
    // marker onto an output_text part, which the R provider 400s (the R wire
    // admits markers only on input_text/input_image/input_file blocks). C and
    // M wires accept markers on assistant content, so only R-targeting
    // directions reject. Tool anchors extend the same rule: C tool_calls
    // entries and R function_call/function_call_output items carry no marker
    // surface, and R function_call_output admits no marker either, while C
    // tool messages and M tool_use/tool_result blocks re-attach them.
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
 * Validates the transcript: instruction placement and authority, tool call and
 * tool result shapes, and content parts that no target wire admits.
 */
function preflightTranscript(req: IrRequest, facts: DirectionFacts): Result<void, NormalizedFailure> {
  const { involvesMessages, isTargetMessages, isTargetChat, isSourceMessages } = facts;

  // Transcript items and content parts inspection
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
        // Custom calls carry no format in the IR or on either OpenAI wire
        // (C custom:{name,input}, R {call_id,name,input}); when a grammar
        // definition is present, the tools loop above has already rejected
        // with custom-grammar-tool. A call without any current definition is
        // attributable only as custom-text-tool.
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
      // Chat tool content is a single text string: empty, multipart, or
      // non-text results cannot map onto the C wire.
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

  // Size enforcement lives at exactly two documented points: the HTTP ingress
  // body limit and the M-bound serialized-body check in the coordinator. No
  // direction-independent media-byte cap exists here — the request-body-size
  // row pins no universal JSON cap for C/R traffic.
  return ok(undefined);
}

/**
 * Shared preflight checks for plain-text request subset across complete and
 * stream deliveries.
 *
 * Each policy domain above is an independent validator; this function only
 * fixes the order in which they run, so adding a check never means editing an
 * unrelated domain's branch. The order is load-bearing: the first failure is
 * the one reported, and the matrix names exactly one owning row per request.
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
 * Plain-text and client-tool complete requests are admitted. Any
 * unsupported direction-specific transcript structures, non-admitted tool
 * capabilities, or wire-only sidecar fields traveling in a T3 direction fail
 * closed with their exact matrix capability ID before any provider dispatch
 * occurs.
 *
 * @param req - Validated semantic IR request.
 * @param direction - Directed protocol conversion path.
 * @param requestWireOptions - Wire-only sidecar captured by the source ingress.
 * @returns Ok if eligible for translation; otherwise fail-closed normalized failure.
 */
export function preflightRequest(
  req: IrRequest,
  direction: Direction,
  requestWireOptions?: RequestWireOptions,
): Result<void, NormalizedFailure> {
  // Gated delivery mode
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
 * Streaming requests may carry client tool definitions and controls so the
 * target request encoder can project them. Admitted function tool call
 * streaming translates piecewise across all six directions; custom tools fail
 * closed with their streaming rows (`custom-tool-streaming`). Other unsupported
 * direction-specific transcript structures or wire-only sidecar fields traveling
 * in a T3 direction fail closed with their exact matrix capability ID before any
 * provider dispatch occurs.
 *
 * @param req - Validated semantic IR request.
 * @param direction - Directed protocol conversion path.
 * @param requestWireOptions - Wire-only sidecar captured by the source ingress.
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

  // Custom tools are permanently blocked in translated streams: the IR has no
  // cross-protocol custom-tool stream surface. Function tool definitions,
  // choices, and parallelism are request-side fields and are validated by the
  // shared target preflight before the stream request encoder projects them.
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
 * Returns the fail-closed failure for response-side wire options discovered in
 * a forbidden direction, or undefined when the sidecar is admissible.
 *
 * A moderation result destined for a Messages client is T3 (`moderation-policy-
 * result`): the M wire has no moderation field, so a present result can never
 * map. Shared by the complete-path outcome preflight and the stream pump,
 * which bypasses it.
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
 * Normalizes outcome-side wire options for one translation direction before
 * client encoding.
 *
 * The service-tier echo passes through only between Chat and Responses: M
 * echoes (`standard|priority|batch`) share no documented cross-provider
 * equivalence with the C/R tiers — `priority` especially has different routing
 * semantics — so an echo touching Messages is declared loss and never
 * fabricated into the other vocabulary.
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
 * Evaluates semantic capability feasibility for an upstream provider's {@link IrOutcome}
 * given the specific translation direction (the direction's source protocol is
 * the client the outcome is destined for).
 *
 * Natural, length, and tool-call finishes with text and tool parts are
 * admitted. Any refusal, content filter discoveries, or a moderation result
 * destined for a Messages client terminate fail-closed.
 *
 * @param out - Validated semantic IR outcome from upstream provider.
 * @param direction - Directed protocol conversion path.
 * @param outcomeWireOptions - Wire-only sidecar captured by the provider ingress.
 * @returns Ok if eligible for client translation; otherwise fail-closed normalized failure.
 */
export function preflightOutcome(
  out: IrOutcome,
  direction: Direction,
  outcomeWireOptions?: OutcomeWireOptions,
): Result<void, NormalizedFailure> {
  // Finish/parts well-formedness guard: a tool finish with zero tool calls is
  // a malformed provider outcome and fails closed before any client wire is
  // forged.
  if (out.finish.reason === "tool_calls" && !out.parts.some((part) => part.type === "tool_call")) {
    return invalidRequest("Outcome with finish reason 'tool_calls' must contain at least one tool_call part");
  }
  const facts = directionFacts(direction);

  const hasRefusalPart = out.parts.some((p) => p.type === "refusal");
  if (hasRefusalPart && out.finish.reason !== "refusal") {
    return invalidRequest("Outcome carries a refusal part but finish reason is not refusal");
  }
  // A provider that emits both a refusal and tool calls in one outcome is
  // malformed: no target wire can express a message that refuses and calls
  // tools. The stream decoders enforce the same co-occurrence rule, so the
  // complete path must reject it here rather than encode a self-inconsistent
  // client message.
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

  // Response-side sidecar feasibility (shared with the stream pump).
  const wireOptionsFailure = outcomeWireOptionsFailure(facts.source, outcomeWireOptions);
  if (wireOptionsFailure !== undefined) return failure(wireOptionsFailure);

  const clientIsMessages = facts.source === "anthropic-messages";
  const clientIsChat = facts.source === "openai-chat";
  const clientIsResponses = facts.source === "openai-responses";

  // Inspect output parts
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
      // A function call without parsed arguments cannot become a M tool_use
      // block (input must be a JSON object); never forge one.
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
