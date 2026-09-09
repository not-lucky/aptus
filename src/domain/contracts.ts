/**
 *
 * @fileoverview Shared domain contracts for the Aptus gateway request lifecycle.
 *
 * Defines the core interfaces and types that connect HTTP admission, routing,
 * provider dispatch, translation, and observability. Covers admitted requests,
 * candidate selection, dispatchers, protocol adapters, key pools, and trace recording.
 */

import type { IrFailureCategory, NormalizedFailure, TraceStage, TraceTerminal } from "./operations.ts";
import type { AptusRequestId } from "./request-id.ts";

export type { AptusRequestId };

/**
 * A JSON primitive scalar, array, or object value.
 *
 * This type represents any value that can appear in a parsed request or
 * response payload: `null`, a boolean, a number, a string, a read-only
 * array of such values, or a {@link JsonObject}. It is the element type
 * that {@link JsonObject} maps keys to, and the value type that the small
 * helpers in `src/domain/json.ts` traverse and compare. Code that decodes
 * wire bodies narrows `unknown` into this type before further processing.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/**
 * A JSON object with no prototype-dependent behavior.
 *
 * This interface represents a parsed JSON object whose keys map to
 * {@link JsonValue} entries. Readers treat it as a plain record: field
 * access goes through the index signature, and narrowing a wire value to
 * this type is done with `isPlainObject` from `src/domain/json.ts`. All
 * properties are read-only at the type level, so mutation goes through
 * explicit helpers such as `setPathCreate` rather than direct assignment.
 *
 * @remarks
 * The index signature below is the dynamic field accessor for parsed
 * payloads. It states that every string key maps to a {@link JsonValue},
 * so `body["model"]` type-checks without a cast. Absence is represented by
 * `undefined` at runtime even though the declared value type does not name
 * it, which matches how JavaScript property access behaves.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * An immutable HTTP header map with lowercase header names and sanitized string values.
 *
 * This type represents a set of HTTP headers where every name is already
 * lowercased and every value is a plain string safe to forward or log. The
 * filtering functions in `src/domain/headers.ts` produce values of this
 * type by lowercasing names and dropping hop-by-hop and credential headers,
 * and the dispatcher, relay, and error encoder consume them without further
 * normalization. Consumers must not assume any particular header is
 * present; every lookup can miss.
 */
export type HeaderMap = Readonly<Record<string, string>>;

/**
 * The supported client ingress and upstream provider protocol types.
 *
 * This type represents the three wire protocols that Aptus speaks on both
 * sides of the gateway: `openai-chat` for the OpenAI chat completions
 * shape, `openai-responses` for the OpenAI responses shape, and
 * `anthropic-messages` for the Anthropic messages shape. The client
 * protocol is determined by which endpoint received the request, and the
 * provider protocol comes from the candidate configuration. When the two
 * are equal, dispatch is native and skips translation; when they differ,
 * the translation pipeline converts through the intermediate
 * representation.
 */
export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";

/**
 * A discriminated union that represents either a successful calculation or an expected domain failure.
 *
 * This type is the standard return shape for fallible pure computations
 * that must report an expected failure without throwing, such as reading a
 * model name from a body or preparing a provider request. The `ok` flag
 * discriminates the two variants: when `ok` is `true`, only `value` is
 * present, and when `ok` is `false`, only `error` is present. Callers
 * branch on `ok` and handle the failure explicitly, which keeps expected
 * failures visible in the type signature instead of hiding them in thrown
 * exceptions.
 *
 * @typeParam T - The successful value payload type. This flows from the
 *   producing function to the caller branch where `ok` is `true`. It can be
 *   any type, including `void`-like shapes, and it is never inspected when
 *   `ok` is `false`.
 * @typeParam E - The domain failure type. In practice this is almost always
 *   {@link NormalizedFailure}. It flows to the caller branch where `ok` is
 *   `false` and carries the classified reason. It is never inspected when
 *   `ok` is `true`.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/**
 * An owned response body stream and buffer abstraction for complete and streaming responses.
 *
 * This interface represents a provider response body that the gateway owns
 * and must eventually release. Ownership means that the holder is
 * responsible for either consuming the bytes or disposing of the body so
 * that pooled connections and temporary spool files are freed. The spool
 * layer in `src/routing/spool.ts` creates values of this type, buffering
 * small bodies in memory and larger bodies in a temporary file, and the
 * relay consumes them when delivering the client response.
 */
