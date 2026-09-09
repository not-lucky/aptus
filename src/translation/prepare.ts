/**
 * @fileoverview Outbound HTTP request preparation for translated provider dispatch.
 *
 * Constructs immutable {@link PreparedProviderRequest} objects for translated payloads,
 * formatting protocol-specific endpoint URLs, filtering headers, installing upstream credentials,
 * and serializing bodies to UTF-8 byte buffers.
 */

import type { HeaderMap, PreparedProviderRequest, Protocol } from "../domain/contracts.ts";
import { filterOutboundHeaders, type OutboundAuth } from "../domain/headers.ts";
import type { PrepareTranslatedRequestInput } from "./contracts.ts";

/** Shared UTF-8 text encoder for serializing translated request payloads. */
const encoder = new TextEncoder();

/** Outbound endpoint configuration for a supported provider protocol. */
interface ProtocolEndpoint {
  /** Relative URL path suffix appended to provider base URL. */
  readonly path: string;
  /** Factory generating protocol-specific authentication headers for an API secret. */
  createAuth(secret: string): OutboundAuth;
  /** Static default headers mandated by the protocol (e.g. `anthropic-version`). */
  readonly defaultHeaders?: HeaderMap;
}

/** Registry of outbound endpoint configurations indexed by protocol. */
const PROTOCOL_ENDPOINTS: Readonly<Record<Protocol, ProtocolEndpoint>> = {
  "openai-chat": {
    path: "/chat/completions",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
  },
  "openai-responses": {
    path: "/responses",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
  },
  "anthropic-messages": {
    path: "/v1/messages",
    createAuth: (secret) => ({ name: "x-api-key", value: secret }),
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  },
};

/**
 * Serializes and packages a translated request into an outbound {@link PreparedProviderRequest}.
 *
 * @param input - Request connection, authentication, headers, body, and timeout configurations.
 * @returns Fully prepared HTTP request descriptor ready for network dispatch.
 */
export function prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput): PreparedProviderRequest {
  const endpoint = PROTOCOL_ENDPOINTS[input.targetProtocol];
  const auth = endpoint.createAuth(input.providerSecret);

  // Provider headers override protocol defaults key by key.
  const providerHeaders: Record<string, string> = {
    ...(endpoint.defaultHeaders ?? {}),
    ...input.providerHeaders,
  };

  const headers = filterOutboundHeaders(input.clientHeaders, providerHeaders, auth);
  // Strip trailing slashes before appending endpoint path.
  const normalizedBase = input.baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBase}${endpoint.path}`;
  const bodyBytes = encoder.encode(JSON.stringify(input.body));

  return {
    protocol: input.targetProtocol,
    provider: input.providerName,
    url,
    headers,
    body: bodyBytes,
    stream: input.stream ?? false,
    mutations: ["/model"],
    deadlineMs: input.deadlineMs,
    streamIdleMs: input.streamIdleMs,
  };
}
