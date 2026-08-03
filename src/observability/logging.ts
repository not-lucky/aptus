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
 * One JSON object per line with every documented event field flattened into
 * the top level: `{"@timestamp","level","message","logger",...fields}`.
 *
 * LogTape's default console formatter renders only the event name and drops
 * the record properties, which would violate the operations contract that
 * every log is structured with its stable required fields.
 */
const consoleFormatter = getJsonLinesFormatter({ message: "rendered", properties: "flatten", categorySeparator: "." });

/**
 * Configures the global LogTape configuration for the `"aptus"` category.
 *
 * A custom sink may be supplied (used by tests to capture structured records);
 * otherwise the console sink renders JSON-lines records through stdout/stderr.
 * When `config.enabled` is `false`, the logger's `lowestLevel` is `null` so
 * every record is rejected.
 *
 * @param config - Structured logging configuration.
 * @param sink - Optional custom sink (defaults to the JSON-lines console sink).
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
 * Returns the configured `"aptus"` logger.
 *
 * Configured event names are emitted as the structured log
 * message with their required fields as properties. Secrets, raw model IDs,
 * and URLs are never logged.
 *
 * @returns The shared `"aptus"` LogTape logger.
 */
export function aptusLogger(): Logger {
  return getLogger("aptus");
}
