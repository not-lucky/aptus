/**
 * @fileoverview Complete outcome decoder for the Anthropic Messages protocol.
 *
 * Translates provider HTTP responses (status, body, and headers) into intermediate representation
 * (IR) outcomes and sidecars. Normalizes text content, citations, and tool call blocks into output
 * parts, maps stop reasons to the IR finish vocabulary, and aggregates usage token metrics.
 *
 * Evaluates provider outcomes independently of request structure to support cross-protocol translation.
 * Non-2xx statuses and error-shaped responses are normalized into provider failures.
 */

import { randomUUID } from "node:crypto";
import type { HeaderMap, JsonObject, Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { OutcomeDecodeResult } from "../../contracts.ts";
import { parseRetryAfterHeaderSeconds, truncateProviderErrorString } from "../../failures.ts";
import type { IrCitation, IrFinishReason, IrOutcome, IrOutputPart, IrUsage } from "../../ir.ts";
import { failure, invalidRequest, ok, unsupportedCapability } from "../../result.ts";
import { accumulateMessagesUsage, collapseMessagesUsage, type MessagesUsageAccumulator } from "../shared/usage.ts";
import {
  messagesHostedBlockFailure,
  messagesServerToolUseFailure,
  parseMessagesCitation,
  parseMessagesToolUseBlock,
} from "./content.ts";

/**
 * Decodes an Anthropic Messages HTTP response into an IR outcome and sidecar.
 *
 * Normalizes content blocks, processes citations, validates stop reasons, and calculates
 * token usage metrics independently of originating request parameters.
 *
 * @param status - Provider response HTTP status code.
 * @param body - Decoded Messages response JSON object.
 * @param headers - Optional HTTP response headers (consulted for `retry-after`).
 * @returns Result containing decoded IR outcome and wire sidecar or normalized failure.
 */
export function parseMessagesOutcome(
  status: number,
  body: JsonObject,
  headers?: HeaderMap,
): Result<OutcomeDecodeResult, NormalizedFailure> {
  if (typeof body !== "object" || body === null) {
    return invalidRequest("Messages response body must be an object");
  }

  if (body.type === "error" || status >= 400) {
    const err = (body.error ?? {}) as Record<string, unknown>;
    const rawMessage = typeof err.message === "string" ? err.message : `Messages provider error HTTP ${status}`;
    const rawCode = typeof err.type === "string" ? err.type : undefined;
    const retryAfterSeconds = parseRetryAfterHeaderSeconds(headers?.["retry-after"]);
    return failure({
      category: "provider",
      message: truncateProviderErrorString(rawMessage),
      code: rawCode !== undefined ? truncateProviderErrorString(rawCode) : undefined,
      retryable: false,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }

  if (body.type !== "message") {
    return invalidRequest("Messages response body must have type 'message'");
  }

  const parts: IrOutputPart[] = [];
  if (Array.isArray(body.content)) {
    for (const block of body.content) {
      const b = block as Record<string, unknown>;
      if (b?.type === "text") {
        const hosted = messagesHostedBlockFailure(b);
        if (hosted !== undefined) return failure(hosted);
        if (typeof b.text !== "string") {
          return invalidRequest("Messages output text block: text must be a string");
        }
        const citations: IrCitation[] = [];
        if (Array.isArray(b.citations)) {
          // Citation translation never drops information: an entry that cannot be fully parsed
          // terminates the outcome instead of translating a success that omits provider-supplied
          // citations.
          for (const c of b.citations) {
            const cit = c as Record<string, unknown> | undefined;
            if (cit === null || typeof cit !== "object") {
              return invalidRequest("Messages output text block: citations entries must be objects");
            }
            const parsed = parseMessagesCitation(cit);
            if (!parsed.ok) return parsed;
            citations.push(parsed.value);
          }
        }
        parts.push({
          type: "text",
          partId: randomUUID(),
          text: b.text,
          ...(citations.length > 0 ? { citations } : {}),
        });
        if (b.signature !== undefined) return unsupportedCapability("reasoning-signature");
      } else if (b?.type === "tool_use") {
        const callResult = parseMessagesToolUseBlock(b, "Messages output tool_use");
        if (!callResult.ok) return callResult;
        parts.push({ type: "tool_call", partId: randomUUID(), call: callResult.value });
      } else if (b?.type === "thinking") {
        return unsupportedCapability("readable-reasoning");
      } else if (b?.type === "redacted_thinking") {
        return unsupportedCapability("redacted-reasoning");
      } else {
        const hosted = messagesHostedBlockFailure(b);
        if (hosted !== undefined) return failure(hosted);
        if (b?.type === "server_tool_use") return failure(messagesServerToolUseFailure(b));
        return unsupportedCapability("unknown-content-item");
      }
    }
  }

  const rawStopReason = body.stop_reason;
  let finishReason: IrFinishReason;
  if (rawStopReason === "end_turn") {
    finishReason = "stop";
  } else if (rawStopReason === "max_tokens") {
    finishReason = "length";
  } else if (rawStopReason === "stop_sequence") {
    finishReason = "stop";
  } else if (rawStopReason === "refusal") {
    finishReason = "refusal";
  } else if (rawStopReason === "tool_use") {
    finishReason = "tool_calls";
  } else if (rawStopReason === "model_context_window_exceeded") {
    finishReason = "context_limit";
  } else if (rawStopReason === "pause_turn") {
    return unsupportedCapability("anthropic-pause-turn");
  } else if (rawStopReason !== null && rawStopReason !== undefined) {
    return unsupportedCapability("finish-other-unknown");
  } else {
    return invalidRequest("Messages complete response requires a non-null stop_reason");
  }

  const rawUsage = body.usage as Record<string, unknown> | null | undefined;
  if (body.container !== undefined) return unsupportedCapability("provider-container");
  if (rawUsage?.inference_geo !== undefined) return unsupportedCapability("inference-geography");

  let usage: IrUsage | undefined;
  if (rawUsage !== undefined && rawUsage !== null) {
    const accumulator: MessagesUsageAccumulator = { sawUsage: false };
    const accumulateResult = accumulateMessagesUsage(accumulator, rawUsage);
    if (!accumulateResult.ok) return accumulateResult;
    if (accumulator.inputTokens === undefined) {
      return invalidRequest("usage.input_tokens must be a finite number when usage is present");
    }
    if (accumulator.outputTokens === undefined) {
      return invalidRequest("usage.output_tokens must be a finite number when usage is present");
    }
    usage = collapseMessagesUsage(accumulator);
  }

  const outcomeWireOptions = typeof rawUsage?.service_tier === "string" ? { serviceTier: rawUsage.service_tier } : {};

  const rawStopSequence = body.stop_sequence;
  if (rawStopSequence !== undefined && rawStopSequence !== null) {
    if (typeof rawStopSequence !== "string") return invalidRequest("stop_sequence must be a string when present");
    if (rawStopReason !== "stop_sequence") {
      return invalidRequest("stop_sequence is only valid with stop_reason 'stop_sequence'");
    }
  }

  const outcome: IrOutcome = {
    responseId: typeof body.id === "string" && body.id.trim() !== "" ? body.id : `msg_${randomUUID()}`,
    model: typeof body.model === "string" ? body.model : "unknown",
    parts,
    finish: {
      reason: finishReason,
      ...(rawStopReason === "stop_sequence" && typeof rawStopSequence === "string"
        ? { stopSequence: rawStopSequence }
        : {}),
    },
    ...(usage !== undefined ? { usage } : {}),
  };

  return ok({ irOutcome: outcome, outcomeWireOptions });
}
