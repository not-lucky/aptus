import { buildTestCliBundle } from "./helpers/cli-bundle.ts";

/**
 * Runs once before any test file. Pre-compiles the CLI entrypoint so the
 * process tests spawn a bundled JavaScript file instead of type-stripping the
 * full TypeScript module graph on every boot.
 */
export default async function setup(): Promise<void> {
  await buildTestCliBundle();
}
