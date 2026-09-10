/**
 * @fileoverview Public composition root and registry factory for cross-protocol translation.
 *
 * Instantiates the standard per-protocol codec registry across OpenAI Chat, OpenAI Responses,
 * and Anthropic Messages, and exposes {@link createDefaultTranslationCoordinator} to wire
 * the translation pipeline with optional timestamp clock overrides.
 *
 * Also re-exports the translation contract types, coordinator factories, and stream utilities.
 */

import { ChatEgressEncoder } from "./codecs/chat/egress.ts";
import { ChatIngressDecoder } from "./codecs/chat/ingress.ts";
import {
  ChatClientStreamEncoder,
  ChatProviderStreamDecoder,
  ChatStreamRequestDecoder,
  ChatStreamRequestEncoder,
} from "./codecs/chat/stream.ts";
import { MessagesEgressEncoder } from "./codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "./codecs/messages/ingress.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
  MessagesStreamRequestDecoder,
  MessagesStreamRequestEncoder,
} from "./codecs/messages/stream.ts";
import { ResponsesEgressEncoder } from "./codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "./codecs/responses/ingress.ts";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
  ResponsesStreamRequestDecoder,
  ResponsesStreamRequestEncoder,
} from "./codecs/responses/stream.ts";
import type {
  ClientStreamEncoder,
  ProviderStreamDecoder,
  StreamSession,
  StreamWireOptions,
  TranslationCodecs,
  TranslationCoordinator,
} from "./contracts.ts";
import { createTranslationCoordinator } from "./coordinator.ts";

export type {
  ClientStreamEncoder,
  Direction,
  EgressEncoder,
  IngressDecoder,
  OutcomeDecodeResult,
  OutcomeWireOptions,
  PrepareTranslatedRequestInput,
  PromptCacheBreakpoint,
  ProviderStreamDecoder,
  RequestDecodeResult,
  RequestWireOptions,
  StreamRequestDecodeResult,
  StreamRequestDecoder,
  StreamRequestEncoder,
  StreamSession,
  StreamSessionBundle,
  StreamWireOptions,
  TranslateCompleteOutcomeInput,
  TranslateCompleteOutcomeResult,
  TranslationCodecs,
  TranslationCoordinator,
} from "./contracts.ts";

export { createTranslationCoordinator } from "./coordinator.ts";
export { prepareTranslatedProviderRequest } from "./prepare.ts";
export type { ResponseOwnership, SseDecodeResult, SseDecoder, SseEncoder, SseFrame } from "./sse.ts";
export { createSseDecoder, createSseEncoder } from "./sse.ts";
export { createIrStreamStateMachine, IrStreamStateMachine } from "./stream-state.ts";

/** Clock configuration options for injecting deterministic timestamps during codec construction. */
export interface TranslationCodecOptions {
  /** Wall-clock Unix epoch seconds provider for synthesizing client envelope timestamps. */
  readonly now?: () => number;
}

/**
 * Instantiates the standard per-protocol codecs registry for Chat, Responses, and Messages.
 *
 * @param options - Optional clock configuration for deterministic envelope timestamp generation.
 * @returns Complete {@link TranslationCodecs} registry with ingress, egress, and streaming codecs.
 */
export function createTranslationCodecs(options?: TranslationCodecOptions): TranslationCodecs {
  return {
    ingress: {
      "openai-chat": new ChatIngressDecoder(),
      "openai-responses": new ResponsesIngressDecoder(),
      "anthropic-messages": new MessagesIngressDecoder(),
    },
    egress: {
      "openai-chat": new ChatEgressEncoder(options?.now),
      "openai-responses": new ResponsesEgressEncoder(options?.now),
      "anthropic-messages": new MessagesEgressEncoder(),
    },
    streamRequestDecoders: {
      "openai-chat": new ChatStreamRequestDecoder(),
      "openai-responses": new ResponsesStreamRequestDecoder(),
      "anthropic-messages": new MessagesStreamRequestDecoder(),
    },
    streamRequestEncoders: {
      "openai-chat": new ChatStreamRequestEncoder(),
      "openai-responses": new ResponsesStreamRequestEncoder(),
      "anthropic-messages": new MessagesStreamRequestEncoder(),
    },
    createProviderStreamDecoder(protocol, session: StreamSession): ProviderStreamDecoder {
      if (protocol === "openai-chat") return new ChatProviderStreamDecoder(session);
      if (protocol === "openai-responses") return new ResponsesProviderStreamDecoder(session);
      return new MessagesProviderStreamDecoder(session);
    },
    createClientStreamEncoder(protocol, session: StreamSession, wireOptions: StreamWireOptions): ClientStreamEncoder {
      if (protocol === "openai-chat") return new ChatClientStreamEncoder(session, wireOptions, options?.now);
      if (protocol === "openai-responses") return new ResponsesClientStreamEncoder(session);
      return new MessagesClientStreamEncoder(session);
    },
  };
}

/**
 * Creates the default initialized translation coordinator with all standard codecs wired.
 *
 * @param options - Optional clock configuration forwarded to the codec registry.
 * @returns Initialized {@link TranslationCoordinator} ready for request and outcome translation.
 */
export function createDefaultTranslationCoordinator(options?: TranslationCodecOptions): TranslationCoordinator {
  return createTranslationCoordinator(createTranslationCodecs(options));
}
