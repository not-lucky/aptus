#!/usr/bin/env node
import { formatStartupError } from "../config/errors.ts";
import { loadConfig, resolveConfigPath } from "../config/load.ts";
import { type Runtime, startRuntime } from "./run.ts";

const argv = process.argv.slice(2);
const env = process.env;

/**
 * Emits startup errors to standard error and terminates the process with EX_CONFIG (exit code 78).
 */
function fail(errorLines: readonly string[]): never {
  for (const line of errorLines) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(78);
}

/**
 * Main CLI entry point:
 * 1. Resolves config path from CLI flags / env / default.
 * 2. Loads and verifies configuration through fail-closed pipeline.
 * 3. Starts runtime listeners.
 * 4. Installs SIGINT and SIGTERM lifecycle signal handlers.
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
 * Behavior:
 * - First signal: Initiates graceful shutdown (`runtime.shutdown.run()`), allowing in-flight requests to finish within the drain window.
 * - Second signal: Triggers immediate abort (`runtime.shutdown.abort()`), cancelling in-flight work immediately.
 *
 * @param runtime - Active runtime instance with shutdown coordinator.
 */
export function installSignalHandlers(runtime: Runtime): void {
  let shuttingDown = false;
  const onSignal = (): void => {
    // If signal received while already shutting down, force immediate abort.
    if (shuttingDown) {
      runtime.shutdown.abort();
      return;
    }
    shuttingDown = true;
    void runtime.shutdown.run().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

void main().catch(() => {
  process.stderr.write("internal startup failure\n");
  process.exit(1);
});
