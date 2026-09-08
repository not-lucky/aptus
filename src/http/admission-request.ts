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

/** Bounded client endpoint identifiers for metrics observation. */
export type ClientEndpoint = "chat_completions" | "responses" | "messages" | "models";

/** Create-endpoint path without prefix, for GatewayRequest. */
export type CreateEndpoint = "/chat/completions" | "/responses" | "/messages";

/**
 * Dependencies for admitting one create request. Transport-owned abort and
 * clock facts are supplied by the controller; everything else is owned here.
 */
export interface AdmissionDeps {
  readonly config: AptusConfig;
  readonly revision: string;
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  readonly errorEncoder: ErrorEncoder;
  readonly traceRecorder: TraceRecorder;
  readonly observer: GatewayObservability;
  readonly clock: Clock;
  readonly limiter: AdmissionLimiter;
  readonly nameIndex: NameIndex;
  readonly modelsByName: ReadonlySet<string>;
  readonly protocol: Protocol;
  readonly endpoint: CreateEndpoint;
  readonly label: ClientEndpoint;
  readonly authPurpose: AuthPurpose;
  readonly signal: AbortSignal;
  readonly isTimeout: () => boolean;
  readonly getCancellationBy: () => "shutdown" | "client";
}

/**
 * Raw HTTP facts needed for auth and ingress. Kept separate so the admission
 * seam stays testable without Express.
 */
export interface AdmissionHttp {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[] | undefined;
  readonly message: IncomingMessage;
}

/**
 * Admitted request ready for Gateway dispatch.
 */
export interface AdmissionSuccess {
  readonly ok: true;
  readonly gatewayRequest: GatewayRequest;
  readonly trace: TraceSession;
  readonly coordinator: TerminalCoordinator;
  readonly stream: boolean;
  readonly release: () => void;
  readonly startedMs: number;
  readonly aptusRequestId: AptusRequestId;
  readonly canonicalPublicName: string;
}

/**
 * Pre-gateway rejection with an already-encoded failure.
 *
 * When `coordinator` / `finalizeFact` are present the controller must settle
 * the request once; `write` distinguishes an encoded envelope write (timeout,
 * validation, resolution failures) from a socket destroy (client cancellation
 * before headers). Pre-ID auth/limiter rejects carry neither coordinator nor
 * finalize fact.
 */
export interface AdmissionFailure {
  readonly ok: false;
  readonly write: boolean;
  readonly encoded?: EncodedFailure;
  readonly coordinator?: TerminalCoordinator;
  readonly trace?: TraceSession;
  readonly release?: () => void;
  readonly startedMs: number;
  readonly stream: boolean;
  readonly aptusRequestId?: AptusRequestId;
  readonly finalizeFact?: Omit<TerminalFact, "durationMs">;
}

export type AdmissionOutcome = AdmissionSuccess | AdmissionFailure;

function authenticationFailure(): NormalizedFailure {
  return { category: "authentication", message: "invalid authentication credentials", retryable: false };
}

function rateLimitFailure(): NormalizedFailure {
  return { category: "rate_limit", message: "too many requests", retryable: false };
}

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
 * Deep admission module: owns the full pre-gateway sequence behind a single
 * interface returning either a ready Gateway request or an already-encoded
 * failure.
 *
 * Owns auth, concurrency lease, request ID, trace start, terminal coordinator,
 * body ingress, admission telemetry, model extraction, and name resolution —
 * including all seven pre-dispatch finalize shapes and the
 * identified/unidentified envelope choice — so lifecycle faults live once
 * instead of spread across controller call sites.
 */
export async function admitCreateRequest(
  http: AdmissionHttp,
  deps: AdmissionDeps,
  clientKeySecrets: readonly { readonly name: string; readonly secret: string }[],
): Promise<AdmissionOutcome> {
  const { protocol, endpoint, label, authPurpose, signal } = deps;
  const clock = deps.clock;
  let startedMs = clock.nowMonotonicMs();

  // 1. Client authentication before reading body or taking lease.
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

  // 2. Concurrency lease.
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

  // 3. Ingress admission raced against abort.
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

  // 4. Admission telemetry and trace ingress boundary.
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

  // 5. Model extraction and resolution.
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
