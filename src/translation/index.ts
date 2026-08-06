import { ChatEgressEncoder } from "./codecs/chat/egress.ts";
import { ChatIngressDecoder } from "./codecs/chat/ingress.ts";
import { MessagesEgressEncoder } from "./codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "./codecs/messages/ingress.ts";
import { ResponsesEgressEncoder } from "./codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "./codecs/responses/ingress.ts";
import type { TranslationCodecs, TranslationCoordinator } from "./contracts.ts";
import { createTranslationCoordinator } from "./coordinator.ts";

export type {
  Direction,
  EgressEncoder,
  IngressDecoder,
  PrepareTranslatedRequestInput,
  TranslateCompleteInput,
  TranslateCompleteOutcomeInput,
  TranslateCompleteOutcomeResult,
  TranslateCompleteRequestResult,
  TranslationCodecs,
  TranslationCoordinator,
} from "./contracts.ts";

export { createTranslationCoordinator } from "./coordinator.ts";
export { prepareTranslatedProviderRequest } from "./prepare.ts";

export interface TranslationCodecOptions {
  /**
   * Wall-clock Unix epoch seconds used to synthesize client envelope timestamps.
   * Defaults to the real clock; inject a fixed value for deterministic tests.
   */
  readonly now?: () => number;
}

/**
 * Instantiates the standard per-protocol codecs registry for Chat, Responses, and Messages.
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
  };
}

/**
 * Creates the default initialized translation coordinator with all standard codecs wired.
 */
export function createDefaultTranslationCoordinator(options?: TranslationCodecOptions): TranslationCoordinator {
  return createTranslationCoordinator(createTranslationCodecs(options));
}
