import express from "express";
import type { AptusConfig } from "../config/types.js";
import type { HealthPayload } from "../domain/operations.js";
import { createOperationsObserver } from "./operations-observer.js";

/**
 * Mutable process-local runtime state shared across HTTP listeners and shutdown handlers.
 */
export interface RuntimeState {
  /**
   * Set to `true` when graceful process shutdown begins, causing `/health/ready` to report degraded 503.
   */
  draining: boolean;

  /**
   * File trace subsystem readiness. Set to `false` if runtime trace write errors occur.
   */
  traceReady: boolean;
}

/**
 * Initialization options for constructing the unauthenticated operations Express application.
 */
export interface OperationsAppOptions {
  /** Deep-frozen active configuration. */
  config: AptusConfig;
  /** SHA-256 digest of active redacted configuration. */
  revision: string;
  /** Shared runtime state reference. */
  state: RuntimeState;
}

/**
 * Instantiates the Express application for the unauthenticated operations listener.
 *
 * Endpoints:
 * - `GET /metrics`: Prometheus metrics scrape endpoint (returns 404 when metrics are disabled).
 * - `GET /health/live`: Liveness check (always returns HTTP 200 `status: "ok"` while process is alive).
 * - `GET /health/ready`: Readiness check (returns HTTP 200 if not draining, traceReady is true, and providers are available; otherwise 503 `status: "degraded"`).
 * - `GET /health`: Exact readiness alias for compatibility with standard container probes.
 *
 * @param options - Application construction options.
 * @returns Configured Express application.
 */
export function createOperationsApp(options: OperationsAppOptions): express.Express {
  const observer = createOperationsObserver();
  const { config, revision, state } = options;

  // Count providers with at least one enabled key.
  const enabledProviderCount = config.providers.filter((provider) => provider.keys.some((key) => key.enabled)).length;

  const payload = (status: "ok" | "degraded"): HealthPayload => ({
    status,
    configRevision: revision,
    traceReady: state.traceReady,
    enabledProviderCount,
  });

  // Readiness condition: must not be in shutdown drain, trace subsystem must be healthy, and at least 1 provider has an enabled key.
  const ready = (): boolean => !state.draining && state.traceReady && enabledProviderCount > 0;

  const app = express();

  app.get("/metrics", (_req, res) => {
    if (!config.metrics.enabled) {
      res.status(404).end();
      return;
    }
    observer.observe("metrics");
    res.type("text/plain; version=0.0.4; charset=utf-8").send(observer.renderMetrics());
  });

  app.get("/health/live", (_req, res) => {
    observer.observe("health_live");
    res.json(payload("ok"));
  });

  app.get("/health/ready", (_req, res) => {
    observer.observe("health_ready");
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });

  app.get("/health", (_req, res) => {
    observer.observe("health_ready");
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });

  return app;
}
