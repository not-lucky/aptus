/**
 * @fileoverview
 * Pre-gateway admission pipeline for create endpoints (`/chat/completions`, `/responses`, `/messages`).
 *
 * Coordinates client authentication, concurrency lease acquisition, request identity minting,
 * trace session creation, payload ingress with abort racing, telemetry emission, and model extraction
 * with authorized route resolution.
 *
 * Returns either an admitted {@link GatewayRequest} ready for dispatch or an {@link AdmissionFailure}
 * containing an encoded error envelope and terminal coordination fact.
 */

import type { IncomingMessage } from "node:http";
import type { AptusConfig } from "../config/types.ts";
import type {
  GatewayRequest,
  HeaderMap,
  JsonObject,
  Protocol,
  ProtocolAdapter,
  TerminalCoordinator,
  TerminalFact,
  TraceRecorder,
  TraceSession,
} from "../domain/contracts.ts";
import type { EncodedFailure, ErrorEncoder, NormalizedFailure } from "../domain/operations.ts";
import type { AptusRequestId } from "../domain/request-id.ts";
import { createRequestId } from "../domain/request-id.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import { failureJson, notFoundFailure, statusFromCategory, timeoutFailure } from "../routing/failures.ts";
import { authorizePublicName, type NameIndex } from "../routing/resolution.ts";
import type { Clock } from "../routing/timing.ts";
import { raceWithAbort } from "./abort-race.ts";
import type { AdmissionLimiter } from "./admission.ts";
import { type AuthPurpose, authenticateClient } from "./auth.ts";
import { createTerminalCoordinator } from "./coordinator.ts";
import { encodeUnidentifiedFailure } from "./error-encoder.ts";
import { admitJsonObject } from "./ingress.ts";

/** Bounded endpoint label for metrics and admission telemetry. */
export type ClientEndpoint = "chat_completions" | "responses" | "messages" | "models";

/** Create-endpoint path without the version prefix, carried by the gateway request. */
export type CreateEndpoint = "/chat/completions" | "/responses" | "/messages";

/** Dependencies required to admit an incoming create request. */
export interface AdmissionDeps {
  /** Active configuration snapshot for body limits, proxy trust, and client keys. */
  readonly config: AptusConfig;
  /** Short revision digest of the configuration snapshot for trace manifests. */
  readonly revision: string;
  /** Protocol adapters keyed by protocol identifier for reading requested model names. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Protocol-native error encoder for formatting identified failure envelopes. */
  readonly errorEncoder: ErrorEncoder;
  /** Trace recorder used to open the per-request trace session. */
  readonly traceRecorder: TraceRecorder;
  /** Telemetry observer for lifecycle and admission events. */
  readonly observer: GatewayObservability;
  /** Clock source for monotonic durations and wall-clock trace directory naming. */
  readonly clock: Clock;
  /** Process-local concurrency limiter for acquiring admission leases. */
  readonly limiter: AdmissionLimiter;
  /** Precomputed name and authorization index for routing lookup. */
  readonly nameIndex: NameIndex;
  /** Set of canonical model names used to distinguish model targets from routes. */
  readonly modelsByName: ReadonlySet<string>;
  /** Client protocol handled by the receiving endpoint. */
  readonly protocol: Protocol;
  /** Create-endpoint path without version prefix. */
  readonly endpoint: CreateEndpoint;
  /** Telemetry endpoint label for ingress metric counters. */
  readonly label: ClientEndpoint;
  /** Credential scheme required by the endpoint. */
  readonly authPurpose: AuthPurpose;
  /** Composed abort signal combining request deadlines, client disconnects, and shutdown. */
  readonly signal: AbortSignal;
  /** Reader reporting whether an abort was triggered by deadline expiry. */
  readonly isTimeout: () => boolean;
  /** Reader identifying whether an abort was caused by server shutdown or client disconnect. */
  readonly getCancellationBy: () => "shutdown" | "client";
}

/** Transport-level HTTP request objects and headers required for admission. */
export interface AdmissionHttp {
  /** Parsed request headers with lowercase keys. */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Raw alternating header names and values from Node.js for duplicate header detection. */
  readonly rawHeaders: readonly string[] | undefined;
  /** Incoming readable message stream for body consumption. */
  readonly message: IncomingMessage;
}

/** Successful admission outcome carrying a dispatch-ready gateway request and session state. */
export interface AdmissionSuccess {
  /** Discriminant indicating successful admission. */
  readonly ok: true;
  /** Validated gateway request ready for dispatch. */
  readonly gatewayRequest: GatewayRequest;
  /** Open trace session for dispatch and relay recording. */
  readonly trace: TraceSession;
  /** Terminal coordinator tracking lifecycle stages and final outcome. */
  readonly coordinator: TerminalCoordinator;
  /** Whether streaming was explicitly requested in the payload. */
  readonly stream: boolean;
  /** Lease release callback to free the concurrency slot once settled. */
  readonly release: () => void;
  /** Monotonic start timestamp in milliseconds following admission. */
  readonly startedMs: number;
  /** Minted unique request identifier. */
  readonly aptusRequestId: AptusRequestId;
  /** Resolved canonical public model or route name. */
  readonly canonicalPublicName: string;
}

