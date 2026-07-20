import type { HeaderMap, JsonObject, Protocol } from "./contracts.js";
import type { AptusRequestId } from "./request-id.js";

/** The canonical 13-member failure category set. */
export type IrFailureCategory =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "unavailable"
  | "provider"
  | "unsupported_capability"
  | "stream_interrupted";

/** A client-safe normalized failure. */
export interface NormalizedFailure {
  /** Stable category that selects status and policy. */
  readonly category: IrFailureCategory;
  /** Redacted bounded human-readable message. */
  readonly message: string;
  /** At most one upstream or Aptus code/type string. */
  readonly code?: string;
  /** Capability ID for `unsupported_capability`; omitted otherwise. */
  readonly capability?: string;
  /** Normalized retry delay in whole seconds when safe. */
  readonly retryAfterSeconds?: number;
  /** True only when same-Candidate safety rules can still permit a retry. */
  readonly retryable: boolean;
}

/** A protocol-native encoded expected failure. */
export interface EncodedFailure {
  /** Target status from the exact failure map. */
  readonly status: number;
  /** Target content headers plus Aptus request ID and optional Retry-After. */
  readonly headers: HeaderMap;
  /** UTF-8 target-native error envelope. */
  readonly body: Uint8Array;
}

/** A Trace stage identity whose sequence number is assigned by the session. */
export type TraceStage =
  | "client_request"
  | "authentication"
  | "resolution"
  | "candidate_skip"
  | "mutation"
  | "preflight"
  | "key_selection"
  | "provider_request"
  | "provider_response_head"
  | "provider_response"
  | "provider_stream"
  | "ir_events"
  | "client_response"
  | "client_stream"
  | "retry"
  | "fallback"
  | "cancellation"
  | "trace_failure";

/** Exactly one terminal Trace result. */
export type TraceTerminal =
  | {
      readonly kind: "complete";
      readonly status: number;
      readonly usage?: JsonObject;
      readonly estimatedCostUsd?: string;
    }
  | { readonly kind: "failed"; readonly failure: NormalizedFailure }
  | { readonly kind: "cancelled"; readonly by: "client" | "shutdown" }
  | { readonly kind: "dry_run" }
  | { readonly kind: "incomplete"; readonly reason: "trace_write_failed" | "process_exit" | "shutdown_abort" };

/** Immutable Trace manifest. */
export interface TraceManifest {
  /** Trace schema version. */
  readonly schemaVersion: 1;
  /** Aptus request identity. */
  readonly aptusRequestId: AptusRequestId;
  /** RFC 3339 start time. */
  readonly startedAt: string;
  /** Client Protocol. */
  readonly sourceProtocol: Protocol;
  /** Frozen config revision digest. */
  readonly configRevision: string;
  /** Credential-only parsed-field redaction policy. */
  readonly redaction: "credentials-and-resolved-secrets";
  /** Warning that general payload data is protected plaintext. */
  readonly payloadProtection: "filesystem-permissions-only";
}

/** Result of one retention pass. */
export interface RetentionResult {
  /** Completed Trace directories deleted for age. */
  readonly deletedForAge: number;
  /** Completed Trace directories deleted for byte limit. */
  readonly deletedForSize: number;
  /** Active or incomplete directories skipped. */
  readonly skipped: number;
  /** Bytes of completed traces after cleanup. */
  readonly remainingBytes: number;
}

/** Operations health payload. */
export interface HealthPayload {
  /** `ok` for ready/live, `degraded` for not-ready readiness responses. */
  readonly status: "ok" | "degraded";
  /** Frozen redacted config revision. */
  readonly configRevision: string;
  /** File Trace subsystem readiness. */
  readonly traceReady: boolean;
  /** Number of configured providers with at least one enabled key. */
  readonly enabledProviderCount: number;
}

/** Input to a target-native expected-failure encoder. */
export interface ErrorEncodingInput {
  /** Client Protocol that owns the error envelope. */
  readonly protocol: Protocol;
  /** Aptus request identity exposed in a response header. */
  readonly aptusRequestId: AptusRequestId;
  /** Client-safe normalized failure. */
  readonly failure: NormalizedFailure;
}

/** Encodes expected failures without foreign provider envelopes. */
export interface ErrorEncoder {
  /** Encodes one target-native error.
   * @param input Target protocol, request identity, and normalized failure.
   * @returns Exact status, safe headers, and UTF-8 body.
   */
  encode(input: ErrorEncodingInput): EncodedFailure;
}

/** Runs retention over completed Trace directories. */
export interface TraceRetention {
  /** Deletes eligible completed traces.
   * @param nowMs Wall-clock Unix time in milliseconds.
   * @returns Counts and completed-Trace bytes after cleanup.
   * @throws Only for local filesystem I/O; the scheduler catches it and degrades Trace readiness.
   */
  run(nowMs: number): Promise<RetentionResult>;
}

/** Builds the current operations health payload without provider network I/O. */
export interface HealthReporter {
  /** Reads process-local readiness facts.
   * @returns A secret-free immutable health payload.
   */
  current(): HealthPayload;
}
