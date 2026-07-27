import { describe, expect, it } from "vitest";
import {
  createOpenAiResponsesTranslatorFamily,
} from "../../src/adapters/index.js";
import type {
  CanonicalChunk,
  CanonicalResponse,
  GatewayError,
} from "../../src/domain/index.js";
import { createGatewayError } from "../../src/domain/index.js";
import {
  createStreamTranslationState,
  type StreamTranslationState,
  type TranslationContext,
} from "../../src/ports/index.js";

const NOW = "2026-07-21T12:00:00.000Z";
const REQUEST_ID = "req_openai_responses";

function context(
  options: {
    readonly streamState?: StreamTranslationState;
    readonly streamResponse?: TranslationContext["streamResponse"];
  } = {},
): TranslationContext {
  return {
    requestId: REQUEST_ID,
    signal: new AbortController().signal,
    trustedRoutingHeaders: {},
    ...(options.streamState === undefined
      ? {}
      : { streamState: options.streamState }),
    ...(options.streamResponse === undefined
      ? {}
      : { streamResponse: options.streamResponse }),
  };
}

function state(resumeFrom?: number): StreamTranslationState {
  const streamState = createStreamTranslationState();
  return resumeFrom === undefined
    ? streamState
    : { ...streamState, resumeFrom };
}

function response(output: CanonicalResponse["choices"][number]["output"]): CanonicalResponse {
  return {
    requestId: REQUEST_ID,
    responseId: "resp_public",
    createdAt: NOW,
    model: "logical-model",
    status: "completed",
    choices: [{ index: 0, output, finishReason: "stop" }],
    usage: {
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    },
    cost: {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      totalUsd: 0,
      currency: "USD",
    },
    provider: {
      providerId: "provider-private",
      credentialId: "credential-private",
      physicalModel: "physical-private",
      responseHeaders: { authorization: "private" },
      upstreamStatus: 200,
    },
  };
}

function translate(path: string, body: unknown) {
  const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
  return family.ingress.translate(
    { path, headers: {}, body, authorization: "Bearer private" },
    context(),
  );
}

function parseEvents(value: string): Array<Record<string, unknown>> {
  return value
    .split("\n\n")
    .filter((record) => record.startsWith("event:"))
    .map((record) => {
      const data = record.split("\n").find((line) => line.startsWith("data: "));
      if (data === undefined) throw new Error("Missing SSE data line.");
      return JSON.parse(data.slice(6)) as Record<string, unknown>;
    });
}

