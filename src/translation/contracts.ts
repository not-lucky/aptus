/**
 * @fileoverview Type contracts for the cross-protocol translation layer.
 *
 * Defines the core interfaces, codecs, and data shapes that mediate translation between
 * OpenAI Chat, OpenAI Responses, and Anthropic Messages protocols. Semantic content maps
 * into the protocol-neutral Intermediate Representation (IR), while protocol-specific wire
 * concerns are carried in typed sidecars (`RequestWireOptions` and `OutcomeWireOptions`).
 *
 * The translation coordinator encapsulates decode, validate, preflight, encode, and dispatch
 * preparation behind branded `TranslatedTicket` values to enforce valid pipeline sequencing.
 */
import type { HeaderMap, JsonObject, PreparedProviderRequest, Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { IrOutcome, IrRequest, IrStreamEvent, IrTool } from "./ir.ts";
import type { SseFrame } from "./sse.ts";

/**
 * The six directed cross-protocol translation paths between supported protocols.
 * Same-protocol requests bypass translation and do not use a direction.
 */
export type Direction =
  | "openai-chat->openai-responses"
  | "openai-chat->anthropic-messages"
  | "openai-responses->openai-chat"
  | "openai-responses->anthropic-messages"
  | "anthropic-messages->openai-chat"
  | "anthropic-messages->openai-responses";

/**
 * Result of decoding an inbound request: the semantic IR request plus any protocol-specific
 * options preserved in the wire options sidecar.
 */
export interface RequestDecodeResult {
  /** The request projected into the semantic intermediate representation. */
  readonly irRequest: IrRequest;

  /** Request-side wire options captured verbatim at ingress. */
  readonly requestWireOptions: RequestWireOptions;
}

/**
 * Result of decoding an upstream provider response: the semantic IR outcome plus any
 * response-side wire options (such as moderation results or service tier echoes).
 */
export interface OutcomeDecodeResult {
  /** The response outcome projected into the semantic intermediate representation. */
  readonly irOutcome: IrOutcome;

  /** Response-side wire options captured from the provider response envelope. */
  readonly outcomeWireOptions: OutcomeWireOptions;
}

/**
 * Anchors an explicit prompt-cache breakpoint to a semantic position in the IR request,
 * enabling target egress encoders to reconstruct cache markers in their native wire format.
 */
export interface PromptCacheBreakpoint {
  /** Zero-based index of the anchored item in `IrRequest.items`. */
  readonly itemIndex: number;

  /** Zero-based index of the anchored part within the item's content parts, or undefined if item-scoped. */
  readonly partIndex?: number;
}

/**
 * Wire-only provider file or image reference preserved when a client references hosted files
 * by identifier rather than passing raw payload bytes.
 */
export interface ProviderFileRef {
  /** IR item index where the reference was captured, used for re-emission ordering. */
  readonly itemIndex: number;

  /** IR part index within the item, used to interleave the reference with decoded parts. */
  readonly partIndex: number;

  /** Media kind distinguishing whether the reference came from an image or document wire format. */
  readonly mediaKind: "image" | "document";

  /** Upstream provider file identifier, preserved verbatim without local resolution. */
  readonly fileId: string;

  /** Optional filename captured alongside the file identifier. */
  readonly filename?: string;

  /** Optional image detail level hint (`"auto"` | `"low"` | `"high"`). */
  readonly detail?: "auto" | "low" | "high";
}

/**
 * Wire-only request options traveling alongside the IR request.
 * Captures protocol-specific controls (caching, metadata, moderation, service tiers)
 * that are evaluated during preflight and projected at egress per capability matrix tiers.
 */
export interface RequestWireOptions {
  /** Explicit server-side storage request flag (`store`), preserved verbatim when present. */
  readonly store?: boolean;

  /** Cache-bucketing key for prompt caching, admitted on OpenAI Chat and Responses. */
  readonly promptCacheKey?: string | null;

  /** Prompt cache breakpoint management mode (`"implicit"` | `"explicit"`). */
  readonly promptCacheMode?: "implicit" | "explicit";

  /** Prompt cache retention window; only `"30m"` is supported on OpenAI wires. */
  readonly promptCacheTtl?: "30m";

  /** Explicit prompt-cache breakpoint anchors mapped to IR positions. */
  readonly promptCacheBreakpoints?: ReadonlyArray<PromptCacheBreakpoint>;

  /** Request-level metadata key-value pairs (max 16 entries, key <= 64 chars, value <= 512 chars). */
  readonly metadata?: Readonly<Record<string, string>>;

  /** Legacy user identifier string; preserved across Chat and Responses, declared loss into Messages. */
  readonly user?: string;

  /** Safety identifier for abuse monitoring, admitted on OpenAI Chat and Responses. */
  readonly safetyIdentifier?: string | null;

  /** Moderation policy specification (`{model, policy?}`), admitted on Chat and Responses. */
  readonly moderation?: JsonObject | null;

  /** Requested service tier parameter (only `"auto"` admitted across Anthropic Messages boundaries). */
  readonly serviceTier?: string | null;

  /** Wire-only allowed tool subset control for Chat-to-Responses translations. */
  readonly allowedToolSubset?: { readonly mode: "auto" | "required"; readonly tools: readonly IrTool[] };

  /** Tool names whose source `allowed_callers` allowed direct callers. */
  readonly toolAllowedCallers?: ReadonlyArray<string>;

  /** Legacy JSON object mode flag (`type: "json_object"`), pass-through between Chat and Responses. */
  readonly legacyJsonObject?: boolean;

  /** Wire-only provider file or image references captured from the source request. */
  readonly providerFileRefs?: ReadonlyArray<ProviderFileRef>;
}

/**
 * Wire-only response options traveling alongside the IR outcome.
 * Holds response metadata such as moderation verdict objects and service-tier echoes.
 */
export interface OutcomeWireOptions {
  /** Unwrapped moderation verdicts (`{input, output}`) captured from the provider response. */
  readonly moderation?: JsonObject;

  /** Verbatim service-tier string echoed by the provider response. */
  readonly serviceTier?: string;
}

/**
 * Protocol-specific ingress decoder contract for transforming raw client requests and provider
 * responses into intermediate representation shapes and wire options sidecars.
 */
export interface IngressDecoder {
  /**
   * Decodes a parsed JSON request body into an {@link IrRequest} and wire options sidecar.
   *
   * @param body - Client request body parsed as JSON.
   * @returns Successful result containing decoded request and sidecar, or a normalized failure.
   */
  decodeRequest(body: JsonObject): Result<RequestDecodeResult, NormalizedFailure>;

  /**
   * Decodes an upstream provider HTTP response into an {@link IrOutcome} and wire options sidecar.
   *
   * @param status - Provider HTTP response status code.
   * @param headers - Provider HTTP response headers.
   * @param body - Provider response body parsed as JSON.
   * @returns Successful result containing decoded outcome and sidecar, or a normalized failure.
   */
  decodeOutcome(status: number, headers: HeaderMap, body: JsonObject): Result<OutcomeDecodeResult, NormalizedFailure>;
}

/**
 * Protocol-specific egress encoder contract for transforming intermediate representation
 * shapes into provider request payloads or client response envelopes.
 */
export interface EgressEncoder {
  /**
   * Encodes an {@link IrRequest} into target provider JSON, projecting admitted wire options.
   *
   * @param request - Semantic IR request to encode.
   * @param targetModel - Upstream model identifier to emit on the wire.
   * @param requestWireOptions - Optional request-side wire options captured at ingress.
   * @returns Target provider request payload as a JSON object.
   */
  encodeRequest(request: IrRequest, targetModel: string, requestWireOptions?: RequestWireOptions): JsonObject;

  /**
   * Encodes an {@link IrOutcome} into client-native response status, headers, and body.
   *
   * @param outcome - Semantic IR outcome to encode.
   * @param outcomeWireOptions - Optional response-side wire options captured from provider.
   * @returns Response envelope containing status, headers, and body.
   */
  encodeOutcome(
    outcome: IrOutcome,
    outcomeWireOptions?: OutcomeWireOptions,
  ): {
    /** Client HTTP status code. */
    readonly status: number;
    /** Client HTTP response headers. */
    readonly headers: HeaderMap;
    /** Client-native response JSON body. */
    readonly body: JsonObject;
  };
}

/**
 * Wire-level options parsed from streaming create requests that fall outside the IR.
 */
export interface StreamWireOptions {
  /** Whether the client requested an explicit usage chunk on streaming responses. */
  readonly includeUsage?: boolean;
}

/**
 * Decode result for a streaming request: IR request, stream options, and wire options sidecar.
 */
export interface StreamRequestDecodeResult extends RequestDecodeResult {
  /** Stream-specific options parsed from the inbound request. */
  readonly sourceWireOptions: StreamWireOptions;
}

/**
 * Protocol-specific decoder for parsing streaming request payloads.
 */
export interface StreamRequestDecoder {
  /**
   * Decodes an inbound streaming request body.
   *
   * @param body - Inbound JSON request payload.
   * @returns Decoded request, stream wire options, and request sidecar, or normalized failure.
   */
  decodeRequest(body: JsonObject): Result<StreamRequestDecodeResult, NormalizedFailure>;
}

/**
 * Protocol-specific encoder for serializing streaming provider requests.
 */
export interface StreamRequestEncoder {
  /**
   * Encodes an IR request and stream wire options into a provider JSON payload with streaming enabled.
   *
   * @param request - Semantic IR request to encode.
   * @param targetModel - Upstream provider model identifier.
   * @param wireOptions - Stream options decoded from client request.
   * @param requestWireOptions - Optional request wire options captured at ingress.
   * @returns Target provider streaming request JSON body.
   */
  encodeRequest(
    request: IrRequest,
    targetModel: string,
    wireOptions: StreamWireOptions,
    requestWireOptions?: RequestWireOptions,
  ): JsonObject;
}

/**
 * Stateful decoder transforming upstream provider SSE frames into semantic IR stream events.
 */
export interface ProviderStreamDecoder {
  /** Upstream provider protocol handled by this decoder. */
  readonly protocol: Protocol;

  /**
   * Consumes one SSE frame and returns any yielded IR stream events.
   *
   * @param frame - Incoming SSE frame from the provider stream.
   * @returns Ordered IR stream events yielded by this frame, or normalized failure.
   */
  push(frame: SseFrame): Result<readonly IrStreamEvent[], NormalizedFailure>;

  /**
   * Validates terminal stream state upon upstream connection closure.
   *
   * @returns Final IR stream events if cleanly terminated, or normalized failure if truncated.
   */
  finish(): Result<readonly IrStreamEvent[], NormalizedFailure>;

  /**
   * Retrieves response-side wire options captured across the stream up to this point.
   *
   * @returns Captured outcome wire options.
   */
  getOutcomeWireOptions(): OutcomeWireOptions;
}

/**
 * Stateful encoder serializing semantic IR stream events into client-native SSE frames.
 */
export interface ClientStreamEncoder {
  /** Client protocol emitted by this encoder. */
  readonly protocol: Protocol;

  /**
   * Encodes one IR stream event into zero or more client SSE frames.
   *
   * @param event - Semantic IR stream event to serialize.
   * @returns Client SSE frames, or normalized failure if inexpressible.
   */
  encode(event: IrStreamEvent): Result<readonly SseFrame[], NormalizedFailure>;

  /**
   * Emits any trailing framing required by the client protocol upon stream completion.
   *
   * @returns Final client SSE frames, or normalized failure.
   */
  finish(): Result<readonly SseFrame[], NormalizedFailure>;

  /**
   * Receives normalized outcome wire options before emitting terminal stream events.
   *
   * @param options - Outcome wire options captured from the provider stream.
   */
  setOutcomeWireOptions(options: OutcomeWireOptions): void;
}

/**
 * Metadata and identifier generation scope for a streaming translation session.
 */
export interface StreamSession {
  /** Unique response identifier stamped on every emitted stream event. */
  readonly responseId: string;

  /** Logical or target model name stamped on streaming protocol envelopes. */
  readonly model: string;

  /** Factory generating unique content part identifiers within this stream session. */
  readonly createPartId: () => string;
}

/**
 * Registry of protocol codecs used by the translation coordinator.
 */
export interface TranslationCodecs {
  /** Complete-path ingress decoders keyed by protocol for request and outcome decoding. */
  readonly ingress: Readonly<Record<Protocol, IngressDecoder>>;

  /** Complete-path egress encoders keyed by protocol for request and outcome encoding. */
  readonly egress: Readonly<Record<Protocol, EgressEncoder>>;

  /** Streaming request decoders keyed by protocol. */
  readonly streamRequestDecoders: Readonly<Record<Protocol, StreamRequestDecoder>>;

  /** Streaming request encoders keyed by protocol. */
  readonly streamRequestEncoders: Readonly<Record<Protocol, StreamRequestEncoder>>;

  /**
   * Creates a fresh stateful provider stream decoder for a streaming session.
   *
   * @param protocol - Upstream provider protocol.
   * @param session - Streaming session context.
   * @returns New provider stream decoder instance.
   */
  readonly createProviderStreamDecoder: (protocol: Protocol, session: StreamSession) => ProviderStreamDecoder;

  /**
   * Creates a fresh stateful client stream encoder for a streaming session.
   *
   * @param protocol - Client protocol format.
   * @param session - Streaming session context.
   * @param wireOptions - Stream wire options decoded from client request.
   * @returns New client stream encoder instance.
   */
  readonly createClientStreamEncoder: (
    protocol: Protocol,
    session: StreamSession,
    wireOptions: StreamWireOptions,
  ) => ClientStreamEncoder;
}

/**
 * Input arguments for unified request translation.
 */
export interface TranslateRequestInput {
  /** Inbound client protocol format. */
  readonly sourceProtocol: Protocol;

  /** Outbound upstream provider protocol format. */
  readonly targetProtocol: Protocol;

  /** Inbound client request body parsed as JSON. */
  readonly sourceBody: JsonObject;

  /** Inbound logical model key requested by the client. */
  readonly logicalModel: string;

  /** Upstream concrete model name resolved by candidate selection. */
  readonly targetModel: string;

  /** Delivery mode: `true` for server-sent events stream, `false` for complete response. */
  readonly stream: boolean;

  /** Default output token limit injected for `anthropic-messages` targets when omitted. */
  readonly targetDefaultMaxTokens?: number;
}

/**
 * Opaque branded ticket proving an inbound request successfully completed decode,
 * validation, preflight, and target encoding in ordered sequence.
 */
export interface TranslatedTicket {
  /** Brand discriminator ensuring tickets cannot be forged outside the coordinator. */
  readonly __brand: "TranslatedTicket";

  /** Inbound client protocol format captured at ticket creation. */
  readonly sourceProtocol: Protocol;

  /** Target provider protocol format for which the body was encoded. */
  readonly targetProtocol: Protocol;

  /** Logical model key requested by the client. */
  readonly logicalModel: string;

  /** Upstream concrete model name resolved by candidate selection. */
  readonly targetModel: string;

  /** Delivery mode: `true` for streaming, `false` for complete response. */
  readonly stream: boolean;

  /** Fully encoded and validated target provider request body. */
  readonly body: JsonObject;

  /** Semantic intermediate representation of the request. */
  readonly irRequest: IrRequest;

  /** Stream wire options decoded from the client request. */
  readonly sourceWireOptions: StreamWireOptions;
}

/**
 * Network connection and timeout parameters for dispatching a ticketed provider request.
 */
export interface PrepareTicketRequestInput {
  /** Configured provider name for telemetry and metric labeling. */
  readonly providerName: string;

  /** Base URL of the upstream provider endpoint. */
  readonly baseUrl: string;

  /** Safe-to-forward client request headers filtered during admission. */
  readonly clientHeaders: HeaderMap;

  /** Static headers configured for this provider, taking precedence over client headers. */
  readonly providerHeaders: HeaderMap;

  /** Resolved provider API credential for upstream request authorization. */
  readonly providerSecret: string;

  /** Total request deadline timeout in milliseconds. */
  readonly deadlineMs: number;

  /** Idle timeout in milliseconds between incoming stream chunks. */
  readonly streamIdleMs: number;
}

/**
 * Input arguments for translating complete (non-streaming) requests.
 */
export interface TranslateCompleteInput {
  /** Inbound client protocol format. */
  readonly sourceProtocol: Protocol;

  /** Outbound upstream provider protocol format. */
  readonly targetProtocol: Protocol;

  /** Inbound client request body parsed as JSON. */
  readonly sourceBody: JsonObject;

  /** Logical model key requested by the client. */
  readonly logicalModel: string;

  /** Upstream concrete model name resolved by candidate selection. */
  readonly targetModel: string;

  /** Default output token limit injected for `anthropic-messages` targets when omitted. */
  readonly targetDefaultMaxTokens?: number;
}

/**
 * Result of translating a complete request: encoded target body and IR request.
 */
export interface TranslateCompleteRequestResult {
  /** Encoded target provider request body. */
  readonly body: JsonObject;

  /** Semantic IR request preserved for telemetry and outcome correlation. */
  readonly irRequest: IrRequest;
}

/**
 * Input arguments for translating streaming requests.
 */
export interface TranslateStreamRequestInput {
  /** Inbound client protocol format. */
  readonly sourceProtocol: Protocol;

  /** Outbound upstream provider protocol format. */
  readonly targetProtocol: Protocol;

  /** Inbound client request body parsed as JSON. */
  readonly sourceBody: JsonObject;

  /** Logical model key requested by the client. */
  readonly logicalModel: string;

  /** Upstream concrete model name resolved by candidate selection. */
  readonly targetModel: string;

  /** Default output token limit injected for `anthropic-messages` targets when omitted. */
  readonly targetDefaultMaxTokens?: number;
}

/**
 * Result of translating a streaming request: encoded target body, IR request, and stream options.
 */
export interface TranslateStreamRequestResult {
  /** Encoded target provider streaming request body. */
  readonly body: JsonObject;

  /** Semantic IR request preserved for session binding and telemetry. */
  readonly irRequest: IrRequest;

  /** Stream options decoded from client request for session forwarding. */
  readonly sourceWireOptions: StreamWireOptions;
}

/**
 * Input arguments for translating an upstream provider outcome into client format.
 */
export interface TranslateCompleteOutcomeInput {
  /** Protocol format of the upstream provider response. */
  readonly sourceProtocol: Protocol;

  /** Protocol format expected by the client. */
  readonly targetProtocol: Protocol;

  /** Upstream provider HTTP response status code. */
  readonly status: number;

  /** Upstream provider HTTP response headers. */
  readonly headers: HeaderMap;

  /** Upstream provider JSON response body. */
  readonly body: JsonObject;

  /** Logical model key requested by the client. */
  readonly logicalModel: string;
}

/**
 * Result of translating a complete outcome: client response envelope and IR outcome.
 */
export interface TranslateCompleteOutcomeResult {
  /** HTTP status code to return to the client. */
  readonly status: number;

  /** HTTP response headers to return to the client. */
  readonly headers: HeaderMap;

  /** Client-native response JSON body. */
  readonly body: JsonObject;

  /** Semantic IR outcome preserved for telemetry and usage accounting. */
  readonly irOutcome: IrOutcome;
}

/**
 * Input arguments for preparing translated provider requests without ticket verification.
 */
export interface PrepareTranslatedRequestInput {
  /** Configured provider name for telemetry and metric labeling. */
  readonly providerName: string;

  /** Target provider protocol format. */
  readonly targetProtocol: Protocol;

  /** Base URL of the upstream provider endpoint. */
  readonly baseUrl: string;

  /** Safe-to-forward client request headers filtered during admission. */
  readonly clientHeaders: HeaderMap;

  /** Static headers configured for this provider, taking precedence over client headers. */
  readonly providerHeaders: HeaderMap;

  /** Resolved provider API credential for upstream request authorization. */
  readonly providerSecret: string;

  /** Encoded target provider request body. */
  readonly body: JsonObject;

  /** Total request deadline timeout in milliseconds. */
  readonly deadlineMs: number;

  /** Idle timeout in milliseconds between incoming stream chunks. */
  readonly streamIdleMs: number;

  /** Whether the outbound request is streaming. */
  readonly stream?: boolean;
}

/**
 * Input arguments for creating a streaming translation session without a ticket.
 */
export interface CreateStreamSessionInput {
  /** Protocol format of the upstream provider stream. */
  readonly sourceProtocol: Protocol;

  /** Protocol format expected by the client stream. */
  readonly targetProtocol: Protocol;

  /** Logical model key requested by the client. */
  readonly logicalModel: string;

  /** Optional response identifier override; generated if omitted. */
  readonly responseId?: string;

  /** Optional factory for part identifiers; defaults to monotonic counter. */
  readonly createPartId?: () => string;

  /** Stream options decoded from client request. */
  readonly sourceWireOptions?: StreamWireOptions;
}

/**
 * Streaming session bundle containing session context and initialized stream codecs.
 */
export interface StreamSessionBundle {
  /** Session metadata and identifier generators. */
  readonly session: StreamSession;

  /** Stateful provider stream decoder for incoming SSE frames. */
  readonly providerDecoder: ProviderStreamDecoder;

  /** Stateful client stream encoder for outgoing SSE frames. */
  readonly clientEncoder: ClientStreamEncoder;
}

/**
 * Unified translation coordinator managing request translation, outcome translation,
 * streaming sessions, and outbound provider dispatch preparation.
 */
export interface TranslationCoordinator {
  /**
   * Unified request translation pipeline: decodes, validates, preflights, and encodes
   * an inbound request into a verified `TranslatedTicket`.
   *
   * @param input - Request parameters including protocols, body, models, and delivery mode.
   * @returns Successful result containing verified ticket, or normalized failure from failing stage.
   */
  translateRequest(input: TranslateRequestInput): Result<TranslatedTicket, NormalizedFailure>;

  /**
   * Prepares a ticketed provider request for HTTP dispatch.
   *
   * @param ticket - Verified ticket from successful request translation.
   * @param input - Connection, authentication, and timeout parameters.
   * @returns Prepared provider request ready for HTTP dispatch.
   */
  prepareTicketRequest(ticket: TranslatedTicket, input: PrepareTicketRequestInput): PreparedProviderRequest;

  /**
   * Creates a streaming translation session bound to a verified streaming ticket.
   *
   * @param ticket - Verified streaming ticket from request translation.
   * @param input - Optional session identifier or part generator overrides.
   * @returns Streaming session bundle with initialized codecs.
   */
  createTicketSession(
    ticket: TranslatedTicket,
    input?: { readonly responseId?: string; readonly createPartId?: () => string },
  ): StreamSessionBundle;

  /**
   * Translates a complete request through decode, validate, preflight, and encode stages.
   *
   * @param input - Request parameters including protocols, body, and models.
   * @returns Encoded provider body and IR request, or normalized failure.
   */
  translateCompleteRequest(input: TranslateCompleteInput): Result<TranslateCompleteRequestResult, NormalizedFailure>;

  /**
   * Translates an upstream provider response back into client-native format.
   *
   * @param input - Response parameters including status, headers, body, and protocols.
   * @returns Client response envelope and IR outcome, or normalized failure.
   */
  translateCompleteOutcome(
    input: TranslateCompleteOutcomeInput,
  ): Result<TranslateCompleteOutcomeResult, NormalizedFailure>;

  /**
   * Translates a streaming request through decode, validate, preflight, and encode stages.
   *
   * @param input - Request parameters including protocols, body, and models.
   * @returns Encoded streaming body, IR request, and stream options, or normalized failure.
   */
  translateStreamRequest(input: TranslateStreamRequestInput): Result<TranslateStreamRequestResult, NormalizedFailure>;

  /**
   * Creates a streaming session bundle from legacy parameters.
   *
   * @param input - Protocols, model, and optional identifier overrides.
   * @returns Streaming session bundle with initialized codecs.
   */
  createStreamSession(input: CreateStreamSessionInput): StreamSessionBundle;

  /**
   * Prepares an outbound provider request from legacy parameters.
   *
   * @param input - Connection, authentication, body, and timeout parameters.
   * @returns Prepared provider request ready for HTTP dispatch.
   */
  prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput): PreparedProviderRequest;
}
