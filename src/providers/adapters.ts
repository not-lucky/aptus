/**
 * @fileoverview Assembly point for native protocol adapters in the Aptus gateway.
 *
 * Instantiates the {@link ProtocolAdapter} registry for supported wire protocols:
 * `openai-chat`, `openai-responses`, and `anthropic-messages`. Each adapter provides
 * protocol-specific wire facts (endpoint paths, auth headers, and catalog envelopes),
 * delegating common lifecycle behaviors to the shared native adapter runtime.
 *
 * Serves native same-protocol dispatch without translation as well as catalog
 * rendering across all paths. Adapter instances are stateless and reusable for the
 * lifetime of the process.
 */

import type { Protocol, ProtocolAdapter } from "../domain/contracts.ts";
import { createMessagesAdapter } from "./anthropic-messages/adapter.ts";
import { createChatAdapter } from "./openai-chat/adapter.ts";
import { createResponsesAdapter } from "./openai-responses/adapter.ts";

/**
 * Instantiates the default adapter table for all supported protocols.
 *
 * Builds one {@link ProtocolAdapter} per protocol using sibling factory modules.
 * Returned adapter instances are stateless and keyed by their {@link Protocol} identifier.
 *
 * @returns An immutable table of {@link ProtocolAdapter} instances keyed by {@link Protocol}.
 */
export function createProtocolAdapters(): Readonly<Record<Protocol, ProtocolAdapter>> {
  return {
    "openai-chat": createChatAdapter(),
    "openai-responses": createResponsesAdapter(),
    "anthropic-messages": createMessagesAdapter(),
  };
}
