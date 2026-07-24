import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import express, { type Request, type Response } from "express";
import type { AptusConfig } from "../config/types.js";
import type { Gateway, GatewayResult, HeaderMap, Protocol, ProtocolAdapter } from "../domain/contracts.js";
import type { ErrorEncoder, NormalizedFailure } from "../domain/operations.js";
import { type AptusRequestId, createRequestId } from "../domain/request-id.js";
import { authorizePublicName, createNameIndex, type NameIndex } from "../routing/resolution.js";
import { type AdmissionLimiter, createAdmissionLimiter } from "./admission.js";
import { type AuthPurpose, authenticateClient } from "./auth.js";
import { authorizedCatalogEntries } from "./catalog.js";
import {
  encodeInternalFailure,
  encodeUnidentifiedFailure,
  encodeUnidentifiedInternalFailure,
  filterResponseHeaders,
} from "./error-encoder.js";
import { admitJsonObject } from "./ingress.js";
import type { RequestCancellationRegistry } from "./request-cancellation.js";

/** Bounded client endpoint identifiers for metrics observation. */
export type ClientEndpoint = "chat_completions" | "responses" | "messages" | "models";

/** Lifecycle outcome of a client request for telemetry. */
export type ClientOutcome = "accepted" | "rejected" | "complete" | "failed" | "cancelled";

/**
 * Narrow HTTP-side telemetry observer, structurally decoupled from the
 * observability module. It records `aptus_http_requests_total` outcomes.
 */
export interface HttpRequestObserver {
  observeRequest(fields: {
    readonly endpointProtocol: Protocol;
    readonly endpoint: ClientEndpoint;
    readonly outcome: ClientOutcome;
    readonly stream: boolean;
  }): void;
}

/**
 * Initialization options for constructing the authenticated client Express application.
 */
export interface ClientAppOptions {
  /** Active configuration snapshot. */
  readonly config: AptusConfig;
  /** Gateway domain contract for dispatching admitted requests. */
  readonly gateway: Gateway;
  /** Dictionary of protocol adapters keyed by protocol identifier. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Protocol-native error encoder for serializing domain failures. */
  readonly errorEncoder: ErrorEncoder;
  /** Optional concurrency limiter (defaults to server config `maxInFlight`). */
  readonly limiter?: AdmissionLimiter;
  /** Optional metrics observer for client endpoint outcomes. */
  readonly observer?: HttpRequestObserver;
  /** Optional cancellation registry for managing active request abort signals during shutdown. */
  readonly cancellations?: RequestCancellationRegistry;
}

type CreateEndpoint = "/chat/completions" | "/responses" | "/messages";

/**
 * Instantiates the Express application for the authenticated client listener.
 *
 * Routes:
 * - `POST /chat/completions` & `POST /v1/chat/completions`: OpenAI chat completions
 * - `POST /responses` & `POST /v1/responses`: OpenAI responses API
 * - `POST /messages` & `POST /v1/messages`: Anthropic messages API
 * - `GET /models` & `GET /v1/models`: Model catalog listing (OpenAI list format for Bearer auth, Anthropic format for x-api-key)
 *
 * @param options - Application construction options.
 * @returns Configured Express application.
 */
