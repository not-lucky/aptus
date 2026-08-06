import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { invalidRequestFailure } from "./failures.ts";
import type {
  IrAssistantPart,
  IrBinarySource,
  IrDocumentSource,
  IrInputPart,
  IrItem,
  IrOutcome,
  IrOutputPart,
  IrRequest,
  IrUsage,
} from "./ir.ts";

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "refusal", "content_filter", "context_limit", "other"]);

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isNonNegativeSafeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function validateBinarySource(source: IrBinarySource, context: string): Result<void, NormalizedFailure> {
  if (source.type === "url") {
    if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
      return {
        ok: false,
        error: invalidRequestFailure(`${context}: URL source must be an absolute HTTPS URL`),
      };
    }
    return { ok: true, value: undefined };
  }
  if (source.type === "bytes") {
    if (typeof source.mediaType !== "string" || source.mediaType.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure(`${context}: mediaType must be a non-empty string`),
      };
    }
    if (
      typeof source.base64 !== "string" ||
      source.base64.trim() === "" ||
      !BASE64_REGEX.test(source.base64.replaceAll(/\s/g, ""))
    ) {
      return {
        ok: false,
        error: invalidRequestFailure(`${context}: base64 payload must be valid base64`),
      };
    }
    return { ok: true, value: undefined };
  }
  if (source.type === "gateway_file") {
    if (typeof source.fileId !== "string" || source.fileId.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure(`${context}: fileId must be a non-empty string`),
      };
    }
    return { ok: true, value: undefined };
  }
  return {
    ok: false,
    error: invalidRequestFailure(`${context}: unknown binary source type`),
  };
}

function validateDocumentSource(source: IrDocumentSource, context: string): Result<void, NormalizedFailure> {
  if (source.type === "text") {
    if (typeof source.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`${context}: text document source must contain string text`),
      };
    }
    return { ok: true, value: undefined };
  }
  return validateBinarySource(source, context);
}

function validateInputPart(part: IrInputPart, index: number): Result<void, NormalizedFailure> {
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`input part [${index}]: text must be a string`),
      };
    }
    return { ok: true, value: undefined };
  }
  if (part.type === "image") {
    return validateBinarySource(part.source, `input part [${index}] (image)`);
  }
  if (part.type === "document") {
    if (typeof part.documentId !== "string" || part.documentId.trim() === "") {
      return {
        ok: false,
        error: invalidRequestFailure(`input part [${index}] (document): documentId must be non-empty`),
      };
    }
    return validateDocumentSource(part.source, `input part [${index}] (document)`);
  }
  return {
    ok: false,
    error: invalidRequestFailure(`input part [${index}]: unknown input part type`),
  };
}

function validateAssistantPart(part: IrAssistantPart, index: number): Result<void, NormalizedFailure> {
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`assistant part [${index}]: text must be a string`),
      };
    }
    return { ok: true, value: undefined };
  }
  if (part.type === "refusal") {
    if (part.text !== undefined && typeof part.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`assistant part [${index}] (refusal): text must be a string if present`),
      };
    }
    return { ok: true, value: undefined };
  }
  return {
    ok: false,
    error: invalidRequestFailure(`assistant part [${index}]: unknown assistant part type`),
  };
}

function validateItem(item: IrItem, index: number): Result<void, NormalizedFailure> {
  if (item.type === "instruction") {
    if (item.authority !== "system" && item.authority !== "developer") {
      return {
        ok: false,
        error: invalidRequestFailure(`item [${index}] (instruction): authority must be system or developer`),
      };
    }
    if (item.separation !== "advisory" && item.separation !== "required") {
      return {
        ok: false,
        error: invalidRequestFailure(`item [${index}] (instruction): separation must be advisory or required`),
      };
    }
    if (typeof item.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`item [${index}] (instruction): text must be a string`),
      };
    }
    return { ok: true, value: undefined };
  }

  if (item.type === "message") {
    if (item.role === "user") {
      if (!Array.isArray(item.content) || item.content.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`item [${index}] (user message): content must be a non-empty array`),
        };
      }
      for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
        const part = item.content[pIdx];
        if (part !== undefined) {
          const partResult = validateInputPart(part, pIdx);
          if (!partResult.ok) return partResult;
        }
      }
      return { ok: true, value: undefined };
    }

    if (item.role === "assistant") {
      if (!Array.isArray(item.content) || item.content.length === 0) {
        return {
          ok: false,
          error: invalidRequestFailure(`item [${index}] (assistant message): content must be a non-empty array`),
        };
      }
      for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
        const part = item.content[pIdx];
        if (part !== undefined) {
          const partResult = validateAssistantPart(part, pIdx);
          if (!partResult.ok) return partResult;
        }
      }
      return { ok: true, value: undefined };
    }

    return {
      ok: false,
      error: invalidRequestFailure(`item [${index}] (message): invalid role`),
    };
  }

  if (item.type === "tool_call") {
    if (!item.call || typeof item.call.callId !== "string" || typeof item.call.name !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`item [${index}] (tool_call): malformed tool call`),
      };
    }
    return { ok: true, value: undefined };
  }

  if (item.type === "tool_result") {
    if (typeof item.callId !== "string" || typeof item.isError !== "boolean" || !Array.isArray(item.content)) {
      return {
        ok: false,
        error: invalidRequestFailure(`item [${index}] (tool_result): malformed tool result`),
      };
    }
    return { ok: true, value: undefined };
  }

  return {
    ok: false,
    error: invalidRequestFailure(`item [${index}]: unknown item type`),
  };
}

