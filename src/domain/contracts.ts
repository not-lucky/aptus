import type { IrFailureCategory, NormalizedFailure, TraceStage, TraceTerminal } from "./operations.js";
import type { AptusRequestId } from "./request-id.js";

/** A JSON scalar, array, or object value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** A JSON object with no prototype-dependent behavior. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A case-insensitive HTTP header map with lower-case keys and joined safe values. */
export type HeaderMap = Readonly<Record<string, string>>;

/** One of the three client and provider create protocols. */
export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";

/** A result for an expected domain failure.
 * @typeParam T Successful value type.
 * @typeParam E Expected failure type.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** An accepted client request passed from HTTP to the Gateway. */
export interface GatewayRequest {
  /** UUID created after ingress admission. */
  readonly aptusRequestId: AptusRequestId;
  /** Protocol selected by the mounted endpoint. */
  readonly protocol: Protocol;
  /** Canonical endpoint metric label, without the optional `/v1` prefix. */
  readonly endpoint: "/chat/completions" | "/responses" | "/messages";
  /** Lower-case filtered client headers. */
  readonly headers: HeaderMap;
  /** Duplicate-free parsed request object. */
  readonly body: JsonObject;
  /** Authenticated client-key name, never its secret. */
  readonly clientKeyName: string;
  /** Signal composed from disconnect, request deadline, and shutdown. */
  readonly signal: AbortSignal;
}

/** The selected dry-run candidate. */
export interface DryRunCandidate {
  /** Configured provider name. */
  readonly provider: string;
  /** Upstream provider model ID. */
  readonly model: string;
  /** Selected configured provider-key name, never its secret. */
  readonly key: string;
}

/** A prepared dry-run provider request. */
export interface DryRunProviderRequest {
  /** Create requests always use POST. */
  readonly method: "POST";
  /** Final same-origin provider URL. */
  readonly url: string;
  /** Redacted final headers. */
  readonly headers: HeaderMap;
  /** Final merged native or translated request object. */
  readonly body: JsonObject;
}

/** The successful dry-run response contract. */
export interface DryRunResult {
  /** Constant success marker. */
  readonly dryRun: true;
  /** Aptus request identity. */
  readonly aptusRequestId: AptusRequestId;
  /** Client Protocol. */
  readonly sourceProtocol: Protocol;
  /** selected Provider Protocol. */
  readonly targetProtocol: Protocol;
  /** Canonical Public Model or Route name. */
  readonly publicName: string;
  /** Selected Candidate and provider key name. */
  readonly candidate: DryRunCandidate;
  /** Ordered JSON Pointers changed by defaults, extra body, overrides, or model replacement. */
  readonly mutations: readonly string[];
  /** Result of Candidate preflight. */
  readonly preflight: { readonly ok: true } | { readonly ok: false; readonly failure: NormalizedFailure };
  /** Provider request that would be sent. */
  readonly providerRequest: DryRunProviderRequest;
}

/** A Gateway result returned to the HTTP owner. */
export type GatewayResult =
  | { readonly kind: "complete"; readonly status: number; readonly headers: HeaderMap; readonly body: Uint8Array }
  | {
      readonly kind: "stream";
      readonly status: number;
      readonly headers: HeaderMap;
      readonly body: ReadableStream<Uint8Array>;
    }
  | {
      readonly kind: "dry_run";
      readonly status: 200;
      readonly contentType: "application/vnd.aptus.dry-run+json";
      readonly body: DryRunResult;
    }
  | { readonly kind: "failure"; readonly failure: NormalizedFailure };

/** Orchestrates one accepted request behind one response-owner result. */
export interface Gateway {
  /** Executes authorization-independent routing and dispatch.
   * @param request Validated request and shared cancellation signal.
   * @returns One complete body, owned stream, dry-run result, or expected failure.
   * @remarks It never writes to an Express response. It checks `request.signal` during each wait and dispatch.
   */
  execute(request: GatewayRequest): Promise<GatewayResult>;
}

