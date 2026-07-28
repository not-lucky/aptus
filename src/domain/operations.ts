import type { HeaderMap, JsonObject, Protocol } from "./contracts.ts";
import type { AptusRequestId } from "./request-id.ts";

/**
 * The canonical 13-member failure category set.
 *
 * Provides a protocol-neutral taxonomy for classifying request, authentication,
 * routing, upstream provider, and transport errors.
 */
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

/**
 * A client-safe normalized failure containing classified category, safe messages, and retry metadata.
 */
export interface NormalizedFailure {
  /**
   * Stable failure category that determines HTTP status code and routing/retry policies.
   */
  readonly category: IrFailureCategory;

  /**
   * Bounded, redacted human-readable error description safe for client return.
   */
  readonly message: string;

  /**
   * Optional upstream or Aptus-specific error code/type identifier.
   */
  readonly code?: string;

  /**
   * Specific capability identifier when {@link category} is `"unsupported_capability"`; omitted otherwise.
   */
  readonly capability?: string;

  /**
   * Normalized retry delay in whole seconds when safely extractable from upstream response headers.
   */
  readonly retryAfterSeconds?: number;

  /**
   * Whether candidate routing or gateway policy permits retrying this failure on the same candidate.
   */
  readonly retryable: boolean;
}

/**
 * A protocol-native encoded expected failure ready for HTTP serialization.
 */
export interface EncodedFailure {
  /**
   * HTTP status code determined by protocol and failure category mapping.
   */
  readonly status: number;

  /**
   * Response headers containing `content-type`, `x-aptus-request-id`, and optional `retry-after`.
   */
  readonly headers: HeaderMap;

  /**
   * UTF-8 encoded protocol-native error envelope payload.
   */
  readonly body: Uint8Array;
}

/**
 * An ordered trace stage identity corresponding to a discrete point in request lifecycle.
 * Sequence numbers are assigned sequentially by the TraceSession.
 */
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

/**
 * The final terminal outcome of a request recorded in `999_terminal.json`.
 */
export type TraceTerminal =
  | {
      /** Successful completion with HTTP status and optional token usage / cost estimates. */
      readonly kind: "complete";
      readonly status: number;
      readonly usage?: JsonObject;
      readonly estimatedCostUsd?: string;
    }
  | {
      /** Request terminated with an expected domain failure. */
      readonly kind: "failed";
      readonly failure: NormalizedFailure;
    }
  | {
      /** Request cancelled by client disconnect or graceful shutdown. */
      readonly kind: "cancelled";
      readonly by: "client" | "shutdown";
    }
  | {
      /** Request was executed in dry-run mode without upstream dispatch. */
      readonly kind: "dry_run";
    }
  | {
      /** Trace aborted prematurely due to write failure, process crash, or shutdown timeout. */
      readonly kind: "incomplete";
      readonly reason: "trace_write_failed" | "process_exit" | "shutdown_abort";
    };

/**
 * Immutable manifest file (`000_manifest.json`) written at the start of every trace session.
 */
export interface TraceManifest {
  /**
   * Trace schema version. Currently pinned to `1`.
   */
  readonly schemaVersion: 1;

  /**
   * The unique Aptus request identifier.
   */
  readonly aptusRequestId: AptusRequestId;

  /**
   * RFC 3339 formatted local start timestamp.
   */
  readonly startedAt: string;

  /**
   * Protocol used by the incoming client create request.
   */
  readonly sourceProtocol: Protocol;

  /**
   * SHA-256 digest of the canonical redacted configuration active when the request started.
   */
  readonly configRevision: string;

  /**
   * Applied secret redaction policy identifier.
   */
  readonly redaction: "credentials-and-resolved-secrets";

  /**
   * Storage protection indicator noting payload confidentiality is enforced by OS file permissions (0700/0600).
   */
  readonly payloadProtection: "filesystem-permissions-only";
}

/**
 * Statistical summary of a trace retention cleanup execution.
 */
export interface RetentionResult {
  /**
   * Number of completed trace directories deleted because they exceeded maximum retention age.
   */
  readonly deletedForAge: number;

  /**
   * Number of completed trace directories deleted because total trace disk usage exceeded byte limits.
   */
  readonly deletedForSize: number;

  /**
   * Number of active or incomplete trace directories skipped during retention sweep.
   */
  readonly skipped: number;

  /**
   * Total disk size in bytes of remaining completed traces after cleanup.
   */
  readonly remainingBytes: number;
}

/**
 * Health check JSON payload returned by `/health/live`, `/health/ready`, and `/health`.
 */
export interface HealthPayload {
  /**
   * Process health status: `"ok"` when operational/live, `"degraded"` when draining or trace subsystem failed.
   */
  readonly status: "ok" | "degraded";

  /**
   * SHA-256 digest of the running redacted configuration.
   */
  readonly configRevision: string;

  /**
   * File trace subsystem readiness. `false` if startup probe failed or runtime write degradation occurred.
   */
  readonly traceReady: boolean;

  /**
   * Number of configured providers that currently have at least one enabled API key.
   */
  readonly enabledProviderCount: number;
}

/**
 * Input arguments for encoding an expected domain failure into a protocol-native response.
 */
export interface ErrorEncodingInput {
  /**
   * The client protocol that owns the error response envelope shape.
   */
  readonly protocol: Protocol;

  /**
   * The Aptus request ID to include in the `x-aptus-request-id` header and Anthropic envelope.
   */
  readonly aptusRequestId: AptusRequestId;

  /**
   * The normalized domain failure to encode.
   */
  readonly failure: NormalizedFailure;
}

/**
 * Encoder contract for serializing normalized domain failures into protocol-native envelopes.
 */
export interface ErrorEncoder {
  /**
   * Encodes a normalized domain failure into target protocol error envelope bytes and headers.
   *
   * @param input - The target protocol, request ID, and failure description.
   * @returns An {@link EncodedFailure} with exact HTTP status, safe headers, and JSON body.
   */
  encode(input: ErrorEncodingInput): EncodedFailure;
}

/**
 * Subsystem contract for sweeping expired or oversized completed trace directories.
 */
export interface TraceRetention {
  /**
   * Executes a single retention pass over the configured trace storage root.
   *
   * @param nowMs - Current wall-clock Unix time in milliseconds.
   * @returns A promise resolving to the cleanup statistics.
   * @throws Local filesystem I/O errors, which degrade trace readiness.
   */
  run(nowMs: number): Promise<RetentionResult>;
}

/**
 * Reporter contract for querying the current process-local health state without network I/O.
 */
export interface HealthReporter {
  /**
   * Reads current readiness facts.
   *
   * @returns An immutable, secret-free {@link HealthPayload}.
   */
  current(): HealthPayload;
}
