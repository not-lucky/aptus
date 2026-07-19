/**
 * Canonical finish-reason and response-status lifecycle mapping.
 *
 * These helpers operate purely over the canonical {@link FinishReason} and
 * {@link ResponseStatus} enums; they never parse provider wire strings (that
 * stays in translators) and perform no I/O. They exist so the application and
 * egress encoders can derive a single response status, decide terminality, and
 * recognize a continuable pause from canonical values alone.
 */

import type { FinishReason, ResponseStatus } from "./canonical.js";

/**
 * Map one choice's finish reason to the response status it implies. `pause_turn`
 * signals a resend-to-continue loop and is therefore non-terminal (`in_progress`);
 * `error` maps to `failed`; clean and truncated stops map to `completed`.
 */
export function finishReasonToStatus(reason: FinishReason): ResponseStatus {
  switch (reason) {
    case "stop":
    case "max_tokens":
    case "stop_sequence":
    case "tool_calls":
    case "refusal":
    case "content_filter":
      return "completed";
    case "incomplete":
      return "incomplete";
    case "cancelled":
      return "cancelled";
    case "pause_turn":
      return "in_progress";
    case "error":
      return "failed";
  }
}

/** True for statuses that permit no further progress. */
export function isTerminalStatus(status: ResponseStatus): boolean {
  return status !== "queued" && status !== "in_progress";
}

/** True only for `pause_turn`, the one finish reason that is resent to continue. */
export function isContinuableFinishReason(reason: FinishReason): boolean {
  return reason === "pause_turn";
}

/**
 * Derive the aggregate response status from every choice's finish reason and
 * whether the response carries an error. Precedence: an error wins, then any
 * cancellation, then any errored choice, then any continuable pause, then any
 * incomplete choice; otherwise the response is completed.
 */
export function deriveResponseStatus(input: {
  readonly finishReasons: readonly FinishReason[];
  readonly hasError: boolean;
}): ResponseStatus {
  if (input.hasError) return "failed";
  if (input.finishReasons.includes("cancelled")) return "cancelled";
  if (input.finishReasons.includes("error")) return "failed";
  if (input.finishReasons.includes("pause_turn")) return "in_progress";
  if (input.finishReasons.includes("incomplete")) return "incomplete";
  return "completed";
}
