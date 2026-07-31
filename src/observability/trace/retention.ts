import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RetentionResult, TraceRetention, TraceTerminal } from "../../domain/operations.ts";

/**
 * Anchored regex matching canonical trace directory names:
 * `YYYY-MM-DDTHH-mm-ss.SSS±HHMM_<UUID-v4>`
 */
const TRACE_DIR_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})([+-])(\d{2})(\d{2})_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * Options for constructing {@link TraceRetention}.
 */
export interface TraceRetentionOptions {
  /** Root directory containing request trace subdirectories. */
  readonly root: string;
  /** Maximum retention age in milliseconds before deletion. */
  readonly maxAgeMs: number;
  /** Maximum total disk space in bytes for completed traces. */
  readonly maxBytes: number;
  /** Optional callback invoked when a completed directory is deleted. */
  readonly onDeleted?: (reason: "age" | "size") => void;
}

/**
 * Internal metadata for an evaluated candidate directory.
 */
interface DirectoryCandidate {
  readonly name: string;
  readonly fullPath: string;
  readonly timestampMs: number;
  readonly totalBytes: number;
  readonly isCompleted: boolean;
}

/**
 * Creates the filesystem trace retention scanner and cleanup executor.
 *
 * @param options - Storage root, age/size limits, and metrics callback.
 * @returns A {@link TraceRetention} instance.
 */
