import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { JsonObject, NativePreparationInput, Protocol, ProtocolAdapter } from "../../src/domain/contracts.js";
import { createMessagesAdapter } from "../../src/providers/anthropic-messages/adapter.js";
import { createChatAdapter } from "../../src/providers/openai-chat/adapter.js";
import { createResponsesAdapter } from "../../src/providers/openai-responses/adapter.js";

interface AdapterTestCase {
  readonly name: string;
  readonly protocol: Protocol;
  readonly createPath: string;
  readonly factory: () => ProtocolAdapter;
  readonly expectedAuthHeader: { readonly name: string; readonly value: string };
  readonly expected422Result: string;
  readonly isAnthropicCatalog: boolean;
}

const ADAPTER_TEST_CASES: readonly AdapterTestCase[] = [
  {
    name: "openai-chat",
    protocol: "openai-chat",
    createPath: "/chat/completions",
    factory: createChatAdapter,
    expectedAuthHeader: { name: "authorization", value: "Bearer provider-secret-123" },
    expected422Result: "invalid_request",
    isAnthropicCatalog: false,
  },
  {
    name: "openai-responses",
    protocol: "openai-responses",
    createPath: "/responses",
    factory: createResponsesAdapter,
    expectedAuthHeader: { name: "authorization", value: "Bearer provider-secret-123" },
    expected422Result: "invalid_request",
    isAnthropicCatalog: false,
  },
  {
    name: "anthropic-messages",
    protocol: "anthropic-messages",
    createPath: "/v1/messages",
    factory: createMessagesAdapter,
    expectedAuthHeader: { name: "x-api-key", value: "provider-secret-123" },
    expected422Result: "provider",
    isAnthropicCatalog: true,
  },
];

function sampleInput(tc: AdapterTestCase, overrides: Partial<NativePreparationInput> = {}): NativePreparationInput {
  return {
    protocol: tc.protocol,
    baseUrl: "https://api.example.com",
    upstreamModel: "upstream-model-id",
    clientBody: { model: "public-model-name", stream: false, input: "test" },
    clientHeaders: { "content-type": "application/json", authorization: "Bearer client-key", "x-client": "test-1" },
    providerHeaders: { "x-static-provider": "prov-val" },
    providerSecret: "provider-secret-123",
    mutations: { defaults: {}, extraBody: {}, overrides: {} },
    deadlineMs: 1000,
    streamIdleMs: 500,
    ...overrides,
  };
}