/**
 * Validates invariant properties of an {@link IrRequest}.
 *
 * Enforces normative request invariants:
 * - Items must be non-empty.
 * - At least one user or assistant message must be present (instruction-only is rejected).
 * - Source order and content parts must satisfy semantic constraints.
 * - Delivery mode must be either "complete" or "stream".
 */
export function validateIrRequest(req: IrRequest): Result<void, NormalizedFailure> {
  if (typeof req.model !== "string" || req.model.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("IrRequest.model must be a non-empty string"),
    };
  }

  if (req.delivery !== "complete" && req.delivery !== "stream") {
    return {
      ok: false,
      error: invalidRequestFailure("IrRequest.delivery must be 'complete' or 'stream'"),
    };
  }

  if (!Array.isArray(req.items) || req.items.length === 0) {
    return {
      ok: false,
      error: invalidRequestFailure("IrRequest.items must be a non-empty array"),
    };
  }

  let hasMessage = false;
  for (let i = 0; i < req.items.length; i++) {
    const item = req.items[i];
    if (item === undefined) continue;
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      hasMessage = true;
    }
    const itemResult = validateItem(item, i);
    if (!itemResult.ok) return itemResult;
  }

  if (!hasMessage) {
    return {
      ok: false,
      error: invalidRequestFailure("IrRequest must contain at least one user or assistant message turn"),
    };
  }

  return { ok: true, value: undefined };
}

function validateOutputPart(part: IrOutputPart, index: number): Result<void, NormalizedFailure> {
  if (typeof part.partId !== "string" || part.partId.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure(`output part [${index}]: partId must be a non-empty string`),
    };
  }

  if (part.type === "text") {
    if (typeof part.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`output part [${index}] (text): text must be a string`),
      };
    }
    return { ok: true, value: undefined };
  }

  if (part.type === "refusal") {
    if (part.text !== undefined && typeof part.text !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`output part [${index}] (refusal): text must be a string if present`),
      };
    }
    return { ok: true, value: undefined };
  }

  if (part.type === "tool_call") {
    if (!part.call || typeof part.call.callId !== "string" || typeof part.call.name !== "string") {
      return {
        ok: false,
        error: invalidRequestFailure(`output part [${index}] (tool_call): malformed tool call`),
      };
    }
    return { ok: true, value: undefined };
  }

  return {
    ok: false,
    error: invalidRequestFailure(`output part [${index}]: unknown output part type`),
  };
}

function validateUsage(usage: IrUsage): Result<void, NormalizedFailure> {
  if (!isNonNegativeSafeInteger(usage.input)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.input must be a non-negative safe integer"),
    };
  }
  if (!isNonNegativeSafeInteger(usage.output)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.output must be a non-negative safe integer"),
    };
  }
  if (usage.total !== undefined && !isNonNegativeSafeInteger(usage.total)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.total must be a non-negative safe integer if present"),
    };
  }
  if (usage.cacheReadInput !== undefined && !isNonNegativeSafeInteger(usage.cacheReadInput)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.cacheReadInput must be a non-negative safe integer if present"),
    };
  }
  if (usage.cacheWriteInput !== undefined && !isNonNegativeSafeInteger(usage.cacheWriteInput)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.cacheWriteInput must be a non-negative safe integer if present"),
    };
  }
  if (usage.reasoningOutput !== undefined && !isNonNegativeSafeInteger(usage.reasoningOutput)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.reasoningOutput must be a non-negative safe integer if present"),
    };
  }

  const cachedInputSum = (usage.cacheReadInput ?? 0) + (usage.cacheWriteInput ?? 0);
  if (usage.input < cachedInputSum) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.input must be the canonical total and cannot be less than cached input"),
    };
  }

  if (usage.total !== undefined && usage.total < usage.input + usage.output) {
    return {
      ok: false,
      error: invalidRequestFailure("IrUsage.total cannot be less than input + output tokens"),
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Validates invariant properties of an {@link IrOutcome}.
 *
 * Enforces normative outcome and accounting invariants:
 * - `responseId` and `model` must be non-empty strings.
 * - `parts` preserves semantic order and may be empty; part IDs must be unique.
 * - `finish.reason` must belong to the normative finish reason union.
 * - `usage` counters must be non-negative finite safe integers.
 */
export function validateIrOutcome(out: IrOutcome): Result<void, NormalizedFailure> {
  if (typeof out.responseId !== "string" || out.responseId.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("IrOutcome.responseId must be a non-empty string"),
    };
  }

  if (typeof out.model !== "string" || out.model.trim() === "") {
    return {
      ok: false,
      error: invalidRequestFailure("IrOutcome.model must be a non-empty string"),
    };
  }

  if (!Array.isArray(out.parts)) {
    return {
      ok: false,
      error: invalidRequestFailure("IrOutcome.parts must be an array"),
    };
  }

  const seenPartIds = new Set<string>();
  for (let i = 0; i < out.parts.length; i++) {
    const part = out.parts[i];
    if (part !== undefined) {
      const partResult = validateOutputPart(part, i);
      if (!partResult.ok) return partResult;
      if (seenPartIds.has(part.partId)) {
        return {
          ok: false,
          error: invalidRequestFailure(`IrOutcome.parts contains duplicate partId '${part.partId}' at index [${i}]`),
        };
      }
      seenPartIds.add(part.partId);
    }
  }

  if (!out.finish || !FINISH_REASONS.has(out.finish.reason)) {
    return {
      ok: false,
      error: invalidRequestFailure(`IrOutcome.finish.reason must be one of: ${[...FINISH_REASONS].join(", ")}`),
    };
  }

  if (out.usage !== undefined) {
    const usageResult = validateUsage(out.usage);
    if (!usageResult.ok) return usageResult;
  }

  return { ok: true, value: undefined };
}
