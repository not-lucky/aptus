import type express from "express";
import { type StartupError, startupError } from "../config/errors.js";
import type { AptusConfig } from "../config/types.js";
import type { Gateway, GatewayRequest, GatewayResult, Result } from "../domain/contracts.js";
import { createClientApp } from "../http/client-app.js";
import { createErrorEncoder } from "../http/error-encoder.js";
import { type BoundListener, listen } from "../http/listeners.js";
import { createOperationsApp, type RuntimeState } from "../http/operations-app.js";
import { createProtocolAdapters } from "../http/protocol-adapters.js";
import { createRequestCancellationRegistry } from "../http/request-cancellation.js";
import { createGracefulShutdown, type GracefulShutdown } from "./shutdown.js";

/**
 * Running server runtime handle containing bound HTTP listeners and shutdown coordinator.
 */
export interface Runtime {
  /** Unauthenticated operations listener (`/health`, `/metrics`). */
  readonly operations: BoundListener;
  /** Authenticated client API listener (`/chat/completions`, `/responses`, `/messages`, `/models`). */
  readonly client: BoundListener;
  /** Graceful shutdown coordinator. */
  readonly shutdown: GracefulShutdown;
}

/**
 * Concrete application composition root:
 * 1. Initializes shared runtime state (`draining = false`, `traceReady = true`).
 * 2. Binds the operations HTTP listener first.
 * 3. Binds the authenticated client HTTP listener second.
 * 4. Rolls back and closes the operations listener if the client listener fails to bind.
 * 5. Wires the graceful shutdown coordinator to drain listeners and abort active requests.
 *
 * @param config - Deep-frozen verified configuration snapshot.
 * @param revision - SHA-256 revision hash of the active configuration.
 * @returns Result containing the running {@link Runtime} or startup errors.
 */
export async function startRuntime(
  config: AptusConfig,
  revision: string,
): Promise<Result<Runtime, readonly StartupError[]>> {
  // Trace readiness starts true because the startup probe passed during loadConfig.
  const state: RuntimeState = { draining: false, traceReady: true };
  const cancellations = createRequestCancellationRegistry();

  // 1. Bind operations listener first.
  const operations = await bind(
    config.operations.host,
    config.operations.port,
    () => createOperationsApp({ config, revision, state }),
    "/operations",
  );
  if (!operations.ok) {
    return operations;
  }

  // 2. Bind client listener second.
  const client = await bind(
    config.server.host,
    config.server.port,
    () =>
      createClientApp({
        config,
        gateway: createUnavailableGateway(),
        adapters: createProtocolAdapters(),
        errorEncoder: createErrorEncoder(),
        cancellations,
      }),
    "/server",
  );
  // Rollback operations listener if client listener fails to bind.
  if (!client.ok) {
    await operations.value.close();
    return client;
  }

  // 3. Assemble running runtime and shutdown coordinator.
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
        onAbortActive: () => cancellations.abortAll(),
      }),
    },
  };
}

/**
 * Fallback Gateway stub returning unavailable failures until provider routing is wired in subsequent phases.
 */
function createUnavailableGateway(): Gateway {
  return {
    async execute(_request: GatewayRequest): Promise<GatewayResult> {
      return {
        kind: "failure",
        failure: { category: "unavailable", message: "gateway routing is not available", retryable: false },
      };
    },
  };
}

/**
 * Binds an Express application factory to a host:port TCP address.
 */
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
