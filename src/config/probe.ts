import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type StartupError, startupError } from "./errors.js";

/**
 * Startup probe for the Trace root: create it with owner-only permissions,
 * then create, write, fsync, close, and delete a probe file inside it. Any
 * filesystem failure is a bounded startup error; no probe file remains on
 * success.
 */
export async function probeTraceRoot(root: string): Promise<StartupError | null> {
  const probeFile = join(root, `.aptus-startup-probe-${process.pid}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const handle = await open(probeFile, "w", 0o600);
    try {
      await handle.writeFile("aptus trace probe\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
