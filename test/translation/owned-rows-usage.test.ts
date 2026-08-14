/**
 * Owned usage rows: totals, cache/reasoning subdivisions, absence semantics,
 * partial-usage fail-closed rules, and stream usage timing carriers.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { ChatEgressEncoder } from "../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { ChatProviderStreamDecoder, ChatStreamRequestDecoder } from "../../src/translation/codecs/chat/stream.ts";
import { MessagesEgressEncoder } from "../../src/translation/codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import { MessagesProviderStreamDecoder } from "../../src/translation/codecs/messages/stream.ts";
import { ResponsesEgressEncoder } from "../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import { ResponsesProviderStreamDecoder } from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrOutcome } from "../../src/translation/ir.ts";
import { sourceBodyFor } from "./owned-rows-helpers.ts";

test.concurrent("row usage-input-output-total: totals map directly; M input formula and absent total", () => {
  const chatDecoder = new ChatIngressDecoder();
  const messagesEgress = new MessagesEgressEncoder();
  const messagesDecoder = new MessagesIngressDecoder();

  // C usage -> M: input/output preserved, no fabricated total
  const cRes = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "t",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  );
  assert.equal(cRes.ok, true);
  if (cRes.ok) {
    const mBody = messagesEgress.encodeOutcome(cRes.value.irOutcome).body as {
      usage: { input_tokens: number; output_tokens: number; total_tokens?: number };
    };
    assert.equal(mBody.usage.input_tokens, 10);
    assert.equal(mBody.usage.output_tokens, 4);
    assert.equal(mBody.usage.total_tokens, undefined);
  }

  // M usage -> IR: input includes cache read + cache creation; total absent
  const mRes = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "t",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        output_tokens: 4,
      },
    },
  );
  assert.equal(mRes.ok, true);
  if (mRes.ok) {
    assert.equal(mRes.value.irOutcome.usage?.input, 15);
    assert.equal(mRes.value.irOutcome.usage?.cacheReadInput, 3);
    assert.equal(mRes.value.irOutcome.usage?.cacheWriteInput, 2);
    assert.equal(mRes.value.irOutcome.usage?.total, undefined);

    // M egress reconstructs the wire base: input minus cached subdivisions.
    const mEchoBody = messagesEgress.encodeOutcome(mRes.value.irOutcome).body as {
      usage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    assert.equal(mEchoBody.usage.input_tokens, 10);
    assert.equal(mEchoBody.usage.cache_read_input_tokens, 3);
    assert.equal(mEchoBody.usage.cache_creation_input_tokens, 2);
  }
});

test.concurrent("usage-absence: egress omits usage when the IR outcome reports none", () => {
  const outcome: IrOutcome = {
    responseId: "resp_1",
    model: "logical-key",
    parts: [{ type: "text", partId: "p1", text: "Hi" }],
    finish: { reason: "stop" },
  };
  const chatBody = new ChatEgressEncoder().encodeOutcome(outcome).body as Record<string, unknown>;
  const responsesBody = new ResponsesEgressEncoder().encodeOutcome(outcome).body as Record<string, unknown>;
  const messagesBody = new MessagesEgressEncoder().encodeOutcome(outcome).body as Record<string, unknown>;
  assert.equal("usage" in chatBody, false);
  assert.equal("usage" in responsesBody, false);
  assert.equal("usage" in messagesBody, false);

  // Source-level absence: a Chat outcome without a usage field decodes to an
  // IR outcome with no usage, and no client fabricates zeros.
  const decoded = new ChatIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl_n",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    },
  );
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const decodedOutcome = decoded.value.irOutcome;
    assert.equal(decodedOutcome.usage, undefined);
    for (const encoder of [new ChatEgressEncoder(), new ResponsesEgressEncoder(), new MessagesEgressEncoder()]) {
      const body = encoder.encodeOutcome(decodedOutcome).body as Record<string, unknown>;
      assert.equal("usage" in body, false, encoder.constructor.name);
    }
  }
});

test.concurrent("stream-final-usage: final usage arrives on end chunk or usage block; final carriers collapse subdivisions per protocol", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const sessionBundle = coordinator.createStreamSession({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    logicalModel: "logical-key",
    responseId: "resp_u",
    sourceWireOptions: { includeUsage: true },
  });

  const endRes = sessionBundle.clientEncoder.encode({
    type: "response_end",
    responseId: "resp_u",
    finish: { reason: "stop" },
    usage: { input: 12, output: 8, total: 20 },
  });
  assert.equal(endRes.ok, true);
  if (endRes.ok) {
    // Should include terminal chunk, usage chunk, and [DONE]
    assert.equal(endRes.value.length, 3);
    const usageJson = JSON.parse(endRes.value[1]?.data ?? "{}");
    assert.equal(usageJson.usage.prompt_tokens, 12);
    assert.equal(usageJson.usage.completion_tokens, 8);
    assert.equal(usageJson.usage.total_tokens, 20);
  }

  const session = { responseId: "resp_us", model: "logical-key", createPartId: () => "p1" };

  // C provider final usage chunk carries details into response_end.usage.
  const cDecoder = new ChatProviderStreamDecoder(session);
  cDecoder.push({
    event: "response.created-not-used",
    data: '{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  });
  cDecoder.push({
    event: "finish",
    data: '{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  });
  cDecoder.push({
    event: "usage",
    data: '{"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":5}},"service_tier":"default"}',
  });
  const done = cDecoder.push({ event: "done", data: "[DONE]" });
  assert.equal(done.ok, true);
  if (done.ok) {
    const end = done.value.find((e) => e.type === "response_end");
    assert.ok(end !== undefined && end.type === "response_end");
    assert.deepEqual(end.usage, {
      input: 10,
      output: 4,
      total: 14,
      cacheReadInput: 3,
      reasoningOutput: 5,
    });
  }

  // R provider response.completed carries details.
  const rSession = { responseId: "resp_ur", model: "logical-key", createPartId: () => "p1" };
  const rDecoder = new ResponsesProviderStreamDecoder(rSession);
  rDecoder.push({
    event: "response.created",
    data: '{"type":"response.created","response":{"id":"x"},"sequence_number":1}',
  });
  const rCompleted = rDecoder.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_ur",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
        service_tier: "flex",
      },
      sequence_number: 2,
    }),
  });
  assert.equal(rCompleted.ok, true);
  if (rCompleted.ok) {
    const end = rCompleted.value[0];
    assert.ok(end !== undefined && end.type === "response_end");
    assert.deepEqual(end.usage, { input: 10, output: 4, cacheReadInput: 3, reasoningOutput: 5 });
    assert.equal(rDecoder.getOutcomeWireOptions().serviceTier, "flex");
  }

  // M provider cumulative usage collapses with the thinking subdivision.
  const mSession = { responseId: "resp_um", model: "logical-key", createPartId: () => "p1" };
  const mDecoder = new MessagesProviderStreamDecoder(mSession);
  mDecoder.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"m","usage":{"input_tokens":5,"cache_read_input_tokens":3}}}',
  });
  mDecoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4,"cache_creation_input_tokens":2,"output_tokens_details":{"thinking_tokens":5}}}',
  });
  const mStop = mDecoder.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(mStop.ok, true);
  if (mStop.ok) {
    const end = mStop.value[0];
    assert.ok(end !== undefined && end.type === "response_end");
    assert.deepEqual(end.usage, {
      input: 10,
      output: 4,
      cacheReadInput: 3,
      cacheWriteInput: 2,
      reasoningOutput: 5,
    });
  }
});

test.concurrent("messages stream: a seen-but-partial usage record fails closed at message_stop instead of fabricating zero totals", () => {
  const session = { responseId: "resp_pu", model: "logical-key", createPartId: () => "p1" };

  // Usage present but empty: neither billing total was ever reported.
  const emptyUsage = new MessagesProviderStreamDecoder(session);
  emptyUsage.push({ event: "message_start", data: '{"type":"message_start","message":{"id":"msg_1","usage":{}}}' });
  const emptyStop = emptyUsage.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(emptyStop.ok, false);
  if (!emptyStop.ok) {
    assert.match(emptyStop.error.message, /usage\.input_tokens must be a finite number when usage is present/);
  }

  // Input reported on message_start but output never arriving.
  const missingOutput = new MessagesProviderStreamDecoder(session);
  missingOutput.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":7}}}',
  });
  const missingOutputStop = missingOutput.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(missingOutputStop.ok, false);
  if (!missingOutputStop.ok) {
    assert.match(missingOutputStop.error.message, /usage\.output_tokens must be a finite number when usage is present/);
  }

  // No usage records at all stay honest absence: no fabricated totals.
  const noUsage = new MessagesProviderStreamDecoder(session);
  noUsage.push({ event: "message_start", data: '{"type":"message_start","message":{"id":"msg_3"}}' });
  noUsage.push({ event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}' });
  const noUsageStop = noUsage.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(noUsageStop.ok, true);
  if (noUsageStop.ok) {
    const end = noUsageStop.value[0];
    assert.equal(end?.type, "response_end");
    assert.equal("usage" in (end ?? {}), false);
  }
});

// =====================================================================
// Usage accounting (exact fixtures per direction)
// =====================================================================

const CHAT_USAGE_OUTCOME: JsonObject = {
  id: "chatcmpl_u",
  object: "chat.completion",
  created: 1,
  model: "upstream-target",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2, audio_tokens: 9 },
    completion_tokens_details: { reasoning_tokens: 5, audio_tokens: 7 },
  },
};

const RESPONSES_USAGE_BODY: JsonObject = {
  id: "resp_u",
  object: "response",
  status: "completed",
  model: "upstream-target",
  output: [],
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
};

const MESSAGES_USAGE_BODY: JsonObject = {
  id: "msg_u",
  type: "message",
  role: "assistant",
  model: "upstream-target",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 5 },
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 },
  },
};

test.concurrent("rows usage-input-output-total/cache-read/cache-write/reasoning: exact subdivision mapping in every direction", () => {
  const chatDecoder = new ChatIngressDecoder();
  const responsesDecoder = new ResponsesIngressDecoder();
  const messagesDecoder = new MessagesIngressDecoder();
  const chatEgress = new ChatEgressEncoder();
  const responsesEgress = new ResponsesEgressEncoder();
  const messagesEgress = new MessagesEgressEncoder();

  // C origin → R target.
  const cDecode = chatDecoder.decodeOutcome(200, {}, CHAT_USAGE_OUTCOME);
  assert.equal(cDecode.ok, true);
  if (cDecode.ok) {
    const u = cDecode.value.irOutcome.usage;
    assert.deepEqual(u, {
      input: 10,
      output: 4,
      total: 14,
      cacheReadInput: 3,
      cacheWriteInput: 2,
      reasoningOutput: 5,
    });
    const rUsage = (
      responsesEgress.encodeOutcome(cDecode.value.irOutcome, cDecode.value.outcomeWireOptions).body as {
        usage: Record<string, unknown>;
      }
    ).usage;
    assert.deepEqual(rUsage, {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 5 },
    });

    // C origin → M target: reconstruction subtracts cached subdivisions from the total.
    const mUsage = (messagesEgress.encodeOutcome(cDecode.value.irOutcome).body as { usage: Record<string, unknown> })
      .usage;
    assert.deepEqual(mUsage, {
      input_tokens: 5,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 5 },
    });
  }

  // R origin → C target.
  const rDecode = responsesDecoder.decodeOutcome(200, {}, RESPONSES_USAGE_BODY);
  assert.equal(rDecode.ok, true);
  if (rDecode.ok) {
    const cUsage = (
      chatEgress.encodeOutcome(rDecode.value.irOutcome, rDecode.value.outcomeWireOptions).body as {
        usage: Record<string, unknown>;
      }
    ).usage;
    assert.deepEqual(cUsage, {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  }

  // M origin: IR input formula includes caches; total never fabricated.
  const mDecode = messagesDecoder.decodeOutcome(200, {}, MESSAGES_USAGE_BODY);
  assert.equal(mDecode.ok, true);
  if (mDecode.ok) {
    assert.deepEqual(mDecode.value.irOutcome.usage, {
      input: 10,
      output: 4,
      cacheReadInput: 3,
      cacheWriteInput: 2,
      reasoningOutput: 5,
    });
    // The TTL breakdown object is recognized wire detail and stays out of the IR.

    const cUsage = (chatEgress.encodeOutcome(mDecode.value.irOutcome).body as { usage: Record<string, unknown> }).usage;
    assert.deepEqual(cUsage, {
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });

    const mEcho = (messagesEgress.encodeOutcome(mDecode.value.irOutcome).body as { usage: Record<string, unknown> })
      .usage;
    assert.deepEqual(mEcho, {
      input_tokens: 5,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 5 },
    });
  }
});

test.concurrent("subdivision-absence: totals without subdivisions omit every *_tokens_details object from client egresses", () => {
  const decoded = new ChatIngressDecoder().decodeOutcome(200, {}, {
    id: "chatcmpl_sa",
    object: "chat.completion",
    created: 1,
    model: "upstream-target",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  } as JsonObject);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const outcome = decoded.value.irOutcome;
  assert.equal(outcome.usage?.cacheReadInput, undefined);
  assert.equal(outcome.usage?.cacheWriteInput, undefined);
  assert.equal(outcome.usage?.reasoningOutput, undefined);

  const cUsage = (new ChatEgressEncoder().encodeOutcome(outcome).body as { usage: Record<string, unknown> }).usage;
  assert.equal("prompt_tokens_details" in cUsage, false);
  assert.equal("completion_tokens_details" in cUsage, false);

  const rUsage = (new ResponsesEgressEncoder().encodeOutcome(outcome).body as { usage: Record<string, unknown> }).usage;
  assert.equal("input_tokens_details" in rUsage, false);
  assert.equal("output_tokens_details" in rUsage, false);

  const mUsage = (new MessagesEgressEncoder().encodeOutcome(outcome).body as { usage: Record<string, unknown> }).usage;
  assert.equal("output_tokens_details" in mUsage, false);
});

// =====================================================================
// Usage null-policy: explicit null is absence; non-object values fail closed
// =====================================================================

test.concurrent("usage null-policy: explicit null usage is absence on every protocol; non-object usage fails invalid_request", () => {
  const chatBase: JsonObject = {
    id: "chatcmpl_un",
    object: "chat.completion",
    created: 1,
    model: "upstream-target",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };
  const responsesBase: JsonObject = {
    id: "resp_un",
    object: "response",
    status: "completed",
    model: "upstream-target",
    output: [],
  };
  const messagesBase: JsonObject = {
    id: "msg_un",
    type: "message",
    role: "assistant",
    model: "upstream-target",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };

  // Complete outcomes: explicit null is treated as absent (never fabricated zeros).
  const chatNull = new ChatIngressDecoder().decodeOutcome(200, {}, { ...chatBase, usage: null } as JsonObject);
  assert.equal(chatNull.ok, true);
  if (chatNull.ok) {
    assert.equal(chatNull.value.irOutcome.usage, undefined);
    const body = new ChatEgressEncoder().encodeOutcome(chatNull.value.irOutcome).body as Record<string, unknown>;
    assert.equal("usage" in body, false);
  }

  const responsesNull = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    { ...responsesBase, usage: null } as JsonObject,
  );
  assert.equal(responsesNull.ok, true);
  if (responsesNull.ok) assert.equal(responsesNull.value.irOutcome.usage, undefined);

  const messagesNull = new MessagesIngressDecoder().decodeOutcome(
    200,
    {},
    { ...messagesBase, usage: null } as JsonObject,
  );
  assert.equal(messagesNull.ok, true);
  if (messagesNull.ok) assert.equal(messagesNull.value.irOutcome.usage, undefined);

  // Chat stream: a null usage chunk is absence; the terminal event carries none.
  const cStream = new ChatProviderStreamDecoder({ responseId: "resp_sun_c", model: "logical-key", createPartId: () => "p1" });
  cStream.push({
    event: "start",
    data: '{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  });
  cStream.push({
    event: "finish",
    data: '{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  });
  const cUsageNull = cStream.push({
    event: "usage",
    data: '{"object":"chat.completion.chunk","choices":[],"usage":null}',
  });
  assert.equal(cUsageNull.ok, true);
  const cDone = cStream.push({ event: "done", data: "[DONE]" });
  assert.equal(cDone.ok, true);
  if (cDone.ok) {
    const end = cDone.value.find((e) => e.type === "response_end");
    assert.ok(end !== undefined && end.type === "response_end");
    assert.equal("usage" in end, false);
  }

  // Responses stream: response.completed documents usage:null as absence.
  const rStream = new ResponsesProviderStreamDecoder({
    responseId: "resp_sun_r",
    model: "logical-key",
    createPartId: () => "p1",
  });
  rStream.push({
    event: "response.created",
    data: '{"type":"response.created","response":{"id":"resp_sun_r"},"sequence_number":1}',
  });
  const rCompletedNull = rStream.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: { id: "resp_sun_r", status: "completed", usage: null },
      sequence_number: 2,
    }),
  });
  assert.equal(rCompletedNull.ok, true);
  if (rCompletedNull.ok) {
    const end = rCompletedNull.value[0];
    assert.ok(end !== undefined && end.type === "response_end");
    assert.equal("usage" in end, false);
  }

  // M accumulator: a null message_delta record is absent; the message_start
  // record survives untouched into the collapsed final usage.
  const mStream = new MessagesProviderStreamDecoder({
    responseId: "resp_sun_m",
    model: "logical-key",
    createPartId: () => "p1",
  });
  mStream.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"output_tokens":1}}}',
  });
  const mDeltaNull = mStream.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":null}',
  });
  assert.equal(mDeltaNull.ok, true);
  const mStop = mStream.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(mStop.ok, true);
  if (mStop.ok) {
    const end = mStop.value[0];
    assert.ok(end !== undefined && end.type === "response_end");
    assert.deepEqual(end.usage, { input: 3, output: 1 });
  }

  // Non-object usage values are malformed wire on every protocol, never coerced.
  const chatDecoder = new ChatIngressDecoder();
  const responsesDecoder = new ResponsesIngressDecoder();
  const messagesDecoder = new MessagesIngressDecoder();
  for (const usage of ["junk", []] as const) {
    const badChat = chatDecoder.decodeOutcome(200, {}, { ...chatBase, usage } as JsonObject);
    assert.equal(badChat.ok, false, `chat usage=${JSON.stringify(usage)}`);
    if (!badChat.ok) assert.equal(badChat.error.capability, undefined);

    const badResponses = responsesDecoder.decodeOutcome(200, {}, { ...responsesBase, usage } as JsonObject);
    assert.equal(badResponses.ok, false, `responses usage=${JSON.stringify(usage)}`);
    if (!badResponses.ok) assert.equal(badResponses.error.capability, undefined);

    const badMessages = messagesDecoder.decodeOutcome(200, {}, { ...messagesBase, usage } as JsonObject);
    assert.equal(badMessages.ok, false, `messages usage=${JSON.stringify(usage)}`);
    if (!badMessages.ok) assert.equal(badMessages.error.capability, undefined);
  }

  // Stream carriers reject non-object usage identically.
  const cBadStream = new ChatProviderStreamDecoder({
    responseId: "resp_sun_cb",
    model: "logical-key",
    createPartId: () => "p1",
  });
  const cJunk = cBadStream.push({
    event: "usage",
    data: '{"object":"chat.completion.chunk","choices":[],"usage":"junk"}',
  });
  assert.equal(cJunk.ok, false);
  if (!cJunk.ok) assert.equal(cJunk.error.capability, undefined);

  const rBadStream = new ResponsesProviderStreamDecoder({
    responseId: "resp_sun_rb",
    model: "logical-key",
    createPartId: () => "p1",
  });
  rBadStream.push({
    event: "response.created",
    data: '{"type":"response.created","response":{"id":"resp_sun_rb"},"sequence_number":1}',
  });
  const rJunk = rBadStream.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: { id: "resp_sun_rb", status: "completed", usage: "junk" },
      sequence_number: 2,
    }),
  });
  assert.equal(rJunk.ok, false);
  if (!rJunk.ok) assert.equal(rJunk.error.capability, undefined);
});

test.concurrent("usage details wrappers: explicit null details are absence; non-object details fail invalid_request", () => {
  const chatDecoder = new ChatIngressDecoder();
  const responsesDecoder = new ResponsesIngressDecoder();
  const messagesDecoder = new MessagesIngressDecoder();

  // Explicit null wrappers decode to plain totals with no subdivisions.
  const chatNull = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl_dn",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      },
    } as JsonObject,
  );
  assert.equal(chatNull.ok, true);
  if (chatNull.ok) assert.deepEqual(chatNull.value.irOutcome.usage, { input: 10, output: 4, total: 14 });

  const responsesNull = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_dn",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        input_tokens_details: null,
        output_tokens_details: null,
      },
    } as JsonObject,
  );
  assert.equal(responsesNull.ok, true);
  if (responsesNull.ok) assert.deepEqual(responsesNull.value.irOutcome.usage, { input: 10, output: 4, total: 14 });

  const messagesNull = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_dn",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4, output_tokens_details: null },
    } as JsonObject,
  );
  assert.equal(messagesNull.ok, true);
  if (messagesNull.ok) assert.deepEqual(messagesNull.value.irOutcome.usage, { input: 5, output: 4 });

  // Present non-null non-object wrappers are malformed wire.
  const chatJunk = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl_dj",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: "junk" },
    } as JsonObject,
  );
  assert.equal(chatJunk.ok, false);
  if (!chatJunk.ok) assert.equal(chatJunk.error.capability, undefined);

  const responsesJunk = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_dj",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: "junk" },
    } as JsonObject,
  );
  assert.equal(responsesJunk.ok, false);
  if (!responsesJunk.ok) assert.equal(responsesJunk.error.capability, undefined);

  const messagesJunk = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_dj",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4, output_tokens_details: "junk" },
    } as JsonObject,
  );
  assert.equal(messagesJunk.ok, false);
  if (!messagesJunk.ok) assert.equal(messagesJunk.error.capability, undefined);
});

test.concurrent("strict usage parsing: a present-but-partial usage object fails invalid_request instead of fabricating zeros", () => {
  const chatDecoder = new ChatIngressDecoder();
  const chatBase: JsonObject = {
    id: "chatcmpl_su",
    object: "chat.completion",
    created: 1,
    model: "upstream-target",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };
  const badChatUsages: ReadonlyArray<JsonObject> = [
    { prompt_tokens: 10 },
    { prompt_tokens: 10, completion_tokens: Number.NaN },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: Number.NaN },
    { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: "3" } },
    { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: null } },
  ];
  for (const usage of badChatUsages) {
    const res = chatDecoder.decodeOutcome(200, {}, { ...chatBase, usage } as JsonObject);
    assert.equal(res.ok, false, JSON.stringify(usage));
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }

  const responsesDecoder = new ResponsesIngressDecoder();
  const responsesBase: JsonObject = {
    id: "resp_su",
    object: "response",
    status: "completed",
    model: "upstream-target",
    output: [],
  };
  const badResponsesUsages: ReadonlyArray<JsonObject> = [
    { output_tokens: 4 },
    { input_tokens: 10, output_tokens: Number.POSITIVE_INFINITY },
  ];
  for (const usage of badResponsesUsages) {
    const res = responsesDecoder.decodeOutcome(200, {}, { ...responsesBase, usage } as JsonObject);
    assert.equal(res.ok, false, JSON.stringify(usage));
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("chat stream_options.include_usage must be a boolean when present; non-boolean fails invalid_request", () => {
  const res = new ChatStreamRequestDecoder().decodeRequest({
    ...sourceBodyFor("openai-chat"),
    stream: true,
    stream_options: { include_usage: "yes" },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.capability, undefined);
});

test.concurrent("usage explicit zeros: M-reported zero subdivisions survive into IR and client payloads", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const chatEgress = new ChatEgressEncoder();
  const responsesEgress = new ResponsesEgressEncoder();
  const messagesEgress = new MessagesEgressEncoder();

  const zeroCacheBody: JsonObject = {
    id: "msg_zero",
    type: "message",
    role: "assistant",
    model: "upstream-target",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  const decode = messagesDecoder.decodeOutcome(200, {}, zeroCacheBody);
  assert.equal(decode.ok, true);
  if (!decode.ok) return;

  // Absence stays distinct from zero: explicitly reported zeros are observations.
  assert.deepEqual(decode.value.irOutcome.usage, {
    input: 5,
    output: 4,
    cacheReadInput: 0,
    cacheWriteInput: 0,
  });

  const cUsage = (chatEgress.encodeOutcome(decode.value.irOutcome).body as { usage: Record<string, unknown> }).usage;
  assert.deepEqual(cUsage, {
    prompt_tokens: 5,
    completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });

  const rUsage = (responsesEgress.encodeOutcome(decode.value.irOutcome).body as { usage: Record<string, unknown> })
    .usage;
  assert.deepEqual(rUsage, {
    input_tokens: 5,
    output_tokens: 4,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });

  // M echo reconstructs base input (5 - 0 - 0) and echoes the reported zeros.
  const mUsage = (messagesEgress.encodeOutcome(decode.value.irOutcome).body as { usage: Record<string, unknown> })
    .usage;
  assert.deepEqual(mUsage, {
    input_tokens: 5,
    output_tokens: 4,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});
