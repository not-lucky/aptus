import { describe, expect, it } from "vitest";
import { createOpenAiChatTranslatorFamily } from "../../src/adapters/index.js";
import type {
  CanonicalChunk,
  CanonicalResponse,
  GatewayError,
} from "../../src/domain/index.js";
import { createGatewayError } from "../../src/domain/index.js";
import type { RawIngressInput, TranslationContext } from "../../src/ports/index.js";

const NOW = "2026-07-21T12:00:00.000Z";
const signal = new AbortController().signal;
const context: TranslationContext = {
  requestId: "req_openai_chat",
  signal,
  trustedRoutingHeaders: {},
};

function input(body: unknown, path = "/v1/chat/completions"): RawIngressInput {
  return {
    path,
    headers: { authorization: "Bearer header-secret", "x-extra": "ignored" },
    authorization: "Bearer boundary-secret",
    body,
  };
}

function translated(body: unknown, path?: string) {
  return createOpenAiChatTranslatorFamily({ now: () => NOW }).ingress.translate(
    input(body, path),
    context,
  );
}

function expectGatewayFailure(
  body: unknown,
  code: string,
  status: number,
): GatewayError {
  try {
    translated(body);
  } catch (error: unknown) {
    const failure = error as GatewayError;
    expect(failure).toMatchObject({
      code,
      status,
      retryable: false,
      category: status >= 500 ? "internal" : "validation",
      requestId: context.requestId,
    });
    return failure;
  }
  throw new Error("Expected translation failure.");
}

function parseSse(value: unknown): unknown[] {
  expect(typeof value).toBe("string");
  return (value as string)
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)) as unknown);
}

const response: CanonicalResponse = {
  requestId: context.requestId,
  responseId: "chatcmpl_response",
  createdAt: NOW,
  model: "model-output",
  status: "completed",
  choices: [
    {
      index: 3,
      output: [
        {
          type: "text",
          text: "hello",
          id: "text-1",
          cacheBreakpoint: { ttl: "5m" },
          citations: [
            {
              kind: "url",
              url: "https://example.test/source",
              sourceTitle: "Source",
              startIndex: 0,
              endIndex: 5,
            },
          ],
        },
        {
          type: "reasoning",
          text: "safe reasoning text",
          signature: "never-signature",
          redactedData: "never-redacted",
          encryptedContent: "never-encrypted",
        },
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "lookup",
          argumentsJson: '{ "secret": "tool-secret" }',
        },
      ],
      finishReason: "tool_calls",
      logprobs: [
        {
          token: "hello",
          logprob: -0.1,
          bytes: [104],
          topAlternatives: [{ token: "hi", logprob: -1, bytes: [104, 105] }],
        },
      ],
    },
  ],
  usage: {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cachedInputTokens: 2,
    cacheWriteBreakdown: [
      { ttlSeconds: 300, tokens: 3 },
      { ttlSeconds: 3600, tokens: 4 },
    ],
    audioInputTokens: 1,
    reasoningTokens: 2,
    audioOutputTokens: 1,
    acceptedPredictionTokens: 1,
    rejectedPredictionTokens: 2,
  },
  cost: {
    inputUsd: 1,
    outputUsd: 2,
    cacheReadUsd: 3,
    cacheWriteUsd: 4,
    totalUsd: 10,
    currency: "USD",
  },
  provider: {
    providerId: "provider-secret",
    credentialId: "credential-secret",
    physicalModel: "physical-secret",
    responseHeaders: { authorization: "response-secret" },
    upstreamStatus: 200,
  },
  extensions: {
    protocols: {
      "openai-chat": {
        protocol: "openai-chat",
        body: {
          request_only_secret: "must-not-replay",
          choices: [{ secret: "must-not-win" }],
        },
        headers: {},
        sourceFields: [],
      },
    },
  },
};

