import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type StartupError, startupError } from "./errors.js";

/**
 * Executes the fail-closed filesystem startup probe on the configured trace root directory.
 *
 * Probe workflow:
 * 1. Creates directory path recursively and enforces strict owner-only `0700` permissions (`rwx------`).
 * 2. Verifies that the trace root is a directory and not group/world accessible.
 * 3. Atomically opens an unpredictable probe file with exclusive creation (`O_CREAT | O_EXCL`) and owner-only `0600` permissions.
 * 4. Writes test payload and invokes `fsync()` to confirm storage writeability.
 * 5. Closes and unlinks the probe file so no temporary probe files remain.
 *
 * @param root - Path to the candidate trace root directory.
 * @returns `null` if the probe succeeds; otherwise a `CONFIG_TRACE_PROBE` {@link StartupError}.
 */
export async function probeTraceRoot(root: string): Promise<StartupError | null> {
  const probeFile = join(root, `.aptus-startup-probe-${randomUUID()}`);
  try {
    // Ensure trace directory exists with strict 0700 permissions.
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      throw new Error("root path is not a directory");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("root directory permissions are not owner-only");
    }
    // Create probe file exclusively with strict 0600 permissions.
    const handle = await open(probeFile, "wx", 0o600);
    try {
      await handle.writeFile("aptus trace probe\n");
      // Force write to disk to ensure directory is truly writeable.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Clean up temporary probe file.
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