export interface OwnedBody {
  /**
   * Returns a readable stream of the body chunks.
   */
  stream(): ReadableStream<Uint8Array>;

  /**
   * Returns the full body bytes from memory or from the temporary spool file.
   */
  bytes(): Promise<Uint8Array>;

  /**
   * Releases the underlying disk and memory resources for the body.
   */
  dispose(): Promise<void>;

  /** The in-memory byte buffer when the body was retained in RAM at or below 64 KiB. */
  readonly inMemoryBytes?: Uint8Array;
}

/**
 * An immutable fact submitted to finalize request lifecycle telemetry and the trace terminal.
 *
 * This interface represents the exactly-once end state of one request that
 * the terminal coordinator records in metrics, logs, and the trace
 * terminal file. Finalization means that duration, first-byte timing,
 * attempt counts, and outcome counters are all settled from this single
 * object. The HTTP layer builds the value after the response has been
 * handed to Express, so that timings reflect actual client delivery, and
 * the coordinator consumes it to emit the completion log exactly once.
 */
export interface TerminalFact {
  /** The logical trace terminal outcome for the request. */
  readonly terminal: TraceTerminal;

  /** The bounded HTTP outcome category for metrics. */
  readonly outcomeCategory: "complete" | "failed" | "cancelled";

  /** The final response HTTP status code delivered to the client. */
  readonly status: number;

  /** The total number of provider attempts executed for the request. */
  readonly attempts: number;

  /** Whether streaming mode was admitted for the request. */
  readonly stream: boolean;

  /** The monotonic request duration in milliseconds from admission to delivery. */
  readonly durationMs: number;

  /** The target candidate provider protocol, or `"unknown"` when none was selected. */
  readonly targetProtocol?: Protocol | "unknown";

  /** The selected candidate provider name, or `"unknown"` when none was selected. */
  readonly provider?: string;

  /** The canonical public model or route name, or `"unknown"` when resolution failed. */
  readonly canonicalPublicName?: string;

  /** The redacted raw token usage object for the request. */
  readonly usage?: JsonObject;

  /** The exact decimal United States dollar cost estimate for the request. */
  readonly estimatedCostUsd?: string;

  /** When `false`, finalization still records counters and timing but skips the completion log. */
  readonly emitCompleted?: boolean;
}

/**
 * The request-scoped delivery and completion coordinator owned by HTTP admission.
 *
 * This interface represents the single object that guarantees exactly-once
 * terminal bookkeeping for one request. Exactly-once means that no matter
 * how many delivery paths race, such as normal completion, failure
 * encoding, cancellation, or shutdown, only one path wins ownership and
 * emits the completion side effects. HTTP admission creates the coordinator
 * and threads it through the {@link GatewayRequest}, the gateway and relay
 * record progress on it, and the winning path finalizes it after the
 * response reaches Express.
 */
export interface TerminalCoordinator {
  /** The promise that settles when terminal delivery and telemetry finalize. */
  readonly finalized: Promise<void>;

  /**
   * Marks that HTTP ingress admission succeeded and records the admitted stream label.
   */
  markIngress(stream: boolean): void;

  /** Idempotently records client time-to-first-byte after response bytes or head reach Express. */
  markClientFirstByte(): void;

  /**
   * Records the current attempt number for authoritative attempt-count tracking on cancellation.
   */
  recordAttempt(attemptNumber: number): void;

  /**
   * Retrieves the highest recorded attempt count.
   */
  getAttempts(): number;

  /**
   * Atomically claims terminal ownership and executes best-effort completion side effects.
   */
  finalize(fact: TerminalFact): Promise<{ readonly won: boolean }>;
}

/**
 * An accepted, validated client create request passed from HTTP ingress to the gateway orchestrator.
 *
 * This interface represents a request that has cleared every admission
 * check: authentication, body parsing, size limits, model extraction, and
 * name resolution. Admission means that the gateway can trust the fields
 * without revalidating them. The HTTP admission layer in `src/http/`
 * creates values of this type, and the gateway orchestrator in
 * `src/routing/` consumes them to select candidates and dispatch. The
 * coordinator and trace fields travel with the request so that every stage
 * records against the same session.
 */
export interface GatewayRequest {
  /** The unique universally unique identifier assigned after admission. */
  readonly aptusRequestId: AptusRequestId;