describe("OpenAI Responses translator family", () => {
  it.each(["/responses", "/v1/responses"])(
    "exposes immutable alias %s and preserves dense ordered input",
    (path) => {
      const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
      expect(family.ingress.paths.has(path)).toBe(true);
      expect(Object.isFrozen(family)).toBe(true);
      expect(Object.isFrozen(family.ingress)).toBe(true);
      expect(Object.isFrozen(family.egress)).toBe(true);
      const canonical = family.ingress.translate(
        {
          path,
          headers: { authorization: "not-retained" },
          authorization: "Bearer not-retained",
          body: {
            model: "logical-model",
            instructions: "Preserve separately",
            input: [
              { type: "message", role: "system", content: "system" },
              { type: "message", role: "developer", content: "developer" },
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "hello", unknown_part: null },
                  {
                    type: "input_image",
                    image_url: "https://example.test/image.png",
                  },
                  { type: "input_audio", data: "YQ==", format: "wav" },
                ],
                unknown_item: { explicit: null },
              },
              {
                type: "function_call",
                id: "item-call",
                call_id: "call-1",
                name: "weather",
                arguments: '{"city":"Paris"}',
              },
              {
                type: "function_call_output",
                call_id: "call-1",
                output: "sunny",
              },
              {
                type: "reasoning",
                id: "reason-1",
                summary: [{ type: "summary_text", text: "approved summary" }],
                encrypted_content: "cipher-private",
              },
              {
                type: "mcp_call",
                id: "mcp-1",
                call_id: "mcp-1",
                name: "lookup",
                server_label: "docs",
                input: { query: "x" },
              },
              {
                type: "mcp_approval_request",
                approval_request_id: "approval-1",
                reason: "needed",
              },
              {
                type: "mcp_approval_response",
                approval_request_id: "approval-1",
                approve: true,
              },
            ],
            tools: [
              {
                type: "function",
                name: "weather",
                description: "Get weather",
                parameters: { type: "object", properties: {} },
                unknown_tool: null,
              },
              {
                type: "mcp",
                server_label: "docs",
                server_url: "https://example.test/mcp",
              },
            ],
            tool_choice: {
              type: "allowed_tools",
              mode: "required",
              tools: [{ type: "function", name: "weather" }],
            },
            parallel_tool_calls: true,
            max_output_tokens: 256,
            temperature: 0.2,
            top_p: 0.9,
            n: 1,
            reasoning: {
              effort: "high",
              summary: "detailed",
              request_encrypted_content: true,
            },
            text: {
              verbosity: "high",
              format: {
                type: "json_schema",
                name: "answer",
                schema: { type: "object", properties: {} },
                strict: true,
              },
            },
            service_tier: "flex",
            store: false,
            zero_data_retention: true,
            previous_response_id: "resp_previous",
            background: true,
            stream: true,
            stream_options: {
              include_usage: true,
              include_obfuscation: false,
              resume_from: 2,
            },
            include: ["reasoning.encrypted_content", "unknown.include"],
            unknown_top: { explicit: null },
            authorization: "must-not-retain",
          },
        },
        context(),
      );

      expect(canonical.source).toEqual({
        adapter: "openai-responses",
        protocol: "openai-responses",
        path,
      });
      expect(canonical.messages.map((message) => message.role)).toEqual([
        "system",
        "developer",
        "user",
        "assistant",
        "tool",
        "assistant",
        "assistant",
        "assistant",
        "user",
      ]);
      expect(canonical.messages[2]?.content.map((block) => block.type)).toEqual([
        "text",
        "image_url",
        "audio_base64",
      ]);
      expect(canonical.messages[5]?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            encryptedContent: "cipher-private",
          }),
        ]),
      );
      expect(canonical.toolChoice).toEqual({
        mode: "allowed",
        names: ["weather"],
        allowRequired: true,
      });
      expect(canonical.sampling).toMatchObject({
        maxTokens: 256,
        temperature: 0.2,
        topP: 0.9,
        n: 1,
      });
      expect(canonical.reasoning).toMatchObject({
        mode: "enabled",
        display: "detailed",
        requestEncryptedContent: true,
      });
      expect(canonical.output).toMatchObject({
        verbosity: "high",
        format: "json_schema",
      });
      expect(canonical.serviceTier).toEqual({
        tier: "auto",
        providerParameters: { service_tier: "flex" },
      });
      expect(canonical.persistence).toEqual({
        store: false,
        zeroDataRetention: true,
      });
      expect(canonical.conversation).toEqual({
        previousResponseId: "resp_previous",
      });
      expect(canonical.execution).toEqual({ mode: "background" });
      expect(canonical.streamOptions).toEqual({
        includeUsage: true,
        resumeFrom: "2",
      });
      expect(canonical.routing.requiredCapabilities).toEqual(
        expect.arrayContaining([
          "audio_input",
          "background_execution",
          "mcp",
          "multimodal",
          "reasoning",
          "server_tools",
          "tools",
          "vision",
        ]),
      );
      const protocol = canonical.extensions?.protocols?.["openai-responses"];
      expect(protocol?.body).toMatchObject({
        unknown_top: { explicit: null },
        include: [{}, "unknown.include"],
        stream_options: { include_obfuscation: false },
      });
      expect(canonical.metadata).toEqual({
        instructions: "Preserve separately",
      });
      expect(protocol?.body["input"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unknown_item: { explicit: null },
            content: [{ unknown_part: null }, {}, {}],
          }),
        ]),
      );
      expect(protocol?.sourceFields).toContain("input[2].content[0].text");
      expect(JSON.stringify(canonical)).not.toContain("must-not-retain");
      expect(JSON.stringify(canonical)).not.toContain("Bearer not-retained");
      expect(Object.isFrozen(canonical)).toBe(true);
      expect(Object.isFrozen(canonical.messages)).toBe(true);
    },
  );

  it("normalizes string input without replacing it with instructions", () => {
    const canonical = translate("/responses", {
      model: "logical-model",
      instructions: "separate",
      input: "hello",
    });
    expect(canonical.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(canonical.metadata).toEqual({ instructions: "separate" });
  });

  it("collapses only an eligible leading instruction run", () => {
    const collapsed = translate("/responses", {
      model: "m",
      input: [
        { role: "system", content: "system" },
        { role: "developer", content: "developer" },
        { role: "user", content: "hello" },
      ],
    });
    expect(collapsed.metadata).toEqual({
      instructions: "system\ndeveloper",
    });
    expect(collapsed.messages.map((message) => message.role)).toEqual([
      "system",
      "developer",
      "user",
    ]);

    const cached = translate("/responses", {
      model: "m",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "cached",
              prompt_cache_breakpoint: { ttl: "5m" },
            },
          ],
        },
        { role: "user", content: "hello" },
      ],
    });
    expect(cached.metadata).toBeUndefined();
    expect(cached.messages[0]?.content[0]).toMatchObject({
      type: "text",
      cacheBreakpoint: { ttl: "5m" },
    });

    const cited = translate("/responses", {
      model: "m",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "cited",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/source",
                },
              ],
            },
          ],
        },
        { role: "user", content: "hello" },
      ],
    });
    expect(cited.metadata).toBeUndefined();

    const midRun = translate("/responses", {
      model: "m",
      input: [
        { role: "user", content: "hello" },
        { role: "system", content: "late" },
      ],
    });
    expect(midRun.metadata).toBeUndefined();
  });

  it.each([
    [{ model: "", input: "x" }, 400, "invalid_model"],
    [{ model: "m", input: [] }, 400, "invalid_messages"],
    [
      { model: "m", input: [{ type: "function_call", call_id: "c", name: "f", arguments: "[]" }] },
      400,
      "invalid_tool_arguments",
    ],
    [
      { model: "m", input: "x", n: 2 },
      422,
      "unsupported_openai_responses_semantics",
    ],
    [
      { model: "m", input: "x", top_k: 1 },
      422,
      "unsupported_openai_responses_semantics",
    ],
    [
      { model: "m", input: "x", stream_options: { resume_from: -1 } },
      400,
      "invalid_resume_metadata",
    ],
    [
      { model: "m", input: "x", previous_response_id: "a", conversation: "b" },
      400,
      "invalid_openai_responses_request",
    ],
  ] as const)("fails safely for malformed or unsupported input %#", (body, status, code) => {
    expect(() => translate("/responses", body)).toThrowError(
      expect.objectContaining({ status, code, retryable: false }),
    );
  });

  it("rejects accessors, cycles, sparse arrays, and non-finite JSON", () => {
    const accessor = { model: "m", input: "x" } as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "private",
    });
    const cycle: Record<string, unknown> = { model: "m", input: "x" };
    cycle["cycle"] = cycle;
    const sparse = new Array(2);
    sparse[0] = { type: "message", role: "user", content: "x" };
    const values: unknown[] = [
      accessor,
      cycle,
      { model: "m", input: sparse },
      { model: "m", input: "x", temperature: Number.NaN },
    ];
    for (const value of values) {
      expect(() => translate("/responses", value)).toThrowError(
        expect.objectContaining({ code: "invalid_openai_responses_request" }),
      );
    }
  });

  it("encodes an exact ordered response envelope and redacts reasoning by default", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const encoded = family.egress.encodeResponse(
      response([
        {
          type: "text",
          id: "message-1",
          text: "answer",
          cacheBreakpoint: { ttl: "5m" },
          citations: [
            { kind: "url", url: "https://example.test/source", sourceTitle: "Source" },
          ],
        },
        {
          type: "reasoning",
          id: "reasoning-1",
          text: "approved ordinary reasoning",
          signature: "signature-private",
          encryptedContent: "cipher-private",
          redactedData: "redacted-private",
        },
        {
          type: "tool_call",
          id: "call-item",
          toolCallId: "call-1",
          name: "weather",
          argumentsJson: '{"city":"Paris"}',
        },
        {
          type: "server_tool_call",
          toolCallId: "mcp-1",
          toolKind: "mcp_call",
          name: "lookup",
          serverName: "docs",
          input: { query: "x" },
        },
        {
          type: "tool_approval_response",
          toolCallId: "approval-1",
          approved: true,
        },
      ]),
      context(),
    );
    expect(encoded).toMatchObject({
      id: "resp_public",
      object: "response",
      created_at: Math.floor(Date.parse(NOW) / 1000),
      status: "completed",
      model: "logical-model",
      output: [
        {
          type: "message",
          id: "message-1",
          content: [
            {
              type: "output_text",
              prompt_cache_breakpoint: { ttl: "5m" },
            },
          ],
        },
        { type: "reasoning", id: "reasoning-1" },
        { type: "function_call", call_id: "call-1" },
        { type: "mcp_call", call_id: "mcp-1" },
        { type: "mcp_approval_response", approval_request_id: "approval-1" },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    });
    expect(JSON.stringify(encoded)).not.toContain("signature-private");
    expect(JSON.stringify(encoded)).not.toContain("cipher-private");
    expect(JSON.stringify(encoded)).not.toContain("redacted-private");
    expect(JSON.stringify(encoded)).not.toContain("provider-private");
    expect(JSON.stringify(encoded)).not.toContain("physical-private");
  });

  it("exposes only approved ordinary reasoning text when explicitly enabled", () => {
    const family = createOpenAiResponsesTranslatorFamily({
      now: () => NOW,
      exposeReasoningText: true,
    });
    const encoded = family.egress.encodeResponse(
      response([
        {
          type: "reasoning",
          text: "approved",
          signature: "signature-private",
          encryptedContent: "cipher-private",
        },
      ]),
      context(),
    );
    expect(encoded).toMatchObject({
      output: [{ type: "reasoning", summary: [{ text: "approved" }] }],
    });
    expect(JSON.stringify(encoded)).not.toContain("signature-private");
    expect(JSON.stringify(encoded)).not.toContain("cipher-private");
  });

  it("emits supplied-sequence named SSE without request allocation state", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const streamResponse = {
      responseId: "resp_stream",
      model: "logical-model",
      createdAt: NOW,
    };
    const modeA = context({ streamResponse });
    const start = family.egress.encodeChunk(
      {
        type: "response_start",
        ...streamResponse,
        sequenceNumber: 1,
      },
      context(),
    ) as string;
    const blockStart = family.egress.encodeChunk(
      {
        type: "content_block_start",
        address: { choiceIndex: 0, outputIndex: 2, contentIndex: 1 },
        block: { type: "text", id: "item-2" },
        sequenceNumber: 3,
      },
      modeA,
    ) as string;
    const delta = family.egress.encodeChunk(
      {
        type: "text_delta",
        address: { choiceIndex: 0, outputIndex: 2, contentIndex: 1 },
        text: "hello",
        sequenceNumber: 5,
      },
      modeA,
    ) as string;
    const stop = family.egress.encodeChunk(
      {
        type: "content_block_stop",
        address: { choiceIndex: 0, outputIndex: 2, contentIndex: 1 },
        block: { type: "text", id: "item-2", text: "hello" },
        sequenceNumber: 6,
      },
      modeA,
    ) as string;
    const end = family.egress.encodeChunk(
      { type: "response_end", status: "completed", sequenceNumber: 8 },
      modeA,
    ) as string;
    expect(parseEvents(start).map((event) => event["type"])).toEqual([
      "response.created",
      "response.in_progress",
    ]);
    expect(parseEvents(blockStart).map((event) => event["type"])).toEqual([
      "response.output_item.added",
      "response.content_part.added",
    ]);
    expect(parseEvents(delta)[0]).toMatchObject({
      type: "response.output_text.delta",
      sequence_number: 5,
      output_index: 2,
      content_index: 1,
      delta: "hello",
    });
    expect(parseEvents(stop).map((event) => event["type"])).toEqual([
      "response.content_part.done",
      "response.output_item.done",
    ]);
    expect(end).toMatch(/event: response.completed/);
    expect(end).toMatch(/data: \[DONE\]\n\n$/);
  });

  it("advances all request-local state before resume filtering and retains terminal usage", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const streamState = state(4);
    const modeB = context({ streamState });
    expect(
      family.egress.encodeChunk(
        {
          type: "response_start",
          responseId: "resp_resume",
          model: "logical-model",
          createdAt: NOW,
        },
        modeB,
      ),
    ).toBe("");
    expect(
      family.egress.encodeChunk(
        {
          type: "text_delta",
          address: { choiceIndex: 0, outputIndex: 0 },
          text: "suppressed",
        },
        modeB,
      ),
    ).toBe("");
    expect(
      family.egress.encodeChunk(
        {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
        modeB,
      ),
    ).toBe("");
    const terminal = family.egress.encodeChunk(
      { type: "response_end", status: "incomplete" },
      modeB,
    ) as string;
    expect(terminal).toContain("event: response.incomplete");
    expect(terminal).toContain('"input_tokens":1');
    expect(terminal).toMatch(/data: \[DONE\]\n\n$/);
    expect(streamState.response).toEqual({
      responseId: "resp_resume",
      model: "logical-model",
      createdAt: NOW,
    });
    expect(streamState.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    expect(streamState.terminal).toBe(true);
    expect(streamState.emittedSequences).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(
      family.egress.encodeChunk(
        { type: "response_end", status: "completed" },
        modeB,
      ),
    ).toBe("");
  });

  it("keeps sequence state independent and rejects duplicate supplied sequences", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const first = state();
    const second = state();
    family.egress.encodeChunk(
      {
        type: "response_start",
        responseId: "a",
        model: "m",
        createdAt: NOW,
      },
      context({ streamState: first }),
    );
    family.egress.encodeChunk(
      {
        type: "response_start",
        responseId: "b",
        model: "m",
        createdAt: NOW,
      },
      context({ streamState: second }),
    );
    expect(first.emittedSequences).toEqual(new Set([1, 2]));
    expect(second.emittedSequences).toEqual(new Set([1, 2]));
    expect(() =>
      family.egress.encodeChunk(
        {
          type: "text_delta",
          address: { outputIndex: 0 },
          text: "x",
          sequenceNumber: 2,
        },
        context({ streamState: first }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
  });

  it("emits one safe typed error plus the exact terminator", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const streamState = state();
    streamState.response = {
      responseId: "resp_error",
      model: "m",
      createdAt: NOW,
    };
    const error = createGatewayError({
      category: "upstream",
      code: "provider_stream_failed",
      message: "Provider stream failed.",
      requestId: REQUEST_ID,
      retryable: true,
      status: 502,
      retryAfterMs: 50,
      providerId: "provider-private",
      credentialId: "credential-private",
      details: { authorization: "Bearer private", reason: "safe" },
    });
    const encoded = family.egress.encodeChunk(
      { type: "error", error },
      context({ streamState }),
    ) as string;
    expect(parseEvents(encoded)).toEqual([
      expect.objectContaining({
        type: "error",
        sequence_number: 1,
        error: expect.objectContaining({
          code: "provider_stream_failed",
          category: "upstream",
          retryable: true,
          status: 502,
          requestId: REQUEST_ID,
          retryAfterMs: 50,
        }),
      }),
    ]);
    expect(encoded).toMatch(/data: \[DONE\]\n\n$/);
    expect(encoded).not.toContain("provider-private");
    expect(encoded).not.toContain("credential-private");
    expect(encoded).not.toContain("Bearer private");
    expect(streamState.terminal).toBe(true);
    expect(
      family.egress.encodeChunk(
        { type: "response_end", status: "completed" },
        context({ streamState }),
      ),
    ).toBe("");
  });

  it("uses the complete safe error envelope outside streams", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const error: GatewayError = createGatewayError({
      category: "validation",
      code: "bad_request",
      message: "Bad request.",
      requestId: REQUEST_ID,
      details: { authorization: "private", field: "input" },
    });
    const encoded = family.egress.encodeError(error, context());
    expect(encoded).toMatchObject({
      error: {
        code: "bad_request",
        message: "Bad request.",
        category: "validation",
        retryable: false,
        status: 400,
        requestId: REQUEST_ID,
        details: { authorization: "[REDACTED]", field: "input" },
      },
    });
  });
  it("recursively removes sensitive provider parameters", () => {
    const canonical = translate("/responses", {
      model: "m",
      input: "x",
      tools: [
        {
          type: "mcp",
          server_label: "docs",
          configuration: {
            authorization: "Bearer private",
            nested: { api_key: "private", safe: "kept" },
          },
        },
      ],
    });
    expect(canonical.tools?.[0]).toMatchObject({
      kind: "server",
      providerParameters: {
        configuration: { nested: { safe: "kept" } },
      },
    });
    expect(JSON.stringify(canonical)).not.toContain("Bearer private");
    expect(JSON.stringify(canonical)).not.toContain('"api_key"');
    const parameters = canonical.tools?.[0]?.kind === "server"
      ? canonical.tools[0].providerParameters
      : undefined;
    expect(parameters).toMatchObject({
      configuration: {
        nested: { safe: "kept" },
      },
    });
    expect(parameters?.["configuration"]).not.toHaveProperty("authorization");
    const withPositions = translate("/responses", {
      model: "m",
      input: "x",
      tools: [
        {
          type: "mcp",
          sequence: [
            { authorization: "private", safe: 1 },
            { body: "retained-body", arguments: "retained-arguments" },
            null,
          ],
        },
      ],
    });
    expect(
      withPositions.tools?.[0]?.kind === "server"
        ? withPositions.tools[0].providerParameters
        : undefined,
    ).toMatchObject({
      sequence: [
        { safe: 1 },
        { body: "retained-body", arguments: "retained-arguments" },
        null,
      ],
    });
  });

  it("fails closed on malformed canonical response containers", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const malformed = response([{ type: "text", text: "x" }]);
    Object.setPrototypeOf(malformed.choices[0]?.output[0], { unsafe: true });
    expect(() => family.egress.encodeResponse(malformed, context())).toThrow(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
    const malformedUsage = {
      ...response([{ type: "text", text: "x" }]),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheWriteBreakdown: { tokens: 1 },
      },
    } as unknown as CanonicalResponse;
    expect(() => family.egress.encodeResponse(malformedUsage, context())).toThrow(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
  });


  it("validates event byte limits and constructor bounds", () => {
    expect(() =>
      createOpenAiResponsesTranslatorFamily({ now: () => NOW, maxEventBytes: 0 }),
    ).toThrow(TypeError);
    const family = createOpenAiResponsesTranslatorFamily({
      now: () => NOW,
      maxEventBytes: 100,
    });
    expect(() =>
      family.egress.encodeChunk(
        {
          type: "response_start",
          responseId: "resp_oversize",
          model: "model-that-makes-the-event-larger-than-the-configured-bound",
          createdAt: NOW,
          sequenceNumber: 1,
        },
        context(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
    const atomicState = state();
    expect(() =>
      family.egress.encodeChunk(
        {
          type: "response_start",
          responseId: "resp_oversize",
          model: "model-that-makes-the-event-larger-than-the-configured-bound",
          createdAt: NOW,
        },
        context({ streamState: atomicState }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
    expect(atomicState).toMatchObject({
      terminal: false,
      bytesEmitted: false,
    });
    expect(atomicState.response).toBeUndefined();
    expect(atomicState.emittedSequences.size).toBe(0);
    expect(atomicState.sequenceNumbers.size).toBe(0);
  });

  it("fails closed for malformed canonical usage without consuming state", () => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const streamState = state();
    streamState.response = {
      responseId: "resp_bad_usage",
      model: "logical-model",
      createdAt: NOW,
    };
    const malformed = {
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheWriteBreakdown: [null],
      },
    } as unknown as CanonicalChunk;
    expect(() =>
      family.egress.encodeChunk(malformed, context({ streamState })),
    ).toThrow(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
    expect(streamState.usage).toBeUndefined();
    expect(streamState.emittedSequences.size).toBe(0);
  });

  it.each([
    {
      type: "text_delta",
      address: null,
      text: "x",
    },
    {
      type: "text_delta",
      address: { outputIndex: -1 },
      text: "x",
    },
    {
      type: "text_delta",
      address: { outputIndex: 0, contentIndex: 1.5 },
      text: "x",
    },
    {
      type: "text_delta",
      address: { outputIndex: 0 },
      text: 1,
    },
    {
      type: "content_block_start",
      address: { outputIndex: 0 },
      block: null,
    },
    {
      type: "content_block_stop",
      address: { outputIndex: 0 },
      block: { type: "tool_call", toolCallId: "call", name: "f", argumentsJson: "[]" },
    },
    {
      type: "response_start",
      responseId: "resp",
      model: "m",
      createdAt: "not-a-time",
    },
    {
      type: "response_end",
      status: 42,
    },
    {
      type: "text_delta",
      address: { outputIndex: 0 },
      text: "x",
      sequenceNumber: 0,
    },
  ])("fails closed for malformed chunk %# without mutating state", (malformed) => {
    const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
    const streamState = state();
    streamState.response = {
      responseId: "resp_preflight",
      model: "logical-model",
      createdAt: NOW,
    };
    expect(() =>
      family.egress.encodeChunk(
        malformed as unknown as CanonicalChunk,
        context({ streamState }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_openai_responses_egress" }),
    );
    expect(streamState.emittedSequences.size).toBe(0);
    expect(streamState.sequenceNumbers.size).toBe(0);
    expect(streamState.terminal).toBe(false);
    expect(streamState.bytesEmitted).toBe(false);
  });
});