/** Input for native provider request preparation. */
export interface NativePreparationInput {
  /** Candidate protocol and provider identity. */
  readonly protocol: Protocol;
  /** API-root base URL without its one trailing slash. */
  readonly baseUrl: string;
  /** Upstream provider model ID. */
  readonly upstreamModel: string;
  /** Duplicate-free client JSON object. */
  readonly clientBody: JsonObject;
  /** Filtered end-to-end client headers. */
  readonly clientHeaders: HeaderMap;
  /** Provider static headers with no authentication header. */
  readonly providerHeaders: HeaderMap;
  /** Provider secret for this Attempt. */
  readonly providerSecret: string;
  /** Ordered provider-native mutation inputs. */
  readonly mutations: NativeMutations;
}

/** Provider-native mutation maps applied in defaults, extraBody, then overrides order. */
export interface NativeMutations {
  /** Values inserted only at absent object paths. */
  readonly defaults: JsonObject;
  /** Provider extension values merged after defaults. */
  readonly extraBody: JsonObject;
  /** Values that replace or insert request values. */
  readonly overrides: JsonObject;
}

/** One fully prepared upstream request whose body belongs to the dispatcher after dispatch starts. */
export interface PreparedProviderRequest {
  /** Configured provider name for bounded telemetry. */
  readonly provider: string;
  /** Provider Protocol. */
  readonly protocol: Protocol;
  /** POST create URL. */
  readonly url: string;
  /** Filtered headers with selected provider authentication. */
  readonly headers: HeaderMap;
  /** UTF-8 serialized JSON body. */
  readonly body: Uint8Array;
  /** True when the client requested SSE. */
  readonly stream: boolean;
  /** Absolute monotonic deadline in milliseconds. */
  readonly deadlineMs: number;
  /** Stream idle limit reset by every received byte. */
  readonly streamIdleMs: number;
}

/** The immutable response head used before any body is exposed. */
export interface ProviderResponseHead {
  /** Provider HTTP status. */
  readonly status: number;
  /** Filtered lower-case headers. */
  readonly headers: HeaderMap;
}

/** A dispatcher response. The caller must consume or cancel `body` exactly once. */
export interface ProviderResponse extends ProviderResponseHead {
  /** Provider bytes with backpressure. */
  readonly body: ReadableStream<Uint8Array>;
  /** Final URL after allowed same-origin redirects. */
  readonly finalUrl: string;
}

/** Normalized facts from a pre-body provider response or transport outcome. */
export interface AttemptObservation {
  /** Stable failure category, or `success`. */
  readonly result: "success" | IrFailureCategory | "client_cancelled";
  /** Explicit HTTP status when one exists. */
  readonly status?: number;
  /** Parsed Retry-After or provider reset delay in milliseconds. */
  readonly retryDelayMs?: number;
  /** True only before any provider response body byte is exposed to the client. */
  readonly beforeClientBytes: boolean;
}

/** One immutable routing lifecycle event observed by logs, metrics, and Trace. */
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

/** Receives immutable lifecycle facts without routing authority. */
export interface LifecycleObserver {
  /** Observes one ordered lifecycle event.
   * @param event Immutable event with bounded routing facts.
   * @returns Nothing; observation is non-blocking for routing.
   * @remarks Implementations queue or record failures. They cannot mutate Gateway state or fail a client request.
   */
  observe(event: LifecycleEvent): void;
}

/** Protocol-specific native behavior. */
export interface ProtocolAdapter {
  /** The one protocol implemented by this adapter. */
  readonly protocol: Protocol;
  /** Exact path appended to the provider API root. */
  readonly createPath: "/chat/completions" | "/responses" | "/v1/messages";
  /** Reads a public model or route name.
   * @param body Parsed request object.
   * @returns The requested public name or `invalid_request`.
   */
  readPublicModel(body: JsonObject): Result<string, NormalizedFailure>;
  /** Prepares a same-protocol provider request.
   * @param input Candidate, header, key, and mutation inputs.
   * @returns A dispatch request or an expected preflight failure.
   * @remarks Unknown native fields and array order remain. JSON whitespace and object-key order can change.
   */
  prepareNative(input: NativePreparationInput): Result<PreparedProviderRequest, NormalizedFailure>;
  /** Classifies a provider response head.
   * @param response Provider status and filtered headers.
   * @returns A bounded Attempt observation.
   */
  classify(response: ProviderResponseHead): AttemptObservation;
  /** Builds the configured local model-list envelope.
   * @param input Sorted authorized canonical catalog entries.
   * @returns A protocol-native list object.
   */
  buildModelList(input: ModelListInput): JsonObject;
}