  /** The client protocol that corresponds to the mounted endpoint. */
  readonly protocol: Protocol;

  /** The canonical endpoint metric label without prefix. */
  readonly endpoint: "/chat/completions" | "/responses" | "/messages";

  /** The filtered, lowercase client headers with hop-by-hop and auth credentials removed. */
  readonly headers: HeaderMap;

  /** The parsed, duplicate-free JSON request payload. */
  readonly body: JsonObject;

  /** The authenticated client key name, never the secret. */
  readonly clientKeyName: string;

  /** The composite abort signal for client disconnect, timeout deadline, and shutdown. */
  readonly signal: AbortSignal;

  /** The canonical public model or route name resolved during HTTP admission. */
  readonly canonicalPublicName: string;

  /** The resolution kind that states whether the public name is a model or a route. */
  readonly resolutionKind: "model" | "route";

  /** Whether streaming was requested and admitted in the JSON body. */
  readonly stream: boolean;

  /** The single terminal delivery and completion coordinator for this request. */
  readonly coordinator: TerminalCoordinator;

  /** The active trace recording session for stage recording. */
  readonly trace: TraceSession;
}

/**
 * The selected candidate provider and key metadata for a dry-run evaluation.
 *
 * This interface represents the routing choice that a dry run inspects
 * without dispatching: which configured provider would serve the request,
 * which upstream model it would target, and which key name would
 * authenticate the call. The dry-run path in `src/routing/` creates values
 * of this type after candidate selection and key preview, and the dry-run
 * response envelope reports them to the caller. Only the key name travels
 * here; the secret itself is never exposed.
 */
export interface DryRunCandidate {
  /** The name of the configured provider that would serve the request. */
  readonly provider: string;

  /** The upstream model identifier that would be requested from the provider. */
  readonly model: string;

  /** The selected provider key name, safe for diagnostic output and never the secret. */
  readonly key: string;
}

/**
 * A fully prepared upstream request inspection object generated during dry-run.
 *
 * This interface represents the exact request that would have been
 * dispatched, minus secrets, so that operators can validate routing,
 * mutation, and translation without spending provider budget. The dry-run
 * path builds it from the same preparer that live dispatch uses, then
 * redacts credentials before returning it. The invariant is that the
 * method, URL, headers, and body always describe a well formed request that
 * live dispatch could have sent unchanged apart from the redacted secret.
 */
export interface DryRunProviderRequest {
  /** The HTTP method for create requests, always HTTP POST. */
  readonly method: "POST";

  /** The resolved provider target URL for the request. */
  readonly url: string;

  /** The outbound provider headers with sensitive secrets redacted. */
  readonly headers: HeaderMap;

  /** The fully mutated or translated JSON request body that would have been sent. */
  readonly body: JsonObject;
}

/**
 * The response payload returned when executing a dry-run create request.
 *
 * This interface represents the complete inspection result for a dry run:
 * which request was evaluated, which candidate was selected, whether the
 * capability preflight passed, and what would have been dispatched. The
 * routing layer creates it without touching the network, and the HTTP layer
 * serializes it with the dry-run content type. The invariant is that every
 * field describes the same hypothetical dispatch, so the candidate, the
 * preflight verdict, and the provider request never disagree.
 */
export interface DryRunResult {
  /** The constant success marker that identifies a dry-run envelope. */
  readonly dryRun: true;

  /** The unique request identifier for the evaluated request. */
  readonly aptusRequestId: AptusRequestId;

  /** The protocol of the incoming client request. */
  readonly sourceProtocol: Protocol;

  /** The protocol of the target candidate provider. */
  readonly targetProtocol: Protocol;

  /** The canonical public model or route name that was evaluated. */
  readonly publicName: string;

  /** The selected candidate provider, model, and key identifier. */
  readonly candidate: DryRunCandidate;

  /**
   * The ordered list of JSON Pointers mutated by defaults, extra body merges, overrides, or model substitution.
   */
  readonly mutations: readonly string[];

  /** The result of candidate capability preflight checks for the hypothetical dispatch. */
  readonly preflight: { readonly ok: true } | { readonly ok: false; readonly failure: NormalizedFailure };

  /** The inspection payload of the provider request that would have been dispatched. */
  readonly providerRequest: DryRunProviderRequest;
}

