import type { IrFailureCategory, NormalizedFailure, TraceStage, TraceTerminal } from "./operations.js";
import type { AptusRequestId } from "./request-id.js";

/**
 * A JSON primitive scalar, array, or object value.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/**
 * A JSON object with no prototype-dependent behavior.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * An immutable HTTP header map with lower-case header names and sanitized string values.
 */
export type HeaderMap = Readonly<Record<string, string>>;

/**
 * Supported client ingress and upstream provider protocol types.
 */
export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";

/**
 * Discriminated union representing either a successful calculation or an expected domain failure.
 *
 * @typeParam T - Successful value payload type.
 * @typeParam E - Domain failure type.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/**
 * An accepted, validated client create request passed from HTTP ingress to the Gateway orchestrator.
 */
export interface GatewayRequest {
  /**
   * Unique UUID assigned after admission.
   */
  readonly aptusRequestId: AptusRequestId;

  /**
   * Client protocol corresponding to the mounted endpoint.
   */
  readonly protocol: Protocol;

  /**
   * Canonical endpoint metric label without prefix (e.g., `"/chat/completions"`).
   */
  readonly endpoint: "/chat/completions" | "/responses" | "/messages";

  /**
   * Filtered, lower-case client headers with hop-by-hop and auth credentials removed.
   */
  readonly headers: HeaderMap;

  /**
   * Parsed, duplicate-free JSON request payload.
   */
  readonly body: JsonObject;

  /**
   * Authenticated client key name (never the secret).
   */
  readonly clientKeyName: string;

  /**
   * Composite abort signal (combines client disconnect, timeout deadline, and shutdown signals).
   */
  readonly signal: AbortSignal;
}

/**
 * The selected candidate provider and key metadata for a dry-run evaluation.
 */
export interface DryRunCandidate {
  /**
   * Name of the configured provider.
   */
  readonly provider: string;

  /**
   * Upstream model ID to be requested from the provider.
   */
  readonly model: string;

  /**
   * Selected provider key name (safe for diagnostic output, never the secret).
   */
  readonly key: string;
}

/**
 * A fully prepared upstream request inspection object generated during dry-run.
 */
export interface DryRunProviderRequest {
  /**
   * Create requests always use HTTP POST.
   */
  readonly method: "POST";

  /**
   * Resolved provider target URL.
   */
  readonly url: string;

  /**
   * Outbound provider headers with sensitive secrets redacted.
   */
  readonly headers: HeaderMap;

  /**
   * Fully mutated or translated JSON request body.
   */
  readonly body: JsonObject;
}

/**
 * Response payload returned when executing a dry-run create request.
 */
export interface DryRunResult {
  /**
   * Constant success marker.
   */
  readonly dryRun: true;

  /**
   * Unique request identifier.
   */
  readonly aptusRequestId: AptusRequestId;

  /**
   * Protocol of the incoming client request.
   */
  readonly sourceProtocol: Protocol;

  /**
   * Protocol of the target candidate provider.
   */
  readonly targetProtocol: Protocol;

  /**
   * Canonical public model or route name.
   */
  readonly publicName: string;

  /**
   * Selected candidate provider, model, and key identifier.
   */
  readonly candidate: DryRunCandidate;

  /**
   * Ordered list of JSON Pointers mutated by defaults, extraBody, overrides, or model substitution.
   */
  readonly mutations: readonly string[];

  /**
   * Result of candidate capability preflight checks.
   */
  readonly preflight: { readonly ok: true } | { readonly ok: false; readonly failure: NormalizedFailure };

  /**
   * Inspection payload of the provider request that would have been dispatched.
   */
  readonly providerRequest: DryRunProviderRequest;
}

/**
 * Terminal result returned by the Gateway orchestrator to the HTTP layer.
 */
export type GatewayResult =
  | {
      /** Complete non-streaming response body. */
      readonly kind: "complete";
      readonly status: number;
      readonly headers: HeaderMap;
      readonly body: Uint8Array;
    }
  | {
      /** Streaming SSE response with backpressured ReadableStream. */
      readonly kind: "stream";
      readonly status: number;
      readonly headers: HeaderMap;
      readonly body: ReadableStream<Uint8Array>;
    }
  | {
      /** Dry-run inspection response. */
      readonly kind: "dry_run";
      readonly status: 200;
      readonly contentType: "application/vnd.aptus.dry-run+json";
      readonly body: DryRunResult;
    }
  | {
      /** Normalized domain failure. */
      readonly kind: "failure";
      readonly failure: NormalizedFailure;
    };

/**
 * Gateway execution orchestrator for admitted client requests.
 */
export interface Gateway {
  /**
   * Executes routing, key lease acquisition, candidate preflight, mutation, and upstream dispatch.
   *
   * @param request - Admitted and validated client request.
   * @returns A promise resolving to a {@link GatewayResult}.
   *
   * @remarks
   * The Gateway is decoupled from Express response management. It checks `request.signal`
   * at every scheduling boundary and yields back to the HTTP layer for actual client response writing.
   */
  execute(request: GatewayRequest): Promise<GatewayResult>;
}