describe("OpenAI Chat ingress", () => {
  it("exposes exactly two genuinely immutable aliases", () => {
    const family = createOpenAiChatTranslatorFamily({ now: () => NOW });
    expect([...family.ingress.paths]).toEqual([
      "/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(family.ingress.canTranslate("/chat/completions", {})).toBe(true);
    expect(family.ingress.canTranslate("/v1/chat/completions", {})).toBe(true);
    expect(family.ingress.canTranslate("/chat/completions", [])).toBe(false);
    expect(family.ingress.canTranslate("/other", {})).toBe(false);
    const mutable = family.ingress.paths as unknown as {
      add?: (value: string) => void;
      delete?: (value: string) => void;
    };
    expect(mutable.add).toBeUndefined();
    expect(mutable.delete).toBeUndefined();
    expect([...family.ingress.paths]).toHaveLength(2);
  });

  it.each(["/chat/completions", "/v1/chat/completions"])(
    "normalizes a dense request through %s without losing supported data",
    (path) => {
      const request = translated(
        {
          model: "logical-model",
          messages: [
            {
              role: "system",
              name: "policy",
              content: [{ type: "text", text: "rules", prompt_cache_breakpoint: {} }],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "look",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: {
                        url: "https://example.test/a",
                        title: "A",
                        start_index: 0,
                        end_index: 4,
                      },
                    },
                  ],
                  beta_part_field: { retained: true },
                },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,aGVsbG8=",
                    detail: "high",
                  },
                },
                {
                  type: "input_audio",
                  input_audio: { data: "aGVsbG8=", format: "mp3" },
                },
                {
                  type: "file",
                  file: {
                    file_data: "data:application/pdf;base64,aGVsbG8=",
                    filename: "brief.pdf",
                  },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "thought", signature: "sig" },
                { type: "refusal", refusal: "no" },
              ],
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{ "q": 1 }' },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call-1",
              content: [{ type: "text", text: "result" }],
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Look up",
                parameters: { type: "object", properties: { q: { type: "number" } } },
                strict: true,
                future_function_field: "retained",
              },
              prompt_cache_breakpoint: {},
              future_tool_field: 9,
            },
          ],
          tool_choice: { type: "function", function: { name: "lookup" } },
          parallel_tool_calls: true,
          temperature: 0.2,
          top_p: 0.9,
          frequency_penalty: -0.5,
          presence_penalty: 0.5,
          seed: 7,
          max_tokens: 128,
          max_completion_tokens: 128,
          stop: ["END"],
          n: 2,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "answer",
              description: "Answer",
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
              strict: true,
            },
          },
          logprobs: true,
          top_logprobs: 2,
          reasoning: {
            mode: "enabled",
            budget_tokens: 100,
            display: "concise",
            persist_across_turns: "current_turn",
            request_encrypted_content: true,
          },
          reasoning_effort: "high",
          service_tier: "priority",
          metadata: { tenant: "t1" },
          store: false,
          stream: true,
          stream_options: { include_usage: true, future_stream_field: null },
          routing: {
            modelAlias: "alias",
            requiredCapabilities: ["custom", "tools"],
            preferredProviders: ["provider-a"],
            excludedProviders: ["provider-b"],
            overrideRoute: "route-a",
            maxCostUsd: 1.5,
            maxLatencyMs: 500,
            dryRun: true,
            future_routing_field: "retained",
          },
          prompt_cache_options: { ttl: "5m" },
          explicit_null: null,
          future_root: { nested: [1, true, "x"] },
        },
        path,
      );

      expect(request).toMatchObject({
        requestId: context.requestId,
        receivedAt: NOW,
        source: { adapter: "openai-chat", protocol: "openai-chat", path },
        model: "logical-model",
        sampling: {
          temperature: 0.2,
          topP: 0.9,
          frequencyPenalty: -0.5,
          presencePenalty: 0.5,
          seed: 7,
          maxTokens: 128,
          stop: ["END"],
          n: 2,
        },
        reasoning: {
          mode: "enabled",
          budgetTokens: 100,
          display: "concise",
          persistAcrossTurns: "current_turn",
          requestEncryptedContent: true,
        },
        output: {
          effort: "high",
          format: "json_schema",
          logprobs: { enabled: true, topLogprobs: 2 },
        },
        serviceTier: { tier: "priority" },
        persistence: { store: false },
        stream: true,
        streamOptions: { includeUsage: true },
        metadata: { tenant: "t1" },
      });
      expect(request.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
      expect(request.messages[1]?.content.map((block) => block.type)).toEqual([
        "text",
        "image_base64",
        "audio_base64",
        "document_base64",
      ]);
      expect(request.messages[2]?.content).toEqual([
        { type: "reasoning", text: "thought", signature: "sig" },
        { type: "refusal", refusal: "no" },
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "lookup",
          argumentsJson: '{ "q": 1 }',
        },
      ]);
      expect(request.messages[3]?.content[0]).toEqual({
        type: "tool_result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "result" }],
      });
      expect(request.routing).toEqual({
        modelAlias: "alias",
        requiredCapabilities: [
          "custom",
          "tools",
          "vision",
          "multimodal",
          "audio_input",
          "reasoning",
          "multiple_choices",
          "structured_outputs",
          "logprobs",
        ],
        preferredProviders: ["provider-a"],
        excludedProviders: ["provider-b"],
        overrideRoute: "route-a",
        maxCostUsd: 1.5,
        maxLatencyMs: 500,
        dryRun: true,
      });
      const protocol = request.extensions?.protocols?.["openai-chat"];
      expect(protocol?.headers).toEqual({});
      expect(protocol?.body).toMatchObject({
        explicit_null: null,
        future_root: { nested: [1, true, "x"] },
        stream_options: { future_stream_field: null },
        routing: { future_routing_field: "retained" },
        tools: [
          {
            future_tool_field: 9,
            function: { future_function_field: "retained" },
          },
        ],
      });
      expect(protocol?.sourceFields).toContain("messages[1].content[1].image_url.url");
      expect(protocol?.sourceFields).toContain("parallel_tool_calls");
      expect(protocol?.sourceFields).toContain("stream");
      expect(protocol?.sourceFields).not.toContain(".stream");
      expect(JSON.stringify(request)).not.toContain("header-secret");
      expect(JSON.stringify(request)).not.toContain("boundary-secret");
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.messages)).toBe(true);
    },
  );

  it.each([
    [null, "invalid_openai_chat_request", 400],
    [[], "invalid_openai_chat_request", 400],
    [{ model: "", messages: [{ role: "user", content: "x" }] }, "invalid_model", 400],
    [{ model: "m", messages: [] }, "invalid_messages", 400],
    [{ model: "m", messages: [{ role: "unknown", content: "x" }] }, "unsupported_openai_chat_semantics", 422],
    [{ model: "m", messages: [{ role: "user", content: [] }] }, "invalid_message_content", 400],
    [{ model: "m", messages: [{ role: "user", content: [{ type: "unknown" }] }] }, "unsupported_openai_chat_semantics", 422],
    [{ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://user:pass@example.test/a" } }] }] }, "invalid_media", 400],
    [{ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,%%%" } }] }] }, "invalid_media", 400],
    [{ model: "m", messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "[]" } }] }] }, "invalid_tool_arguments", 400],
    [{ model: "m", messages: [{ role: "user", content: "x" }], temperature: 3 }, "invalid_range", 400],
    [{ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1, max_completion_tokens: 2 }, "unsupported_openai_chat_semantics", 422],

    [{ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }] }, "unsupported_openai_chat_semantics", 422],
    [{ model: "m", messages: [{ role: "user", content: "x" }], top_logprobs: 1 }, "invalid_range", 400],
  ] as const)("rejects unsafe input %#", (body, code, status) => {
    const error = expectGatewayFailure(body, code, status);
    const encoded = JSON.stringify(error);
    expect(encoded).not.toContain("pass@example");
    expect(encoded).not.toContain("tool-secret");
  });
  it("preserves prototype-like unknown keys, rejects noncanonical array keys, and avoids duplicate metadata", () => {
    const body = JSON.parse('{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/a","future_nested":{"__proto__":{"safe":true},"values":[1,2]}},"future_outer":null}]}],"__proto__":{"retained":true}}') as Record<string, unknown>;
    const request = translated(body);
    const block = request.messages[0]?.content[0];
    expect(block?.providerMetadata).toMatchObject({
      future_outer: null,
      image_url: {
        future_nested: { values: [1, 2] },
      },
    });
    const nested = block?.providerMetadata?.["image_url"] as Record<string, unknown> | undefined;
    const future = nested?.["future_nested"] as Record<string, unknown> | undefined;
    expect(Object.prototype.hasOwnProperty.call(future, "__proto__")).toBe(true);
    expect(future?.["__proto__"]).toEqual({ safe: true });
    const extensionBody = request.extensions?.protocols?.["openai-chat"]?.body;
    expect(Object.keys(extensionBody ?? {})).toEqual(["__proto__"]);
    expect(extensionBody?.["__proto__"]).toEqual({ retained: true });
    expect(Object.prototype.hasOwnProperty.call(request.extensions?.protocols?.["openai-chat"]?.body, "__proto__")).toBe(true);
    const content = [{ role: "user", content: "x" }] as unknown[] & Record<string, unknown>;
    Object.defineProperty(content, "01", { value: "lost", enumerable: true });
    expectGatewayFailure({ model: "m", messages: content }, "invalid_openai_chat_request", 400);
    const mixed = translated({
      model: "m",
      messages: [
        { role: "user", content: "first", unknown_message: { keep: 1 } },
        { role: "user", content: "second" },
      ],
    });
    expect(mixed.extensions?.protocols?.["openai-chat"]?.body).toEqual({
      messages: [{ unknown_message: { keep: 1 } }, {}],
    });
    expect(Object.getPrototypeOf((mixed.extensions?.protocols?.["openai-chat"]?.body["messages"] as Array<Record<string, unknown>>)[1]!)).toBeNull();
    expect(mixed.extensions?.protocols?.["openai-chat"]?.sourceFields).toEqual([
      "model",
      "messages[0].role",
      "messages[0].content",
      "messages[1].role",
      "messages[1].content",
    ]);
  });

  it("retains valid future service tiers and explicit metadata null only in protocol extensions", () => {
    const request = translated({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      service_tier: "flex",
      reasoning_effort: "xhigh",
      metadata: null,
    });
    expect(request.serviceTier).toBeUndefined();
    expect(request.metadata).toBeUndefined();
    expect(request.routing.requiredCapabilities).toEqual(["reasoning"]);
    expect(request.extensions?.protocols?.["openai-chat"]?.body).toEqual({
      service_tier: "flex",
      reasoning_effort: "xhigh",
      metadata: null,
    });
  });

  it("rejects accessors, symbols, cycles, non-finite numbers, and bad injected time safely", () => {
    const accessor = { model: "m", messages: [{ role: "user", content: "x" }] } as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "getter-secret",
    });
    const cyclic: Record<string, unknown> = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
    };
    cyclic["cycle"] = cyclic;
    const symbolic = { model: "m", messages: [{ role: "user", content: "x" }] } as Record<PropertyKey, unknown>;
    symbolic[Symbol("secret")] = "symbol-secret";
    for (const body of [accessor, cyclic, symbolic, { model: "m", messages: [{ role: "user", content: "x" }], future: Number.NaN }]) {
      expectGatewayFailure(body, "invalid_openai_chat_request", 400);
    }
    const family = createOpenAiChatTranslatorFamily({ now: () => "not-a-time" });
    expect(() => family.ingress.translate(input({ model: "m", messages: [{ role: "user", content: "x" }] }), context)).toThrowError(
      expect.objectContaining({ code: "invalid_translation_timestamp", status: 500 }),
    );
  });
});