/**
 * The terminal result returned by the gateway orchestrator to the HTTP layer.
 *
 * This type represents the six mutually exclusive ways that gateway
 * execution can end: a complete non-streaming response with an owned body,
 * a streaming response with a backpressured byte stream, a dry-run
 * inspection payload, a normalized domain failure, an internal and local
 * unexpected fault, or a cancellation by client or shutdown. The gateway
 * never finalizes a normal-delivery result itself; instead each result
 * carries a finalization seam, namely `onDelivered` or `finalize`, that the
 * HTTP layer invokes after the corresponding bytes have been handed to
 * Express, so that duration, first-byte timing, and terminal ownership
 * reflect actual client delivery rather than internal completion.
 */
export type GatewayResult =
  | {
      /**  */
      readonly kind: "complete";
      readonly status: number;
      readonly headers: HeaderMap;
      readonly body: OwnedBody;
      /**
       * Invoked by HTTP after the body has been fully handed to Express, finalizing the complete or failed terminal with the exact client-end duration.
       */
      readonly onDelivered?: (durationMs: number) => Promise<void>;
    }
  | {
      /**  */
      readonly kind: "stream";
      readonly status: number;
      readonly headers: HeaderMap;
      readonly body: ReadableStream<Uint8Array>;
      /**
       * Invoked by HTTP after the client stream has been fully handed to Express, finalizing the success terminal with the exact client-end duration.
       */
      readonly onDelivered?: (durationMs: number) => Promise<void>;
    }
  | {
      /**  */
      readonly kind: "dry_run";
      readonly status: 200;
      readonly contentType: "application/vnd.aptus.dry-run+json";
      readonly body: DryRunResult;
    }
  | {
      /**  */
      readonly kind: "failure";
      readonly failure: NormalizedFailure;
      /**
       * Invoked by HTTP after the error envelope has been handed to Express, finalizing the failed terminal with the exact delivery duration.
       */
      readonly finalize?: (durationMs: number) => Promise<void>;
    }
  | {
      /**  */
      readonly kind: "internal_fault";
      /**
       * Invoked by HTTP after the safe 500 envelope has been handed to Express, finalizing the internal-fault terminal with the exact delivery duration.
       */
      readonly finalize?: (durationMs: number) => Promise<void>;
    }
  | {
      /**  */
      readonly kind: "cancelled";
      readonly by: "client" | "shutdown";
    };

/**
 * The gateway execution orchestrator for admitted client requests.
 *
 * This interface represents the single seam between HTTP admission and the
 * routing and dispatch machinery. The HTTP layer depends on this contract
 * rather than on a concrete gateway class, so tests can substitute a stub
 * that returns canned {@link GatewayResult} values. Production code
 * provides one gateway that owns candidate selection, key leasing,
 * preflight, mutation, dispatch, and relay preparation. The orchestrator
 * holds no per-request state; all request state travels in the
 * {@link GatewayRequest} argument.
 */
export interface Gateway {
  /**
   * Executes routing, key lease acquisition, candidate preflight, mutation, and upstream dispatch.
   */
  execute(request: GatewayRequest): Promise<GatewayResult>;
}

/**
 * The input arguments for preparing a same-protocol provider request.
 *
 * This interface represents everything the native preparer needs to turn an
 * admitted client body into a dispatch-ready upstream request without
 * translation: which protocol and base URL to target, which upstream model
 * to substitute, which headers to merge, which secret to authenticate with,
 * which mutations to apply, and which timeouts to enforce. The gateway
 * builds the value after candidate and key selection, and the protocol
 * adapter consumes it in `prepareNative`. All fields are always present.
 */
export interface NativePreparationInput {
  /** The protocol for the target provider. */
  readonly protocol: Protocol;

  /** The normalized base API URL without a trailing slash. */
  readonly baseUrl: string;

  /** The upstream model identifier to substitute into the request payload. */
  readonly upstreamModel: string;

  /** The parsed, duplicate-free client JSON body to mutate. */
  readonly clientBody: JsonObject;

  /** The filtered end-to-end client headers for the outbound request. */
  readonly clientHeaders: HeaderMap;

  /** The configured static provider headers without authentication. */
  readonly providerHeaders: HeaderMap;

  /** The resolved provider secret for the acquired key lease. */
  readonly providerSecret: string;

  /** The configured native mutations with defaults, extra body, and overrides. */
  readonly mutations: NativeMutations;

  /** The absolute monotonic request deadline in milliseconds. */
  readonly deadlineMs: number;

