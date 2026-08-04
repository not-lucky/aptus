import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rolldown } from "rolldown";

/**
 * Where the bundled test CLI is written. Process-test helpers spawn this file
 * instead of `src/bootstrap/cli.ts`, so each spawned Node process skips the
 * per-file type stripping and module resolution that dominate CLI boot time.
 */
export const TEST_CLI_BUNDLE = resolve(import.meta.dirname, "..", ".artifacts", "aptus-cli.mjs");

/**
 * Bundles `src/bootstrap/cli.ts` (and its transitive app modules) into a
 * single ESM file at {@link TEST_CLI_BUNDLE}. Node builtins stay external; the
 * bundle is regenerated once per test run by the Vitest global setup — unless
 * it is already newer than every source file, in which case it is reused.
 */
export async function buildTestCliBundle(): Promise<void> {
  mkdirSync(dirname(TEST_CLI_BUNDLE), { recursive: true });
  if (bundleIsFresh()) return;

  const bundle = await rolldown({
    input: resolve(import.meta.dirname, "..", "..", "src", "bootstrap", "cli.ts"),
    platform: "node",
    external: (id) => id.startsWith("node:"),
    resolve: { extensions: [".ts", ".js"] },
  });
  await bundle.write({ file: TEST_CLI_BUNDLE, format: "esm" });
}

/**
 * Returns true when the bundle exists and is at least as new as every source
 * file it is built from, so an unchanged checkout skips the ~200ms rebundle.
 */
function bundleIsFresh(): boolean {
  if (!existsSync(TEST_CLI_BUNDLE)) return false;
  const bundleMtime = statSync(TEST_CLI_BUNDLE).mtimeMs;
  return newestMtime(resolve(import.meta.dirname, "..", "..", "src")) <= bundleMtime;
}

/**
 * Returns the most recent file modification time under a directory tree.
 */
function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    newest = Math.max(newest, mtime);
  }
  return newest;
}
