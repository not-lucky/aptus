import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { estimateCostUsd, type PricingConfig } from "../../src/domain/pricing.ts";
import { createStreamUsageCollector, extractCompleteUsage } from "../../src/routing/usage.ts";

const encoder = new TextEncoder();

const PRICING: PricingConfig = {
  inputUsdPerMillionTokens: "2.50",
  outputUsdPerMillionTokens: "10.00",
  cacheReadUsdPerMillionTokens: "1.25",
  cacheWriteUsdPerMillionTokens: "3.75",
};

test("extractCompleteUsage extracts raw usage and normalized usage across OpenAI and Anthropic", () => {
  // 1. OpenAI Chat
  const chatBody = {
    id: "chat-1",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  const chatResult = extractCompleteUsage("openai-chat", chatBody);
  assert.deepEqual(chatResult.rawUsage, {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });
  assert.deepEqual(chatResult.normalizedUsage, {
    input: 100,
    output: 50,
    total: 150,
    cacheReadInput: undefined,
    cacheWriteInput: undefined,
  });

  // 2. OpenAI with cached tokens
  const chatCachedBody = {
    id: "chat-2",
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 30 },
    },
  };
  const chatCachedResult = extractCompleteUsage("openai-chat", chatCachedBody);
  assert.deepEqual(chatCachedResult.normalizedUsage, {
    input: 70, // 100 - 30 uncached
    output: 50,
    total: 150,
    cacheReadInput: 30,
    cacheWriteInput: undefined,
  });

  // 3. Anthropic Messages with caching
  const anthropicBody = {
    id: "msg-1",
    usage: {
      input_tokens: 300,
      output_tokens: 120,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 100,
    },
  };
  const anthropicResult = extractCompleteUsage("anthropic-messages", anthropicBody);
  assert.deepEqual(anthropicResult.rawUsage, {
    input_tokens: 300,
    output_tokens: 120,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 100,
  });
  assert.deepEqual(anthropicResult.normalizedUsage, {
    input: 300,
    output: 120,
    total: 570,
    cacheReadInput: 100,
    cacheWriteInput: 50,
  });

  // Missing or invalid usage
  assert.deepEqual(extractCompleteUsage("openai-chat", {}), {});
  assert.deepEqual(extractCompleteUsage("openai-chat", { usage: null as any }), {});
});

test("createStreamUsageCollector accumulates chunk usage and validates framing", () => {
  // 1. OpenAI Chat SSE stream
  const openAiCollector = createStreamUsageCollector("openai-chat");
  openAiCollector.feed(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
  openAiCollector.feed(
    encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'),
  );
  openAiCollector.feed(encoder.encode("data: [DONE]\n\n"));

  const openAiResult = openAiCollector.finish();
  assert.equal(openAiResult.hasValidTerminal, true);
  assert.equal(openAiResult.isProviderError, false);
  assert.deepEqual(openAiResult.rawUsage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
  assert.deepEqual(openAiResult.normalizedUsage, {
    input: 10,
    output: 5,
    total: 15,
    cacheReadInput: undefined,
    cacheWriteInput: undefined,
  });

  // 2. Anthropic SSE stream
  const anthropicCollector = createStreamUsageCollector("anthropic-messages");
  anthropicCollector.feed(
    encoder.encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":20}}}\n\n',
    ),
  );
  anthropicCollector.feed(
    encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n'),
  );
  anthropicCollector.feed(
    encoder.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n'),
  );
  anthropicCollector.feed(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));

  const anthropicResult = anthropicCollector.finish();
  assert.equal(anthropicResult.hasValidTerminal, true);
  assert.equal(anthropicResult.isProviderError, false);
  assert.deepEqual(anthropicResult.rawUsage, {
    input_tokens: 40,
    output_tokens: 15,
    cache_read_input_tokens: 20,
  });
  assert.deepEqual(anthropicResult.normalizedUsage, {
    input: 40,
    output: 15,
    total: 75,
    cacheReadInput: 20,
    cacheWriteInput: undefined,
  });

  // 3. Incomplete stream without terminal framing
  const incompleteCollector = createStreamUsageCollector("openai-chat");
  incompleteCollector.feed(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
  const incompleteResult = incompleteCollector.finish();
  assert.equal(incompleteResult.hasValidTerminal, false);
});

test("estimateCostUsd computes exact decimal cost from normalized Usage", () => {
  const usage = {
    input: 1_000_000,
    output: 500_000,
    total: 1_800_000,
    cacheReadInput: 200_000,
    cacheWriteInput: 100_000,
  };

  // 1M * 2.50 = 2.50
  // 0.5M * 10.00 = 5.00
  // 0.2M * 1.25 = 0.25
  // 0.1M * 3.75 = 0.375
  // Total cost = 8.125 USD
  const cost = estimateCostUsd(PRICING, usage);
  assert.equal(cost, "8.125");
});

test("extractCompleteUsage extracts OpenAI Responses usage with cache detail", () => {
  const responsesBody = {
    id: "resp-1",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
  };
  const result = extractCompleteUsage("openai-responses", responsesBody);
  assert.deepEqual(result.rawUsage, responsesBody.usage);
  assert.deepEqual(result.normalizedUsage, {
    input: 60, // 100 - 30 cached - 10 cache-write
    output: 50,
    total: 150,
    cacheReadInput: 30,
    cacheWriteInput: 10,
  });
});

test("createStreamUsageCollector captures Responses usage from response.completed", () => {
  const collector = createStreamUsageCollector("openai-responses");
  collector.feed(
    encoder.encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"input_tokens_details":{"cached_tokens":30}}}}',
    ),
  );

  const result = collector.finish();
  assert.equal(result.hasValidTerminal, true);
  assert.equal(result.isProviderError, false);
  assert.deepEqual(result.normalizedUsage, {
    input: 70,
    output: 50,
    total: 150,
    cacheReadInput: 30,
    cacheWriteInput: undefined,
  });
});

test("oversized or deeply nested raw usage is omitted and suppresses cost", () => {
  // Exceeds the 16 KiB byte bound.
  const oversized = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    huge: "x".repeat(20 * 1024),
  };
  assert.deepEqual(extractCompleteUsage("openai-chat", { usage: oversized }), {});

  // Exceeds the nesting-depth bound.
  let deep: JsonObject = { prompt_tokens: 10, completion_tokens: 5 };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.deepEqual(extractCompleteUsage("openai-chat", { usage: deep }), {});
});