  /** The stream idle limit in milliseconds reset by every received byte. */
  readonly streamIdleMs: number;
}

/**
 * The native request mutations applied in deterministic order.
 *
 * This interface represents the three mutation layers plus the implied
 * model replacement that together turn a client body into a provider body:
 * defaults fill in absent keys, the extra body deep-merges provider
 * extensions, overrides replace or insert fields, and model substitution
 * swaps the public name for the upstream identifier. The preparer applies
 * them in that fixed order so that configuration authors can predict the
 * winner on every path. The configuration layer creates values of this type
 * from provider and route blocks, and the native and translated preparers
 * consume them.
 */
export interface NativeMutations {
  /** The key-value pairs applied only when the key is absent in the client payload. */
  readonly defaults: JsonObject;

  /** The provider extension values deeply merged after defaults. */
  readonly extraBody: JsonObject;

  /** The values that override or insert fields in the final payload. */
  readonly overrides: JsonObject;
}

/**
 * A fully prepared upstream provider request ready for network dispatch.
 *
 * This interface represents the exact bytes, URL, and headers that the
 * dispatcher sends: the provider to attribute, the protocol shape, the
 * absolute POST URL, the filtered headers with authentication, the UTF-8
 * encoded JSON body, the stream flag, the deadline and idle timeouts, and
 * the ordered mutation record. The native and translated preparers create
 * values of this type, the dispatcher consumes them in one call, and the
 * dry-run path reports a redacted projection of them. The invariant is that
 * the request is complete and self-contained: dispatch needs no further
 * lookups.
 */
export interface PreparedProviderRequest {
  /** The configured provider name for metrics and traces. */
  readonly provider: string;

  /** The target provider protocol for the request shape. */
  readonly protocol: Protocol;

  /** The absolute target URL for the POST create request. */
  readonly url: string;

  /** The filtered outbound headers containing provider authentication. */
  readonly headers: HeaderMap;

  /** The UTF-8 encoded serialized JSON payload for the request. */
  readonly body: Uint8Array;

  /** Whether streaming server-sent events response mode was requested. */
  readonly stream: boolean;

  /** The absolute monotonic request deadline in milliseconds. */
  readonly deadlineMs: number;

  /** The maximum stream idle duration in milliseconds between incoming bytes. */
  readonly streamIdleMs: number;

  /**
   * The ordered list of JSON Pointers mutated by defaults, extra body merges, overrides, or model substitution.
   */
  readonly mutations: readonly string[];
}

/**
 * The HTTP status and headers received from upstream before body consumption.
 *
 * This interface represents the response head: the status code plus the
 * filtered lowercase headers, captured before any body byte is read. The
 * dispatcher creates values of this type as soon as headers arrive, and the
 * protocol adapter classifies them into an {@link AttemptObservation} that
 * drives retry, fallback, and key health. The invariant is that `status` is
 * always a valid three-digit code and `headers` never carries hop-by-hop
 * framing.
 */
export interface ProviderResponseHead {
  /** The upstream HTTP status code. */
  readonly status: number;

  /** The filtered lowercase response headers from the provider. */
  readonly headers: HeaderMap;
}

/**
 * A complete upstream dispatcher response with a streaming body.
 *
 * This interface extends {@link ProviderResponseHead} with the response
 * body stream and the final URL after redirects. The dispatcher creates
 * values of this type for every network call that yields a head, and the
 * attempt and relay layers consume the body exactly once before either
 * spooling it or relaying it to the client.
 *
 * @remarks
 * The consumer must consume or cancel {@link OwnedBody} style body content,
 * here the `body` stream, exactly once to prevent connection leaks. The
 * dispatcher lends ownership to the caller on return, and abandoning the
 * stream without cancelling it pins the pooled connection.
 */
export interface ProviderResponse extends ProviderResponseHead {
  /** The backpressured byte stream of the response body. */
  readonly body: ReadableStream<Uint8Array>;

  /** The final URL after following allowed same-origin redirects. */
  readonly finalUrl: string;
}

/**
 * A normalized observation extracted from an upstream attempt response head or transport failure.
 *
 * This interface represents what the gateway learned from one dispatch try,
 * distilled to the routing decision inputs: the stable result category or
 * success, the observed status, the parsed retry delay, and whether any
 * client byte had been written yet. The protocol adapter classifiers create
 * values of this type from response heads, and the transport wrappers
 * create them from faults. The retry policy, fallback selector, and key
 * pool all consume the same object, so one classification drives every
 * downstream decision consistently.
 */
