import type { HeaderMap, JsonObject, PreparedProviderRequest, Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { IrOutcome, IrRequest, IrStreamEvent } from "./ir.ts";
import type { SseFrame } from "./sse.ts";

/**
 * Six directed cross-protocol translation paths.
 */
export type Direction =
  | "openai-chat->openai-responses"
  | "openai-chat->anthropic-messages"
  | "openai-responses->openai-chat"
  | "openai-responses->anthropic-messages"
  | "anthropic-messages->openai-chat"
  | "anthropic-messages->openai-responses";

/**
 * Decode result for a request body: the semantic IR request plus the wire-only
 * option sidecar captured from protocol-specific fields that stay out of the IR.
 */
export interface RequestDecodeResult {
  readonly irRequest: IrRequest;
  readonly requestWireOptions: RequestWireOptions;
}

/**
 * Decode result for an outcome body: the semantic IR outcome plus the wire-only
 * response-side sidecar (moderation result, service-tier echo).
 */
export interface OutcomeDecodeResult {
  readonly irOutcome: IrOutcome;
  readonly outcomeWireOptions: OutcomeWireOptions;
}

/**
 * Anchor of a prompt-cache breakpoint on a semantic IR position.
 *
 * `itemIndex` is the index of the anchored item in `IrRequest.items` and
 * `partIndex` the index of the anchored content part within that item's message
 * content (omitted for instruction items, which have no part list). Anchoring to
 * IR positions lets every target egress re-anchor markers onto its own
 * reconstructed parts/blocks without knowing the source wire layout. Only
 * explicit per-part/per-block markers are admitted today, so every anchor is an
 * explicit marker by construction.
 */
export interface PromptCacheBreakpoint {
  readonly itemIndex: number;
  readonly partIndex?: number;
}

/**
 * Wire-only request options traveling beside the IR.
 *
 * Matrix-admitted semantic fields (storage, prompt-cache key/mode/ttl/breakpoints,
 * metadata/legacy user, safety identifier, moderation param, service tier) are
 * protocol-shaped but deliberately NOT represented in `IrRequest` — they ride in
 * this closed, typed sidecar so the IR stays protocol-neutral. Source ingress
 * captures them verbatim; direction feasibility is enforced by preflight and
 * target egress projects them per the matrix tiers. Never an extension bag.
 */
export interface RequestWireOptions {
  /** `responses-storage`: explicit server-side storage flag (never a fabricated default). */
  readonly store?: boolean;
  /** `prompt-cache-key`: cache-bucketing key (C/R only). */
  readonly promptCacheKey?: string | null;
  /** `prompt-cache-mode`: implicit or explicit breakpoint management (C/R only). */
  readonly promptCacheMode?: "implicit" | "explicit";
  /** `prompt-cache-ttl`: C/R support only "30m". */
  readonly promptCacheTtl?: "30m";
  /**
   * `prompt-cache-breakpoint`: per-part explicit breakpoints anchored to IR positions.
   * C↔R direct; into/out of M marker-only with declared TTL loss.
   */
  readonly promptCacheBreakpoints?: ReadonlyArray<PromptCacheBreakpoint>;
  /** `request-metadata` kv subset (C/R limits: ≤16 entries, key ≤64, value ≤512). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** C/R legacy `user` identifier — C↔R passthrough only, declared loss into M. */
  readonly user?: string;
  /** `safety-identifier` (C/R only). */
  readonly safetyIdentifier?: string | null;
  /** `moderation-policy-result` request param `{model, policy?}`, verbatim (C/R only). */
  readonly moderation?: JsonObject | null;
  /** `service-tier` request param; into/out of M only "auto" maps (preflight enforces). */
  readonly serviceTier?: string | null;
}

/**
 * Wire-only response-side options traveling beside `IrOutcome`.
 *
 * Carried in the SOURCE protocol's normal form: the moderation result is stored
 * unwrapped ({input, output}, each holding one singular verdict) regardless of
 * source wrapper shape; the service-tier echo is the source's verbatim value.
 * The target egress re-wraps the moderation verdicts to its own wire shape, and
 * emits the tier echo only when the value belongs to its own vocabulary.
 */
export interface OutcomeWireOptions {
  /** `moderation-policy-result` response result in normal (unwrapped) form. */
  readonly moderation?: JsonObject;
  /** `service-tier` response echo, verbatim from the source wire. */
  readonly serviceTier?: string;
}

/**
 * Protocol-specific ingress decoder contract for transforming raw client/provider
 * wire payloads into the private IR representation alongside the wire-only
 * option sidecars.
 */
export interface IngressDecoder {
  /**
   * Decodes a validated JSON request body into an {@link IrRequest} plus the
   * captured {@link RequestWireOptions} sidecar.
   */
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure>;

  /**
   * Decodes an upstream provider HTTP response into an {@link IrOutcome} plus the
   * captured {@link OutcomeWireOptions} sidecar.
   */
  decodeOutcome(status: number, headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure>;
}

/**
 * Protocol-specific egress encoder contract for transforming private IR representations
 * into target provider or client wire payloads.
 */
export interface EgressEncoder {
  /**
   * Encodes an {@link IrRequest} into the target provider JSON request body,
   * projecting any admitted {@link RequestWireOptions} onto target wire fields.
   *
   * @param request - Semantic IR request.
   * @param targetModel - The resolved upstream provider model name.
   * @param requestWireOptions - Wire-only options captured by the source ingress.
   */
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject;

  /**
   * Encodes an {@link IrOutcome} into the client-native JSON response representation,
   * projecting any admitted {@link OutcomeWireOptions} onto client wire fields.
   */
  encodeOutcome(
    outcome: IrOutcome,
    outcomeWireOptions?: OutcomeWireOptions,
  ): {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly body: JsonObject;
  };
}

/**
 * Wire-level options discovered on a stream request that are outside the private IR.
 */
export interface StreamWireOptions {
  readonly includeUsage?: boolean;
}

/**
 * Decode result for a streaming create request: IR, stream wire options, and the
 * request wire-options sidecar.
 */
export interface StreamRequestDecodeResult extends RequestDecodeResult {
  readonly sourceWireOptions: StreamWireOptions;
}

/**
 * Decodes a streaming create request into an {@link IrRequest} and wire options.
 */
export interface StreamRequestDecoder {
  decodeRequest(body: JsonObject): Result<StreamRequestDecodeResult, NormalizedFailure>;
}

/**
 * Encodes a semantic {@link IrRequest} and resolved wire options into target provider JSON with stream: true.
 */
export interface StreamRequestEncoder {
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject;
}

/**
 * Decodes one provider protocol stream into semantic IR events.
 */
export interface ProviderStreamDecoder {
  /** Provider Protocol accepted by this decoder. */
  readonly protocol: Protocol;
  /** Accepts one strict SSE frame. */
  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure>;
  /** Validates EOF and protocol terminal state. */
  finish(): Result<readonly IrStreamEvent[], NormalizedFailure>;
  /**
   * Outcome-side wire-only options discovered on the stream so far (moderation
   * result, service-tier echo). Read by the stream pump when it reaches the
   * terminal event, before the client encoder encodes the final frame.
   */
  getOutcomeWireOptions(): OutcomeWireOptions;
}

/**
 * Encodes semantic IR events as one client protocol stream.
 */
export interface ClientStreamEncoder {
  /** Client Protocol emitted by this encoder. */
  readonly protocol: Protocol;
  /** Encodes one ordered semantic event into target SSE frames. */
  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure>;
  /** Emits only the protocol codec's legal final framing. */
  finish(): Result<readonly SseFrame[], NormalizedFailure>;
  /**
   * Receives outcome-side wire-only options (normalized for the direction)
   * before the terminal event is encoded. Encoders whose protocol has no
   * outcome-side wire surface implement this as a documented no-op — the pump
   * only ever calls it with non-empty options, so an unimplemented setter
   * could silently drop captured facts.
   */
  setOutcomeWireOptions(options: OutcomeWireOptions): void;
}

/**
 * Stream session metadata identifying the opaque response ID and logical model.
 */
export interface StreamSession {
  readonly responseId: string;
  readonly model: string;
  readonly createPartId: () => string;
}

/**
 * Codec registry mapping every supported protocol to its decoder and encoder implementations.
 */
export interface TranslationCodecs {
  readonly ingress: Readonly<Record<Protocol, IngressDecoder>>;
  readonly egress: Readonly<Record<Protocol, EgressEncoder>>;
  readonly streamRequestDecoders: Readonly<Record<Protocol, StreamRequestDecoder>>;
  readonly streamRequestEncoders: Readonly<Record<Protocol, StreamRequestEncoder>>;
  readonly createProviderStreamDecoder: (protocol: Protocol, session: StreamSession) => ProviderStreamDecoder;
  readonly createClientStreamEncoder: (
    protocol: Protocol,
    session: StreamSession,
    wireOptions: StreamWireOptions,
  ) => ClientStreamEncoder;
}

/**
 * Input arguments for translating an admitted cross-protocol complete request.
 */
export interface TranslateCompleteInput {
  readonly sourceProtocol: Protocol;
  readonly targetProtocol: Protocol;
  readonly sourceBody: JsonObject;
  readonly logicalModel: string;
  readonly targetModel: string;
  readonly targetDefaultMaxTokens?: number;
}

/**
 * Result of complete request translation containing target provider body and the private IR request.
 */
export interface TranslateCompleteRequestResult {
  readonly body: JsonObject;
  readonly irRequest: IrRequest;
}

/**
 * Input arguments for translating an admitted cross-protocol stream request.
 */
export interface TranslateStreamRequestInput {
  readonly sourceProtocol: Protocol;
  readonly targetProtocol: Protocol;
  readonly sourceBody: JsonObject;
  readonly logicalModel: string;
  readonly targetModel: string;
  readonly targetDefaultMaxTokens?: number;
}

/**
 * Result of stream request translation containing target provider body, IR request, and source wire options.
 */
export interface TranslateStreamRequestResult {
  readonly body: JsonObject;
  readonly irRequest: IrRequest;
  readonly sourceWireOptions: StreamWireOptions;
}

/**
 * Input arguments for translating an upstream provider outcome back to client-native format.
 */
export interface TranslateCompleteOutcomeInput {
  readonly sourceProtocol: Protocol;
  readonly targetProtocol: Protocol;
  readonly status: number;
  readonly headers: HeaderMap;
  readonly body: JsonObject;
  readonly logicalModel: string;
}

/**
 * Result of outcome translation containing client response envelope and the private IR outcome.
 */
export interface TranslateCompleteOutcomeResult {
  readonly status: number;
  readonly headers: HeaderMap;
  readonly body: JsonObject;
  readonly irOutcome: IrOutcome;
}

/**
 * Input arguments for preparing the translated outbound provider request with headers and auth.
 */
export interface PrepareTranslatedRequestInput {
  /** Configured provider name for metrics and traces. */
  readonly providerName: string;
  readonly targetProtocol: Protocol;
  readonly baseUrl: string;
  readonly clientHeaders: HeaderMap;
  readonly providerHeaders: HeaderMap;
  readonly providerSecret: string;
  readonly body: JsonObject;
  readonly deadlineMs: number;
  readonly streamIdleMs: number;
  readonly stream?: boolean;
}

/**
 * Input arguments for creating a streaming translation session.
 */
export interface CreateStreamSessionInput {
  readonly sourceProtocol: Protocol;
  readonly targetProtocol: Protocol;
  readonly logicalModel: string;
  readonly responseId?: string;
  readonly createPartId?: () => string;
  readonly sourceWireOptions?: StreamWireOptions;
}

/**
 * Stream session bundle containing session metadata and instantiated stream codecs.
 */
export interface StreamSessionBundle {
  readonly session: StreamSession;
  readonly providerDecoder: ProviderStreamDecoder;
  readonly clientEncoder: ClientStreamEncoder;
}

/**
 * Bundled translation coordinator providing request translation, outcome translation,
 * streaming session management, and outbound provider request preparation.
 */
export interface TranslationCoordinator {
  translateCompleteRequest(input: TranslateCompleteInput): Result<TranslateCompleteRequestResult, NormalizedFailure>;
  translateCompleteOutcome(
    input: TranslateCompleteOutcomeInput,
  ): Result<TranslateCompleteOutcomeResult, NormalizedFailure>;
  translateStreamRequest(input: TranslateStreamRequestInput): Result<TranslateStreamRequestResult, NormalizedFailure>;
  createStreamSession(input: CreateStreamSessionInput): StreamSessionBundle;
  prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput): PreparedProviderRequest;
}