for (const tc of ADAPTER_TEST_CASES) {
  describe(`Shared ProtocolAdapter Contract: ${tc.name}`, () => {
    test("protocol and createPath match expected constants", () => {
      const adapter = tc.factory();
      assert.equal(adapter.protocol, tc.protocol);
      assert.equal(adapter.createPath, tc.createPath);
    });

    test("readPublicModel accepts non-empty string and rejects missing, non-string, or empty model", () => {
      const adapter = tc.factory();
      assert.deepEqual(adapter.readPublicModel({ model: "gpt-main" }), { ok: true, value: "gpt-main" });

      const invalidBodies: readonly JsonObject[] = [
        {},
        { model: "" },
        { model: 123 },
        { model: null },
        { model: true },
        { model: [] },
        { model: {} },
      ];
      for (const body of invalidBodies) {
        const result = adapter.readPublicModel(body);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.category, "invalid_request");
          assert.equal(result.error.message, "model is required");
          assert.equal(result.error.retryable, false);
        }
      }
    });

    test("prepareNative constructs target URL from baseUrl + createPath", () => {
      const adapter = tc.factory();
      const input = sampleInput(tc, { baseUrl: "https://custom.provider.com/v1" });
      const result = adapter.prepareNative(input);
      assert.ok(result.ok);
      assert.equal(result.value.url, `https://custom.provider.com/v1${tc.createPath}`);
      assert.equal(result.value.protocol, tc.protocol);
      assert.equal(result.value.deadlineMs, 1000);
      assert.equal(result.value.streamIdleMs, 500);
    });

    test("prepareNative installs outbound auth and strips client auth, hop-by-hop, and framing headers", () => {
      const adapter = tc.factory();
      const input = sampleInput(tc, {
        clientHeaders: {
          "content-type": "application/json",
          authorization: "Bearer client-secret",
          "x-api-key": "client-api-key",
          host: "gateway.example.com",
          "content-length": "999",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "keep-alive": "timeout=5",
          upgrade: "websocket",
          te: "trailers",
          trailer: "x-trailer",
          "proxy-authenticate": "basic",
          "proxy-authorization": "secret",
          "x-forwarded-custom": "client-trace-id",
        },
        providerHeaders: {
          "x-custom-provider": "static-value",
        },
      });

      const result = adapter.prepareNative(input);
      assert.ok(result.ok);
      const headers = result.value.headers;

      // Installed outbound auth
      assert.equal(headers[tc.expectedAuthHeader.name], tc.expectedAuthHeader.value);

      // Preserved end-to-end and static provider headers
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers["x-forwarded-custom"], "client-trace-id");
      assert.equal(headers["x-custom-provider"], "static-value");

      // Stripped client auth (both types removed if not the installed outbound auth)
      if (tc.expectedAuthHeader.name !== "authorization") {
        assert.equal(headers.authorization, undefined);
      }
      if (tc.expectedAuthHeader.name !== "x-api-key") {
        assert.equal(headers["x-api-key"], undefined);
      }

      // Stripped hop-by-hop and transport framing
      assert.equal(headers.host, undefined);
      assert.equal(headers["content-length"], undefined);
      assert.equal(headers.connection, undefined);
      assert.equal(headers["transfer-encoding"], undefined);
      assert.equal(headers["keep-alive"], undefined);
      assert.equal(headers.upgrade, undefined);
      assert.equal(headers.te, undefined);
      assert.equal(headers.trailer, undefined);
      assert.equal(headers["proxy-authenticate"], undefined);
      assert.equal(headers["proxy-authorization"], undefined);
    });

    test("prepareNative applies mutation pipeline and encodes body to Uint8Array", () => {
      const adapter = tc.factory();
      const clientBody: JsonObject = {
        model: "public-model",
        stream: true,
        temperature: 0.8,
        messages: [{ role: "user", content: "hello" }],
        unknown_field: { keep: true },
      };
      const input = sampleInput(tc, {
        clientBody,
        upstreamModel: "resolved-upstream-model",
        mutations: {
          defaults: { max_tokens: 2048, default_extra: 1 },
          extraBody: { extra_key: "value" },
          overrides: { temperature: 0.1 },
        },
      });

      const result = adapter.prepareNative(input);
      assert.ok(result.ok);
      assert.equal(result.value.stream, true);

      const decodedBody = JSON.parse(new TextDecoder().decode(result.value.body)) as JsonObject;
      assert.equal(decodedBody.model, "resolved-upstream-model");
      assert.equal(decodedBody.temperature, 0.1);
      assert.equal(decodedBody.max_tokens, 2048);
      assert.equal(decodedBody.default_extra, 1);
      assert.equal(decodedBody.extra_key, "value");
      assert.deepEqual(decodedBody.unknown_field, { keep: true });
      assert.deepEqual(decodedBody.messages, [{ role: "user", content: "hello" }]);

      // Input body was not mutated
      assert.equal(clientBody.model, "public-model");
      assert.equal(clientBody.temperature, 0.8);
    });

    test("classify maps status codes accurately with beforeClientBytes: true", () => {
      const adapter = tc.factory();
      const cases: Array<[number, string]> = [
        [200, "success"],
        [201, "success"],
        [299, "success"],
        [400, "invalid_request"],
        [401, "authentication"],
        [403, "permission"],
        [404, "not_found"],
        [408, "timeout"],
        [409, "conflict"],
        [413, "payload_too_large"],
        [422, tc.expected422Result],
        [429, "rate_limit"],
        [500, "unavailable"],
        [503, "unavailable"],
        [504, "timeout"],
        [529, "unavailable"],
        [418, "provider"],
      ];

      for (const [status, expected] of cases) {
        const obs = adapter.classify({ status, headers: {} });
        assert.equal(obs.result, expected, `status ${status}`);
        assert.equal(obs.status, status);
        assert.equal(obs.beforeClientBytes, true);
      }
    });

    test("classify parses Retry-After delta-seconds on 429", () => {
      const adapter = tc.factory();
      const obs = adapter.classify({ status: 429, headers: { "retry-after": "5" } });
      assert.equal(obs.result, "rate_limit");
      assert.equal(obs.retryDelayMs, 5000);
      assert.equal(obs.beforeClientBytes, true);
    });

    test("classify parses a Retry-After HTTP-date on 429", () => {
      const adapter = tc.factory();
      const futureDate = new Date(Date.now() + 60_000).toUTCString();
      const obs = adapter.classify({ status: 429, headers: { "retry-after": futureDate } });
      assert.equal(obs.result, "rate_limit");
      assert.equal(obs.beforeClientBytes, true);
      const { retryDelayMs } = obs;
      assert.ok(retryDelayMs !== undefined, "HTTP-date Retry-After should parse");
      if (retryDelayMs !== undefined) {
        assert.ok(
          retryDelayMs > 50_000 && retryDelayMs <= 60_000,
          `expected ~60s delay, got ${retryDelayMs}`,
        );
      }
    });

    test("classify ignores an expired Retry-After HTTP-date on 429", () => {
      const adapter = tc.factory();
      const pastDate = new Date(Date.now() - 60_000).toUTCString();
      const obs = adapter.classify({ status: 429, headers: { "retry-after": pastDate } });
      assert.equal(obs.result, "rate_limit");
      assert.equal(obs.retryDelayMs, undefined);
      assert.equal(obs.beforeClientBytes, true);
    });

    test("buildModelList returns valid catalog envelope for populated and empty lists", () => {
      const adapter = tc.factory();
      const populated = adapter.buildModelList({
        entries: [
          { id: "model-a", metadata: { created: 100, custom_meta: "x" } },
          { id: "model-b", metadata: { created: 200, custom_meta: "y" } },
        ],
      });

      if (tc.isAnthropicCatalog) {
        assert.deepEqual(populated, {
          data: [
            { created: 100, custom_meta: "x", type: "model", id: "model-a" },
            { created: 200, custom_meta: "y", type: "model", id: "model-b" },
          ],
          has_more: false,
          first_id: "model-a",
          last_id: "model-b",
        });

        const empty = adapter.buildModelList({ entries: [] });
        assert.deepEqual(empty, {
          data: [],
          has_more: false,
          first_id: null,
          last_id: null,
        });
      } else {
        assert.deepEqual(populated, {
          object: "list",
          data: [
            { created: 100, custom_meta: "x", id: "model-a", object: "model" },
            { created: 200, custom_meta: "y", id: "model-b", object: "model" },
          ],
        });

        const empty = adapter.buildModelList({ entries: [] });
        assert.deepEqual(empty, {
          object: "list",
          data: [],
        });
      }
    });
  });
}
