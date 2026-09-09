/**
 * @fileoverview Stream session budgeting for tool call arguments.
 *
 * Implements a session-wide memory ceiling for streaming tool call arguments across chunks,
 * protecting against unbounded memory growth from misbehaving or hostile provider streams.
 *
 * Used by StreamShapeTracker across OpenAI Chat, OpenAI Responses, and Anthropic Messages stream
 * decoders to enforce payload size limits before accumulating tool call deltas.
 */

import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import { failure, ok } from "../../result.ts";

/** Default maximum accumulated UTF-8 bytes for tool arguments in a stream session (32 MiB). */
export const MAX_STREAM_TOOL_ARGUMENTS_BYTES = 33_554_432;

/**
 * Tracks accumulated UTF-8 byte sizes of streaming tool arguments against a session ceiling.
 * Rejects any fragment that would exceed the budget with a `payload_too_large` failure.
 */
export class StreamToolArgumentsBudget {
  /** Maximum number of UTF-8 bytes that the session can admit across all tool calls. */
  private readonly maxBytes: number;

  /** Running total of UTF-8 bytes admitted for tool arguments in this session. */
  private currentBytes = 0;

  /**
   * Initializes a new budget instance with the given ceiling.
   *
   * @param maxBytes - Maximum permitted UTF-8 bytes across the session. Defaults to 32 MiB.
   */
  constructor(maxBytes: number = MAX_STREAM_TOOL_ARGUMENTS_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * Checks and claims bytes for an incoming argument fragment.
   *
   * @param fragment - String fragment to accumulate.
   * @returns Successful result if within budget, or `payload_too_large` failure if exceeded.
   */
  claim(fragment: string): Result<void, NormalizedFailure> {
    const bytes = Buffer.byteLength(fragment, "utf8");
    if (this.currentBytes + bytes > this.maxBytes) {
      return failure({
        category: "payload_too_large",
        message: `Stream tool arguments exceeded limit of ${this.maxBytes} bytes`,
        retryable: false,
      });
    }
    this.currentBytes += bytes;
    return ok(undefined);
  }
}