export function createTraceRetention(options: TraceRetentionOptions): TraceRetention {
  const { root, maxAgeMs, maxBytes, onDeleted } = options;

  return {
    async run(nowMs: number): Promise<RetentionResult> {
      // 1. Verify root directory without following symlinks.
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Trace retention root is not a real directory: ${root}`);
      }

      // 2. Read direct children of root.
      const entries = await readdir(root, { withFileTypes: true });

      const completedCandidates: DirectoryCandidate[] = [];
      let incompleteBytes = 0;
      let skippedCount = 0;

      for (const entry of entries) {
        // Skip non-directories, symlinks, hidden files/dirs, and malformed directory names.
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) {
          continue;
        }

        const match = TRACE_DIR_REGEX.exec(entry.name);
        if (match === null) {
          continue;
        }

        const fullPath = join(root, entry.name);
        const dirStat = await lstat(fullPath);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
          continue;
        }

        const timestampMs = parseDirectoryTimestamp(match);
        if (Number.isNaN(timestampMs)) {
          continue;
        }

        // Recursively inspect the directory for total file bytes, staging files, and terminal.
        const inspection = await inspectDirectory(fullPath);

        if (inspection.isCompleted) {
          completedCandidates.push({
            name: entry.name,
            fullPath,
            timestampMs,
            totalBytes: inspection.totalBytes,
            isCompleted: true,
          });
        } else {
          incompleteBytes += inspection.totalBytes;
          skippedCount++;
        }
      }

      // 3. Sort completed candidates deterministically by parsed timestamp ascending, then directory name ascending.
      completedCandidates.sort((a, b) => {
        if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
        return a.name.localeCompare(b.name);
      });

      let deletedForAge = 0;
      let deletedForSize = 0;
      const survivingCompleted: DirectoryCandidate[] = [];

      // 4. Age-based eviction: delete completed traces older than maxAgeMs.
      for (const candidate of completedCandidates) {
        const ageMs = nowMs - candidate.timestampMs;
        if (ageMs > maxAgeMs) {
          const deleted = await deleteIfStillCompleted(candidate.fullPath);
          if (deleted) {
            deletedForAge++;
            onDeleted?.("age");
          } else {
            // Became incomplete or invalid; update accounting.
            const reinspection = await inspectDirectory(candidate.fullPath).catch(() => ({
              totalBytes: 0,
              isCompleted: false,
            }));
            incompleteBytes += reinspection.totalBytes;
            skippedCount++;
          }
        } else {
          survivingCompleted.push(candidate);
        }
      }

      // 5. Size-based eviction: delete oldest completed traces until remaining completed bytes <= maxBytes.
      let remainingBytes = survivingCompleted.reduce((sum, c) => sum + c.totalBytes, 0);

      while (remainingBytes > maxBytes && survivingCompleted.length > 0) {
        const oldest = survivingCompleted.shift();
        if (oldest === undefined) break;

        const deleted = await deleteIfStillCompleted(oldest.fullPath);
        if (deleted) {
          deletedForSize++;
          remainingBytes -= oldest.totalBytes;
          onDeleted?.("size");
        } else {
          const reinspection = await inspectDirectory(oldest.fullPath).catch(() => ({
            totalBytes: 0,
            isCompleted: false,
          }));
          incompleteBytes += reinspection.totalBytes;
          skippedCount++;
        }
      }

      return {
        deletedForAge,
        deletedForSize,
        skipped: skippedCount,
        remainingBytes,
        incompleteBytes,
      };
    },
  };
}

/**
 * Inspects a directory to count regular file bytes and determine if it has a valid completed terminal.
 */
async function inspectDirectory(dirPath: string): Promise<{ totalBytes: number; isCompleted: boolean }> {
  let totalBytes = 0;
  let hasStaging = false;
  let terminalContent: string | undefined;

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await lstat(full);
        if (!stat.isSymbolicLink()) {
          totalBytes += stat.size;
          if (entry.name.startsWith(".aptus-") || entry.name.endsWith(".tmp")) {
            hasStaging = true;
          }
          if (entry.name === "999_terminal.json" && currentPath === dirPath) {
            terminalContent = await readFile(full, "utf8").catch(() => undefined);
          }
        }
      }
    }
  }

  await walk(dirPath);

  if (hasStaging || terminalContent === undefined) {
    return { totalBytes, isCompleted: false };
  }

  try {
    const parsed = JSON.parse(terminalContent) as TraceTerminal;
    if (parsed !== null && typeof parsed === "object" && "kind" in parsed) {
      if (
        parsed.kind === "complete" ||
        parsed.kind === "failed" ||
        parsed.kind === "cancelled" ||
        parsed.kind === "dry_run"
      ) {
        return { totalBytes, isCompleted: true };
      }
    }
  } catch {
    // Malformed terminal
  }

  return { totalBytes, isCompleted: false };
}

/**
 * Re-validates directory state immediately before deletion.
 * Returns `true` if directory was still valid and deleted; `false` if skipped.
 */
async function deleteIfStillCompleted(dirPath: string): Promise<boolean> {
  const initialStat = await lstat(dirPath).catch(() => undefined);
  if (initialStat === undefined || !initialStat.isDirectory() || initialStat.isSymbolicLink()) {
    return false;
  }
  const inspection = await inspectDirectory(dirPath);
  if (!inspection.isCompleted) {
    return false;
  }
  // Re-lstat immediately before rm to defeat symlink swap (TOCTOU)
  const finalStat = await lstat(dirPath).catch(() => undefined);
  if (finalStat === undefined || !finalStat.isDirectory() || finalStat.isSymbolicLink()) {
    return false;
  }
  await rm(dirPath, { recursive: true, force: true });
  return true;
}

/**
 * Parses timestamp from regex match groups into UTC milliseconds.
 */
function parseDirectoryTimestamp(match: RegExpExecArray): number {
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10) - 1;
  const day = Number.parseInt(match[3] as string, 10);
  const hours = Number.parseInt(match[4] as string, 10);
  const minutes = Number.parseInt(match[5] as string, 10);
  const seconds = Number.parseInt(match[6] as string, 10);
  const ms = Number.parseInt(match[7] as string, 10);
  const sign = (match[8] as string) === "+" ? 1 : -1;
  const tzHours = Number.parseInt(match[9] as string, 10);
  const tzMinutes = Number.parseInt(match[10] as string, 10);

  const tzOffsetMs = sign * (tzHours * 60 + tzMinutes) * 60 * 1000;
  return Date.UTC(year, month, day, hours, minutes, seconds, ms) - tzOffsetMs;
}
