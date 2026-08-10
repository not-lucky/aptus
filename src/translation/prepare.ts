import type { HeaderMap, PreparedProviderRequest, Protocol } from "../domain/contracts.ts";
import type { PrepareTranslatedRequestInput } from "./contracts.ts";

const encoder = new TextEncoder();

/**
 * Hop-by-hop and transport-framing header names defined by RFC 7230 §6.1.
 * These are never forwarded across the gateway boundary in either direction.
 */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Outbound request headers removed before dispatch: the hop-by-hop set plus
 * framing fields the dispatcher owns (`host`, `content-length`) and the
 * client's authentication credentials, which Aptus replaces with the selected
 * provider key credential.
 *
 * This mirrors the outbound policy in `src/providers/shared/headers.ts` but is
 * intentionally duplicated here: the translation layer depends only on Domain
 * and protocol codec contracts and must not import
 * provider modules.
 */
const OUTBOUND_REMOVE: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "authorization",
  "x-api-key",
]);

/** Provider authentication header installed on an outbound request. */
interface OutboundAuth {
  readonly name: string;
  readonly value: string;
}

/**
 * Builds the filtered outbound request headers for a translated provider dispatch.
 *
 * Precedence (later wins): client end-to-end headers, provider static headers,
 * then the selected provider authentication header. All names are lower-cased;
 * hop-by-hop, framing, and client-auth headers are removed.
 */
function filterOutboundHeaders(clientHeaders: HeaderMap, providerHeaders: HeaderMap, auth: OutboundAuth): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const normalized = name.toLowerCase();
    if (!OUTBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  for (const [name, value] of Object.entries(providerHeaders)) {
    const normalized = name.toLowerCase();
    if (!OUTBOUND_REMOVE.has(normalized)) result[normalized] = value;
  }
  result[auth.name.toLowerCase()] = auth.value;
  return result;
}

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
