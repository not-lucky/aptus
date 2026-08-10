import type { NormalizedFailure } from "../domain/operations.ts";
import { invalidRequestFailure } from "./failures.ts";

/** A decoded SSE field block without protocol semantics. */
export interface SseFrame {
  /** Optional named event; absent for data-only Chat events. */
  readonly event?: string;
  /** Ordered concatenated data lines separated by `\n`. */
  readonly data: string;
  /** Optional event ID retained only when the target protocol defines it. */
  readonly id?: string;
  /** Optional reconnection delay in milliseconds. */
  readonly retryMs?: number;
}

/** Incremental result from a strict UTF-8 SSE parser. */
export type SseDecodeResult =
  | { readonly kind: "frame"; readonly frame: SseFrame }
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "need_more" }
  | { readonly kind: "failure"; readonly failure: NormalizedFailure };

/** Owns incremental SSE framing, not protocol semantics. */
export interface SseDecoder {
  /** Accepts one received byte segment.
   * @param bytes Next exact upstream bytes.
   * @returns Zero or more ordered frames/comments, or one terminal parse failure.
   * @remarks It preserves frame order and buffers at most the configured event limit.
   */
  push(bytes: Uint8Array): readonly SseDecodeResult[];
  /** Finishes at EOF.
   * @returns Remaining frames or an incomplete-frame failure.
   */
  finish(): readonly SseDecodeResult[];
}

/** Encodes one complete target SSE frame. */
export interface SseEncoder {
  /** Serializes one target frame.
   * @param frame Frame with target-protocol fields.
   * @returns UTF-8 SSE bytes ending in one blank line.
   */
  encode(frame: SseFrame): Uint8Array;
}

/** One-owner state after response headers. */
export type ResponseOwnership =
  | { readonly kind: "unowned" }
  | { readonly kind: "owned"; readonly attemptNumber: number; readonly status: number }
  | { readonly kind: "closed"; readonly reason: "complete" | "failed" | "cancelled" };

/** Options for creating an incremental SSE decoder. */
export interface SseDecoderOptions {
  /** Maximum allowable raw bytes per in-progress SSE event block (default 64 KB). */
  readonly maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

/**
 * Strict incremental UTF-8 SSE decoder implementing closed-world field parsing.
 */
class StrictSseDecoder implements SseDecoder {
  private readonly maxEventBytes: number;
  private readonly textDecoder: InstanceType<typeof TextDecoder>;
  private isFirstChunk = true;
  private textBuffer = "";
  private rawBytesInCurrentEvent = 0;
  private failed = false;
  private terminalFailure: NormalizedFailure | undefined;

  // In-progress event fields
  private dataLines: string[] = [];
  private currentEvent: string | undefined;
  private currentId: string | undefined;
  private currentRetry: number | undefined;

  constructor(options?: SseDecoderOptions) {
    this.maxEventBytes = options?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.textDecoder = new TextDecoder("utf-8", { fatal: true });
  }

  private fail(failure: NormalizedFailure): readonly SseDecodeResult[] {
    this.failed = true;
    this.terminalFailure = failure;
    return [{ kind: "failure", failure }];
  }

