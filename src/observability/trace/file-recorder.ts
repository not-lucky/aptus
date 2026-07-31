import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, TraceByteSink, TraceContext, TraceRecorder, TraceSession } from "../../domain/contracts.ts";
import type { TraceManifest, TraceStage, TraceTerminal } from "../../domain/operations.ts";
import { createRedactor, type Redactor } from "./redaction.ts";

const encoder = new TextEncoder();

/**
 * Bounded safe error codes for trace degradation telemetry.
 */
export type SafeErrorCode = "permission_denied" | "no_space" | "not_found" | "io_error";

/**
 * Initialization options for the filesystem-backed {@link TraceRecorder}.
 */
export interface FileTraceRecorderOptions {
  /** Filesystem root directory under which per-request directories are created. */
  readonly root: string;
  /** Resolved client and provider secrets to redact from parsed trace fields. */
  readonly secrets: ReadonlySet<string>;
  /**
   * Invoked on every runtime trace write failure with the affected request ID
   * (`undefined` for the startup/manifest bootstrap). It must record the
   * `aptus.trace.failure` event and increment the failure counter; it is not
   * edge-triggered.
   */
  readonly onFailure: (operation: string, safeErrorCode: SafeErrorCode, aptusRequestId?: string) => void;
  /** Edge-triggered readiness degradation (invoked once until recovery). */
  readonly onDegrade: () => void;
  /** Edge-triggered readiness recovery (invoked once after a successful write). */
  readonly onRecover: () => void;
}

/**
 * A serial trace session plus the internal manifest bootstrap step.
 */
type FileTraceSession = TraceSession & { readonly writeManifest: () => Promise<void> };

/**
 * Creates the protected filesystem {@link TraceRecorder}.
 *
 * Per-request directories are created with mode `0700` and every file with mode
 * `0600`. Each stage is written atomically (create temp → write → fsync → close
 * → rename → directory fsync). A runtime write failure never fails traffic: it
 * records a best-effort `trace_failure` stage and an `incomplete` terminal,
 * invokes `onFailure`, and swallows the error. A later successful write invokes
 * `onRecover` to restore readiness.
 *
 * @param options - Recorder configuration and degradation hooks.
 * @returns A filesystem-backed {@link TraceRecorder}.
 */
export function createFileTraceRecorder(options: FileTraceRecorderOptions): TraceRecorder {
  const redactor = createRedactor(options.secrets);
  let degraded = false;

  // Every failure emits per-failure telemetry; readiness transitions are
  // edge-triggered separately (degrade once, recover once).
  const fail = (operation: string, code: SafeErrorCode, aptusRequestId?: string): void => {
    if (!degraded) {
      degraded = true;
      options.onDegrade();
    }
    options.onFailure(operation, code, aptusRequestId);
  };
  const succeed = (): void => {
    if (degraded) {
      degraded = false;
      options.onRecover();
    }
  };

  return {
    async start(context: TraceContext): Promise<TraceSession> {
      const directory = join(options.root, `${context.startedAtLocal}_${context.aptusRequestId}`);
      const session = makeSession(directory, context, redactor, fail, succeed);
      try {
        await session.writeManifest();
      } catch (err) {
        fail("trace_start", safeErrorCode(err), context.aptusRequestId);
      }
      return session;
    },
  };
}

/**
 * Constructs one serial trace session bound to a request directory.
 */
