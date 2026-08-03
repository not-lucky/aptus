import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import express, { type Request, type Response } from "express";
import type { AptusConfig } from "../config/types.ts";
import type {
  Gateway,
  GatewayResult,
  HeaderMap,
  Protocol,
  ProtocolAdapter,
  TerminalCoordinator,
  TraceRecorder,
} from "../domain/contracts.ts";
import type { ErrorEncoder, NormalizedFailure, TraceTerminal } from "../domain/operations.ts";
import { type AptusRequestId, createRequestId } from "../domain/request-id.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import type { Redactor } from "../observability/trace/redaction.ts";
import { failureJson, notFoundFailure, statusFromCategory } from "../routing/failures.ts";
import { authorizePublicName, createNameIndex, type NameIndex } from "../routing/resolution.ts";
import { type Clock, systemClock } from "../routing/timing.ts";
import { type AdmissionLimiter, createAdmissionLimiter } from "./admission.ts";
import { type AuthPurpose, authenticateClient } from "./auth.ts";
import { authorizedCatalogEntries } from "./catalog.ts";
import { createTerminalCoordinator } from "./coordinator.ts";
import {
  encodeInternalFailure,
  encodeUnidentifiedFailure,
  encodeUnidentifiedInternalFailure,
  filterResponseHeaders,
} from "./error-encoder.ts";
import { admitJsonObject } from "./ingress.ts";
import type { RequestCancellationRegistry } from "./request-cancellation.ts";

/** Bounded client endpoint identifiers for metrics observation. */
export type ClientEndpoint = "chat_completions" | "responses" | "messages" | "models";

/** Lifecycle outcome of a client request for telemetry. */
export type ClientOutcome = "complete" | "failed" | "cancelled";

/**
 * Initialization options for constructing the authenticated client Express application.
 */
export interface ClientAppOptions {
  /** Active configuration snapshot. */
  readonly config: AptusConfig;
  /** SHA-256 config revision digest recorded in trace manifests. */
  readonly revision: string;
  /** Gateway domain contract for dispatching admitted requests. */
  readonly gateway: Gateway;
  /** Dictionary of protocol adapters keyed by protocol identifier. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Protocol-native error encoder for serializing domain failures. */
  readonly errorEncoder: ErrorEncoder;
  /** Trace recorder for opening per-request trace sessions. */
  readonly traceRecorder: TraceRecorder;
  /** Shared telemetry observer for structured logs and metrics. */
  readonly observer: GatewayObservability;
  /** Optional monotonic and wall clock source. */
  readonly clock?: Clock;
  /** Optional field-aware secret redactor. */
  readonly redactor?: Redactor;
  /** Optional concurrency limiter (defaults to server config `maxInFlight`). */
  readonly limiter?: AdmissionLimiter;
  /** Optional cancellation registry for managing active request abort signals during shutdown. */
  readonly cancellations?: RequestCancellationRegistry;
  /** Optional process-global shutdown abort signal composed into each request. */
  readonly shutdownSignal?: AbortSignal;
}

type CreateEndpoint = "/chat/completions" | "/responses" | "/messages";

/**
 * Instantiates the Express application for the authenticated client listener.
 *
 * Routes:
 * - `POST /chat/completions` & `POST /v1/chat/completions`: OpenAI chat completions
 * - `POST /responses` & `POST /v1/responses`: OpenAI responses API
 * - `POST /messages` & `POST /v1/messages`: Anthropic messages API
 * - `GET /models` & `GET /v1/models`: Model catalog listing
 *
 * @param options - Application construction options.
 * @returns Configured Express application.
 */
