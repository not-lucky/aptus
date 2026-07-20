/**
 * Startup error contract: stable code, JSON pointer, and a safe bounded message.
 * Messages never contain file contents, environment values, or raw stacks.
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

export interface StartupError {
  /** Stable machine-readable code. */
  readonly code: StartupErrorCode;
  /** JSON pointer to the offending value; "" when not localizable. */
  readonly pointer: string;
  /** Safe, bounded, human-readable message. */
  readonly message: string;
}

export function startupError(code: StartupErrorCode, pointer: string, message: string): StartupError {
  return { code, pointer, message };
}

/** Stable ordering: pointer first, then code, then message. */
export function sortStartupErrors(errors: readonly StartupError[]): readonly StartupError[] {
  return [...errors].sort(
    (a, b) => a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

/** One stable output line: `<CODE> <POINTER> <MESSAGE>`. */
export function formatStartupError(error: StartupError): string {
  return `${error.code} ${error.pointer} ${error.message}`;
}

/** Build a JSON pointer from path segments. */
export function jsonPointer(path: readonly (string | number)[]): string {
  return path.length === 0
    ? ""
    : `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
