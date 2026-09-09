/**
 * @fileoverview Unauthenticated operations Express application for health and metrics.
 *
 * Exposes unauthenticated diagnostic endpoints: `/metrics` for Prometheus scraping,
 * `/health/live` for process liveness, and `/health/ready` (and `/health`) for readiness.
 * Readiness checks evaluate shutdown drain state, file trace readiness, and key availability.
 */

import express from "express";
import type { AptusConfig } from "../config/types.ts";
import type { HealthPayload } from "../domain/operations.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";

/**
 * Mutable process-local runtime state inspected by health checks.
 */
export interface RuntimeState {
  /** True when graceful process shutdown has initiated. Causes readiness probes to fail. */
  draining: boolean;

  /** True when file tracing is initialized and healthy without write degradation. */
  traceReady: boolean;
}

/**
 * Options for constructing the operations Express application.
 */
export interface OperationsAppOptions {
  /** Active configuration snapshot providing metrics settings and provider key pools. */
  config: AptusConfig;
  /** SHA-256 hash of active redacted configuration. */
  revision: string;
  /** Mutable runtime state tracking draining and trace readiness. */
  state: RuntimeState;
  /** Process-local Prometheus metrics registry. */
  metrics: MetricsRegistry;
}

/**
 * Creates the Express application serving operations endpoints (`/metrics`, `/health/*`).
 *
 * - `GET /metrics`: Renders Prometheus text exposition, or returns 404 if metrics are disabled.
 * - `GET /health/live`: Returns 200 OK while the event loop and process are alive.
 * - `GET /health/ready` (and `/health`): Returns 200 OK if not draining, traces ready, and providers available; 503 otherwise.
 *
 * @param options - Configuration, state reference, and metrics registry.
 * @returns An Express application ready for HTTP listener binding.
 */
export function createOperationsApp(options: OperationsAppOptions): express.Express {
  const { config, revision, state, metrics } = options;

  const enabledProviderCount = config.providers.filter((provider) => provider.keys.some((key) => key.enabled)).length;

  const payload = (status: "ok" | "degraded"): HealthPayload => ({
    status,
    configRevision: revision,
    traceReady: state.traceReady,
    enabledProviderCount,
  });

  const ready = (): boolean => !state.draining && state.traceReady && enabledProviderCount > 0;

  const app = express();

  app.get("/metrics", async (_req, res) => {
    if (!config.metrics.enabled) {
      res.status(404).end();
      return;
    }
    metrics.operations("metrics");
    res.type("text/plain; version=0.0.4; charset=utf-8").send(await metrics.render());
  });

  app.get("/health/live", (_req, res) => {
    metrics.operations("health_live");
    res.json(payload("ok"));
  });

  app.get("/health/ready", (_req, res) => {
    metrics.operations("health_ready");
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });

  app.get("/health", (_req, res) => {
    metrics.operations("health_ready");
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });

  return app;
}
