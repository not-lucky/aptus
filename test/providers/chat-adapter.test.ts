import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject, NativePreparationInput, ProtocolAdapter } from "../../src/domain/contracts.js";
import { createChatAdapter } from "../../src/providers/openai-chat/adapter.js";
import { applyNativeMutations } from "../../src/providers/shared/mutation.js";

function adapter(): ProtocolAdapter {
  return createChatAdapter();
}

function input(overrides: Partial<NativePreparationInput> = {}): NativePreparationInput {
  return {
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    upstreamModel: "gpt-5.4",
    clientBody: { model: "gpt-main", stream: false, messages: [{ role: "user", content: "hi" }] },
    clientHeaders: { "content-type": "application/json", authorization: "Bearer client-secret", "x-client": "1" },
    providerHeaders: { "openai-organization": "org_example" },
    providerSecret: "provider-secret",
    mutations: { defaults: {}, extraBody: {}, overrides: {} },
    deadlineMs: 1000,
    streamIdleMs: 500,
    ...overrides,
  };
}

test("Chat adapter exposes the chat completions path", () => {
  assert.equal(adapter().protocol, "openai-chat");
  assert.equal(adapter().createPath, "/chat/completions");
});

test("readPublicModel accepts a non-empty string model and rejects everything else", () => {
  assert.deepEqual(adapter().readPublicModel({ model: "gpt-main" }), { ok: true, value: "gpt-main" });
  for (const body of [{}, { model: "" }, { model: 42 }, { model: null }, { model: true }] as JsonObject[]) {
    const result = adapter().readPublicModel(body);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, "invalid_request");
      assert.equal(result.error.message, "model is required");
    }
  }
});

test("prepareNative builds the POST URL from baseUrl + createPath", () => {
  const result = adapter().prepareNative(input());
  assert(result.ok);
  assert.equal(result.value.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(result.value.stream, false);
});

test("prepareNative installs Bearer auth and strips client auth/hop-by-hop/framing headers", () => {
  const result = adapter().prepareNative(
    input({
      clientHeaders: {
        "content-type": "application/json",
        authorization: "Bearer client-secret",
        "x-api-key": "client-key",
        host: "client.example",
        "content-length": "100",
        connection: "keep-alive",
        "x-end-to-end": "kept",
      },
    }),
  );
  assert(result.ok);
  const headers = result.value.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer provider-secret");
  assert.equal(headers["openai-organization"], "org_example");
  assert.equal(headers["x-end-to-end"], "kept");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers.connection, undefined);
});

test("prepareNative replaces the model with the upstream model ID", () => {
  const result = adapter().prepareNative(input());
  assert(result.ok);
  const body = JSON.parse(new TextDecoder().decode(result.value.body)) as JsonObject;
  assert.equal(body.model, "gpt-5.4");
});

test("applyNativeMutations preserves unknown fields and array order and reports ordered pointers", () => {
  const clientBody: JsonObject = {
    model: "public-name",
    temperature: 1.5,
    messages: [
      { role: "system", content: "a" },
      { role: "user", content: "b" },
    ],
    unknown: { keep: true },
  };
  const result = applyNativeMutations(
    clientBody,
    {
      defaults: { max_tokens: 100, nested: { a: 1 } },
      extraBody: { temperature: 0.5, extra: { deep: { x: 1 } } },
      overrides: { temperature: 0.2, store: false },
    },
    "upstream-model",
  );

  assert.deepEqual(result.mutations, [
    "/max_tokens",
    "/nested/a",
    "/temperature",
    "/extra/deep/x",
    "/temperature",
    "/store",
    "/model",
  ]);

  const body = result.body as JsonObject;
  assert.equal(body.model, "upstream-model");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.nested, { a: 1 });
  assert.deepEqual(body.extra, { deep: { x: 1 } });
  assert.equal(body.store, false);
  assert.deepEqual(body.messages, [
    { role: "system", content: "a" },
    { role: "user", content: "b" },
  ]);
  assert.deepEqual(body.unknown, { keep: true });

  // The configured maps and the client body are never mutated.
  assert.equal(clientBody.model, "public-name");
  assert.equal(clientBody.temperature, 1.5);
});

test("applyNativeMutations skips defaults when intermediate segment is a client scalar", () => {
  const clientBody: JsonObject = {
    model: "public-name",
    a: 1,
  };
  const result = applyNativeMutations(
    clientBody,
    {
      defaults: { a: { b: 2 }, c: { d: 3 } },
      extraBody: {},
      overrides: {},
    },
    "upstream-model",
  );

  const body = result.body as JsonObject;
  assert.equal(body.a, 1);
  assert.deepEqual(body.c, { d: 3 });
  assert.deepEqual(result.mutations, ["/c/d", "/model"]);
});

test("classify maps the full Chat status table", () => {
  const cases: Array<[number, string]> = [
    [200, "success"],
    [299, "success"],
    [429, "rate_limit"],
    [500, "unavailable"],
    [503, "unavailable"],
    [529, "unavailable"],
    [408, "timeout"],
    [504, "timeout"],
    [401, "authentication"],
    [403, "permission"],
    [400, "invalid_request"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [422, "invalid_request"],
    [418, "provider"],
  ];
  for (const [status, expected] of cases) {
    const observation = adapter().classify({ status, headers: {} });
    assert.equal(observation.result, expected, `status ${status}`);
    assert.equal(observation.status, status);
    assert.equal(observation.beforeClientBytes, true);
  }
});

test("classify parses a Retry-After delta-seconds header on 429", () => {
  const observation = adapter().classify({ status: 429, headers: { "retry-after": "3" } });
  assert.equal(observation.result, "rate_limit");
  assert.equal(observation.retryDelayMs, 3000);
});

test("buildModelList emits the OpenAI list envelope", () => {
  const envelope = adapter().buildModelList({
    entries: [
      { id: "a", metadata: { created: 1, owned_by: "aptus" } },
      { id: "b", metadata: { created: 2, owned_by: "aptus" } },
    ],
  }) as JsonObject;
  assert.equal(envelope.object, "list");
  assert.deepEqual(envelope.data, [
    { created: 1, owned_by: "aptus", id: "a", object: "model" },
    { created: 2, owned_by: "aptus", id: "b", object: "model" },
  ]);
});
