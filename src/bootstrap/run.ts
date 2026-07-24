import type express from "express";
import { type StartupError, startupError } from "../config/errors.js";
import type { AptusConfig } from "../config/types.js";
import type { Result } from "../domain/contracts.js";
import { createClientApp, type HttpRequestObserver } from "../http/client-app.js";
import { createErrorEncoder } from "../http/error-encoder.js";
import { type BoundListener, listen } from "../http/listeners.js";
import { createOperationsApp, type RuntimeState } from "../http/operations-app.js";
import { createRequestCancellationRegistry } from "../http/request-cancellation.js";
import { createLifecycleObserver } from "../observability/lifecycle-observer.js";
import { aptusLogger, configureLogging } from "../observability/logging.js";
import { createMetricsRegistry } from "../observability/metrics.js";
import { createFileTraceRecorder } from "../observability/trace/file-recorder.js";
import { createNoopTraceRecorder } from "../observability/trace/noop-recorder.js";
import { createProtocolAdapters } from "../providers/adapters.js";
import { createUndiciDispatcher } from "../providers/shared/dispatcher.js";
import { createGateway } from "../routing/gateway.js";
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
 * Concrete application composition root.
 *
 * This is the only module that imports concrete adapters and wires them behind
 * domain interfaces. It builds the real Gateway (Chat native path), the Undici
 * dispatcher, the protected/no-op trace recorder, and the LogTape + Prometheus
 * observability seam, then binds the operations and client listeners.
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

  configureLogging(config.logging);
  const logger = aptusLogger();
  const metrics = createMetricsRegistry();
  const observer = createLifecycleObserver({
    logger,
    metrics,
    loggingEnabled: config.logging.enabled,
    metricsEnabled: config.metrics.enabled,
  });

  // The trace recorder degrades readiness on write failure and recovers on a
  // later successful write. The failure hook also emits the trace-failure log
  // and metric through the shared observer.
  const traceRecorder = config.tracing.enabled
    ? createFileTraceRecorder({
        root: config.tracing.root,
        secrets: collectSecrets(config),
        onFailure: (safeErrorCode) => {
          state.traceReady = false;
          observer.traceFailure({ aptusRequestId: undefined, operation: "trace_write", safeErrorCode });
        },
        onRecover: () => {
          state.traceReady = true;
        },
      })
    : createNoopTraceRecorder();

  const adapters = createProtocolAdapters();
  const dispatcher = createUndiciDispatcher();
  const gateway = createGateway({
    config,
    revision,
    adapters,
    dispatcher,
    traceRecorder,
    observer,
  });

  // HTTP stays decoupled from the observability module through this narrow
  // structural observer, which records `aptus_http_requests_total`.
  const httpObserver: HttpRequestObserver = {
    observeRequest(fields) {
      if (config.metrics.enabled) {
        metrics.httpRequest(fields.endpointProtocol, fields.endpoint, fields.outcome, fields.stream);
      }
    },
  };

  const cancellations = createRequestCancellationRegistry();

  // 1. Bind operations listener first.
  const operations = await bind(
    config.operations.host,
    config.operations.port,
    () => createOperationsApp({ config, revision, state, metrics }),
    "/operations",
  );
  if (!operations.ok) {
    await dispatcher.close?.();
    return operations;
  }

  // 2. Bind client listener second.
  const client = await bind(
    config.server.host,
    config.server.port,
    () =>
      createClientApp({
        config,
        gateway,
        adapters,
        errorEncoder: createErrorEncoder(),
        cancellations,
        observer: httpObserver,
      }),
    "/server",
  );
  // Rollback operations listener if client listener fails to bind.
  if (!client.ok) {
    await operations.value.close();
    await dispatcher.close?.();
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
        onShutdown: async () => {
          await dispatcher.close?.();
        },
      }),
    },
  };
}

/**
 * Collects every resolved client and provider secret for trace redaction.
 */
function collectSecrets(config: AptusConfig): ReadonlySet<string> {
  const secrets = new Set<string>();
  for (const key of config.auth.clientKeys) secrets.add(key.secret);
  for (const provider of config.providers) {
    for (const key of provider.keys) secrets.add(key.secret);
  }
  return secrets;
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