describe("OpenAI Chat egress", () => {
  it("encodes exact safe completion fields without replaying request/provider secrets", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    const encoded = egress.encodeResponse(response, context);
    expect(encoded).toMatchObject({
      id: "chatcmpl_response",
      object: "chat.completion",
      created: 1784635200,
      model: "model-output",
      choices: [
        {
          index: 3,
          message: {
            role: "assistant",
            content: "hello",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: '{ "secret": "tool-secret" }',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: {
          cached_tokens: 2,
          audio_tokens: 1,
          cache_write_tokens: 7,
        },
        completion_tokens_details: {
          reasoning_tokens: 2,
          audio_tokens: 1,
          accepted_prediction_tokens: 1,
          rejected_prediction_tokens: 2,
        },
      },
    });
    const serialized = JSON.stringify(encoded);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("credential-secret");
    expect(serialized).not.toContain("response-secret");
    expect(serialized).not.toContain("must-not-replay");
    expect(serialized).not.toContain("never-signature");
    expect(serialized).not.toContain("never-redacted");
    expect(serialized).not.toContain("never-encrypted");
    expect(serialized).not.toContain("safe reasoning text");
    expect(serialized).not.toContain("totalUsd");
  });

  it("emits only explicitly approved reasoning text in ordered replay output", () => {
    const encoded = createOpenAiChatTranslatorFamily({
      now: () => NOW,
      exposeReasoningText: true,
    }).egress.encodeResponse(response, context);
    expect(JSON.stringify(encoded)).toContain("safe reasoning text");
    expect(JSON.stringify(encoded)).not.toContain("never-signature");
  });

  it("redacts exact error output and omits provider and credential identifiers", () => {
    const error = createGatewayError({
      category: "upstream",
      code: "upstream_failed",
      message: "Upstream failed.",
      requestId: context.requestId,
      providerId: "provider-secret",
      credentialId: "credential-secret",
      retryAfterMs: 50,
      details: { authorization: "token-secret", path: "dispatch" },
    });
    const encoded = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress.encodeError(error, context);
    expect(encoded).toEqual({
      error: {
        code: "upstream_failed",
        message: "Upstream failed.",
        category: "upstream",
        retryable: true,
        status: 502,
        requestId: context.requestId,
        retryAfterMs: 50,
        details: { authorization: "[REDACTED]", path: "dispatch" },
      },
    });
    expect(JSON.stringify(encoded)).not.toContain("provider-secret");
    expect(JSON.stringify(encoded)).not.toContain("credential-secret");
    expect(JSON.stringify(encoded)).not.toContain("token-secret");
  });

  it("round-trips refusal annotations and rejects malformed refusal citations", () => {
    const request = translated({
      model: "m",
      messages: [{
        role: "assistant",
        content: [{
          type: "refusal",
          refusal: "no",
          annotations: [{
            type: "file_citation",
            file_citation: { file_id: "file-1", quote: "source" },
          }],
        }],
      }],
    });
    const refusal = request.messages[0]?.content[0];
    expect(refusal).toMatchObject({
      type: "refusal",
      citations: [{ kind: "file", sourceId: "file-1", citedText: "source" }],
    });
    const safe: CanonicalResponse = {
      ...response,
      choices: [{ index: 0, output: [refusal!], finishReason: "refusal" }],
    };
    const encoded = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress.encodeResponse(safe, context);
    expect(encoded).toMatchObject({
      choices: [{
        message: {
          refusal: "no",
          annotations: [{ type: "file_citation", file_citation: { file_id: "file-1", quote: "source" } }],
        },
        output: [{ type: "refusal", refusal: "no", annotations: [{ type: "file_citation" }] }],
      }],
    });
    const unsafe: CanonicalResponse = {
      ...response,
      choices: [{ index: 0, output: [{ type: "refusal", refusal: "no", citations: [{ kind: "file", sourceId: "" }] }], finishReason: "refusal" }],
    };
    expect(() => createOpenAiChatTranslatorFamily({ now: () => NOW }).egress.encodeResponse(unsafe, context)).toThrow(
      expect.objectContaining({ code: "invalid_openai_chat_egress", status: 500 }),
    );
  });

  it("rejects citation kinds OpenAI Chat cannot represent", () => {
    const unsafe: CanonicalResponse = {
      ...response,
      choices: [{
        index: 0,
        output: [{ type: "text", text: "source", citations: [{ kind: "char_span", startIndex: 0, endIndex: 6 }] }],
        finishReason: "stop",
      }],
    };
    expect(() => createOpenAiChatTranslatorFamily({ now: () => NOW }).egress.encodeResponse(unsafe, context)).toThrow(
      expect.objectContaining({ code: "invalid_openai_chat_egress", status: 500 }),
    );
  });

  it.each(["stop_sequence", "pause_turn", "incomplete", "cancelled", "error"] as const)(
    "rejects unrepresentable finish reason %s",
    (finishReason) => {
      const unsafe: CanonicalResponse = {
        ...response,
        choices: [{ index: 0, output: [{ type: "text", text: "x" }], finishReason }],
      };
      expect(() => createOpenAiChatTranslatorFamily({ now: () => NOW }).egress.encodeResponse(unsafe, context)).toThrowError(
        expect.objectContaining({ code: "invalid_openai_chat_egress", status: 500 }),
      );
    },
  );
  it("rejects unsafe canonical usage, logprobs, indexes, IDs, and audio", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    const unsafeResponses: CanonicalResponse[] = [
      { ...response, usage: { ...response.usage, reasoningTokens: Number.NaN } },
      { ...response, choices: [{ ...response.choices[0]!, index: -1 }] },
      { ...response, choices: [{ ...response.choices[0]!, logprobs: [{ token: "x", logprob: Number.POSITIVE_INFINITY }] }] },
      { ...response, choices: [{ index: 0, output: [{ type: "tool_call", toolCallId: "", name: "f", argumentsJson: "{}" }], finishReason: "tool_calls" }] },
      { ...response, choices: [{ index: 0, output: [{ type: "audio_output", mediaType: "audio/mpeg", data: "%%%" }], finishReason: "stop" }] },
    ];
    for (const unsafe of unsafeResponses) {
      expect(() => egress.encodeResponse(unsafe, context)).toThrow(
        expect.objectContaining({ code: "invalid_openai_chat_egress", status: 500 }),
      );
    }
  });

});

