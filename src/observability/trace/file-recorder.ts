import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, TraceContext, TraceRecorder, TraceSession } from "../../domain/contracts.js";
import type { TraceManifest, TraceStage, TraceTerminal } from "../../domain/operations.js";
import { createRedactor, type Redactor } from "./redaction.js";

const encoder = new TextEncoder();

/**
 * Initialization options for the filesystem-backed {@link TraceRecorder}.
 */
export interface FileTraceRecorderOptions {
  /** Filesystem root directory under which per-request directories are created. */
  readonly root: string;
  /** Resolved client and provider secrets to redact from parsed trace fields. */
  readonly secrets: ReadonlySet<string>;
  /** Invoked when a runtime trace write fails (readiness degradation). */
  readonly onFailure: (safeErrorCode: string) => void;
  /** Invoked when a later trace write succeeds (readiness recovery). */
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

  // Idempotent, recorder-wide readiness transitions (span individual sessions).
  const onFailure = (safeErrorCode: string): void => {
    if (degraded) return;
    degraded = true;
    options.onFailure(safeErrorCode);
  };
  const onSuccess = (): void => {
    if (!degraded) return;
    degraded = false;
    options.onRecover();
  };

  return {
    async start(context: TraceContext): Promise<TraceSession> {
      const directory = join(options.root, `${context.startedAtLocal}_${context.aptusRequestId}`);
      const session = makeSession(directory, context, redactor, onFailure, onSuccess);
      await session.writeManifest();
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
  onFailure: (safeErrorCode: string) => void,
  onSuccess: () => void,
): FileTraceSession {
  let sequence = 1;
  let finished = false;
  let incompleteWritten = false;

  /**
   * Commits one file atomically. On failure, degrades readiness and writes a
   * best-effort `trace_failure` + `incomplete` terminal exactly once.
   */
  async function commit(filename: string, data: Uint8Array): Promise<void> {
    try {
      await atomicWrite(directory, filename, data);
      onSuccess();
    } catch (error) {
      onFailure(safeErrorCode(error));
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
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(directory, 0o700);
    } catch (error) {
      onFailure(safeErrorCode(error));
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
    await commit("000_manifest.json", encoder.encode(`${JSON.stringify(manifest)}\n`));
  }

  return {
    writeManifest,

    async recordJson(stage: TraceStage, value: JsonValue): Promise<void> {
      if (finished) return;
      const filename = `${pad(sequence)}_${stage}.json`;
      sequence++;
      await commit(filename, encoder.encode(`${JSON.stringify(redactor.redactJson(value))}\n`));
    },

    async recordBytes(stage: TraceStage, bytes: Uint8Array): Promise<void> {
      if (finished) return;
      const filename = `${pad(sequence)}_${stage}.${bytesExtension(stage)}`;
      sequence++;
      await commit(filename, bytes);
    },

    async finish(result: TraceTerminal): Promise<void> {
      if (finished) return;
      finished = true;
      await commit("999_terminal.json", encoder.encode(`${JSON.stringify(result)}\n`));
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
function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "io_error";
}
