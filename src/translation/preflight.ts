import type { Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction, OutcomeWireOptions, RequestWireOptions } from "./contracts.ts";
import { invalidRequestFailure, unsupportedCapabilityFailure } from "./failures.ts";
import type { IrOutcome, IrRequest } from "./ir.ts";

/** C/R metadata limits (`request-metadata` declared subset). */
const METADATA_MAX_ENTRIES = 16;
const METADATA_MAX_KEY_LENGTH = 64;
const METADATA_MAX_VALUE_LENGTH = 512;

/**
 * Validates the C/R metadata size/count subset: at most 16 entries, keys ≤64
 * chars, values ≤512 chars. Violations fail `invalid_request` per the
 * `request-metadata` row's declared subset.
 */
function validateMetadataLimits(metadata: Readonly<Record<string, string>>): Result<void, NormalizedFailure> {
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_ENTRIES) {
    return {
      ok: false,
      error: invalidRequestFailure(`metadata supports at most ${METADATA_MAX_ENTRIES} entries`),
    };
  }
  for (const [key, value] of entries) {
    if (key.length > METADATA_MAX_KEY_LENGTH) {
      return { ok: false, error: invalidRequestFailure(`metadata key exceeds ${METADATA_MAX_KEY_LENGTH} characters`) };
    }
    if (value.length > METADATA_MAX_VALUE_LENGTH) {
      return {
        ok: false,
        error: invalidRequestFailure(`metadata['${key}'] value exceeds ${METADATA_MAX_VALUE_LENGTH} characters`),
      };
    }
  }
  return { ok: true, value: undefined };
}

/** True when either endpoint of the direction is Anthropic Messages. */
function directionInvolvesMessages(direction: Direction): boolean {
  return direction.startsWith("anthropic-messages->") || direction.endsWith("->anthropic-messages");
}

/** The client-facing endpoint of a direction: its source protocol. */
function directionSourceProtocol(direction: Direction): Protocol {
  return direction.split("->")[0] as Protocol;
}

/** True when the direction is Chat ↔ Responses (neither endpoint is Messages). */
function isChatResponsesDirection(direction: Direction): boolean {
  return !directionInvolvesMessages(direction);
}

/**
 * Shared preflight checks for plain-text request subset across complete and stream deliveries.
 */