export function createClientApp(options: ClientAppOptions): express.Express {
  const app = express();
  const limiter = options.limiter ?? createAdmissionLimiter(options.config.server.maxInFlight);
  const nameIndex = createNameIndex(options.config);
  mountCreate(
    app,
    options,
    limiter,
    nameIndex,
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
  paths: readonly string[],
  protocol: Protocol,
  endpoint: CreateEndpoint,
  label: ClientEndpoint,
  authPurpose: AuthPurpose,
): void {
  app.post([...paths], createController(options, limiter, nameIndex, protocol, endpoint, label, authPurpose));
}

/**
 * Constructs the request lifecycle handler for create endpoints.
 */
function createController(
  options: ClientAppOptions,
  limiter: AdmissionLimiter,
  nameIndex: NameIndex,
  protocol: Protocol,
  endpoint: CreateEndpoint,
  label: ClientEndpoint,
  authPurpose: AuthPurpose,
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    const controller = new AbortController();
    const requestAborted = (): void => controller.abort();
    const responseClosed = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", requestAborted);
    response.once("close", responseClosed);
    let deadline: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    let aptusRequestId: AptusRequestId | undefined;
    let release: (() => void) | undefined;
    let unregisterCancellation: (() => void) | undefined;
    // Narrow telemetry helper recording `aptus_http_requests_total` outcomes.
    const observeOutcome = (outcome: ClientOutcome, stream = false): void => {
      options.observer?.observeRequest({ endpointProtocol: protocol, endpoint: label, outcome, stream });
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
        observeOutcome("rejected");
        writeEncoded(response, encodeUnidentifiedFailure(protocol, authenticationFailure()));
        return;
      }

      // 2. Concurrency lease: Reject with 429 if maxInFlight limit is exceeded.
      release = limiter.tryAcquire();
      if (release === undefined) {
        observeOutcome("rejected");
        writeEncoded(response, encodeUnidentifiedFailure(protocol, rateLimitFailure()));
        return;
      }
      unregisterCancellation = options.cancellations?.register(controller);
      aptusRequestId = createRequestId();
      deadline = setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
      }, options.config.server.requestDeadlineMs);

      // 3. Ingress admission: Stream body, enforce byte limits, validate UTF-8 & duplicate-free JSON, bounded by deadline.
      const admissionRace = await raceWithAbort(
        admitJsonObject(
          request as IncomingMessage,
          options.config.server.bodyLimitBytes,
          options.config.server.trustedProxyCidrs,
        ),
        controller.signal,
      );
      if (admissionRace.aborted || controller.signal.aborted) {
        if (deadlineExpired && !response.headersSent) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
        } else if (!response.destroyed) {
          response.destroy();
        }
        observeOutcome(deadlineExpired ? "failed" : "cancelled");
        return;
      }
      const admission = admissionRace.value;
      if (!admission.ok) {
        observeOutcome("rejected");
        writeEncoded(response, encodeUnidentifiedFailure(protocol, { ...admission.failure, retryable: false }));
        return;
      }

      // 4. Model extraction & resolution: Extract model field and verify client authorization.
      const publicName = options.adapters[protocol].readPublicModel(admission.body);
      if (!publicName.ok) {
        writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: publicName.error }));
        observeOutcome("failed");
        return;
      }
      if (authorizePublicName(nameIndex, authentication.name, publicName.value) === undefined) {
        writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: notFoundFailure() }));
        observeOutcome("failed");
        return;
      }

      // 5. Gateway execution: Dispatch request through domain gateway.
      observeOutcome("accepted", admission.body.stream === true);
      const gatewayResult = await raceWithAbort(
        options.gateway.execute({
          aptusRequestId,
          protocol,
          endpoint,
          headers: admission.headers,
          body: admission.body,
          clientKeyName: authentication.name,
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (gatewayResult.aborted || controller.signal.aborted) {
        if (deadlineExpired && !response.headersSent) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
        } else if (!response.destroyed) {
          response.destroy();
        }
        observeOutcome(deadlineExpired ? "failed" : "cancelled");
        return;
      }

      // 6. Response serialization: Stream or write complete body to client.
      const writeResult = await writeGatewayResult(
        response,
        gatewayResult.value,
        protocol,
        aptusRequestId,
        options.errorEncoder,
        controller.signal,
      );
      if (writeResult === "aborted") {
        if (deadlineExpired && !response.headersSent) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
        } else if (!response.destroyed) {
          response.destroy();
        }
        observeOutcome(deadlineExpired ? "failed" : "cancelled");
        return;
      }
      observeOutcome(
        gatewayResult.value.kind === "failure" ? "failed" : "complete",
        gatewayResult.value.kind === "stream",
      );
    } catch {
      if (!response.headersSent && !response.destroyed) {
        if (deadlineExpired && aptusRequestId !== undefined) {
          writeEncoded(response, options.errorEncoder.encode({ protocol, aptusRequestId, failure: timeoutFailure() }));
        } else if (!controller.signal.aborted) {
          writeEncoded(
            response,
            aptusRequestId === undefined
              ? encodeUnidentifiedInternalFailure(protocol)
              : encodeInternalFailure(protocol, aptusRequestId),
          );
        }
      } else if (!response.destroyed) {
        // A stream read rejection after headers were sent must close the client
        // connection (no forged success terminator) instead of leaving it open.
        response.destroy();
      }
      observeOutcome("failed");
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
      options.observer?.observeRequest({
        endpointProtocol: "openai-chat",
        endpoint: "models",
        outcome: "rejected",
        stream: false,
      });
      writeEncoded(
        response,
        options.errorEncoder.encode({ protocol: "openai-chat", aptusRequestId, failure: authenticationFailure() }),
      );
      return;
    }
    // Bearer token returns OpenAI list format; x-api-key returns Anthropic list format.
    const protocol: Protocol = authentication.kind === "bearer" ? "openai-chat" : "anthropic-messages";
    const body = options.adapters[protocol].buildModelList({
      entries: authorizedCatalogEntries(options.config, nameIndex, authentication.name, protocol),
    });
    options.observer?.observeRequest({
      endpointProtocol: protocol,
      endpoint: "models",
      outcome: "complete",
      stream: false,
    });
    response.set("x-aptus-request-id", aptusRequestId).type("application/json").status(200).send(JSON.stringify(body));
  };
}

function authenticationFailure(): NormalizedFailure {
  return { category: "authentication", message: "invalid authentication credentials", retryable: false };
}

function notFoundFailure(): NormalizedFailure {
  return { category: "not_found", message: "model not found", retryable: false };
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
): Promise<"complete" | "aborted"> {
  if (result.kind === "failure") {
    writeEncoded(response, errorEncoder.encode({ protocol, aptusRequestId, failure: result.failure }));
    return "complete";
  }
  if (result.kind === "dry_run") {
    response
      .set("x-aptus-request-id", aptusRequestId)
      .type(result.contentType)
      .status(result.status)
      .send(JSON.stringify(result.body));
    return "complete";
  }
  response.status(result.status).set(filterResponseHeaders(result.headers)).set("x-aptus-request-id", aptusRequestId);
  if (result.kind === "complete") {
    response.end(result.body);
    return "complete";
  }

  // Handle streaming response with backpressure management.
  const reader = result.body.getReader();
  const cancelStream = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancelStream, { once: true });
  response.once("close", cancelStream);
  try {
    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      if (chunk.aborted) return "aborted";
      if (chunk.value.done) break;
      // Write chunk; if socket buffer is full (false), wait for 'drain' event before reading next chunk.
      if (!response.write(chunk.value.value)) {
        const drained = await raceWithAbort(once(response, "drain"), signal);
        if (drained.aborted) return "aborted";
      }
    }
    response.end();
    return "complete";
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