export function createClientApp(options: ClientAppOptions): express.Express {
  const app = express();
  const limiter = options.limiter ?? createAdmissionLimiter(options.config.server.maxInFlight);
  const nameIndex = createNameIndex(options.config);
  const modelsByName = new Set(options.config.models.map((m) => m.name));

  mountCreate(
    app,
    options,
    limiter,
    nameIndex,
    modelsByName,
    ["/chat/completions", "/v1/chat/completions"],
    "openai-chat",
    "/chat/completions",
    "chat_completions",
    "openai-create",
  );
  mountCreate(
    app,
    options,
    limiter,
    nameIndex,
    modelsByName,
    ["/responses", "/v1/responses"],
    "openai-responses",
    "/responses",
    "responses",
    "openai-create",
  );
  mountCreate(
    app,
    options,
    limiter,
    nameIndex,
    modelsByName,
    ["/messages", "/v1/messages"],
    "anthropic-messages",
    "/messages",
    "messages",
    "messages-create",
  );
  app.get(["/models", "/v1/models"], catalogController(options, nameIndex));
  app.use((_request, response) => response.status(404).end());
  return app;
}

/**
 * Mounts a POST create endpoint across alias paths.
 */
function mountCreate(
  app: express.Express,
  options: ClientAppOptions,
  limiter: AdmissionLimiter,
  nameIndex: NameIndex,
  modelsByName: ReadonlySet<string>,
  paths: readonly string[],
  protocol: Protocol,
  endpoint: CreateEndpoint,
  label: ClientEndpoint,
  authPurpose: AuthPurpose,
): void {
  app.post(
    [...paths],
    createController(options, limiter, nameIndex, modelsByName, protocol, endpoint, label, authPurpose),
  );
}

/**
 * Constructs the request lifecycle handler for create endpoints.
 */