/** A local configured model-list entry. */
export interface ModelListEntry {
  /** Canonical Public Model or Route name. */
  readonly id: string;
  /** Explicit catalog metadata for the selected envelope. */
  readonly metadata: JsonObject;
}

/** Input to one protocol model-list builder. */
export interface ModelListInput {
  /** Lexicographically sorted, authorized canonical entries. */
  readonly entries: readonly ModelListEntry[];
}

/** Owns network dispatch and response-body resource transfer. */
export interface ProviderDispatcher {
  /** Dispatches one prepared request.
   * @param request Request whose body ownership transfers for this call.
   * @param signal Composed request cancellation signal.
   * @returns A response whose body must be consumed or canceled once.
   * @throws Only for transport, timeout, abort, redirect-policy, or local I/O failures.
   */
  dispatch(request: PreparedProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

/** A provider-key lease. */
export interface KeyLease {
  /** Configured provider name. */
  readonly provider: string;
  /** Stable key name safe for traces, not the secret. */
  readonly keyName: string;
  /** Secret used only to prepare the provider request. */
  readonly secret: string;
  /** Opaque lease generation that prevents stale observations. */
  readonly generation: number;
}

/** Result of a non-blocking key acquisition. */
export type KeyAcquireResult =
  | { readonly kind: "acquired"; readonly lease: KeyLease }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "unavailable" };

/** Maintains process-local selection and adaptive key health. */
export interface KeyPool {
  /** Acquires an available key without waiting.
   * @param nowMs Monotonic current time.
   * @returns A lease, earliest availability time, or permanent unavailability.
   */
  acquire(nowMs: number): KeyAcquireResult;
  /** Applies one completed observation to key health.
   * @param lease Lease used by the Attempt.
   * @param observation Normalized Attempt result.
   * @param nowMs Monotonic observation time.
   * @remarks Stale lease generations have no effect.
   */
  observe(lease: KeyLease, observation: AttemptObservation, nowMs: number): void;
}

/** Starts one protected Trace. */
export interface TraceRecorder {
  /** Opens a request Trace.
   * @param context Immutable Trace identity and config revision.
   * @returns A serial Trace Session or a no-op/degraded session.
   * @throws Only when the configured policy makes startup probing fatal; runtime failures are recorded as degraded state.
   */
  start(context: TraceContext): Promise<TraceSession>;
}

/** Immutable Trace identity. */
export interface TraceContext {
  /** Aptus request identity. */
  readonly aptusRequestId: AptusRequestId;
  /** ISO-local directory timestamp. */
  readonly startedAtLocal: string;
  /** Frozen config revision digest. */
  readonly configRevision: string;
  /** Client Protocol. */
  readonly sourceProtocol: Protocol;
}

/** An ordered per-request Trace writer. */
export interface TraceSession {
  /** Records a parsed stage atomically.
   * @param stage Stable stage identity.
   * @param value JSON value after field-aware secret redaction.
   * @returns Completion after fsync and atomic rename.
   */
  recordJson(stage: TraceStage, value: JsonValue): Promise<void>;
  /** Records exact native or translated bytes atomically.
   * @param stage Stable stage identity.
   * @param bytes Bytes that are not content-scanned.
   * @returns Completion after fsync and atomic rename.
   */
  recordBytes(stage: TraceStage, bytes: Uint8Array): Promise<void>;
  /** Writes exactly one terminal marker and closes the session.
   * @param result Complete, failed, cancelled, dry-run, shutdown, or trace-incomplete result.
   * @returns Completion after resources close.
   */
  finish(result: TraceTerminal): Promise<void>;
}