function preflightPlainTextRequestFeatures(
  req: IrRequest,
  direction: Direction,
  requestWireOptions: RequestWireOptions | undefined,
): Result<void, NormalizedFailure> {
  // Gated tool controls
  if (req.tools !== undefined && req.tools.length > 0) {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("function-tool-definition"),
    };
  }
  if (req.toolChoice !== undefined && req.toolChoice.type !== "none" && req.toolChoice.type !== "auto") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("tool-choice-none-auto-required"),
    };
  }
  if (req.parallelToolCalls !== undefined) {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("parallel-tool-calls"),
    };
  }

  // ---- Generation controls: direction-specific feasibility ----
  // Sampling controls are already bounded to [0, 1] at decode; verbosity and
  // common reasoning effort are C↔R-only; stop sequences have per-direction
  // target constraints. Out-of-range values never reach preflight unclamped —
  // the decoders reject them first.
  const generation = req.generation;
  if (generation !== undefined) {
    if (generation.verbosity !== undefined && !isChatResponsesDirection(direction)) {
      return { ok: false, error: unsupportedCapabilityFailure("text-verbosity") };
    }
    if (generation.reasoning?.effort !== undefined && !isChatResponsesDirection(direction)) {
      return { ok: false, error: unsupportedCapabilityFailure("reasoning-effort-common") };
    }
    if (generation.stopSequences !== undefined && generation.stopSequences.length > 0) {
      // Responses has no request stop parameter: every direction targeting R rejects.
      if (direction.endsWith("->openai-responses")) {
        return { ok: false, error: unsupportedCapabilityFailure("stop-sequence-request") };
      }
      // M→C: Chat admits at most 4 entries; larger (valid M) sets reject.
      if (direction.startsWith("anthropic-messages->") && generation.stopSequences.length > 4) {
        return { ok: false, error: unsupportedCapabilityFailure("stop-sequence-request") };
      }
    }
  }

  // ---- Wire-only sidecar: direction feasibility before any dispatch ----
  // The decoder has no direction, so per-row T1/T2/T3 feasibility is enforced here.
  if (requestWireOptions !== undefined) {
    const involvesMessages = directionInvolvesMessages(direction);
    // C↔R-only rows: every M direction is T3.
    if (involvesMessages) {
      if (requestWireOptions.store !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("responses-storage") };
      }
      if (requestWireOptions.promptCacheKey !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("prompt-cache-key") };
      }
      if (requestWireOptions.promptCacheMode !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("prompt-cache-mode") };
      }
      if (requestWireOptions.promptCacheTtl !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("prompt-cache-ttl") };
      }
      if (requestWireOptions.safetyIdentifier !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("safety-identifier") };
      }
      if (requestWireOptions.moderation !== undefined) {
        return { ok: false, error: unsupportedCapabilityFailure("moderation-policy-result") };
      }
      // Service tier maps into/out of M only at the documented `auto`
      // intersection. Explicit null is the sidecar's deliberately-preserved
      // "no tier requested" fact and is treated as unspecified for M
      // directions: no rejection and nothing emitted into M (C↔R round-trip
      // null verbatim and never reach this branch).
      if (
        requestWireOptions.serviceTier !== undefined &&
        requestWireOptions.serviceTier !== null &&
        requestWireOptions.serviceTier !== "auto"
      ) {
        return { ok: false, error: unsupportedCapabilityFailure("service-tier") };
      }
    }
    // request-metadata is T2 in every direction: enforce the declared C/R
    // size/count subset and let the egress subset into M (user_id only).
    if (requestWireOptions.metadata !== undefined) {
      const metadataResult = validateMetadataLimits(requestWireOptions.metadata);
      if (!metadataResult.ok) return metadataResult;
    }
    // prompt-cache-breakpoints: C↔R is direct and into/out of M is marker-only
    // with declared TTL loss (egress-side), except breakpoints anchored to
    // assistant content cannot target Responses: R egress would re-emit the
    // marker onto an output_text part, which the R provider 400s (the R wire
    // admits markers only on input_text/input_image/input_file blocks). C and
    // M wires accept markers on assistant content, so only R-targeting
    // directions reject.
    if (direction.endsWith("->openai-responses") && requestWireOptions.promptCacheBreakpoints !== undefined) {
      for (const entry of requestWireOptions.promptCacheBreakpoints) {
        const anchored = req.items[entry.itemIndex];
        if (anchored?.type === "message" && anchored.role === "assistant") {
          return { ok: false, error: unsupportedCapabilityFailure("prompt-cache-breakpoint") };
        }
      }
    }
  }

  // Gated structured output
  if (req.output !== undefined && req.output.type !== "text") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("structured-json-schema"),
    };
  }

  // Transcript items and content parts inspection
  const isTargetMessages = direction.endsWith("->anthropic-messages");
  const isSourceMessages = direction.startsWith("anthropic-messages->");
  let sawNonInstruction = false;

  for (const item of req.items) {
    if (item.type === "instruction") {
      if (isTargetMessages) {
        if (sawNonInstruction) {
          return {
            ok: false,
            error: unsupportedCapabilityFailure("mid-conversation-instruction"),
          };
        }
        if (item.separation === "required") {
          return {
            ok: false,
            error: unsupportedCapabilityFailure(
              item.authority === "developer" ? "developer-instruction" : "mixed-instruction-authority",
            ),
          };
        }
      }
      if (isSourceMessages && item.authority === "developer") {
        return {
          ok: false,
          error: unsupportedCapabilityFailure("developer-instruction"),
        };
      }
    } else {
      sawNonInstruction = true;
    }

    if (item.type === "tool_call") {
      return {
        ok: false,
        error: unsupportedCapabilityFailure("function-tool-definition"),
      };
    }
    if (item.type === "tool_result") {
      return {
        ok: false,
        error: unsupportedCapabilityFailure("tool-result-text"),
      };
    }

    if (item.type === "message") {
      if (item.role === "user") {
        for (const part of item.content) {
          if (part.type === "image") {
            return {
              ok: false,
              error: unsupportedCapabilityFailure("image-url"),
            };
          }
          if (part.type === "document") {
            return {
              ok: false,
              error: unsupportedCapabilityFailure("document-inline-bytes"),
            };
          }
        }
      } else if (item.role === "assistant") {
        for (const part of item.content) {
          if (part.type === "refusal") {
            return {
              ok: false,
              error: unsupportedCapabilityFailure("refusal-content"),
            };
          }
          if (part.type === "text" && part.citations !== undefined && part.citations.length > 0) {
            return {
              ok: false,
              error: unsupportedCapabilityFailure("url-citation-source"),
            };
          }
        }
      }
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Evaluates semantic capability feasibility for an admitted complete {@link IrRequest}
 * given the specific translation direction.
 *
 * Only plain-text complete requests are admitted. Any non-plain-text
 * features, unsupported direction-specific transcript structures, or wire-only
 * sidecar fields traveling in a T3 direction fail closed with their exact
 * matrix capability ID before any provider dispatch occurs.
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
    return {
      ok: false,
      error: unsupportedCapabilityFailure("semantic-stream-lifecycle"),
    };
  }

  return preflightPlainTextRequestFeatures(req, direction, requestWireOptions);
}