function makeSession(
  directory: string,
  context: TraceContext,
  redactor: Redactor,
  onFailure: (operation: string, code: SafeErrorCode, aptusRequestId?: string) => void,
  onSuccess: () => void,
): FileTraceSession {
  let sequence = 1;
  let finished = false;
  let incompleteWritten = false;
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = queue.then(op, op);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Commits one file atomically. On failure, degrades readiness and writes a
   * best-effort `trace_failure` + `incomplete` terminal exactly once.
   */
  async function commit(filename: string, data: Uint8Array, operation: string): Promise<void> {
    try {
      await atomicWrite(directory, filename, data);
      onSuccess();
    } catch (error) {
      onFailure(operation, safeErrorCode(error), context.aptusRequestId);
      await writeIncompleteOnce();
    }
  }

  /**
   * Best-effort terminal marker written after any trace write failure. Marking
   * the session finished prevents any further stage writes.
   */
  async function writeIncompleteOnce(): Promise<void> {
    if (incompleteWritten) return;
    incompleteWritten = true;
    finished = true;
    try {
      await atomicWrite(
        directory,
        `${pad(sequence)}_trace_failure.json`,
        encoder.encode(`${JSON.stringify({ operation: "trace_write" })}\n`),
      );
      sequence++;
    } catch {
      // The directory may be unwritable or absent; the absent terminal already marks the trace incomplete.
    }
    try {
      await atomicWrite(
        directory,
        "999_terminal.json",
        encoder.encode(
          `${JSON.stringify({ kind: "incomplete", reason: "trace_write_failed" } satisfies TraceTerminal)}\n`,
        ),
      );
    } catch {
      // Nothing further can be recorded.
    }
  }

  async function writeManifest(): Promise<void> {
    return enqueue(async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(directory, 0o700);
      } catch (error) {
        onFailure("trace_start", safeErrorCode(error), context.aptusRequestId);
        await writeIncompleteOnce();
        return;
      }
      const manifest: TraceManifest = {
        schemaVersion: 1,
        aptusRequestId: context.aptusRequestId,
        startedAt: new Date().toISOString(),
        sourceProtocol: context.sourceProtocol,
        configRevision: context.configRevision,
        redaction: "credentials-and-resolved-secrets",
        payloadProtection: "filesystem-permissions-only",
      };
      await commit("000_manifest.json", encoder.encode(`${JSON.stringify(manifest)}\n`), "trace_write");
    });
  }

  return {
    writeManifest,

    recordJson(stage: TraceStage, value: JsonValue): Promise<void> {
      return enqueue(async () => {
        if (finished) return;
        const filename = `${pad(sequence)}_${stage}.json`;
        sequence++;
        const redacted = redactor.redactJson(value);
        await commit(filename, encoder.encode(`${JSON.stringify(redacted)}\n`), "trace_write");
      });
    },

    recordBytes(stage: TraceStage, bytes: Uint8Array): Promise<void> {
      return enqueue(async () => {
        if (finished) return;
        const filename = `${pad(sequence)}_${stage}.${bytesExtension(stage)}`;
        sequence++;
        await commit(filename, bytes, "trace_write");
      });
    },

    openBytes(stage: TraceStage): TraceByteSink {
      if (finished) {
        return {
          append: async () => {},
          complete: async () => {},
          discard: async () => {},
        };
      }
      const seq = sequence++;
      const tempPath = join(directory, `.aptus-${randomUUID()}.tmp`);
      let handlePromise: Promise<import("node:fs/promises").FileHandle> | undefined;
      let closed = false;

      async function getHandle() {
        if (handlePromise === undefined) {
          handlePromise = (async () => {
            await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
            return open(tempPath, "wx", 0o600);
          })();
        }
        return handlePromise;
      }

      return {
        append(chunk: Uint8Array): Promise<void> {
          return enqueue(async () => {
            if (closed || finished) return;
            try {
              const handle = await getHandle();
              await handle.writeFile(chunk);
            } catch (err) {
              onFailure("trace_write", safeErrorCode(err), context.aptusRequestId);
              await writeIncompleteOnce();
            }
          });
        },

        complete(): Promise<void> {
          return enqueue(async () => {
            if (closed) return;
            closed = true;
            if (finished) {
              await unlink(tempPath).catch(() => undefined);
              return;
            }
            try {
              if (handlePromise !== undefined) {
                const handle = await handlePromise;
                await handle.sync();
                await handle.close();
                const filename = `${pad(seq)}_${stage}.${bytesExtension(stage)}`;
                await rename(tempPath, join(directory, filename));
                await fsyncDirectory(directory);
                onSuccess();
              }
            } catch (err) {
              await unlink(tempPath).catch(() => undefined);
              onFailure("trace_write", safeErrorCode(err), context.aptusRequestId);
              await writeIncompleteOnce();
            }
          });
        },

        discard(): Promise<void> {
          return enqueue(async () => {
            if (closed) return;
            closed = true;
            try {
              if (handlePromise !== undefined) {
                const handle = await handlePromise;
                await handle.close().catch(() => undefined);
                await unlink(tempPath).catch(() => undefined);
              }
            } catch {
              // Ignore discard errors
            }
          });
        },
      };
    },

    finish(result: TraceTerminal): Promise<void> {
      return enqueue(async () => {
        if (finished) return;
        finished = true;
        const redacted = redactor.redactJson(result as unknown as JsonValue);
        await commit("999_terminal.json", encoder.encode(`${JSON.stringify(redacted)}\n`), "trace_finish");
      });
    },
  };
}

/**
 * Writes a file atomically: temp file → write → fsync → close → rename → dir fsync.
 */
async function atomicWrite(directory: string, filename: string, data: Uint8Array): Promise<void> {
  const temp = join(directory, `.aptus-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(directory, filename));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(directory);
}

/**
 * Best-effort directory fsync; some platforms do not support opening a dir for fsync.
 */
async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on this platform; the rename is still atomic.
  }
}

/**
 * Maps a raw-bytes trace stage to its file extension.
 */
function bytesExtension(stage: TraceStage): string {
  if (stage === "provider_stream" || stage === "client_stream") return "sse";
  if (stage === "ir_events") return "jsonl";
  return "bin";
}

/**
 * Pads a sequence number to a three-digit file prefix.
 */
function pad(sequence: number): string {
  return String(sequence).padStart(3, "0");
}

/**
 * Extracts a safe, bounded error code for degradation logging (never a raw
 * path or secret-bearing message).
 */
export function safeErrorCode(error: unknown): SafeErrorCode {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EACCES" || code === "EPERM") return "permission_denied";
    if (code === "ENOSPC" || code === "EDQUOT") return "no_space";
    if (code === "ENOENT") return "not_found";
  }
  return "io_error";
}