/**
 * Input arguments for preparing a same-protocol provider request.
 */
export interface NativePreparationInput {
  /**
   * Protocol for the target provider.
   */
  readonly protocol: Protocol;

  /**
   * Normalized base API URL without trailing slash.
   */
  readonly baseUrl: string;

  /**
   * Upstream model ID to substitute into the request payload.
   */
  readonly upstreamModel: string;

  /**
   * Parsed, duplicate-free client JSON body.
   */
  readonly clientBody: JsonObject;

  /**
   * Filtered end-to-end client headers.
   */
  readonly clientHeaders: HeaderMap;

  /**
   * Configured static provider headers (without authentication).
   */
  readonly providerHeaders: HeaderMap;

  /**
   * Resolved provider secret for the acquired key lease.
   */
  readonly providerSecret: string;

  /**
   * Configured native mutations (defaults, extraBody, overrides).
   */
  readonly mutations: NativeMutations;
}

/**
 * Native request mutations applied in deterministic order: defaults -> extraBody -> overrides -> model replacement.
 */
export interface NativeMutations {
  /**
   * Key-value pairs applied only when the key is absent in the client payload.
   */
  readonly defaults: JsonObject;

  /**
   * Provider extension values deeply merged after defaults.
   */
  readonly extraBody: JsonObject;

  /**
   * Values that override or insert fields in the final payload.
   */
  readonly overrides: JsonObject;
}

/**
 * Fully prepared upstream provider request ready for network dispatch.
 */
export interface PreparedProviderRequest {
  /**
   * Configured provider name for metrics and traces.
   */
  readonly provider: string;

  /**
   * Target provider protocol.
   */
  readonly protocol: Protocol;

  /**
   * Absolute target URL for the POST create request.
   */
  readonly url: string;

  /**
   * Filtered outbound headers containing provider authentication.
   */
  readonly headers: HeaderMap;

  /**
   * UTF-8 encoded serialized JSON payload.
   */
  readonly body: Uint8Array;

  /**
   * Whether streaming SSE response mode was requested.
   */
  readonly stream: boolean;

  /**
   * Absolute monotonic request deadline in milliseconds.
   */
  readonly deadlineMs: number;

  /**
   * Maximum stream idle duration in milliseconds between incoming bytes.
   */
  readonly streamIdleMs: number;
}

/**
 * HTTP status and headers received from upstream before body consumption.
 */
export interface ProviderResponseHead {
  /**
   * Upstream HTTP status code.
   */
  readonly status: number;

  /**
   * Filtered lower-case response headers from provider.
   */
  readonly headers: HeaderMap;
}

/**
 * Complete upstream dispatcher response.
 *
 * @remarks
 * The consumer must consume or cancel {@link body} exactly once to prevent connection leaks.
 */
export interface ProviderResponse extends ProviderResponseHead {
  /**
   * Backpressured byte stream of the response body.
   */
  readonly body: ReadableStream<Uint8Array>;

  /**
   * Final URL after following allowed same-origin redirects.
   */
  readonly finalUrl: string;
}

/**
 * Normalized observation extracted from an upstream attempt response head or transport failure.
 */
export interface AttemptObservation {
  /**
   * Stable result category or `"success"`.
   */
  readonly result: "success" | IrFailureCategory | "client_cancelled";

  /**
   * Observed HTTP status code, if response head was received.
   */
  readonly status?: number;

  /**
   * Parsed `Retry-After` delay in milliseconds.
   */
  readonly retryDelayMs?: number;

  /**
   * `true` only if no response body bytes have been written to the downstream client.
   */
  readonly beforeClientBytes: boolean;
}

/**
 * Immutable lifecycle event emitted during routing and dispatch for telemetry observation.
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
 * Observer interface for recording routing lifecycle events in metrics, logs, and traces.
 */
export interface LifecycleObserver {
  /**
   * Receives an immutable routing lifecycle event.
   *
   * @param event - The emitted lifecycle event.
   * @remarks Observation is synchronous/non-blocking and cannot alter routing decisions or fail requests.
   */
  observe(event: LifecycleEvent): void;
}

/**
 * Protocol adapter interface defining protocol-specific serialization, classification, and catalog building.
 */
export interface ProtocolAdapter {
  /**
   * Protocol identifier handled by this adapter.
   */
  readonly protocol: Protocol;

  /**
   * Exact relative path appended to provider API base URL for create requests.
   */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";

  /**
   * Extracts the public model or route name requested in the client JSON body.
   *
   * @param body - Parsed client request payload.
   * @returns Result containing the model string or an invalid_request failure.
   */
  readPublicModel(body: JsonObject): Result<string, NormalizedFailure>;

