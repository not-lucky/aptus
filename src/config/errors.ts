/**
 * @fileoverview Startup error taxonomy for configuration loading in the Aptus gateway.
 *
 * Defines structured startup error records and machine-readable failure codes emitted during
 * gateway initialization prior to listener binding. Errors maintain RFC 6901 JSON Pointers
 * to invalid configuration nodes and carry safe, bounded descriptions suitable for standard error output.
 *
 * All failures fail closed: any validation, YAML syntax, schema, secret resolution, or probe error
 * aborts startup before traffic is admitted, ensuring a running gateway always serves a verified snapshot.
 */

/**
 * Stable machine-readable code classifying startup configuration or binding failures.
 *
 * Categorizes failures across CLI parsing, YAML syntax, schema conformity, secret resolution,
 * semantic integrity, route validation, trace probing, and listener binding.
 */
export type StartupErrorCode =
  | "CONFIG_CLI_ARGUMENT"
  | "CONFIG_FILE_READ"
  | "CONFIG_YAML_DOCUMENT_COUNT"
  | "CONFIG_YAML_PARSE"
  | "CONFIG_YAML_ALIAS"
  | "CONFIG_YAML_MERGE_KEY"
  | "CONFIG_YAML_NON_STRING_KEY"
  | "CONFIG_YAML_CUSTOM_TAG"
  | "CONFIG_SCHEMA"
  | "BIND_FAILED"
  | "CONFIG_SECRET_MISSING"
  | "CONFIG_INTERPOLATION_FORBIDDEN"
  | "CONFIG_PUBLIC_NAME_DUPLICATE"
  | "CONFIG_REFERENCE_NOT_CANONICAL"
  | "CONFIG_PROVIDER_URL_QUERY"
  | "CONFIG_PROVIDER_SECRET_DUPLICATE"
  | "CONFIG_SECRET_LITERAL"
  | "CONFIG_SECRET_REFERENCE_INVALID"
  | "CONFIG_REFERENCE_UNKNOWN"
  | "CONFIG_ROUTE_CANDIDATE_DUPLICATE"
  | "CONFIG_CLIENT_ALLOW_UNKNOWN"
  | "CONFIG_PROVIDER_NAME_DUPLICATE"
  | "CONFIG_PROVIDER_KEY_NAME_DUPLICATE"
  | "CONFIG_PROVIDER_HEADER_FORBIDDEN"
  | "CONFIG_PROVIDER_URL_SCHEME"
  | "CONFIG_PROVIDER_URL_CREDENTIALS"
  | "CONFIG_PROVIDER_URL_FRAGMENT"
  | "CONFIG_PROVIDER_URL_PATH_EMPTY"
  | "CONFIG_RETRY_ON_DUPLICATE"
  | "CONFIG_FALLBACK_ON_DUPLICATE"
  | "CONFIG_TRACE_PROBE";

/**
 * Normalized startup configuration or listener binding failure record.
 *
 * Pairs a machine-readable failure code with an RFC 6901 pointer to the invalid node
 * and a safe human-readable diagnostic message.
 */
export interface StartupError {
  /** Stable machine-readable classification code for the startup failure. */
  readonly code: StartupErrorCode;

  /** RFC 6901 JSON Pointer locating the invalid configuration value, or `""` for document-level errors. */
  readonly pointer: string;

  /** Bounded human-readable diagnostic description safe for CLI output without exposing secrets. */
  readonly message: string;
}

/**
 * Constructs a structured startup error record.
 *
 * @param code - Machine-readable code classifying the failure.
 * @param pointer - RFC 6901 JSON Pointer to the offending configuration node.
 * @param message - Bounded diagnostic message safe for display.
 * @returns A fresh immutable {@link StartupError} record.
 */
export function startupError(code: StartupErrorCode, pointer: string, message: string): StartupError {
  return { code, pointer, message };
}

/**
 * Deterministically sorts startup error records for consistent CLI output and test assertions.
 *
 * Orders by RFC 6901 pointer first, then error code, and finally error message.
 *
 * @param errors - Read-only collection of startup errors.
 * @returns A new array of errors sorted in canonical order.
 */
export function sortStartupErrors(errors: readonly StartupError[]): readonly StartupError[] {
  return [...errors].sort(
    (a, b) => a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

/**
 * Formats a startup error record as a single standard error output line.
 *
 * @param error - Startup error to format.
 * @returns Space-separated `<CODE> <POINTER> <MESSAGE>` string.
 */
export function formatStartupError(error: StartupError): string {
  return `${error.code} ${error.pointer} ${error.message}`;
}

/** Re-exported RFC 6901 JSON Pointer encoder for configuration modules. */
export { jsonPointer } from "../domain/json.ts";
