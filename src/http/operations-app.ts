import express from "express";
import type { AptusConfig } from "../config/types.js";
import type { HealthPayload } from "../domain/operations.js";

/** Mutable runtime state shared with the shutdown path. */
export interface RuntimeState {
  /** True once graceful shutdown has started. */
  draining: boolean;
  /** File Trace subsystem readiness. True after a successful startup probe. */
  traceReady: boolean;
}

/** Options for constructing the operations Express application. */
export interface OperationsAppOptions {
  config: AptusConfig;
  revision: string;
  state: RuntimeState;
}

/**
 * The unauthenticated operations listener: `/health/live`, `/health/ready`, and
 * `/health` (exact readiness alias). `/metrics` arrives with the metrics phase.
 */
export function createOperationsApp(options: OperationsAppOptions): express.Express {
  const { config, revision, state } = options;
  const enabledProviderCount = config.providers.filter((provider) => provider.keys.some((key) => key.enabled)).length;
  const payload = (status: "ok" | "degraded"): HealthPayload => ({
    status,
    configRevision: revision,
    traceReady: state.traceReady,
    enabledProviderCount,
  });
  const ready = (): boolean => !state.draining && state.traceReady && enabledProviderCount > 0;

  const app = express();
  app.get("/health/live", (_req, res) => {
    res.json(payload("ok"));
  });
  app.get("/health/ready", (_req, res) => {
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });
  app.get("/health", (_req, res) => {
    const isReady = ready();
    res.status(isReady ? 200 : 503).json(payload(isReady ? "ok" : "degraded"));
  });
  return app;
}
