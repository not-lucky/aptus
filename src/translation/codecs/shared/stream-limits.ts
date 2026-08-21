import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import { failure, ok } from "../../result.ts";

/** Default stream tool arguments buffer limit: 32 MiB (mirrors default bodyLimitBytes). */
export const MAX_STREAM_TOOL_ARGUMENTS_BYTES = 33_554_432;

/**
 * Tracks cumulative tool argument memory consumption across a stream session.
 *
 * Enforces an aggregate UTF-8 byte budget across all active tool calls within a
 * single stream to prevent unbounded memory growth from streaming tool
 * invocations.
 */
export class StreamToolArgumentsBudget {
  private readonly maxBytes: number;
  private currentBytes = 0;

  constructor(maxBytes: number = MAX_STREAM_TOOL_ARGUMENTS_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * Claims additional bytes from a string fragment against the budget.
   *
   * Fails closed with `payload_too_large` if the added bytes would cause the
   * cumulative total to exceed the configured maximum limit.
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