describe("OpenAI Chat streaming egress", () => {
  const streamContext: TranslationContext = Object.freeze({
    ...context,
    streamResponse: Object.freeze({
      responseId: "stream-a",
      model: "model-a",
      createdAt: NOW,
    }),
  });
  const address = { choiceIndex: 2, outputIndex: 4 };

  it("maps every chunk variant without adapter state or sensitive reasoning", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    const chunks: CanonicalChunk[] = [
      { type: "response_start", responseId: "stream-a", model: "model-a", createdAt: NOW },
      { type: "ping" },
      { type: "content_block_start", address, block: { type: "text" } },
      { type: "text_delta", address, text: "hello" },
      { type: "refusal_delta", address, text: "no" },
      { type: "reasoning_delta", address, text: "hidden", signatureDelta: "sig", redactedDataDelta: "redacted", encryptedContentDelta: "encrypted" },
      { type: "audio_delta", address, audioBase64: "YQ==", transcriptDelta: "a" },
      { type: "content_block_start", address, block: { type: "tool_call", id: "call", name: "lookup" } },
      { type: "tool_call_delta", address, id: "call", name: "lookup", argumentsDelta: '{"q":' },
      { type: "citation_added", address, citation: { kind: "url", url: "https://example.test/a" } },
      { type: "content_block_stop", address },
      { type: "choice_end", choiceIndex: 2, finishReason: "tool_calls" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    ];
    const frames = chunks.flatMap((chunk) => parseSse(egress.encodeChunk(chunk, streamContext)));
    expect(frames[0]).toMatchObject({
      id: "stream-a",
      object: "chat.completion.chunk",
      created: 1784635200,
      model: "model-a",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
    expect(frames).toContainEqual(
      expect.objectContaining({ choices: [expect.objectContaining({ index: 2, delta: { content: "hello" } })] }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ choices: [expect.objectContaining({ index: 2, delta: { tool_calls: [expect.objectContaining({ index: 4 })] } })] }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    );
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("sig");
    expect(serialized).not.toContain("redacted");
    expect(serialized).not.toContain("encrypted");
  });

  it("rejects stream citation kinds OpenAI Chat cannot represent", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    expect(() => egress.encodeChunk({
      type: "citation_added",
      address,
      citation: { kind: "char_span", startIndex: 0, endIndex: 1 },
    }, streamContext)).toThrow(
      expect.objectContaining({ code: "invalid_openai_chat_egress", status: 500 }),
    );
  });

  it("terminates successful and error streams byte-for-byte", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    const end = egress.encodeChunk({ type: "response_end", status: "completed" }, streamContext);
    expect(typeof end).toBe("string");
    expect(end as string).toMatch(/^data: \{.*"choices":\[\]\}\n\ndata: \[DONE\]\n\n$/);
    const error = createGatewayError({
      category: "upstream",
      code: "stream_failed",
      message: "Stream failed.",
      requestId: context.requestId,
      providerId: "provider-secret",
      credentialId: "credential-secret",
    });
    const failed = egress.encodeChunk({ type: "error", error }, streamContext);
    expect(typeof failed).toBe("string");
    expect(failed as string).toBe(`data: ${JSON.stringify(egress.encodeError(error, streamContext))}\n\ndata: [DONE]\n\n`);
    expect(failed as string).not.toContain("chat.completion.chunk");
  });

  it("requires metadata after start and preserves interleaved request identities", () => {
    const egress = createOpenAiChatTranslatorFamily({ now: () => NOW }).egress;
    expect(() => egress.encodeChunk({ type: "ping" }, context)).toThrowError(
      expect.objectContaining({ code: "missing_stream_response_metadata", status: 500 }),
    );
    const other: TranslationContext = Object.freeze({
      ...context,
      requestId: "req_other",
      streamResponse: Object.freeze({
        responseId: "stream-b",
        model: "model-b",
        createdAt: "2026-07-21T12:00:01.000Z",
      }),
    });
    const first = parseSse(egress.encodeChunk({ type: "text_delta", address, text: "a" }, streamContext))[0];
    const second = parseSse(egress.encodeChunk({ type: "text_delta", address, text: "b" }, other))[0];
    const third = parseSse(egress.encodeChunk({ type: "tool_call_delta", address, argumentsDelta: "x".repeat(10_000) }, streamContext))[0];
    expect(first).toMatchObject({ id: "stream-a", model: "model-a" });
    expect(second).toMatchObject({ id: "stream-b", model: "model-b" });
    expect(third).toMatchObject({ id: "stream-a", model: "model-a" });
  });
});
