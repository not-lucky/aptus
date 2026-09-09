/**
 * @fileoverview Failure taxonomy, trace vocabulary, and small subsystem contracts.
 *
 * Defines the shared failure categories (13-member taxonomy), normalized and HTTP-encoded
 * failure envelopes, trace lifecycle stages/terminals, retention accounting, and health
 * reporting interfaces used across routing, HTTP admission, and observability.
 */

import type { HeaderMap, JsonObject, Protocol } from "./contracts.ts";
import type { AptusRequestId } from "./request-id.ts";

/**
 * The canonical thirteen-member failure category set.
 *
 * Protocol-neutral classification used to determine HTTP status code mapping,
 * retry/fallback eligibility in routing, and client error representations.
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
 * Client-safe normalized failure containing category, message, and retry metadata.
 *
 * Normalizes provider-specific and translation errors into a safe representation
 * with internal paths and credentials redacted.
 */
export interface NormalizedFailure {
  /** Stable failure category determining HTTP status mapping and retry eligibility. */
  readonly category: IrFailureCategory;

  /** Redacted, bounded human-readable error description safe for client return. */
  readonly message: string;

  /** Optional upstream provider error code or internal marker. */
  readonly code?: string;

  /** Specific matrix row ID when category is `"unsupported_capability"`. */
  readonly capability?: string;

  /** Parsed retry delay in seconds from upstream `Retry-After` headers, if present. */
  readonly retryAfterSeconds?: number;

  /** Upstream request identifier echoed on provider error responses, if available. */
  readonly requestId?: string;

  /** Whether routing policy permits retrying this failure against the same provider candidate. */
  readonly retryable: boolean;
}

/**
 * Protocol-native encoded failure payload and headers ready for HTTP serialization.
 */
export interface EncodedFailure {
  /** HTTP response status code (4xx or 5xx). */
  readonly status: number;

  /** Filtered response headers containing content type, request ID, and optional retry delay. */
  readonly headers: HeaderMap;

  /** UTF-8 encoded protocol-native error envelope payload. */
  readonly body: Uint8Array;
}

/**
 * Ordered trace stage identifier marking a discrete step in the request lifecycle.
 */
export type TraceStage =
  | "client_request"
  | "authentication"
  | "resolution"
  | "candidate_skip"
  | "translation_ingress"
  | "ir_request"
  | "translation_egress"
  | "translation_failure"
  | "mutation"
  | "preflight"
  | "key_selection"
  | "provider_request"
  | "provider_response_head"
  | "provider_response"
  | "provider_stream"
  | "ir_outcome"
  | "ir_events"
  | "client_response"
  | "client_stream"
  | "retry"
  | "fallback"
  | "cancellation"
  | "trace_failure";

/**
 * Final terminal state of a request recorded in `999_terminal.json`.
 */
export type TraceTerminal =
  | {
      /** Successful request completion with status, token usage, and cost estimate. */
      readonly kind: "complete";
      readonly status: number;
      readonly usage?: JsonObject;
      readonly estimatedCostUsd?: string;
    }
  | {
      /** Request terminated with an expected normalized domain failure. */
      readonly kind: "failed";
      readonly failure: NormalizedFailure;
    }
  | {
      /** Request cancelled by client disconnect or graceful server shutdown. */
      readonly kind: "cancelled";
      readonly by: "client" | "shutdown";
    }
  | {
      /** Request executed in dry-run mode without upstream network dispatch. */
      readonly kind: "dry_run";
    }
  | {
      /** Trace aborted prematurely due to write failure, process crash, shutdown, or fault. */
      readonly kind: "incomplete";
      readonly reason: "trace_write_failed" | "process_exit" | "shutdown_abort" | "internal_fault";
    };

/**
 * Session header written to `000_manifest.json` at the start of every trace session.
 */
export interface TraceManifest {
  /** Trace schema format version, currently pinned to `1`. */
  readonly schemaVersion: 1;

  /** Unique request identifier matching the `x-aptus-request-id` response header. */
  readonly aptusRequestId: AptusRequestId;

  /** RFC 3339 timestamp recording when the trace session opened. */
  readonly startedAt: string;

  /** Client wire protocol accepted at ingress (`openai-chat`, `openai-responses`, `anthropic-messages`). */
  readonly sourceProtocol: Protocol;