export interface AttemptObservation {
  /** The stable result category or `"success"` for a dispatch that can proceed. */
  readonly result: "success" | IrFailureCategory | "client_cancelled";

  /** The observed HTTP status code, when a response head was received. */
  readonly status?: number;

  /** The parsed `Retry-After` delay in milliseconds. */
  readonly retryDelayMs?: number;

  /** Whether no response body byte has been written to the downstream client yet. */
  readonly beforeClientBytes: boolean;
}

/**
 * An immutable lifecycle event emitted during routing and dispatch for telemetry observation.
 *
 * This type represents the six moments that observers can see: request
 * ingress with identity and stream flag, candidate skip with the rejecting
 * failure, attempt start with attempt and candidate numbers, scheduled
 * retry with delay and category, fallback selection with source and target
 * indexes and category, and the terminal result. The routing layer emits
 * each event at the moment it happens, and the lifecycle observer in
 * `src/observability/` records it in metrics, logs, and traces without ever
 * affecting the routing decision. The `aptusRequestId` on every variant
 * joins the event back to its request.
 */
export type LifecycleEvent =
  | {
      readonly type: "request_ingress";
      readonly aptusRequestId: AptusRequestId;
      readonly sourceProtocol: Protocol;
      readonly stream: boolean;
    }
  | {
      readonly type: "candidate_skipped";
      readonly aptusRequestId: AptusRequestId;
      readonly candidateIndex: number;
      readonly provider: string;
      readonly targetProtocol: Protocol;
      readonly failure: NormalizedFailure;
    }
  | {
      readonly type: "attempt_started";
      readonly aptusRequestId: AptusRequestId;
      readonly attemptNumber: number;
      readonly candidateIndex: number;
      readonly provider: string;
      readonly targetProtocol: Protocol;
    }
  | {
      readonly type: "retry_scheduled";
      readonly aptusRequestId: AptusRequestId;
      readonly attemptNumber: number;
      readonly delayMs: number;
      readonly category: IrFailureCategory;
    }
  | {
      readonly type: "fallback_selected";
      readonly aptusRequestId: AptusRequestId;
      readonly fromCandidateIndex: number;
      readonly toCandidateIndex: number;
      readonly category: IrFailureCategory;
    }
  | {
      readonly type: "request_terminal";
      readonly aptusRequestId: AptusRequestId;
      readonly result: "complete" | "failed" | "cancelled" | "dry_run";
    };

/**
 * The observer interface for recording routing lifecycle events in metrics, logs, and traces.
 *
 * This interface represents the telemetry sink that the routing layer
 * notifies as execution proceeds. The observability layer provides the
 * production implementation that fans events out to metrics, structured
 * logs, and trace stages, and tests substitute a recording stub to assert
 * on the emitted sequence. Observation never feeds back into routing: the
 * observer cannot change the candidate choice, delay, or outcome.
 */
export interface LifecycleObserver {
  /**
   * Receives an immutable routing lifecycle event.
   */
  observe(event: LifecycleEvent): void;
}

/**
 * The protocol adapter interface for protocol-specific serialization, classification, and catalog building.
 *
 * This interface represents the per-protocol specialist that owns
 * everything wire-shaped: reading the public model from a client body,
 * preparing a native upstream request with mutations, classifying a
 * response head into an observation, and building the model list envelope.
 * One implementation exists per supported protocol, and the gateway selects
 * among them by the {@link Protocol} value. The adapter performs no network
 * I/O itself; it only builds and interprets shapes that the dispatcher and
 * relay act on.
 */
export interface ProtocolAdapter {
  /** The protocol identifier handled by this adapter. */
  readonly protocol: Protocol;

  /** The exact relative path appended to the provider API base URL for create requests. */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";

  /**
   * Extracts the public model or route name requested in the client JSON body.
   */
  readPublicModel(body: JsonObject): Result<string, NormalizedFailure>;