/** Pre-gateway rejection outcome with pre-encoded failure envelope and cleanup state. */
export interface AdmissionFailure {
  /** Discriminant indicating admission rejection. */
  readonly ok: false;
  /** Whether an HTTP error response should be written to the client. */
  readonly write: boolean;
  /** Pre-encoded error envelope, if a response should be emitted. */
  readonly encoded?: EncodedFailure;
  /** Terminal coordinator if created before rejection occurred. */
  readonly coordinator?: TerminalCoordinator;
  /** Open trace session if created before rejection occurred. */
  readonly trace?: TraceSession;
  /** Lease release callback if a concurrency slot was acquired. */
  readonly release?: () => void;
  /** Monotonic start timestamp in milliseconds. */
  readonly startedMs: number;
  /** Stream flag known at rejection time. */
  readonly stream: boolean;
  /** Minted request identifier if generated before rejection. */
  readonly aptusRequestId?: AptusRequestId;
  /** Partial terminal fact for lifecycle accounting through the coordinator. */
  readonly finalizeFact?: Omit<TerminalFact, "durationMs">;
}

/** Result union of the create admission pipeline. */
export type AdmissionOutcome = AdmissionSuccess | AdmissionFailure;

/** Constructs a normalized authentication failure representation. */
function authenticationFailure(): NormalizedFailure {
  return { category: "authentication", message: "invalid authentication credentials", retryable: false };
}

/** Constructs a normalized concurrency rate limit failure representation. */
function rateLimitFailure(): NormalizedFailure {
  return { category: "rate_limit", message: "too many requests", retryable: false };
}

/**
 * Formats a Date object into a filesystem-safe directory timestamp (`YYYY-MM-DDTHH-mm-ss.SSS±ZZZZ`).
 *
 * @param date - Wall-clock timestamp to format.
 * @returns Filesystem-safe timestamp string.
 */
function formatTraceDirectoryTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}

/**
 * Executes the pre-gateway admission sequence for an incoming create request.
 *
 * Performs client authentication, concurrency limiting, identity minting, trace and coordinator
 * setup, body streaming with abort racing, and target model resolution.
 *
 * @param http - Transport-level HTTP request objects and headers.
 * @param deps - Gateway dependencies and endpoint configuration.
 * @param clientKeySecrets - Configured client API credentials for authentication.
 * @returns Admitted request bundle on success, or an encoded failure with cleanup hooks on rejection.
 */
