import type { HeaderMap, PreparedProviderRequest, Protocol } from "../domain/contracts.ts";
import { filterOutboundHeaders, type OutboundAuth } from "../domain/headers.ts";
import type { PrepareTranslatedRequestInput } from "./contracts.ts";

const encoder = new TextEncoder();

interface ProtocolEndpoint {
  readonly path: string;
  createAuth(secret: string): OutboundAuth;
  readonly defaultHeaders?: HeaderMap;
}

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
 * Builds the prepared outbound HTTP request for cross-protocol provider dispatch.
 *
 * Configures target endpoint paths, filters outbound hop-by-hop/auth headers,
 * installs provider credentials, and serializes the translated JSON payload.
 *
 * @param input - Composition facts including target protocol, URL, credentials, and body.
 * @returns An immutable {@link PreparedProviderRequest}.
 */
export function prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput): PreparedProviderRequest {
  const endpoint = PROTOCOL_ENDPOINTS[input.targetProtocol];
  const auth = endpoint.createAuth(input.providerSecret);

  const providerHeaders: Record<string, string> = {
    ...(endpoint.defaultHeaders ?? {}),
    ...input.providerHeaders,
  };

  const headers = filterOutboundHeaders(input.clientHeaders, providerHeaders, auth);
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