  /**
   * Prepares a native upstream provider request by applying configured mutations.
   */
  prepareNative(input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure>;

  /**
   * Classifies an upstream response head into a normalized attempt observation.
   */
  classify(response: ProviderResponseHead, nowMs?: number): AttemptObservation;

  /**
   * Constructs a protocol-native model catalog list envelope.
   */
  buildModelList(input: ModelListInput): JsonObject;
}

/**
 * A single entry in the local model catalog.
 *
 * This interface represents one client-visible model or route: its
 * canonical public identifier plus the protocol-specific metadata fields
 * that the catalog envelope carries alongside it. The catalog builder in
 * `src/http/catalog.ts` creates values of this type from configuration
 * after authorization filtering and sorting, and the protocol adapters wrap
 * them into envelopes. The invariant is that `id` is always a validated
 * non-empty public name and `metadata` never carries secrets.
 */
export interface ModelListEntry {
  /** The canonical public model or route identifier visible to clients. */
  readonly id: string;

  /** The protocol-specific catalog metadata fields for the entry. */
  readonly metadata: JsonObject;
}

/**
 * The input parameters for building a protocol-specific model catalog list.
 *
 * This interface represents the sorted, authorized entries that the catalog
 * endpoint hands to the adapter for envelope rendering. The HTTP catalog
 * code builds the value after filtering to the caller identity and sorting
 * lexicographically, and the adapter consumes it in `buildModelList`. The
 * invariant is that every entry is already authorized and the array is
 * already sorted, so the adapter never filters or sorts.
 */
export interface ModelListInput {
  /** The lexicographically sorted, authorized model list entries. */
  readonly entries: readonly ModelListEntry[];
}

/**
 * The HTTP transport dispatcher for sending prepared requests to upstream providers.
 *
 * This interface represents the network seam that the attempt layer calls
 * to execute one dispatch. The shared dispatcher in `src/providers/shared/`
 * implements timeout, redirect, and socket policy on top of the pooled
 * transport, and tests substitute a fixture dispatcher that returns canned
 * responses. The dispatcher owns connection pooling and owns nothing
 * per-request beyond the call itself.
 */
export interface ProviderDispatcher {
  /**
   * Executes network dispatch for a prepared request with timeout and redirect policies.
   */
  dispatch(request: PreparedProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;

  /**
   * Closes the underlying transport resources and pooled connections gracefully.
   */
  close?(): Promise<void>;

  /**
   * Forcibly destroys the underlying transport resources and active sockets.
   */
  destroy?(): Promise<void>;
}

/**
 * A leased provider API key credential with generation tracking.
 *
 * This interface represents one checked-out key from a provider pool: which
 * provider owns it, which named key was selected, what the secret text is,
 * and which pool generation the lease belongs to. The key pool creates the
 * lease in `acquire`, the preparer formats the secret into the
 * authentication header, and the pool consumes the lease again in `observe`
 * to update health. The generation counter lets the pool ignore
 * observations from stale leases after the pool reconfigures.
 */
export interface KeyLease {
  /** The name of the provider that owns this key. */
  readonly provider: string;

  /** The unique name of the key within its key pool, safe for telemetry. */
  readonly keyName: string;

  /** The secret value used to prepare authorization headers. */
  readonly secret: string;

  /** The lease generation counter that prevents stale observations from updating key health. */
  readonly generation: number;
}

/**
 * A non-mutating key credential preview for dry-run inspection.
 *
 * This interface represents the key that a dry run would have leased,
 * without actually checking it out of the pool. The pool creates the value
 * in `preview`, and the dry-run response reports the key name to the
 * caller while keeping the secret redacted in the outer envelope. The
 * invariant is that previewing never changes pool state: availability,
 * cooldowns, and ordering are all untouched.
 */
export interface KeyPreview {
  /** The selected key name safe for diagnostic output. */
  readonly keyName: string;

  /** The secret value for header preparation in the hypothetical dispatch. */
  readonly secret: string;
}

/**
 * The result of a non-blocking key acquisition attempt.
 *
 * This type represents the three mutually exclusive outcomes of asking a
 * pool for a key without waiting: `acquired` with the fresh {@link KeyLease}
 * when an enabled key is available, `wait` with the millisecond timestamp
 * when every enabled key is cooling down and the caller should retry after
 * that time, or `unavailable` when the pool holds no enabled key at all.
 * The routing layer branches on `kind` to decide whether to dispatch, back
 * off, or skip the candidate. The `kind` flag discriminates the variants.
 */
export type KeyAcquireResult =
  | { readonly kind: "acquired"; readonly lease: KeyLease }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "unavailable" };

/**
 * The key pool that manages key selection strategy and adaptive cooldown health states.
 *
 * This interface represents the per-provider credential rotation and health
 * tracker. Rotation means spreading dispatches across the enabled keys, and
 * adaptive cooldown means backing off keys that just failed with
 * throttling, overload, or transport faults. The gateway acquires a lease
 * before each attempt, dispatches with its secret, and then reports the
 * classified observation so that the pool can cool the key down. Dry runs
 * preview without mutating. The pool holds no network resources itself.
 */
export interface KeyPool {
  /**
   * Makes a non-blocking attempt to acquire an enabled, available key lease.
   */
  acquire(nowMs: number): KeyAcquireResult;