export async function admitCreateRequest(
  http: AdmissionHttp,
  deps: AdmissionDeps,
  clientKeySecrets: readonly { readonly name: string; readonly secret: string }[],
): Promise<AdmissionOutcome> {
  const { protocol, endpoint, label, authPurpose, signal } = deps;
  const clock = deps.clock;
  let startedMs = clock.nowMonotonicMs();

  // Authenticate the client first, before reading the body or acquiring a lease, to keep rejections cheap.
  const authentication = authenticateClient(
    http.headers as Parameters<typeof authenticateClient>[0],
    clientKeySecrets as Parameters<typeof authenticateClient>[1],
    authPurpose,
    http.rawHeaders,
  );
  if (authentication === undefined) {
    return {
      ok: false,
      write: true,
      encoded: encodeUnidentifiedFailure(protocol, authenticationFailure()),
      startedMs,
      stream: false,
    };
  }

  // Acquire one concurrency lease and reject with a rate limit failure when the server is saturated.
  const release = deps.limiter.tryAcquire();
  if (release === undefined) {
    return {
      ok: false,
      write: true,
      encoded: encodeUnidentifiedFailure(protocol, rateLimitFailure()),
      startedMs,
      stream: false,
    };
  }

  const aptusRequestId = createRequestId();
  startedMs = clock.nowMonotonicMs();

  const trace = await deps.traceRecorder.start({
    aptusRequestId,
    startedAtLocal: formatTraceDirectoryTimestamp(clock.nowWall()),
    configRevision: deps.revision,
    sourceProtocol: protocol,
  });

  const coordinator = createTerminalCoordinator({
    aptusRequestId,
    endpointProtocol: protocol,
    startedMs,
    trace,
    observer: deps.observer,
    clock,
  });

  // Race body ingress against the abort signal so disconnects, deadlines, and shutdown interrupt the read.
  const admissionRace = await raceWithAbort(
    admitJsonObject(http.message, deps.config.server.bodyLimitBytes, deps.config.server.trustedProxyCidrs),
    signal,
  );

  if (admissionRace.aborted || signal.aborted) {
    const timeout = deps.isTimeout();
    if (timeout) {
      coordinator.markClientFirstByte();
    }
    const by = deps.getCancellationBy();
    if (!timeout) {
      deps.observer.cancelled({ aptusRequestId, phase: "admission", by });
      await trace.recordJson("cancellation", { phase: "admission", by });
    }
    const terminal = timeout
      ? ({ kind: "failed", failure: timeoutFailure() } as const)
      : ({ kind: "cancelled", by } as const);
    if (!timeout) {
      return {
        ok: false,
        write: false,
        coordinator,
        trace,
        release,
        startedMs,
        stream: false,
        aptusRequestId,
        finalizeFact: {
          terminal,
          outcomeCategory: "cancelled",
          status: 499,
          attempts: coordinator.getAttempts(),
          stream: false,
          canonicalPublicName: "unknown",
        },
      };
    }
    return {
      ok: false,
      write: true,
      encoded: deps.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }),
      coordinator,
      trace,
      release,
      startedMs,
      stream: false,
      aptusRequestId,
      finalizeFact: {
        terminal,
        outcomeCategory: "failed",
        status: 504,
        attempts: coordinator.getAttempts(),
        stream: false,
        canonicalPublicName: "unknown",
      },
    };
  }

  const admission = admissionRace.value;
  if (!admission.ok) {
    const failure = { ...admission.failure, retryable: false as const };
    return {
      ok: false,
      write: true,
      encoded: encodeUnidentifiedFailure(protocol, failure),
      coordinator,
      trace,
      release,
      startedMs,
      stream: false,
      aptusRequestId,
      finalizeFact: {
        terminal: { kind: "failed", failure },
        outcomeCategory: "failed",
        status: statusFromCategory(failure.category, protocol),
        attempts: coordinator.getAttempts(),
        stream: false,
        canonicalPublicName: "unknown",
      },
    };
  }

  const streamRequested = (admission.body as JsonObject & { stream?: unknown }).stream === true;

  // Record admission telemetry and the trace ingress boundary now that the body is validated.
  deps.observer.requestIngress({
    aptusRequestId,
    endpointProtocol: protocol,
    endpoint: label,
    stream: streamRequested,
  });
  coordinator.markIngress(streamRequested);
  deps.observer.observe({
    type: "request_ingress",
    aptusRequestId,
    sourceProtocol: protocol,
    stream: streamRequested,
  });
  await trace.recordJson("client_request", { headers: admission.headers as HeaderMap, body: admission.body });

  const scheme = authentication.kind === "api-key" ? "x-api-key" : "bearer";
  await trace.recordJson("authentication", { scheme, clientKeyName: authentication.name });
  deps.observer.authResult({ aptusRequestId, scheme, result: "ok" });

  // Extract the public model name with the protocol adapter and reject bodies without a usable model field.
  const publicNameResult = deps.adapters[protocol].readPublicModel(admission.body);
  if (!publicNameResult.ok) {
    await trace.recordJson("resolution", { failure: failureJson(publicNameResult.error) });
    coordinator.markClientFirstByte();
    return {
      ok: false,
      write: true,
      encoded: deps.errorEncoder.encode({ protocol, aptusRequestId, failure: publicNameResult.error }),
      coordinator,
      trace,
      release,
      startedMs,
      stream: streamRequested,
      aptusRequestId,
      finalizeFact: {
        terminal: { kind: "failed", failure: publicNameResult.error },
        outcomeCategory: "failed",
        status: 400,
        attempts: coordinator.getAttempts(),
        stream: streamRequested,
        canonicalPublicName: "unknown",
        emitCompleted: false,
      },
    };
  }

  const canonicalPublicName = authorizePublicName(deps.nameIndex, authentication.name, publicNameResult.value);
  if (canonicalPublicName === undefined) {
    const failure = notFoundFailure();
    await trace.recordJson("resolution", { requested: publicNameResult.value });
    coordinator.markClientFirstByte();
    return {
      ok: false,
      write: true,
      encoded: deps.errorEncoder.encode({ protocol, aptusRequestId, failure }),
      coordinator,
      trace,
      release,
      startedMs,
      stream: streamRequested,
      aptusRequestId,
      finalizeFact: {
        terminal: { kind: "failed", failure },
        outcomeCategory: "failed",
        status: 404,
        attempts: coordinator.getAttempts(),
        stream: streamRequested,
        canonicalPublicName: "unknown",
        emitCompleted: false,
      },
    };
  }

  const resolutionKind = deps.modelsByName.has(canonicalPublicName) ? ("model" as const) : ("route" as const);
  await trace.recordJson("resolution", {
    publicName: publicNameResult.value,
    canonicalPublicName,
    kind: resolutionKind,
  });
  deps.observer.nameResolved({ aptusRequestId, canonicalPublicName, kind: resolutionKind });

  const gatewayRequest = {
    aptusRequestId,
    protocol,
    endpoint,
    headers: admission.headers,
    body: admission.body,
    clientKeyName: authentication.name,
    signal,
    canonicalPublicName,
    resolutionKind,
    stream: streamRequested,
    coordinator,
    trace,
  } as GatewayRequest;

  return {
    ok: true,
    gatewayRequest,
    trace,
    coordinator,
    stream: streamRequested,
    release,
    startedMs,
    aptusRequestId,
    canonicalPublicName,
  };
}
