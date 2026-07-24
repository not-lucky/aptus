import type { Protocol, ProtocolAdapter } from "../domain/contracts.js";
import { createMessagesAdapter } from "./anthropic-messages/adapter.js";
import { createChatAdapter } from "./openai-chat/adapter.js";
import { createResponsesAdapter } from "./openai-responses/adapter.js";

/**
 * Instantiates the default set of protocol adapters for OpenAI Chat, OpenAI
 * Responses, and Anthropic Messages.
 *
 * This factory is the single concrete assembly point for adapters; it is
 * imported only by `src/bootstrap` (the composition root) and tests, keeping
 * the protocol submodules out of the `http`/`routing` dependency graphs.
 *
 * @returns Immutable dictionary of {@link ProtocolAdapter} keyed by {@link Protocol}.
 */
export function createProtocolAdapters(): Readonly<Record<Protocol, ProtocolAdapter>> {
  return {
    "openai-chat": createChatAdapter(),
    "openai-responses": createResponsesAdapter(),
    "anthropic-messages": createMessagesAdapter(),
  };
}
