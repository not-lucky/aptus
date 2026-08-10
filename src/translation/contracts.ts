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
 * Protocol-specific ingress decoder contract for transforming raw client/provider
 * wire payloads into the private IR representation.
 */
export interface IngressDecoder {
  /**
   * Decodes a validated JSON request body into an {@link IrRequest}.
   */
  decodeRequest(body: JsonObject): Result<IrRequest, NormalizedFailure>;

  /**
   * Decodes an upstream provider HTTP response into an {@link IrOutcome}.
   */
  decodeOutcome(status: number, headers: HeaderMap, body: JsonObject): Result<IrOutcome, NormalizedFailure>;
}

/**
 * Protocol-specific egress encoder contract for transforming private IR representations
 * into target provider or client wire payloads.
 */
export interface EgressEncoder {
  /**
   * Encodes an {@link IrRequest} into the target provider JSON request body.
   *
   * @param request - Semantic IR request.
   * @param targetModel - The resolved upstream provider model name.
   */
  encodeRequest(request: IrRequest, targetModel: string): JsonObject;

  /**
   * Encodes an {@link IrOutcome} into the client-native JSON response representation.
   */
  encodeOutcome(outcome: IrOutcome): {
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
 * Decodes a streaming create request into an {@link IrRequest} and wire options.
 */
export interface StreamRequestDecoder {
  decodeRequest(
    body: JsonObject,
  ): Result<{ readonly irRequest: IrRequest; readonly sourceWireOptions: StreamWireOptions }, NormalizedFailure>;
}

/**
 * Encodes a semantic {@link IrRequest} and resolved wire options into target provider JSON with stream: true.
 */
export interface StreamRequestEncoder {
  encodeRequest(request: IrRequest, targetModel: string, wireOptions: StreamWireOptions): JsonObject;
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
