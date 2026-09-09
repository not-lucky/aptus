#!/usr/bin/env node
/**
 * @packageDocumentation Command-line entry point for the Aptus gateway process.
 *
 * Handles argument parsing, configuration loading, runtime initialization, and process
 * lifecycle. Exits with code 78 (`EX_CONFIG`) on configuration or binding failures, and
 * code 1 on unexpected errors. Listens for SIGINT/SIGTERM to initiate graceful shutdown.
 */

import { formatStartupError } from "../config/errors.ts";
import { loadConfig, resolveConfigPath } from "../config/load.ts";
import { type Runtime, startRuntime } from "./run.ts";

const argv = process.argv.slice(2);
const env = process.env;

/**
 * Emits startup errors to standard error and terminates the process with exit code 78 (`EX_CONFIG`).
 *
 * @param errorLines - Pre-formatted error lines to print to stderr.
 */
function fail(errorLines: readonly string[]): never {
  for (const line of errorLines) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(78);
}

/**
 * Main CLI entry point:
 * 1. Resolves configuration path from CLI flags, environment, or defaults.
 * 2. Loads and validates configuration through the fail-closed pipeline.
 * 3. Starts runtime listeners and reports readiness.
 * 4. Installs SIGINT and SIGTERM graceful shutdown signal handlers.
 */
async function main(): Promise<void> {
  const pathResult = resolveConfigPath(argv, env);
  if (!pathResult.ok) {
    fail(pathResult.error.map(formatStartupError));
  }

  const loaded = await loadConfig(pathResult.value);
  if (!loaded.ok) {
    fail(loaded.error.map(formatStartupError));
  }

  const runtimeResult = await startRuntime(loaded.value.config, loaded.value.revision);
  if (!runtimeResult.ok) {
    fail(runtimeResult.error.map(formatStartupError));
  }

  installSignalHandlers(runtimeResult.value);
  process.stdout.write(
    `aptus ready: operations http://${runtimeResult.value.operations.host}:${runtimeResult.value.operations.port}, client http://${runtimeResult.value.client.host}:${runtimeResult.value.client.port}\n`,
  );
}

/**
 * Registers OS signal listeners (`SIGTERM` and `SIGINT`) for graceful shutdown management.
 *
 * - First signal: Initiates graceful drain (`runtime.shutdown.run()`), allowing in-flight requests to complete.
 * - Second signal: Triggers immediate abort (`runtime.shutdown.abort()`), cancelling in-flight work.
 *
 * @param runtime - Active runtime instance with shutdown coordinator.
 */
export function installSignalHandlers(runtime: Runtime): void {
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) {
      runtime.shutdown.abort();
      return;
    }
    shuttingDown = true;
    void runtime.shutdown.run().then(async () => {
      // Flush stdout/stderr before exiting so final shutdown logs are captured by supervisors
      await flushStream(process.stdout);
      await flushStream(process.stderr);
      process.exit(0);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

/**
 * Drains all pending writes on a stream by queueing an empty write and waiting for completion.
 */
async function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => stream.write("", () => resolve()));
}

void main().catch(() => {
  process.stderr.write("internal startup failure\n");
  process.exit(1);
});
