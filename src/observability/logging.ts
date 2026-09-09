/**
 * @fileoverview Structured JSON-lines logging for the Aptus gateway.
 *
 * Configures the process-global LogTape logging subsystem and exposes the shared
 * gateway logger. Log records are formatted as single-line JSON objects with flattened
 * event properties for direct ingestion by log aggregators.
 *
 * Invariants: Sensitive credentials, raw model IDs, and client IP addresses are never
 * logged. Startup configuration runs once before traffic admission.
 */

import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
  type Sink,
} from "@logtape/logtape";
import type { LoggingConfig } from "../config/types.ts";

/**
 * JSON-lines formatter that flattens event fields to the top level of each record.
 *
 * Renders timestamp, level, message, logger category, and event properties into
 * a single flat JSON object per line with dot-separated categories.
 */
const consoleFormatter = getJsonLinesFormatter({ message: "rendered", properties: "flatten", categorySeparator: "." });

/**
 * Installs the process-global LogTape logging configuration.
 *
 * Sets up the `"aptus"` logger category with the configured severity threshold
 * and sink. When logging is disabled, the lowest level is set to null to drop records.
 *
 * @param config - Logging configuration containing enablement and level threshold.
 * @param sink - Optional custom sink override; defaults to the JSON-lines console sink.
 */
export function configureLogging(config: LoggingConfig, sink?: Sink): void {
  configureSync({
    sinks: { aptus: sink ?? getConsoleSink({ formatter: consoleFormatter }) },
    loggers: [
      { category: "aptus", sinks: ["aptus"], lowestLevel: config.enabled ? config.level : null },
      { category: ["logtape", "meta"], sinks: ["aptus"], lowestLevel: "warning" },
    ],
    reset: true,
  });
}

/**
 * Returns the shared LogTape logger for the `"aptus"` category.
 *
 * Callers emit documented structured event names with safe payload properties.
 *
 * @returns The shared LogTape {@link Logger} instance.
 */
export function aptusLogger(): Logger {
  return getLogger("aptus");
}
