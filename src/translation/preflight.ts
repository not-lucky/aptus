import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { Direction } from "./contracts.ts";
import { unsupportedCapabilityFailure } from "./failures.ts";
import type { IrOutcome, IrRequest } from "./ir.ts";

/**
 * Evaluates semantic capability feasibility for an admitted {@link IrRequest}
 * given the specific translation direction.
 *
 * Only plain-text complete requests are admitted. Any non-plain-text
 * features or unsupported direction-specific transcript structures fail closed
 * with their exact matrix capability ID before any provider dispatch occurs.
 *
 * @param req - Validated semantic IR request.
 * @param direction - Directed protocol conversion path.
 * @returns Ok if eligible for translation; otherwise fail-closed normalized failure.
 */
export function preflightRequest(req: IrRequest, direction: Direction): Result<void, NormalizedFailure> {
  // Gated delivery mode
  if (req.delivery !== "complete") {
    return {
      ok: false,
      error: unsupportedCapabilityFailure("semantic-stream-lifecycle"),
    };
  }

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

  // Gated generation controls
  if (req.generation !== undefined) {
    if (req.generation.temperature !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("temperature-0-1") };
    }
    if (req.generation.topP !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("top-p-0-1") };
    }
    if (req.generation.verbosity !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("text-verbosity") };
    }
    if (req.generation.maxOutputTokens !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("output-token-limit") };
    }
    if (req.generation.stopSequences !== undefined && req.generation.stopSequences.length > 0) {
      return { ok: false, error: unsupportedCapabilityFailure("stop-sequence-request") };
    }
    if (req.generation.reasoning !== undefined) {
      return { ok: false, error: unsupportedCapabilityFailure("reasoning-effort-common") };
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
 * Evaluates semantic capability feasibility for an upstream provider's {@link IrOutcome}
 * given the specific translation direction.
 *
 * Only natural ("stop") and length ("length") finish reasons with text parts
 * are admitted. Any refusal, tool calls, or content filter discoveries terminate fail-closed.
 *
 * @param out - Validated semantic IR outcome from upstream provider.
 * @param _direction - Directed protocol conversion path.
 * @returns Ok if eligible for client translation; otherwise fail-closed normalized failure.
 */
export function preflightOutcome(out: IrOutcome, _direction: Direction): Result<void, NormalizedFailure> {
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
