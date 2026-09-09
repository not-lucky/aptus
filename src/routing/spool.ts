/**
 * @fileoverview Bounded response body buffering with memory and temporary file storage.
 *
 * Non-streaming translated and native responses require full body buffering before
 * parsing or relaying. To prevent large upstream payloads from exhausting process RAM,
 * responses below {@link MEMORY_THRESHOLD_BYTES} are held in memory, while larger payloads
 * automatically spill to a private temporary file on disk.
 *
 * Implements the {@link OwnedBody} lifecycle contract: callers take ownership of the
 * returned body and must call `dispose()` when processing completes to clean up disk files.
 */

import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedBody } from "../domain/contracts.ts";

/**
 * In-memory threshold in bytes (64 KiB) below which responses stay in RAM.
 * Responses exceeding this threshold transition to a temporary disk spool file.
 */
const MEMORY_THRESHOLD_BYTES = 64 * 1024;

/**
 * Creates an {@link OwnedBody} backed entirely by an in-memory byte buffer.
 *
 * Used when the entire response payload is already buffered in memory. The returned
 * body holds a reference to `data` and does not allocate disk resources.
 *
 * @param data - Full response byte buffer. Callers must treat this array as read-only.
 * @returns An {@link OwnedBody} instance serving reads directly from RAM.
 */
export function createOwnedMemoryBody(data: Uint8Array): OwnedBody {
  return {
    /**
     * In-memory byte buffer backing this body, available for direct synchronous access.
     */
    inMemoryBytes: data,

    /**
     * Returns a readable stream that yields the memory buffer once and closes.
     * Safe for multiple calls, each yielding an independent stream over the buffer.
     */
    stream(): ReadableStream<Uint8Array> {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(data);
          }
          controller.close();
        },
      });
    },

    /**
     * Resolves with the backing byte buffer without copying or asynchronous I/O.
     */
    async bytes(): Promise<Uint8Array> {
      return data;
    },

    /**
     * Releases resources. A safe no-op for in-memory bodies since no disk files are held.
     */
    async dispose(): Promise<void> {
      // In-memory body has no disk resources to release
    },
  };
}

/**
 * Drains a provider byte stream into an {@link OwnedBody}, buffering small bodies in memory
 * and spilling larger bodies to a private temporary file.
 *
 * Accumulates incoming chunks in RAM until the stream finishes or exceeds
 * {@link MEMORY_THRESHOLD_BYTES}. If the threshold is crossed, existing and subsequent
 * chunks are written to a temporary file created in the OS temp directory with 0600 permissions.
 *
 * The caller assumes ownership of the returned body and must call `dispose()` to clean up
 * temporary files. If spooling or stream reading fails, any partially written file is deleted
 * before rethrowing.
 *
 * @param stream - Backpressured byte stream from the upstream provider response.
 * @returns An {@link OwnedBody} backed by RAM or a temporary spool file.
 * @throws Stream read or filesystem errors encountered while draining or writing to disk.
 */
export async function spoolResponseBody(stream: ReadableStream<Uint8Array>): Promise<OwnedBody> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let spoolPath: string | undefined;
  let fileHandle: import("node:fs/promises").FileHandle | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;

      totalBytes += value.length;

      if (fileHandle === undefined && totalBytes > MEMORY_THRESHOLD_BYTES) {
        // Transition to disk spool: payload exceeded 64 KiB threshold
        spoolPath = join(tmpdir(), `.aptus-body-${randomUUID()}.tmp`);
        fileHandle = await open(spoolPath, "wx", 0o600);
        for (const chunk of chunks) {
          await fileHandle.writeFile(chunk);
        }
        chunks.length = 0; // Release memory buffer now that bytes are persisted to disk
        await fileHandle.writeFile(value);
      } else if (fileHandle !== undefined) {
        await fileHandle.writeFile(value);
      } else {
        chunks.push(value);
      }
    }

    if (fileHandle !== undefined) {
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;

      const path = spoolPath as string;
      let disposed = false;

      return {
        /**
         * Streams the spooled body from the temporary file in 64 KiB chunks.
         * Opens an independent read handle and tracks read position internally.
         */
        stream(): ReadableStream<Uint8Array> {
          let handle: import("node:fs/promises").FileHandle | undefined;
          let position = 0;

          return new ReadableStream<Uint8Array>({
            async start() {
              handle = await open(path, "r");
            },
            async pull(controller) {
              if (handle === undefined) {
                controller.close();
                return;
              }
              const buffer = new Uint8Array(64 * 1024);
              const readResult = await handle.read(buffer, 0, buffer.length, position);
              if (readResult.bytesRead === 0) {
                await handle.close().catch(() => undefined);
                handle = undefined;
                controller.close();
                return;
              }
              position += readResult.bytesRead;
              controller.enqueue(buffer.subarray(0, readResult.bytesRead));
            },
            async cancel() {
              if (handle !== undefined) {
                await handle.close().catch(() => undefined);
                handle = undefined;
              }
            },
          });
        },

        /**
         * Reads and returns the complete spooled payload from the temporary file on disk.
         *
         * @throws Filesystem errors if opening or reading the spool file fails.
         */
        async bytes(): Promise<Uint8Array> {
          const handle = await open(path, "r");
          try {
            const stat = await handle.stat();
            const buffer = new Uint8Array(stat.size);
            await handle.read(buffer, 0, stat.size, 0);
            return buffer;
          } finally {
            await handle.close();
          }
        },

        /**
         * Idempotently deletes the temporary spool file from disk.
         * Subsequent calls are safe no-ops.
         */
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          await unlink(path).catch(() => undefined);
        },
      };
    }

    // Payload stayed within threshold; return in-memory body
    const fullBytes = new Uint8Array(Buffer.concat(chunks as unknown as Buffer[], totalBytes));
    return createOwnedMemoryBody(fullBytes);
  } catch (error) {
    if (fileHandle !== undefined) {
      await fileHandle.close().catch(() => undefined);
    }
    if (spoolPath !== undefined) {
      await unlink(spoolPath).catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
