import { mkdirSync } from "node:fs";
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
 * bundle is regenerated once per test run by the Vitest global setup.
 */
export async function buildTestCliBundle(): Promise<void> {
  mkdirSync(dirname(TEST_CLI_BUNDLE), { recursive: true });
  const bundle = await rolldown({
    input: resolve(import.meta.dirname, "..", "..", "src", "bootstrap", "cli.ts"),
    platform: "node",
    external: (id) => id.startsWith("node:"),
    resolve: { extensions: [".ts", ".js"] },
  });
  await bundle.write({ file: TEST_CLI_BUNDLE, format: "esm" });
}
