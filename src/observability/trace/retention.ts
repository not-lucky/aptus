/**
 * @fileoverview Age and size eviction for completed filesystem trace directories.
 *
 * Scans the trace storage directory and deletes completed request traces that exceed
 * the configured maximum retention age or cumulative byte budget. Oldest completed
 * traces are evicted first during size-based cleanup.
 *
 * Invariants: Incomplete traces and active staging files are never deleted to prevent
 * corrupting in-flight requests. Symbolic links are never followed. Target directories
 * are revalidated immediately prior to deletion to prevent race conditions.
 */

import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RetentionResult, TraceRetention, TraceTerminal } from "../../domain/operations.ts";

/**
 * Anchored pattern matching canonical trace directory names:
 * `YYYY-MM-DDTHH-mm-ss.SSS±HHMM_<UUID-v4>`.
 */
const TRACE_DIR_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})([+-])(\d{2})(\d{2})_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * Configuration options for the filesystem trace retention sweeper.
 */
export interface TraceRetentionOptions {
  /** Root directory that holds one subdirectory per request trace. */
  readonly root: string;
  /** Maximum retention age in milliseconds before a completed trace is deleted. */
  readonly maxAgeMs: number;
  /** Maximum total disk usage in bytes for completed traces before size eviction. */
  readonly maxBytes: number;
  /** Optional callback invoked once per deleted completed directory with eviction reason. */
  readonly onDeleted?: (reason: "age" | "size") => void;
}

/**
 * Inspected metadata for a candidate trace directory discovered during a sweep.
 */
interface DirectoryCandidate {
  /** Bare directory name matching {@link TRACE_DIR_REGEX}. */
  readonly name: string;
  /** Absolute filesystem path to the candidate directory. */
  readonly fullPath: string;
  /** Request start time in Unix milliseconds, parsed from the directory name. */
  readonly timestampMs: number;
  /** Total size in bytes of regular files found inside the directory. */
  readonly totalBytes: number;
  /** Whether the directory contains a valid terminal marker and no staging files. */
  readonly isCompleted: boolean;
}

/**
 * Creates the filesystem trace retention scanner and cleanup executor.
 *
 * @param options - Storage root, retention limits, and optional deletion callback.
 * @returns A {@link TraceRetention} instance.
 */
export function createTraceRetention(options: TraceRetentionOptions): TraceRetention {
  const { root, maxAgeMs, maxBytes, onDeleted } = options;

  return {
    /**
     * Executes one retention sweep over the configured trace storage root.
     *
     * Scans child directories, evicts completed traces exceeding the age budget,
     * and trims oldest completed traces until cumulative size fits the byte budget.
     *
     * @param nowMs - Current wall-clock time in Unix milliseconds.
     * @returns Promise resolving to a {@link RetentionResult} summarizing cleanup counts.
     * @throws {Error} If the root directory does not exist or is not a directory.
     */
    async run(nowMs: number): Promise<RetentionResult> {
      // First, verify that the root is a real directory without following symbolic links.
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Trace retention root is not a real directory: ${root}`);
      }

      // Second, read the direct children of the root directory.
      const entries = await readdir(root, { withFileTypes: true });

      const completedCandidates: DirectoryCandidate[] = [];
      let incompleteBytes = 0;
      let skippedCount = 0;

      for (const entry of entries) {
        // Skip entries that cannot be trace directories: plain files, symbolic links, hidden names, and names
        // outside the canonical pattern are never request traces, so they stay untouched.
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

        // Measure this directory: sum its regular file bytes and check for staging files and a valid terminal.
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

      // Third, order the completed candidates deterministically by parsed timestamp and then by directory name.
      // The name tiebreaker keeps oldest-first deletion stable when two requests share a millisecond.
      completedCandidates.sort((a, b) => {
        if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
        return a.name.localeCompare(b.name);
      });

      let deletedForAge = 0;
      let deletedForSize = 0;
      const survivingCompleted: DirectoryCandidate[] = [];

      // Fourth, evict by age: delete each completed trace whose age exceeds the configured maximum age.
      for (const candidate of completedCandidates) {
        const ageMs = nowMs - candidate.timestampMs;
        if (ageMs > maxAgeMs) {
          const deleted = await deleteIfStillCompleted(candidate.fullPath);
          if (deleted) {
            deletedForAge++;
            onDeleted?.("age");
          } else {
            // The directory changed under the sweep, so recount it on the incomplete path instead of dropping it.
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

      // Fifth, evict by size: delete the oldest completed traces until the survivors fit the byte budget.
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
 * Inspects a candidate directory, calculating regular file bytes and checking completion status.
 *
 * A directory is considered completed only if it contains a valid terminal marker (`999_terminal.json`
 * with kind `complete`, `failed`, `cancelled`, or `dry_run`) and no active staging files.
 *
 * @param dirPath - Absolute path to the candidate directory.
 * @returns Promise resolving to the total byte size and completion flag.
 */
async function inspectDirectory(dirPath: string): Promise<{ totalBytes: number; isCompleted: boolean }> {
  let totalBytes = 0;
  let hasStaging = false;
  let terminalContent: string | undefined;

  /**
   * Recursively walks the directory tree to sum file sizes and detect staging or terminal files.
   *
   * @param currentPath - Current directory path being inspected.
   */
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
    // A terminal that fails to parse is treated as incomplete, so the directory survives this sweep.
  }

  return { totalBytes, isCompleted: false };
}

/**
 * Deletes a trace directory after verifying it remains a regular, completed directory.
 *
 * Re-validates the directory immediately before removal to guard against symlink swaps
 * or concurrent status changes.
 *
 * @param dirPath - Absolute path to the directory targeted for deletion.
 * @returns Promise resolving to `true` if deleted, or `false` if skipped or changed.
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
  // Stat once more immediately before removal so that a symbolic link swapped in after the first check is caught.
  const finalStat = await lstat(dirPath).catch(() => undefined);
  if (finalStat === undefined || !finalStat.isDirectory() || finalStat.isSymbolicLink()) {
    return false;
  }
  await rm(dirPath, { recursive: true, force: true });
  return true;
}

/**
 * Parses the ISO-like timestamp from a canonical trace directory name regex match.
 *
 * @param match - RegExp exec result matching {@link TRACE_DIR_REGEX}.
 * @returns Unix epoch timestamp in milliseconds, or NaN if unparseable.
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