function createController(
  options: ClientAppOptions,
  limiter: AdmissionLimiter,
  nameIndex: NameIndex,
  modelsByName: ReadonlySet<string>,
  protocol: Protocol,
  endpoint: CreateEndpoint,
  label: ClientEndpoint,
  authPurpose: AuthPurpose,
): (request: Request, response: Response) => Promise<void> {
  const clock = options.clock ?? systemClock;

  return async (request, response) => {
    const perRequest = new AbortController();
    const requestAborted = (): void => perRequest.abort("client");
    const responseClosed = (): void => {
      if (!response.writableEnded) perRequest.abort("client");
    };
    request.once("aborted", requestAborted);
    response.once("close", responseClosed);

    let deadline: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    let aptusRequestId: AptusRequestId | undefined;
    let release: (() => void) | undefined;
    let unregisterCancellation: (() => void) | undefined;
    let coordinator: TerminalCoordinator | undefined;
    let streamRequested = false;
    let startedMs = clock.nowMonotonicMs();
    let canonicalPublicName: string | undefined;

    const signal = options.shutdownSignal
      ? AbortSignal.any([perRequest.signal, options.shutdownSignal])
      : perRequest.signal;

    const getCancellationBy = (): "shutdown" | "client" => {
      return signal.reason === "shutdown" ? "shutdown" : "client";
    };

    const isTimeout = (): boolean => {
      return deadlineExpired || signal.reason === "timeout";
    };

    try {
      // 1. Client authentication: Validate Bearer token or x-api-key before reading body or taking lease.
      const authentication = authenticateClient(
        request.headers,
        options.config.auth.clientKeys,
        authPurpose,
        request.rawHeaders,
      );
      if (authentication === undefined) {
        writeEncoded(response, encodeUnidentifiedFailure(protocol, authenticationFailure()));
        return;
      }

      // 2. Concurrency lease: Reject with 429 if maxInFlight limit is exceeded.
      release = limiter.tryAcquire();
      if (release === undefined) {
        writeEncoded(response, encodeUnidentifiedFailure(protocol, rateLimitFailure()));
        return;
      }

      aptusRequestId = createRequestId();
      startedMs = clock.nowMonotonicMs();

      deadline = setTimeout(() => {
        deadlineExpired = true;
        perRequest.abort("timeout");
      }, options.config.server.requestDeadlineMs);

      // Start Trace session
      const trace = await options.traceRecorder.start({
        aptusRequestId,
        startedAtLocal: formatTraceDirectoryTimestamp(clock.nowWall()),
        configRevision: options.revision,
        sourceProtocol: protocol,
      });

      // Create request-scoped terminal coordinator
      coordinator = createTerminalCoordinator({
        aptusRequestId,
        endpointProtocol: protocol,
        startedMs,
        trace,
        observer: options.observer,
        clock,
        redactor: options.redactor,
      });

      unregisterCancellation = options.cancellations?.register(perRequest, coordinator.finalized);

      // 3. Ingress admission: Stream body, enforce byte limits, validate UTF-8 & duplicate-free JSON.
      const admissionRace = await raceWithAbort(
        admitJsonObject(
          request as IncomingMessage,
          options.config.server.bodyLimitBytes,
          options.config.server.trustedProxyCidrs,
        ),
        signal,
      );

      if (admissionRace.aborted || signal.aborted) {
        const timeout = isTimeout();
        if (timeout && !response.headersSent) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
          coordinator.markClientFirstByte();
        } else if (!response.destroyed) {
          response.destroy();
        }
        const by = getCancellationBy();
        if (!timeout) {
          options.observer.cancelled({ aptusRequestId, phase: "admission", by });
          await trace.recordJson("cancellation", { phase: "admission", by });
        }
        const terminal = timeout
          ? ({ kind: "failed", failure: timeoutFailure() } as const)
          : ({ kind: "cancelled", by } as const);
        await coordinator.finalize({
          terminal,
          outcomeCategory: timeout ? "failed" : "cancelled",
          status: timeout ? 504 : 499,
          attempts: coordinator.getAttempts(),
          stream: false,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName: "unknown",
        });
        await coordinator.finalized;
        return;
      }

      const admission = admissionRace.value;
      if (!admission.ok) {
        const failure = { ...admission.failure, retryable: false };
        writeEncoded(response, encodeUnidentifiedFailure(protocol, failure));
        // Close the already-started Trace session so rejected bodies do not
        // leak manifest-only directories that retention can never age-evict.
        await coordinator.finalize({
          terminal: { kind: "failed", failure },
          outcomeCategory: "failed",
          status: statusFromCategory(failure.category, protocol),
          attempts: coordinator.getAttempts(),
          stream: false,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName: "unknown",
        });
        await coordinator.finalized;
        return;
      }

      streamRequested = admission.body.stream === true;

      // 4. Request admission telemetry & trace ingress
      options.observer.requestIngress({
        aptusRequestId,
        endpointProtocol: protocol,
        endpoint: label,
        stream: streamRequested,
      });
      coordinator.markIngress(streamRequested);
      options.observer.observe({
        type: "request_ingress",
        aptusRequestId,
        sourceProtocol: protocol,
        stream: streamRequested,
      });
      await trace.recordJson("client_request", { headers: admission.headers, body: admission.body });

      const scheme = authentication.kind === "api-key" ? "x-api-key" : "bearer";
      await trace.recordJson("authentication", { scheme, clientKeyName: authentication.name });
      options.observer.authResult({ aptusRequestId, scheme, result: "ok" });

      // 5. Model extraction & resolution
      const publicNameResult = options.adapters[protocol].readPublicModel(admission.body);
      if (!publicNameResult.ok) {
        await trace.recordJson("resolution", { failure: failureJson(publicNameResult.error) });
        writeEncoded(
          response,
          options.errorEncoder.encode({ protocol, aptusRequestId, failure: publicNameResult.error }),
        );
        coordinator.markClientFirstByte();
        await coordinator.finalize({
          terminal: { kind: "failed", failure: publicNameResult.error },
          outcomeCategory: "failed",
          status: 400,
          attempts: coordinator.getAttempts(),
          stream: streamRequested,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName: "unknown",
          emitCompleted: false,
        });
        await coordinator.finalized;
        return;
      }

      canonicalPublicName = authorizePublicName(nameIndex, authentication.name, publicNameResult.value);
      if (canonicalPublicName === undefined) {
        const failure = notFoundFailure();
        await trace.recordJson("resolution", { requested: publicNameResult.value });
        writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure }));
        coordinator.markClientFirstByte();
        await coordinator.finalize({
          terminal: { kind: "failed", failure },
          outcomeCategory: "failed",
          status: 404,
          attempts: coordinator.getAttempts(),
          stream: streamRequested,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName: "unknown",
          emitCompleted: false,
        });
        await coordinator.finalized;
        return;
      }

      const resolutionKind = modelsByName.has(canonicalPublicName) ? "model" : "route";
      await trace.recordJson("resolution", {
        publicName: publicNameResult.value,
        canonicalPublicName,
        kind: resolutionKind,
      });
      options.observer.nameResolved({ aptusRequestId, canonicalPublicName, kind: resolutionKind });

      // 6. Gateway execution
      const gatewayResult = await raceWithAbort(
        options.gateway.execute({
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
        }),
        signal,
      );

      if (gatewayResult.aborted || signal.aborted) {
        const timeout = isTimeout();
        if (timeout && !response.headersSent) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
          coordinator.markClientFirstByte();
        } else if (!response.destroyed) {
          response.destroy();
        }
        const by = getCancellationBy();
        const terminal = timeout
          ? ({ kind: "failed", failure: timeoutFailure() } as const)
          : ({ kind: "cancelled", by } as const);
        await coordinator.finalize({
          terminal,
          outcomeCategory: timeout ? "failed" : "cancelled",
          status: timeout ? 504 : 499,
          attempts: coordinator.getAttempts(),
          stream: streamRequested,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName,
        });
        await coordinator.finalized;
        return;
      }

      // 7. Response serialization and delivery
      const delivery = await writeGatewayResult(
        response,
        gatewayResult.value,
        protocol,
        aptusRequestId,
        options.errorEncoder,
        signal,
        coordinator,
        canonicalPublicName,
        startedMs,
        clock,
        trace,
      );

      if (delivery === "aborted" && !response.destroyed) {
        response.destroy();
      }

      // Fallback finalization in case gateway didn't finalize (e.g., test mocks).
      // Emit cancellation telemetry only when the gateway could not observe the
      // abort itself: complete-body delivery reads the owned body here, so a
      // mid-delivery disconnect is invisible to the Gateway. `cancelled` results
      // (attempt/spool seams) and stream relays already emitted their single
      // `aptus.request.cancelled` + trace cancellation stage before returning,
      // so emitting again here would duplicate both.
      const timeout = isTimeout();
      const by = getCancellationBy();
      if (delivery === "aborted" && !timeout && gatewayResult.value.kind === "complete") {
        options.observer.cancelled({ aptusRequestId, phase: "relay", by });
        await trace.recordJson("cancellation", { phase: "relay", by });
      }
      const terminal: TraceTerminal =
        delivery === "aborted"
          ? timeout
            ? { kind: "failed", failure: timeoutFailure() }
            : { kind: "cancelled", by }
          : { kind: "complete", status: response.statusCode || 200 };
      await coordinator.finalize({
        terminal,
        outcomeCategory:
          delivery === "aborted"
            ? timeout
              ? "failed"
              : "cancelled"
            : response.statusCode >= 400
              ? "failed"
              : "complete",
        status: delivery === "aborted" ? (timeout ? 504 : 499) : response.statusCode || 200,
        attempts: coordinator.getAttempts(),
        stream: streamRequested,
        durationMs: clock.nowMonotonicMs() - startedMs,
        canonicalPublicName,
      });

      await coordinator.finalized;
    } catch {
      if (!response.headersSent && !response.destroyed) {
        if (isTimeout() && aptusRequestId !== undefined) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
        } else if (!signal.aborted) {
          writeEncoded(
            response,
            aptusRequestId === undefined
              ? encodeUnidentifiedInternalFailure(protocol)
              : encodeInternalFailure(protocol, aptusRequestId),
          );
        }
      } else if (!response.destroyed) {
        response.destroy();
      }
      if (coordinator !== undefined) {
        await coordinator.finalize({
          terminal: { kind: "incomplete", reason: "internal_fault" },
          outcomeCategory: "failed",
          status: 500,
          attempts: coordinator.getAttempts(),
          stream: streamRequested,
          durationMs: clock.nowMonotonicMs() - startedMs,
          canonicalPublicName: canonicalPublicName ?? "unknown",
        });
      }
    } finally {
      clearTimeout(deadline);
      request.off("aborted", requestAborted);
      response.off("close", responseClosed);
      release?.();
      unregisterCancellation?.();
    }
  };
}

