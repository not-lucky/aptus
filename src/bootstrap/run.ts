import type { Sink } from "@logtape/logtape";
import type express from "express";
import { type StartupError, startupError } from "../config/errors.ts";
import type { AptusConfig } from "../config/types.ts";
import type { Result } from "../domain/contracts.ts";
import { createClientApp } from "../http/client-app.ts";
import { createErrorEncoder } from "../http/error-encoder.ts";
import { type BoundListener, listen } from "../http/listeners.ts";
import { createOperationsApp, type RuntimeState } from "../http/operations-app.ts";
import { createRequestCancellationRegistry } from "../http/request-cancellation.ts";
import { createLifecycleObserver } from "../observability/lifecycle-observer.ts";
import { aptusLogger, configureLogging } from "../observability/logging.ts";
import { createMetricsRegistry } from "../observability/metrics.ts";
import { createFileTraceRecorder } from "../observability/trace/file-recorder.ts";
import { createNoopTraceRecorder } from "../observability/trace/noop-recorder.ts";
import { createRedactor } from "../observability/trace/redaction.ts";
import { createTraceRetention } from "../observability/trace/retention.ts";
import { startRetentionScheduler, type TraceRetentionScheduler } from "../observability/trace/scheduler.ts";
import { createProtocolAdapters } from "../providers/adapters.ts";
import { createUndiciDispatcher } from "../providers/shared/dispatcher.ts";
import { createGateway } from "../routing/gateway.ts";
import { createDefaultTranslationCoordinator } from "../translation/index.ts";
import { createGracefulShutdown, type GracefulShutdown } from "./shutdown.ts";

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
 * Options for {@link startRuntime}.
 */
export interface StartRuntimeOptions {
  /** Overrides the console log sink (tests inject a no-op sink to keep output quiet). */
  readonly logSink?: Sink;
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
  options: StartRuntimeOptions = {},
): Promise<Result<Runtime, readonly StartupError[]>> {
  // Trace readiness starts true because the startup probe passed during loadConfig.
  const state: RuntimeState = { draining: false, traceReady: true };

  configureLogging(config.logging, options.logSink);
  const logger = aptusLogger();

  const providerNames = new Set(config.providers.map((p) => p.name));
  const publicNames = new Set([...config.models.map((m) => m.name), ...config.routes.map((r) => r.name)]);

  const metrics = createMetricsRegistry({ providers: providerNames, publicNames });
  const observer = createLifecycleObserver({
    logger,
    metrics,
    loggingEnabled: config.logging.enabled,
    metricsEnabled: config.metrics.enabled,
  });

  const secrets = collectSecrets(config);
  const redactor = createRedactor(secrets);

  // The trace recorder degrades readiness on write failure and recovers on a
  // later successful write. The failure hook also emits the trace-failure log
  // and metric through the shared observer.
  const traceRecorder = config.tracing.enabled
    ? createFileTraceRecorder({
        root: config.tracing.root,
        secrets,
        onFailure: (operation, safeErrorCode, aptusRequestId) => {
          observer.traceFailure({ aptusRequestId, operation, safeErrorCode });
        },
        onDegrade: () => {
          state.traceReady = false;
        },
        onRecover: () => {
          state.traceReady = true;
        },
      })
    : createNoopTraceRecorder();

  const adapters = createProtocolAdapters();
  const dispatcher = createUndiciDispatcher();
  const translation = createDefaultTranslationCoordinator();
  const gateway = createGateway({
    config,
    revision,
    adapters,
    dispatcher,
    traceRecorder,
    observer,
    redactor,
    translation,
  });

  const cancellations = createRequestCancellationRegistry();
  const shutdownController = new AbortController();

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
        revision,
        gateway,
        adapters,
        errorEncoder: createErrorEncoder(),
        traceRecorder,
        observer,
        cancellations,
        shutdownSignal: shutdownController.signal,
        redactor,
      }),
    "/server",
  );
  // Rollback operations listener if client listener fails to bind.
  if (!client.ok) {
    await operations.value.close();
    await dispatcher.close?.();
    return client;
  }

  // 3. Start retention scheduler after both listeners are bound and startup Trace probe passed.
  let retentionScheduler: TraceRetentionScheduler | undefined;
  if (config.tracing.enabled) {
    const retention = createTraceRetention({
      root: config.tracing.root,
      maxAgeMs: config.tracing.retention.maxAgeMs,
      maxBytes: config.tracing.retention.maxBytes,
      onDeleted: (reason) => metrics.traceCleanupDeleted(reason),
    });
    retentionScheduler = startRetentionScheduler({
      retention,
      observer,
      intervalMs: config.tracing.retention.cleanupIntervalMs,
      onFailure: () => {
        state.traceReady = false;
      },
    });
    // Run one retention pass immediately at startup, then on the interval.
    void retentionScheduler.triggerNow();
  }

  // 4. Assemble running runtime and shutdown coordinator.
  return {
    ok: true,
    value: {
      operations: operations.value,
      client: client.value,
      shutdown: createGracefulShutdown({
        client: client.value.server,
        operations: operations.value.server,
        drainMs: config.server.shutdownDrainMs,
        shutdownController,
        retentionScheduler,
        cancellations,
        observer,
        onDraining: () => {
          state.draining = true;
        },
        onAbortActive: () => cancellations.abortAll("shutdown"),
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