/**
 * Evaluates semantic capability feasibility for an admitted streaming {@link IrRequest}
 * given the specific translation direction.
 *
 * Only plain-text streaming requests are admitted. Any non-plain-text
 * features, unsupported direction-specific transcript structures, or wire-only
 * sidecar fields traveling in a T3 direction fail closed with their exact
 * matrix capability ID before any provider dispatch occurs.
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
    return {
      ok: false,
      error: unsupportedCapabilityFailure("semantic-stream-lifecycle"),
    };
  }

  return preflightPlainTextRequestFeatures(req, direction, requestWireOptions);
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
 * Only natural ("stop") and length ("length") finish reasons with text parts
 * are admitted. Any refusal, tool calls, content filter discoveries, or a
 * moderation result destined for a Messages client terminate fail-closed.
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
  // Gated finish reason
  if (out.finish.reason === "tool_calls") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("finish-tool-calls"),
    };
  }
  if (out.finish.reason === "refusal") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("refusal-content"),
    };
  }
  if (out.finish.reason === "content_filter") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("finish-content-filter"),
    };
  }
  if (out.finish.reason === "context_limit") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("finish-context-limit"),
    };
  }
  if (out.finish.reason === "other") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("finish-other-unknown"),
    };
  }

  // Response-side sidecar feasibility (shared with the stream pump).
  const wireOptionsFailure = outcomeWireOptionsFailure(directionSourceProtocol(direction), outcomeWireOptions);
  if (wireOptionsFailure !== undefined) return { ok: false, error: wireOptionsFailure };

  // Inspect output parts
  for (const part of out.parts) {
    if (part.type === "refusal") {
      return {
        ok: false,
        error: unsupportedCapabilityFailure("refusal-content"),
      };
    }
    if (part.type === "tool_call") {
      return {
        ok: false,
        error: unsupportedCapabilityFailure("function-tool-definition"),
      };
    }
    if (part.type === "text" && part.citations !== undefined && part.citations.length > 0) {
      return {
        ok: false,
        error: unsupportedCapabilityFailure("url-citation-source"),
      };
    }
  }

  return { ok: true, value: undefined };
}
