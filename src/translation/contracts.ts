import type { HeaderMap, JsonObject, PreparedProviderRequest, Protocol, Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { IrOutcome, IrRequest } from "./ir.ts";

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
 * Codec registry mapping every supported protocol to its decoder and encoder implementations.
 */
export interface TranslationCodecs {
  readonly ingress: Readonly<Record<Protocol, IngressDecoder>>;
  readonly egress: Readonly<Record<Protocol, EgressEncoder>>;
}

/**
 * Input arguments for translating an admitted cross-protocol request.
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
 * Result of request translation containing target provider body and the private IR request.
 */
export interface TranslateCompleteRequestResult {
  readonly body: JsonObject;
  readonly irRequest: IrRequest;
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
}

/**
 * Bundled translation coordinator providing request translation, outcome translation,
 * and outbound provider request preparation.
 */
export interface TranslationCoordinator {
  translateCompleteRequest(input: TranslateCompleteInput): Result<TranslateCompleteRequestResult, NormalizedFailure>;
  translateCompleteOutcome(
    input: TranslateCompleteOutcomeInput,
  ): Result<TranslateCompleteOutcomeResult, NormalizedFailure>;
  prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput): PreparedProviderRequest;
}
