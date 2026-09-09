/**
 * @fileoverview Fail-closed filesystem probe for the trace storage root in the Aptus gateway.
 *
 * Verifies that the configured trace root directory exists, enforces owner-only permissions
 * (POSIX 0700), and confirms write and sync capabilities by executing a probe write-sync-delete
 * cycle before gateway listeners bind.
 *
 * Failing the probe returns a `CONFIG_TRACE_PROBE` startup error, preventing the gateway from
 * admitting traffic it cannot reliably trace.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type StartupError, startupError } from "./errors.ts";

/**
 * Verifies that the configured trace root directory exists, is private, and accepts writes.
 *
 * Recursively creates the directory if missing, enforces owner-only POSIX permissions,
 * performs an exclusive probe file write and sync, and cleans up the temporary probe file.
 *
 * @param root - Path to the candidate trace root directory.
 * @returns A promise resolving to `null` on success, or a `CONFIG_TRACE_PROBE` {@link StartupError} on failure.
 */
export async function probeTraceRoot(root: string): Promise<StartupError | null> {
  const probeFile = join(root, `.aptus-startup-probe-${randomUUID()}`);
  try {
    // Create missing parents with strict permissions so the directory is private from the first byte.
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      throw new Error("root path is not a directory");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("root directory permissions are not owner-only");
    }
    // Open the probe file with exclusive creation so an existing file can never be overwritten silently.
    const handle = await open(probeFile, "wx", 0o600);
    try {
      await handle.writeFile("aptus trace probe\n");
      // Synchronize the payload to storage so a write cache cannot hide a read-only mount.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Delete the probe file so successful startup leaves no temporary file behind.
    await unlink(probeFile);
    return null;
  } catch (err) {
    const candidate = err as { code?: unknown; message?: string };
    return startupError(
      "CONFIG_TRACE_PROBE",
      "/tracing/root",
      `trace startup probe failed: ${candidate.code !== undefined ? String(candidate.code) : (candidate.message ?? String(err))}`,
    );
  }
}
