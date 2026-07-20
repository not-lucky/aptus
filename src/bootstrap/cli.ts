#!/usr/bin/env node
import { formatStartupError } from "../config/errors.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { type Runtime, startRuntime } from "./run.js";

const argv = process.argv.slice(2);
const env = process.env;

function fail(errorLines: readonly string[]): never {
  for (const line of errorLines) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(78);
}

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

/** Signals are registered only after both listeners are bound. */
export function installSignalHandlers(runtime: Runtime): void {
  let shuttingDown = false;
  const onSignal = (): void => {
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