/**
 * Controller for GET `/models` and `/v1/models` catalog endpoints.
 */
function catalogController(
  options: ClientAppOptions,
  nameIndex: NameIndex,
): (request: Request, response: Response) => void {
  return (request, response) => {
    const authentication = authenticateClient(
      request.headers,
      options.config.auth.clientKeys,
      "catalog",
      request.rawHeaders,
    );
    const aptusRequestId = createRequestId();
    if (authentication === undefined) {
      writeEncoded(
        response,
        options.errorEncoder.encode({ protocol: "openai-chat", aptusRequestId, failure: authenticationFailure() }),
      );
      return;
    }

    const protocol: Protocol = authentication.kind === "bearer" ? "openai-chat" : "anthropic-messages";
    const body = options.adapters[protocol].buildModelList({
      entries: authorizedCatalogEntries(options.config, nameIndex, authentication.name, protocol),
    });

    options.observer.catalogCompleted({ endpointProtocol: protocol });

    response.set("x-aptus-request-id", aptusRequestId).type("application/json").status(200).send(JSON.stringify(body));
  };
}

function authenticationFailure(): NormalizedFailure {
  return { category: "authentication", message: "invalid authentication credentials", retryable: false };
}

function rateLimitFailure(): NormalizedFailure {
  return { category: "rate_limit", message: "too many requests", retryable: false };
}

