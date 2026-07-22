/**
 * Startup error taxonomy codes identifying specific configuration loading, validation, and binding failures.
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
 * Normalized startup configuration or binding error.
 *
 * Designed to be deterministic, safe, and easily machine-parseable. Messages never include
 * raw environment variable values, file paths containing secrets, or stack traces.
 */
export interface StartupError {
  /**
   * Stable machine-readable error code.
   */
  readonly code: StartupErrorCode;

  /**
   * RFC 6901 JSON pointer to the offending configuration value (or empty string `""` if not field-localizable).
   */
  readonly pointer: string;

  /**
   * Bounded human-readable error description.
   */
  readonly message: string;
}

/**
 * Constructs a new {@link StartupError}.
 *
 * @param code - The startup error code.
 * @param pointer - The RFC 6901 JSON pointer identifying the failing configuration node.
 * @param message - Bounded, human-readable error description.
 * @returns A structured {@link StartupError} object.
 */
export function startupError(code: StartupErrorCode, pointer: string, message: string): StartupError {
  return { code, pointer, message };
}

/**
 * Deterministically sorts a collection of startup errors.
 *
 * Sorting precedence:
 * 1. JSON pointer path (`pointer` ascending via localeCompare)
 * 2. Error code (`code` ascending)
 * 3. Human message (`message` ascending)
 *
 * @param errors - Collection of startup errors to sort.
 * @returns A new sorted array of {@link StartupError} instances.
 */
export function sortStartupErrors(errors: readonly StartupError[]): readonly StartupError[] {
  return [...errors].sort(
    (a, b) => a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

/**
 * Formats a startup error into a single standard output line: `<CODE> <POINTER> <MESSAGE>`.
 *
 * @param error - The startup error to format.
 * @returns Formatted single-line error string.
 */
export function formatStartupError(error: StartupError): string {
  return `${error.code} ${error.pointer} ${error.message}`;
}

/**
 * Encodes an array of path segments into an RFC 6901 JSON pointer string.
 *
 * @param path - Array of string keys or numeric array indexes.
 * @returns Formatted JSON pointer prefixed with `/` (or `""` if empty).
 *
 * @remarks
 * In accordance with RFC 6901:
 * - Tildes (`~`) are escaped as `~0`
 * - Forward slashes (`/`) are escaped as `~1`
 */
export function jsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "";
  }
  // Escape ~ first, then / to avoid double-escaping ~1.
  return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
