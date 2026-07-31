import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedBody } from "../domain/contracts.ts";

/**
 * In-memory threshold in bytes (64 KiB) below which responses stay in RAM.
 */
const MEMORY_THRESHOLD_BYTES = 64 * 1024;

/**
 * Creates an {@link OwnedBody} backed entirely by an in-memory byte buffer.
 *
 * @param data - The complete response byte buffer.
 * @returns An {@link OwnedBody} instance.
 */
export function createOwnedMemoryBody(data: Uint8Array): OwnedBody {
  return {
    inMemoryBytes: data,
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
    async bytes(): Promise<Uint8Array> {
      return data;
    },
    async dispose(): Promise<void> {
      // In-memory body has no disk resources to release
    },
  };
}

/**
 * Spools a stream of chunks into an {@link OwnedBody}.
 * If total bytes remain under {@link MEMORY_THRESHOLD_BYTES}, retains in RAM;
 * otherwise streams to a private temporary file and cleans up on `dispose()`.
 *
 * @param stream - Incoming backpressured byte stream.
 * @returns A promise resolving to an {@link OwnedBody}.
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
        // Transition to disk spool
        spoolPath = join(tmpdir(), `.aptus-body-${randomUUID()}.tmp`);
        fileHandle = await open(spoolPath, "wx", 0o600);
        for (const chunk of chunks) {
          await fileHandle.writeFile(chunk);
        }
        chunks.length = 0; // Clear memory buffer
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
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          await unlink(path).catch(() => undefined);
        },
      };
    }

    // In-memory body
    const fullBytes = concatChunks(chunks, totalBytes);
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

/**
 * Concatenates an array of byte chunks into a single Uint8Array.
 */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