function timeoutFailure(): NormalizedFailure {
  return { category: "timeout", message: "request deadline exceeded", retryable: false };
}

type AbortRace<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T };

/**
 * Races an async operation against an AbortSignal, returning an `{ aborted: true }` tag if aborted.
 */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<AbortRace<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true });
    };
    if (signal.aborted) {
      void operation.then(
        () => undefined,
        () => undefined,
      );
      resolve({ aborted: true });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Serializes gateway results (complete payload, streaming ReadableStream, dry run, or error envelope) to Express response.
 */
async function writeGatewayResult(
  response: Response,
  result: GatewayResult,
  protocol: Protocol,
  aptusRequestId: AptusRequestId,
  errorEncoder: ErrorEncoder,
  signal: AbortSignal,
  coordinator: import("../domain/contracts.ts").TerminalCoordinator,
  canonicalPublicName: string,
  startedMs: number,
  clock: Clock,
  trace: import("../domain/contracts.ts").TraceSession,
): Promise<"complete" | "aborted"> {
  if (result.kind === "cancelled") {
    if (!response.destroyed) {
      response.destroy();
    }
    return "aborted";
  }
  if (result.kind === "failure") {
    writeEncoded(response, errorEncoder.encode({ protocol, aptusRequestId, failure: result.failure }));
    coordinator.markClientFirstByte();
    await result.finalize?.(clock.nowMonotonicMs() - startedMs);
    return "complete";
  }
  if (result.kind === "internal_fault") {
    writeEncoded(response, encodeInternalFailure(protocol, aptusRequestId));
    coordinator.markClientFirstByte();
    await result.finalize?.(clock.nowMonotonicMs() - startedMs);
    return "complete";
  }
  if (result.kind === "dry_run") {
    response
      .set("x-aptus-request-id", aptusRequestId)
      .type(result.contentType)
      .status(result.status)
      .send(JSON.stringify(result.body));
    coordinator.markClientFirstByte();
    await coordinator.finalize({
      terminal: { kind: "dry_run" },
      outcomeCategory: "complete",
      status: 200,
      attempts: 0,
      stream: false,
      durationMs: clock.nowMonotonicMs() - startedMs,
      canonicalPublicName,
      targetProtocol: result.body.targetProtocol,
      provider: result.body.candidate.provider,
    });
    return "complete";
  }

  response.status(result.status).set(filterResponseHeaders(result.headers)).set("x-aptus-request-id", aptusRequestId);

  if (result.kind === "complete") {
    const reader = result.body.stream().getReader();
    const isDisk = result.body.inMemoryBytes === undefined;
    const clientSink = isDisk ? trace.openBytes("client_response") : undefined;
    let delivery: "complete" | "aborted" = "complete";
    try {
      while (true) {
        const chunk = await raceWithAbort(reader.read(), signal);
        if (chunk.aborted) {
          delivery = "aborted";
          await clientSink?.discard().catch(() => undefined);
          break;
        }
        if (chunk.value.done) break;
        if (!response.write(chunk.value.value)) {
          const drained = await raceWithAbort(once(response, "drain"), signal);
          if (drained.aborted) {
            delivery = "aborted";
            await clientSink?.discard().catch(() => undefined);
            break;
          }
        }
        coordinator.markClientFirstByte();
        if (clientSink !== undefined) {
          await clientSink.append(chunk.value.value);
        }
      }
      if (delivery === "complete") {
        coordinator.markClientFirstByte();
        await clientSink?.complete().catch(() => undefined);
        response.end();
        await result.onDelivered?.(clock.nowMonotonicMs() - startedMs);
      }
    } finally {
      reader.releaseLock();
    }
    await result.body.dispose();
    return delivery;
  }

  // Handle streaming response with backpressure management.
  const reader = result.body.getReader();
  const clientSink = trace.openBytes("client_stream");
  const cancelStream = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancelStream, { once: true });
  response.once("close", cancelStream);
  try {
    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      if (chunk.aborted) {
        await clientSink.discard().catch(() => undefined);
        return "aborted";
      }
      if (chunk.value.done) break;
      coordinator.markClientFirstByte();
      // Write chunk; if socket buffer is full (false), wait for 'drain' event before reading next chunk.
      if (!response.write(chunk.value.value)) {
        const drained = await raceWithAbort(once(response, "drain"), signal);
        if (drained.aborted) {
          await clientSink.discard().catch(() => undefined);
          return "aborted";
        }
      }
      await clientSink.append(chunk.value.value);
    }
    await clientSink.complete().catch(() => undefined);
    response.end();
    await result.onDelivered?.(clock.nowMonotonicMs() - startedMs);
    return "complete";
  } catch (err) {
    await clientSink.discard().catch(() => undefined);
    throw err;
  } finally {
    signal.removeEventListener("abort", cancelStream);
    response.off("close", cancelStream);
    reader.releaseLock();
  }
}

/**
 * Writes an encoded error envelope to the response if headers have not yet been committed.
 */
function writeEncoded(
  response: Response,
  encoded: { readonly status: number; readonly headers: HeaderMap; readonly body: Uint8Array },
): void {
  if (!response.headersSent) response.status(encoded.status).set(encoded.headers).end(encoded.body);
}

/**
 * Formats a local timestamp into the trace directory prefix:
 * `YYYY-MM-DDTHH-mm-ss.SSS±HHMM` (colons are avoided for filesystem safety).
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