  /** SHA-256 hash of the redacted active configuration at request start. */
  readonly configRevision: string;

  /** Guarantee marker declaring credential and secret redaction policy. */
  readonly redaction: "credentials-and-resolved-secrets";

  /** Payload confidentiality model relying on filesystem permissions (`0700`/`0600`). */
  readonly payloadProtection: "filesystem-permissions-only";
}

/**
 * Statistics reported by a trace retention cleanup pass.
 */
export interface RetentionResult {
  /** Completed trace sessions purged due to exceeding maximum retention age. */
  readonly deletedForAge: number;

  /** Oldest-first completed trace sessions purged to satisfy the total size budget. */
  readonly deletedForSize: number;

  /** Active or incomplete sessions skipped to prevent corrupting in-flight requests. */
  readonly skipped: number;

  /** Total disk bytes of surviving completed trace sessions after cleanup. */
  readonly remainingBytes: number;

  /** Total disk bytes occupied by active or incomplete trace directories. */
  readonly incompleteBytes: number;
}

/**
 * Process health status payload served at `/health`, `/health/live`, and `/health/ready`.
 */
export interface HealthPayload {
  /** Operational health status (`ok` when live and routable, `degraded` during shutdown drain or trace failure). */
  readonly status: "ok" | "degraded";

  /** SHA-256 digest of active running redacted configuration. */
  readonly configRevision: string;

  /** File trace subsystem readiness flag (false if startup probe failed or degraded). */
  readonly traceReady: boolean;

  /** Number of configured providers that currently have at least one usable API key. */
  readonly enabledProviderCount: number;
}

/**
 * Input arguments for encoding a normalized domain failure into a protocol-native response.
 */
export interface ErrorEncodingInput {
  /** Target client wire protocol for envelope formatting. */
  readonly protocol: Protocol;

  /** Request identifier to echo in headers and payload. */
  readonly aptusRequestId: AptusRequestId;

  /** Normalized failure containing category, message, and retry details. */
  readonly failure: NormalizedFailure;
}

/**
 * Encoder contract for rendering normalized domain failures into wire-ready HTTP responses.
 */
export interface ErrorEncoder {
  /**
   * Encodes a normalized domain failure into wire headers and response body.
   *
   * @param input - Client protocol, request ID, and failure description.
   * @returns An {@link EncodedFailure} with HTTP status, headers, and UTF-8 JSON body.
   */
  encode(input: ErrorEncodingInput): EncodedFailure;
}

/**
 * Subsystem contract for sweeping expired or oversized completed trace directories.
 */
export interface TraceRetention {
  /**
   * Executes a retention cleanup sweep against the trace directory root.
   *
   * Deletes expired traces by age and enforces overall storage budgets.
   *
   * @param nowMs - Current epoch time in milliseconds.
   * @returns A promise resolving to cleanup metrics in {@link RetentionResult}.
   */
  run(nowMs: number): Promise<RetentionResult>;
}

/**
 * Reporter contract for querying local process readiness without network I/O.
 */
export interface HealthReporter {
  /**
   * Reads current health and readiness facts.
   *
   * @returns A snapshot {@link HealthPayload} without secrets or credentials.
   */
  current(): HealthPayload;
}

/**
 * Maps gateway failure categories to Anthropic wire error types.
 *
 * Provides a canonical mapping shared by HTTP error envelopes and in-band stream events.
 *
 * @param category - Domain failure category or `"internal"` fault marker.
 * @returns The matching Anthropic wire error type string (e.g. `"invalid_request_error"`).
 */
export function anthropicErrorType(category: IrFailureCategory | "internal"): string {
  switch (category) {
    case "invalid_request":
    case "unsupported_capability":
      return "invalid_request_error";
    case "payload_too_large":
      return "request_too_large";
    case "authentication":
      return "authentication_error";
    case "permission":
      return "permission_error";
    case "not_found":
      return "not_found_error";
    case "conflict":
      return "conflict_error";
    case "rate_limit":
    case "quota":
      return "rate_limit_error";
    case "timeout":
      return "timeout_error";
    case "unavailable":
      return "overloaded_error";
    default:
      return "api_error";
  }
}