  push(bytes: Uint8Array): readonly SseDecodeResult[] {
    if (this.failed) {
      return [
        {
          kind: "failure",
          failure: this.terminalFailure ?? invalidRequestFailure("SSE decoder in failed state"),
        },
      ];
    }

    if (bytes.length === 0) {
      return [{ kind: "need_more" }];
    }

    this.rawBytesInCurrentEvent += bytes.length;
    if (this.rawBytesInCurrentEvent > this.maxEventBytes) {
      return this.fail(invalidRequestFailure(`SSE event buffer exceeded maximum limit of ${this.maxEventBytes} bytes`));
    }

    let chunkText: string;
    try {
      chunkText = this.textDecoder.decode(bytes, { stream: true });
    } catch (err) {
      return this.fail(
        invalidRequestFailure(
          `Malformed UTF-8 sequence in SSE stream: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    if (this.isFirstChunk) {
      this.isFirstChunk = false;
      // Strip optional leading UTF-8 BOM
      if (chunkText.startsWith("\uFEFF")) {
        chunkText = chunkText.slice(1);
      }
    }

    this.textBuffer += chunkText;
    return this.processBuffer();
  }

  private processBuffer(): readonly SseDecodeResult[] {
    const results: SseDecodeResult[] = [];

    while (true) {
      // Find line delimiter (\r\n, \r, or \n)
      const newlineIndex = this.textBuffer.indexOf("\n");
      const crIndex = this.textBuffer.indexOf("\r");

      let lineEnd = -1;
      let delimiterLength = 1;

      if (newlineIndex !== -1 && (crIndex === -1 || newlineIndex < crIndex)) {
        // Plain LF
        lineEnd = newlineIndex;
        delimiterLength = 1;
      } else if (crIndex !== -1 && (newlineIndex === -1 || crIndex < newlineIndex)) {
        // CR or CRLF
        if (crIndex + 1 < this.textBuffer.length) {
          if (this.textBuffer[crIndex + 1] === "\n") {
            // CRLF
            lineEnd = crIndex;
            delimiterLength = 2;
          } else {
            // Standalone CR
            lineEnd = crIndex;
            delimiterLength = 1;
          }
        } else {
          // CR is at the very end of current buffer - wait for possible \n in next chunk
          break;
        }
      } else {
        // No complete line found
        break;
      }

      const rawLine = this.textBuffer.slice(0, lineEnd);
      this.textBuffer = this.textBuffer.slice(lineEnd + delimiterLength);

      // Blank line: dispatch in-progress event block
      if (rawLine === "") {
        if (this.dataLines.length > 0) {
          const frame: SseFrame = {
            ...(this.currentEvent !== undefined ? { event: this.currentEvent } : {}),
            data: this.dataLines.join("\n"),
            ...(this.currentId !== undefined ? { id: this.currentId } : {}),
            ...(this.currentRetry !== undefined ? { retryMs: this.currentRetry } : {}),
          };
          results.push({ kind: "frame", frame });
        }
        // Reset event state and raw byte counter for next event
        this.dataLines = [];
        this.currentEvent = undefined;
        this.currentId = undefined;
        this.currentRetry = undefined;
        this.rawBytesInCurrentEvent = this.textBuffer.length;
        continue;
      }

      // Comment line
      if (rawLine.startsWith(":")) {
        const text = rawLine.slice(1).startsWith(" ") ? rawLine.slice(2) : rawLine.slice(1);
        results.push({ kind: "comment", text });
        continue;
      }

      // Field line
      const colonIndex = rawLine.indexOf(":");
      let fieldName: string;
      let fieldValue: string;

      if (colonIndex === -1) {
        fieldName = rawLine;
        fieldValue = "";
      } else {
        fieldName = rawLine.slice(0, colonIndex);
        fieldValue = rawLine.slice(colonIndex + 1);
        if (fieldValue.startsWith(" ")) {
          fieldValue = fieldValue.slice(1);
        }
      }

      if (fieldName === "data") {
        this.dataLines.push(fieldValue);
      } else if (fieldName === "event") {
        if (this.currentEvent !== undefined) {
          return this.fail(invalidRequestFailure("Duplicate singleton 'event' field in SSE block"));
        }
        this.currentEvent = fieldValue;
      } else if (fieldName === "id") {
        if (this.currentId !== undefined) {
          return this.fail(invalidRequestFailure("Duplicate singleton 'id' field in SSE block"));
        }
        if (fieldValue.includes("\0")) {
          return this.fail(invalidRequestFailure("SSE 'id' field must not contain NUL characters"));
        }
        this.currentId = fieldValue;
      } else if (fieldName === "retry") {
        if (this.currentRetry !== undefined) {
          return this.fail(invalidRequestFailure("Duplicate singleton 'retry' field in SSE block"));
        }
        if (!/^[0-9]+$/.test(fieldValue)) {
          return this.fail(invalidRequestFailure(`Invalid non-integer SSE 'retry' field: '${fieldValue}'`));
        }
        const retryNum = Number(fieldValue);
        if (!Number.isSafeInteger(retryNum) || retryNum < 0) {
          return this.fail(invalidRequestFailure(`SSE 'retry' field out of bounds: '${fieldValue}'`));
        }
        this.currentRetry = retryNum;
      } else {
        return this.fail(invalidRequestFailure(`Unknown SSE field name '${fieldName}'`));
      }
    }

    if (results.length === 0) {
      results.push({ kind: "need_more" });
    }
    return results;
  }

  finish(): readonly SseDecodeResult[] {
    if (this.failed) {
      return [
        {
          kind: "failure",
          failure: this.terminalFailure ?? invalidRequestFailure("SSE decoder in failed state"),
        },
      ];
    }

    // Flush any pending bytes from the TextDecoder
    try {
      const remainingDecoded = this.textDecoder.decode(new Uint8Array(0), { stream: false });
      this.textBuffer += remainingDecoded;
    } catch (err) {
      return this.fail(
        invalidRequestFailure(`Incomplete UTF-8 sequence at EOF: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // If there is any unparsed line or unclosed event block at EOF
    if (
      this.textBuffer.length > 0 ||
      this.dataLines.length > 0 ||
      this.currentEvent !== undefined ||
      this.currentId !== undefined ||
      this.currentRetry !== undefined
    ) {
      return this.fail({
        category: "stream_interrupted",
        message: "SSE stream ended unexpectedly with an incomplete line or unclosed event block",
        retryable: false,
      });
    }

    return [];
  }
}

/**
 * Standard SSE frame serializer creating UTF-8 canonical wire representations.
 */
class CanonicalSseEncoder implements SseEncoder {
  private readonly textEncoder = new TextEncoder();

  encode(frame: SseFrame): Uint8Array {
    let out = "";
    if (frame.event !== undefined) {
      out += `event: ${frame.event}\n`;
    }
    if (frame.id !== undefined) {
      out += `id: ${frame.id}\n`;
    }
    if (frame.retryMs !== undefined) {
      out += `retry: ${frame.retryMs}\n`;
    }
    const lines = frame.data.split("\n");
    for (const line of lines) {
      out += `data: ${line}\n`;
    }
    out += "\n";
    return this.textEncoder.encode(out);
  }
}

/**
 * Creates a new incremental SSE decoder.
 */
export function createSseDecoder(options?: SseDecoderOptions): SseDecoder {
  return new StrictSseDecoder(options);
}

/**
 * Creates a canonical SSE frame encoder.
 */
export function createSseEncoder(): SseEncoder {
  return new CanonicalSseEncoder();
}
