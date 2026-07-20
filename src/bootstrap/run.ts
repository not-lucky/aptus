import type express from "express";
import { type StartupError, startupError } from "../config/errors.js";
import type { AptusConfig } from "../config/types.js";
import type { Result } from "../domain/contracts.js";
import { createClientApp } from "../http/client-app.js";
import { type BoundListener, listen } from "../http/listeners.js";
import { createOperationsApp, type RuntimeState } from "../http/operations-app.js";
import { createGracefulShutdown, type GracefulShutdown } from "./shutdown.js";

export interface Runtime {
  readonly operations: BoundListener;
  readonly client: BoundListener;
  readonly shutdown: GracefulShutdown;
}

/**
 * The only concrete composition root: bind operations first, then the client
 * listener. A client bind failure closes the operations listener again before
 * reporting a startup error.
 */
export async function startRuntime(
  config: AptusConfig,
  revision: string,
): Promise<Result<Runtime, readonly StartupError[]>> {
  // A successful load implies the Trace startup probe passed, so trace readiness
  // starts true; runtime Trace degradation (phase 8) can flip it later.
  const state: RuntimeState = { draining: false, traceReady: true };

  const operations = await bind(
    config.operations.host,
    config.operations.port,
    () => createOperationsApp({ config, revision, state }),
    "/operations",
  );
  if (!operations.ok) {
    return operations;
  }

  const client = await bind(config.server.host, config.server.port, () => createClientApp(), "/server");
  if (!client.ok) {
    await operations.value.close();
    return client;
  }

  return {
    ok: true,
    value: {
      operations: operations.value,
      client: client.value,
      shutdown: createGracefulShutdown({
        client: client.value.server,
        operations: operations.value.server,
        drainMs: config.server.shutdownDrainMs,
        onDraining: () => {
          state.draining = true;
        },
      }),
    },
  };
}

async function bind(
  host: string,
  port: number,
  app: () => express.Express,
  pointer: "/operations" | "/server",
): Promise<Result<BoundListener, readonly StartupError[]>> {
  try {
    return { ok: true, value: await listen(app(), host, port) };
  } catch (err) {
    return {
      ok: false,
      error: [
        startupError(
          "BIND_FAILED",
          pointer,
          `cannot bind ${host}:${port}: ${err instanceof Error ? err.message : "unknown error"}`,
        ),
      ],
    };
  }
}