  /**
   * Records an attempt outcome to update adaptive health cooldowns for the leased key.
   */
  observe(lease: KeyLease, observation: AttemptObservation, nowMs: number): number | undefined;

  /**
   * Returns the count of enabled keys in this pool that are not cooling down at the given time.
   */
  availableCount(nowMs: number): number;

  /**
   * Returns a non-mutating preview of the next enabled key for dry-run evaluation.
   */
  preview(): KeyPreview | undefined;
}

/**
 * An incremental raw byte sink for streaming trace stages.
 *
 * This interface represents an open temporary file for one trace stage that
 * becomes visible atomically only when completed. Streaming stages such as
 * provider and client event streams append chunk by chunk because the full
 * content is not known up front. The trace session creates the sink, the
 * relay appends as bytes flow, and completion fsyncs, closes, and renames
 * the temporary file into place. Discarding removes the temporary file so
 * that partial content never appears in the trace directory.
 */
export interface TraceByteSink {
  /**
   * Appends a raw chunk to the active temporary stage sink.
   */
  append(chunk: Uint8Array): Promise<void>;

  /**
   * Flushes, closes, and atomically commits the stage file into the trace directory.
   */
  complete(): Promise<void>;

  /**
   * Closes and discards the temporary sink without committing any bytes.
   */
  discard(): Promise<void>;
}

/**
 * The recorder interface for initiating request trace recording sessions.
 *
 * This interface represents the trace subsystem entry point that admission
 * calls to open a session per request. The file-based implementation
 * creates the trace directory, writes the manifest, and returns a live
 * session, while the no-operation implementation returns a stub that drops
 * everything for deployments with tracing disabled. Callers depend on this
 * contract so that tracing can be toggled without touching admission code.
 */
export interface TraceRecorder {
  /**
   * Opens a new trace recording session for an admitted request.
   */
  start(context: TraceContext): Promise<TraceSession>;
}

/**
 * The immutable metadata that identifies a trace session.
 *
 * This interface represents the four facts that every trace directory is
 * stamped with: which request it belongs to, when it started, which
 * configuration revision was active, and which protocol the client spoke.
 * Admission builds the value and passes it to `TraceRecorder.start`, which
 * persists it as the manifest. The value never changes after the session
 * opens.
 */
export interface TraceContext {
  /** The unique request identifier for the traced request. */
  readonly aptusRequestId: AptusRequestId;

  /** The ISO-local timestamp formatted for directory naming. */
  readonly startedAtLocal: string;

  /** The SHA-256 digest of the running configuration. */
  readonly configRevision: string;

  /** The client protocol for the trace manifest. */
  readonly sourceProtocol: Protocol;
}

/**
 * An active per-request trace recording session for atomic stage logging.
 *
 * This interface represents the open trace directory that every pipeline
 * stage writes to as the request flows. Atomic stage logging means that
 * each stage file appears either fully written or not at all, because JSON
 * stages are fsynced and renamed and byte stages commit through a sink.
 * Admission opens the session, each layer records its stages, and the
 * terminal path finishes the session with the final outcome. The session
 * holds filesystem resources until finished.
 */
export interface TraceSession {
  /**
   * Records a structured JSON trace stage with secret redaction.
   */
  recordJson(stage: TraceStage, value: JsonValue): Promise<void>;

  /**
   * Records raw payload bytes without text redaction for binary-safe stages.
   */
  recordBytes(stage: TraceStage, bytes: Uint8Array): Promise<void>;

  /**
   * Opens an incremental raw byte sink that publishes atomically on completion.
   */
  openBytes(stage: TraceStage): TraceByteSink;

  /**
   * Writes the final terminal marker file and closes session resources.
   */
  finish(result: TraceTerminal): Promise<void>;
}
