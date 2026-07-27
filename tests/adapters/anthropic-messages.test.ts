import { describe, expect, it } from "vitest";
import {
  createAnthropicMessagesTranslatorFamily,
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
const REQUEST_ID = "req_anthropic_messages";
const aliases = ["/messages", "/v1/messages"] as const;

function context(streamState?: StreamTranslationState): TranslationContext {
  return {
    requestId: REQUEST_ID,
    signal: new AbortController().signal,
    trustedRoutingHeaders: {},
    ...(streamState === undefined ? {} : { streamState }),
  };
}

function input(body: unknown, path = "/v1/messages") {
  return {
    path,
    headers: { authorization: "Bearer boundary-secret", "x-ignored": "ignored" },
    authorization: "Bearer outer-secret",
    body,
  };
}

function family(options: Partial<Parameters<typeof createAnthropicMessagesTranslatorFamily>[0]> = {}) {
  return createAnthropicMessagesTranslatorFamily({ now: () => NOW, ...options });
}

function translate(body: unknown, path = "/v1/messages") {
  return family().ingress.translate(input(body, path), context());
}

function expectThrown(call: () => unknown, expected: Record<string, unknown>): GatewayError {
  try {
    call();
  } catch (error: unknown) {
    const value = error as GatewayError;
    expect(value).toMatchObject(expected);
    return value;
  }
  throw new Error("Expected translation failure.");
}

function failure(body: unknown, code: string, status: number, path = "/v1/messages") {
  const value = expectThrown(() => translate(body, path), {
    code,
    status,
    retryable: false,
    requestId: REQUEST_ID,
    category: status >= 500 ? "internal" : "validation",
  });
  expect(JSON.stringify(value)).not.toMatch(/secret|authorization|Bearer|https?:\/\//i);
  return value;
}
function eventRecords(value: unknown): Array<{ event: string; data: Record<string, unknown> }> {
  expect(typeof value).toBe("string");
  return (value as string)
    .split("\n\n")
    .filter(Boolean)
    .map((record) => {
      const lines = record.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) throw new Error("Malformed named SSE record.");
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}


const usage = {
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
  cachedInputTokens: 2,
  cacheWriteBreakdown: [
    { ttlSeconds: 300, tokens: 3 },
    { ttlSeconds: 3600, tokens: 4 },
  ],
  reasoningTokens: 5,
  serverToolUsage: { web_fetch: 2, web_search: 1, private_counter: 9 },
};

function response(output: CanonicalResponse["choices"][number]["output"]): CanonicalResponse {
  return {
    requestId: REQUEST_ID,
    responseId: "msg_public",
    createdAt: NOW,
    model: "logical-model",
    status: "completed",
    choices: [{ index: 0, output, finishReason: "stop" }],
    usage,
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
      responseHeaders: { authorization: "never-replay" },
      upstreamStatus: 200,
    },
  };
}

const start = (sequenceNumber = 1): CanonicalChunk => ({
  type: "response_start",
  responseId: "stream_public",
  model: "logical-model",
  createdAt: NOW,
  sequenceNumber,
});

const end = (status: "completed" | "incomplete" = "completed"): CanonicalChunk => ({
  type: "response_end",
  status,
});

const choiceEnd: CanonicalChunk = { type: "choice_end", choiceIndex: 0, finishReason: "stop" };
const usageChunk: CanonicalChunk = { type: "usage", usage };

 describe("Anthropic Messages translator family", () => {
  it("exposes exactly two immutable aliases and the protocol literal", () => {
    const value = family();
    expect([...value.ingress.paths]).toEqual([...aliases]);
    expect(value.ingress.protocol).toBe("anthropic-messages");
    expect(value.ingress.canTranslate("/messages", {})).toBe(true);
    expect(value.ingress.canTranslate("/v1/messages", {})).toBe(true);
    expect(value.ingress.canTranslate("/other", {})).toBe(false);
    expect(value.ingress.canTranslate("/messages", [])).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.ingress)).toBe(true);
    expect(Object.isFrozen(value.egress)).toBe(true);
    const mutable = value.ingress.paths as unknown as { add?: unknown; delete?: unknown };
    expect(mutable.add).toBeUndefined();
    expect(mutable.delete).toBeUndefined();
  });

  it.each(aliases)("normalizes ordered, lossless multimodal input through %s", (path) => {
    const request = family({ exposeReasoningText: true, exposeReasoningSignatures: true }).ingress.translate(
      input(
        {
          model: "logical-model",
          max_tokens: 4096,
          stream: true,
          system: [
            { type: "text", text: "policy", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "", cache_control: null },
          ],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "before", citations: [{ type: "char_location", cited_text: "bef", start_char_index: 0, end_char_index: 3, document_title: "doc" }], cache_control: { type: "ephemeral", ttl: "1h" } },
                { type: "image", source: { type: "url", url: "https://example.test/image.png" }, cache_control: null },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
                { type: "audio", source: { type: "url", url: "https://example.test/audio.wav", format: "wav" } },
                { type: "audio", source: { type: "base64", media_type: "audio/wav", data: "YQ==" } },
                { type: "document", source: { type: "url", url: "https://example.test/a.pdf" }, title: "A", citations: { enabled: true } },
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: "Yg==" }, title: "B" },
                { type: "search_result", source: "result-1", title: "Search", content: [{ type: "text", text: "found" }], citations: { enabled: true } },
                { type: "mid_conv_system", content: [{ type: "text", text: "mid-policy", cache_control: { type: "ephemeral" } }] },
                { type: "text", text: "after", future_block: { explicit: null } },
              ],
              future_message_field: null,
            },
            { role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "sig" }, { type: "redacted_thinking", data: "cipher" }, { type: "text", text: "answer" }, { type: "tool_use", id: "call-1", name: "lookup", input: { z: 1, a: null } }, { type: "server_tool_use", id: "server-1", name: "web_search", input: { q: "x" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "result" }, { type: "image", source: { type: "url", url: "https://example.test/result.png" } }], is_error: true }] },
            { role: "assistant", content: [{ type: "server_tool_result", tool_use_id: "server-1", content: [{ type: "text", text: "server result" }] }] },
          ],
          tools: [
            { name: "lookup", description: "Look up", input_schema: { type: "object", properties: { q: { type: "string" } } }, strict: true, cache_control: { type: "ephemeral" }, unknown_tool_field: null },
            { type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["example.test"], defer_loading: true },
            { type: "mcp_toolset", mcp_server_name: "docs", default_config: { enabled: false }, allowed_tools: ["lookup"], tools: { lookup: { defer_loading: true } }, cache_control: { type: "ephemeral" } },
          ],
          mcp_servers: [{ type: "url", name: "docs", url: "https://example.test/mcp", authorization_token: "token-never-retained-in-extension" }],
          metadata: { tenant: "demo", explicit: null },
          service_tier: "priority",
          temperature: 0.2,
          top_p: 0.9,
          top_k: 4,
          stop_sequences: ["END"],
          output_config: { effort: "xhigh", format: { type: "json_schema", schema: { type: "object" } }, future_output: null },
          thinking: { type: "enabled", budget_tokens: 1024, display: "summarized", future_thinking: null },
          future_top_level: { retained: true },
        },
        path,
      ),
      context(),
    );
    expect(request.source).toEqual({ adapter: "anthropic-messages", protocol: "anthropic-messages", path });
    expect(request.model).toBe("logical-model");
    expect(request.stream).toBe(true);
    expect(request.messages.map((message) => message.role)).toEqual([
      "system", "user", "system", "user", "assistant", "user", "assistant",
    ]);
    expect(request.messages[0]?.content).toHaveLength(2);
    expect(request.messages[1]?.content.map((block) => block.type)).toEqual([
      "text", "image_url", "image_base64", "audio_url", "audio_base64", "document_url", "document_base64", "search_result",
    ]);
    expect(request.messages[2]?.content.map((block) => block.type)).toEqual(["text"]);
    expect(request.messages[4]?.content.map((block) => block.type)).toEqual(["reasoning", "reasoning", "text", "tool_call", "server_tool_call"]);
    expect(request.messages[5]?.content[0]).toMatchObject({ type: "tool_result", toolCallId: "call-1", isError: true });
    expect(request.messages[5]?.content[0]).toHaveProperty("content.1.type", "image_url");
    expect(request.messages[3]?.content[0]).toMatchObject({ type: "text", text: "after" });
    expect(request.messages[1]?.content[0]).toMatchObject({
      type: "text",
      citations: [{ kind: "char_span", raw: { type: "char_location" } }],
    });
    expect(request.messages[1]?.content[0]?.cacheBreakpoint).toEqual({ ttl: "1h" });
    expect(request.tools?.[0]).toMatchObject({ kind: "function", name: "lookup", inputSchema: { type: "object" }, strict: true });
    expect(request.tools?.[1]).toMatchObject({ kind: "server", serverType: "web_search_20250305", name: "web_search" });
    expect(request.tools?.[1]).toHaveProperty("providerParameters.max_uses", 5);
    expect(request.mcpServers).toEqual([{ name: "docs", url: "https://example.test/mcp", authorizationToken: "token-never-retained-in-extension", toolsEnabled: false, allowedTools: ["lookup"] }]);
    expect(request.reasoning).toMatchObject({ mode: "enabled", budgetTokens: 1024, display: "summarized", providerParameters: { future_thinking: null } });
    expect(request.output).toMatchObject({ effort: "max", format: "json_schema", providerParameters: { effort: "xhigh", future_output: null } });
    expect(request.sampling).toMatchObject({ temperature: 0.2, topP: 0.9, topK: 4, stop: ["END"] });
    expect(request.serviceTier).toMatchObject({ tier: "priority" });
    expect(request.metadata).toEqual({ tenant: "demo", explicit: null });
    expect(request.extensions?.protocols?.["anthropic-messages"]?.body).toMatchObject({ future_top_level: { retained: true }, mcp_servers: [{ type: "url" }] });
    expect(request.extensions?.protocols?.["anthropic-messages"]?.body).not.toHaveProperty("mcp_servers.0.authorization_token");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.messages)).toBe(true);
  });

  it("preserves explicit nulls and unknown valid fields", () => {
    const body = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: [{ type: "text", text: "x", unknown: null }] },
      ],
      metadata: null,
      stop_sequences: ["A", "B"],
      unknown_top: null,
    };
    const value = translate(body);
    expect(value.metadata).toBeUndefined();
    expect(value.extensions?.protocols?.["anthropic-messages"]?.body).toMatchObject({
      metadata: null,
      unknown_top: null,
    });
    expect(value.sampling?.stop).toEqual(["A", "B"]);
  });

  it.each([
    [{ max_tokens: 2, messages: [{ role: "user", content: "x" }] }, "invalid_anthropic_messages_request"],
    [{ model: "", max_tokens: 2, messages: [{ role: "user", content: "x" }] }, "invalid_anthropic_messages_request"],
    [{ model: "m", max_tokens: 0, messages: [{ role: "user", content: "x" }] }, "invalid_range"],
    [{ model: "m", max_tokens: 2, messages: [] }, "invalid_messages"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: "x" }], temperature: 2 }, "invalid_range"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: "x" }], top_k: -1 }, "invalid_range"],
    [{ model: "m", max_tokens: 2048, messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 2048 } }, "invalid_range"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: "x" }], stop_sequences: ["A", null] }, "invalid_anthropic_messages_request"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: [{ type: "audio", source: { type: "bad" } }] }] }, "invalid_anthropic_messages_request"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: [{ type: "tool_use", id: "x", name: "f", input: "not-object" }] }] }, "invalid_anthropic_messages_request"],
    [{ model: "m", max_tokens: 2, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "%%%" } }] }] }, "invalid_media"],
  ] as const)("rejects malformed request safely", (body, code) => {
    const error = failure(body, code, 400);
    expect(error.message).not.toContain("model");
  });

  it("rejects missing MCP matches and unsupported semantics before dispatch", () => {
    failure({ model: "m", max_tokens: 2, messages: [{ role: "user", content: "x" }], tools: [{ type: "mcp_toolset", mcp_server_name: "missing" }], mcp_servers: [{ type: "url", name: "docs", url: "https://example.test/mcp" }] }, "invalid_anthropic_messages_request", 400);
    failure({ model: "m", max_tokens: 2, messages: [{ role: "user", content: "x" }], thinking: { type: "unknown" } }, "unsupported_anthropic_messages_feature", 400);
  });

  it("fails closed for hostile prototypes and getters", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "model", { get() { throw new Error("secret getter"); }, enumerable: true });
    hostile["max_tokens"] = 2;
    hostile["messages"] = [{ role: "user", content: "x" }];
    const error = failure(hostile, "invalid_anthropic_messages_request", 400);
    expect(error.message).not.toMatch(/getter|secret/i);
  });

  it("maps safe non-stream response blocks, usage, finish, and policy exposure", () => {
    const translator = family({ exposeReasoningText: true, exposeReasoningSignatures: true, exposeRedactedThinking: true });
    const wire = translator.egress.encodeResponse(response([
      { type: "text", text: "answer", citations: [{ kind: "url", url: "https://example.test/cite", sourceTitle: "C", raw: { type: "web_search_result_location" } }] },
      { type: "reasoning", text: "think", signature: "sig", redactedData: "redacted", encryptedContent: "encrypted" },
      { type: "tool_call", toolCallId: "call-1", name: "lookup", argumentsJson: '{"q":1}' },
      { type: "server_tool_call", toolCallId: "server-1", toolKind: "web_search", name: "web_search", input: { q: "x" } },
    ]), context());
    expect(wire).toMatchObject({ id: "msg_public", type: "message", role: "assistant", model: "logical-model", stop_reason: "end_turn", stop_sequence: null });
    expect((wire as { content: Array<Record<string, unknown>> }).content.map((block) => block["type"])).toEqual(["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use"]);
    expect((wire as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({ text: "answer", citations: [{ type: "web_search_result_location" }] });
    expect((wire as { content: Array<Record<string, unknown>> }).content[3]).toMatchObject({ id: "call-1", name: "lookup", input: { q: 1 } });
    expect(wire).toHaveProperty("usage.input_tokens", 11);
    expect(wire).toHaveProperty("usage.output_tokens", 7);
    expect(wire).toHaveProperty("usage.cache_read_input_tokens", 2);
    expect(wire).toHaveProperty("usage.cache_creation_input_tokens", 7);
    expect(wire).toHaveProperty("usage.cache_creation.ephemeral_5m_input_tokens", 3);
    expect(wire).toHaveProperty("usage.cache_creation.ephemeral_1h_input_tokens", 4);
    expect(wire).toHaveProperty("usage.output_tokens_details.thinking_tokens", 5);
    expect(wire).toHaveProperty("usage.server_tool_use.web_fetch_requests", 2);
    expect(wire).toHaveProperty("usage.server_tool_use.web_search_requests", 1);
    expect(JSON.stringify(wire)).not.toMatch(/provider-private|credential-private|physical-private|never-replay|encrypted/);
  });

  it("does not expose reasoning when policy forbids it", () => {
    const wire = family().egress.encodeResponse(response([{ type: "reasoning", text: "private", signature: "secret-sig", redactedData: "secret-redacted", encryptedContent: "cipher" }, { type: "text", text: "ok" }]), context());
    if (typeof wire !== "object" || wire === null || !("content" in wire)) throw new Error("Expected message content.");
    const content = wire["content"];
    expect(content).toEqual([{ type: "text", text: "ok" }]);
    expect(JSON.stringify(wire)).not.toMatch(/private|secret|cipher/);
  });

  it.each<[CanonicalResponse["choices"][number]["finishReason"], string]>([
    ["stop", "end_turn"], ["max_tokens", "max_tokens"], ["tool_calls", "tool_use"], ["pause_turn", "pause_turn"], ["refusal", "refusal"], ["stop_sequence", "stop_sequence"],
  ])("maps finish reason %s", (finishReason, stopReason) => {
    const value = response([{ type: "text", text: "x" }]);
    value.choices[0] = { index: 0, output: value.choices[0]!.output, finishReason };
    expect((family().egress.encodeResponse(value, context()) as Record<string, unknown>)["stop_reason"]).toBe(stopReason);
  });

  it.each(["content_filter", "incomplete", "cancelled", "error"] as const)("rejects successful response finish %s", (finishReason) => {
    const value = response([{ type: "text", text: "x" }]);
    value.choices[0] = { index: 0, output: value.choices[0]!.output, finishReason };
    expectThrown(() => family().egress.encodeResponse(value, context()), { code: "unsupported_anthropic_messages_feature", status: 500, category: "internal", retryable: false });
  });

  it("encodes byte-exact named SSE lifecycle and never emits DONE", () => {
    const state = createStreamTranslationState();
    const translator = family().egress;
    const streamContext = context(state);
    const records = [
      translator.encodeChunk(start(), streamContext),
      translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 0 }, block: { type: "text" } }, streamContext),
      translator.encodeChunk({ type: "text_delta", address: { outputIndex: 0 }, text: "hello" }, streamContext),
      translator.encodeChunk({ type: "content_block_stop", address: { outputIndex: 0 } }, streamContext),
      translator.encodeChunk(choiceEnd, streamContext),
      translator.encodeChunk(usageChunk, streamContext),
      translator.encodeChunk(end(), streamContext),
    ];
    expect(records[0]).toBe(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "stream_public", type: "message", role: "assistant", content: [], model: "logical-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
    expect(records.map((record) => eventRecords(record).map((event) => event.event))).toEqual([["message_start"], ["content_block_start"], ["content_block_delta"], ["content_block_stop"], [], [], ["message_delta", "message_stop"]]);
    expect(records.slice(1, 4).join("")).toContain('"index":0');
    expect(records.join("")).not.toContain("[DONE]");
    expect(state.terminal).toBe(true);
    expect(state.bytesEmitted).toBe(true);
  });

  it("allocates indexes by full address and suppresses reasoning without gaps", () => {
    const state = createStreamTranslationState();
    const translator = family().egress;
    const streamContext = context(state);
    translator.encodeChunk(start(), streamContext);
    expect(translator.encodeChunk({ type: "content_block_start", address: { choiceIndex: 0, outputIndex: 8, contentIndex: 2 }, block: { type: "reasoning" } }, streamContext)).toBe("");
    const publicStart = translator.encodeChunk({ type: "content_block_start", address: { choiceIndex: 0, outputIndex: 8, contentIndex: 3 }, block: { type: "text" } }, streamContext);
    expect(publicStart).toContain('"index":0');
    expect(translator.encodeChunk({ type: "text_delta", address: { choiceIndex: 0, outputIndex: 8, contentIndex: 3 }, text: "x" }, streamContext)).toContain('"index":0');
  });

  it("encodes reasoning/signature, tool partial JSON, citation, and ping events exactly", () => {
    const state = createStreamTranslationState();
    const translator = family({ exposeReasoningText: true, exposeReasoningSignatures: true }).egress;
    const streamContext = context(state);
    translator.encodeChunk(start(), streamContext);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 0 }, block: { type: "reasoning" } }, streamContext);
    expect(translator.encodeChunk({ type: "reasoning_delta", address: { outputIndex: 0 }, text: "think", signatureDelta: "sig" }, streamContext)).toBe('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n');
    translator.encodeChunk({ type: "content_block_stop", address: { outputIndex: 0 } }, streamContext);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 1 }, block: { type: "tool_call", id: "call-1", name: "lookup" } }, streamContext);
    expect(translator.encodeChunk({ type: "tool_call_delta", address: { outputIndex: 1 }, argumentsDelta: '{"q":' }, streamContext)).toBe('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n');
    translator.encodeChunk({ type: "content_block_stop", address: { outputIndex: 1 } }, streamContext);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 2 }, block: { type: "text" } }, streamContext);
    expect(translator.encodeChunk({ type: "citation_added", address: { outputIndex: 2 }, citation: { kind: "search_result_span", url: "https://example.test/c", raw: { type: "web_search_result_location", url: "https://example.test/c" } } }, streamContext)).toContain('"type":"citations_delta"');
    expect(translator.encodeChunk({ type: "ping" }, streamContext)).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it("rejects missing state, duplicate/out-of-order chunks, and preserves state atomically on oversize", () => {
    const oversized = family({ maxEventBytes: 32 }).egress;
    expectThrown(() => oversized.encodeChunk(start(), context()), { code: "invalid_anthropic_messages_egress", status: 500, retryable: false });
    const state = createStreamTranslationState();
    const streamContext = context(state);
    const translator = family({ maxEventBytes: 256 }).egress;
    translator.encodeChunk(start(), streamContext);
    const before = { terminal: state.terminal, bytesEmitted: state.bytesEmitted, nextBlockIndex: state.nextBlockIndex, open: [...(state.openBlocks ?? [])] };
    expectThrown(() => translator.encodeChunk({ type: "text_delta", address: { outputIndex: 0 }, text: "x" }, streamContext), { code: "invalid_anthropic_messages_egress" });
    expect({ terminal: state.terminal, bytesEmitted: state.bytesEmitted, nextBlockIndex: state.nextBlockIndex, open: [...(state.openBlocks ?? [])] }).toEqual(before);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 0 }, block: { type: "text" } }, streamContext);
    expectThrown(() => translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 0 }, block: { type: "text" } }, streamContext), { code: "invalid_anthropic_messages_egress" });
    expectThrown(() => translator.encodeChunk(end(), streamContext), { code: "invalid_anthropic_messages_egress" });
  });

  it("enforces terminal matrix and typed error closure", () => {
    const state = createStreamTranslationState();
    const translator = family().egress;
    const streamContext = context(state);
    translator.encodeChunk(start(), streamContext);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 0 }, block: { type: "text" } }, streamContext);
    translator.encodeChunk({ type: "content_block_start", address: { outputIndex: 1 }, block: { type: "text" } }, streamContext);
    const error = createGatewayError({ category: "upstream", code: "upstream_failure", message: "Upstream failed.", requestId: REQUEST_ID, status: 502, retryable: true });
    const records = eventRecords(translator.encodeChunk({ type: "error", error }, streamContext));
    expect(records.map((record) => record.event)).toEqual(["error", "content_block_stop", "content_block_stop", "message_delta", "message_stop"]);
    expect(records[0]?.data).toEqual({ type: "error", error: { type: "overloaded_error", message: "Upstream failed." } });
    expect(records[3]?.data).toMatchObject({ delta: { stop_reason: null, stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
    expectThrown(() => translator.encodeChunk({ type: "ping" }, streamContext), { code: "invalid_anthropic_messages_egress" });

    const invalid = context(createStreamTranslationState());
    const invalidTranslator = family().egress;
    expectThrown(() => invalidTranslator.encodeChunk(end(), invalid), { code: "invalid_anthropic_messages_egress" });
    const failed = context(createStreamTranslationState());
    expectThrown(() => invalidTranslator.encodeChunk({ type: "response_end", status: "failed" }, failed), { code: "invalid_anthropic_messages_egress" });
  });

  it("maps typed errors without secrets", () => {
    const translator = family().egress;
    const categories: Array<[GatewayError["category"], string]> = [
      ["validation", "invalid_request_error"],
      ["authentication", "authentication_error"],
      ["authorization", "permission_error"],
      ["rate_limit", "rate_limit_error"],
      ["timeout", "timeout_error"],
      ["upstream", "overloaded_error"],
      ["internal", "api_error"],
    ];
    for (const [category, type] of categories) {
      const value = translator.encodeError(createGatewayError({ category, code: "safe", message: "safe message", requestId: REQUEST_ID, providerId: "private-provider", credentialId: "private-credential" }), context());
      expect(value).toEqual({ type: "error", error: { type, message: "safe message" } });
      expect(JSON.stringify(value)).not.toMatch(/private|authorization|Bearer/);
    }
  });
});