  /**
   * Prepares a native upstream provider request applying configured mutations.
   *
   * @param input - Mutation, header, secret, and model configuration inputs.
   * @returns Result containing the prepared request or a preflight failure.
   */
  prepareNative(input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure>;

  /**
   * Classifies an upstream response head into a normalized attempt observation.
   *
   * @param response - Response status and filtered headers.
   * @returns An {@link AttemptObservation} indicating outcome and retry metadata.
   */
  classify(response: ProviderResponseHead): AttemptObservation;

  /**
   * Constructs a protocol-native model catalog list envelope.
   *
   * @param input - Sorted authorized catalog entries.
   * @returns Protocol-native list envelope JSON object.
   */
  buildModelList(input: ModelListInput): JsonObject;
}

/**
 * A single entry in the local model catalog.
 */
export interface ModelListEntry {
  /**
   * Canonical public model or route identifier.
   */
  readonly id: string;

  /**
   * Protocol-specific catalog metadata fields.
   */
  readonly metadata: JsonObject;
}

/**
 * Input parameters for building a protocol-specific model catalog list.
 */
export interface ModelListInput {
  /**
   * Lexicographically sorted, authorized model list entries.
   */
  readonly entries: readonly ModelListEntry[];
}

/**
 * HTTP transport dispatcher for sending prepared requests to upstream providers.
 */
export interface ProviderDispatcher {
  /**
   * Executes network dispatch for a prepared request with timeout and redirect policies.
   *
   * @param request - Prepared request payload and headers.
   * @param signal - Abort signal for request cancellation.
   * @returns Promise resolving to the upstream response.
   * @throws Transport, timeout, abort, redirect violation, or socket errors.
   */
  dispatch(request: PreparedProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

/**
 * A leased provider API key credential with generation tracking.
 */
export interface KeyLease {
  /**
   * Name of the provider owning this key.
   */
  readonly provider: string;

  /**
   * Unique name of the key within its key pool (safe for telemetry).
   */
  readonly keyName: string;

  /**
   * Secret value used to prepare authorization headers.
   */
  readonly secret: string;

  /**
   * Lease generation counter preventing stale observations from updating key health.
   */
  readonly generation: number;
}

/**
 * Result of a non-blocking key acquisition attempt.
 */
export type KeyAcquireResult =
  | { readonly kind: "acquired"; readonly lease: KeyLease }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "unavailable" };

/**
 * Key pool managing key selection strategy and adaptive cooldown health states.
 */
export interface KeyPool {
  /**
   * Non-blocking attempt to acquire an enabled, available key lease.
   *
   * @param nowMs - Current monotonic time in milliseconds.
   * @returns Acquisition outcome: acquired lease, wait timestamp, or permanently unavailable.
   */
  acquire(nowMs: number): KeyAcquireResult;

  /**
   * Records an attempt outcome to update adaptive health cooldowns for the leased key.
   *
   * @param lease - The leased key used for the attempt.
   * @param observation - Classified attempt observation.
   * @param nowMs - Monotonic timestamp of the observation.
   */
  observe(lease: KeyLease, observation: AttemptObservation, nowMs: number): void;
}

/**
 * Recorder interface for initiating request trace recording sessions.
 */
export interface TraceRecorder {
  /**
   * Opens a new trace recording session for an admitted request.
   *
   * @param context - Immutable trace metadata and request identifiers.
   * @returns A promise resolving to an active {@link TraceSession}.
   */
  start(context: TraceContext): Promise<TraceSession>;
}

/**
 * Immutable metadata identifying a trace session.
 */
export interface TraceContext {
  /**
   * Unique request identifier.
   */
  readonly aptusRequestId: AptusRequestId;

  /**
   * ISO-local timestamp formatted for directory naming.
   */
  readonly startedAtLocal: string;

  /**
   * SHA-256 digest of the running configuration.
   */
  readonly configRevision: string;

  /**
   * Client protocol for the trace manifest.
   */
  readonly sourceProtocol: Protocol;
}

/**
 * Active per-request trace recording session for atomic stage logging.
 */
export interface TraceSession {
  /**
   * Records a structured JSON trace stage with secret redaction.
   *
   * @param stage - Lifecycle stage identifier.
   * @param value - JSON payload to record.
   * @returns Promise resolving when the stage file is fsynced and atomically renamed.
   */
  recordJson(stage: TraceStage, value: JsonValue): Promise<void>;

  /**
   * Records raw payload bytes (SSE stream chunks or binary payloads) without text redaction.
   *
   * @param stage - Lifecycle stage identifier.
   * @param bytes - Byte buffer to record.
   * @returns Promise resolving when the file is fsynced and atomically renamed.
   */
  recordBytes(stage: TraceStage, bytes: Uint8Array): Promise<void>;

  /**
   * Writes the final terminal marker file (`999_terminal.json`) and closes session resources.
   *
   * @param result - Terminal execution outcome.
   * @returns Promise resolving when terminal state is finalized.
   */
  finish(result: TraceTerminal): Promise<void>;
}
