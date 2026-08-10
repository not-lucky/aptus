import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject, Protocol } from "../../src/domain/contracts.ts";
import { ChatEgressEncoder } from "../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { MessagesEgressEncoder } from "../../src/translation/codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import { ResponsesEgressEncoder } from "../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import type { Direction, TranslationCoordinator } from "../../src/translation/contracts.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrOutcome, IrRequest } from "../../src/translation/ir.ts";
import { preflightOutcome, preflightRequest } from "../../src/translation/preflight.ts";

/**
 * One direction/tier test per owned plain-text complete capability row.
 * Directions use the fixed [C→R, C→M, R→C, R→M, M→C, M→R] order.
 */
const ALL_DIRECTIONS: ReadonlyArray<readonly [Protocol, Protocol]> = [
  ["openai-chat", "openai-responses"],
  ["openai-chat", "anthropic-messages"],
  ["openai-responses", "openai-chat"],
  ["openai-responses", "anthropic-messages"],
  ["anthropic-messages", "openai-chat"],
  ["anthropic-messages", "openai-responses"],
];

function sourceBodyFor(protocol: Protocol): JsonObject {
  if (protocol === "openai-chat") {
    return { model: "wire-model", messages: [{ role: "user", content: "Hello!" }] };
  }
  if (protocol === "openai-responses") {
    return { model: "wire-model", input: "Hello!" };
  }
  return { model: "wire-model", max_tokens: 1024, messages: [{ role: "user", content: "Hello!" }] };
}

function translateRequest(coordinator: TranslationCoordinator, source: Protocol, target: Protocol, body: JsonObject) {
  return coordinator.translateCompleteRequest({
    sourceProtocol: source,
    targetProtocol: target,
    sourceBody: body,
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: target === "anthropic-messages" ? 2048 : undefined,
  });
}

test.concurrent("row logical-model-selection: logical key resolves to target model and never leaks the wire model", () => {
  const coordinator = createDefaultTranslationCoordinator();
  for (const [source, target] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator, source, target, sourceBodyFor(source));
    assert.equal(res.ok, true, `${source}->${target}`);
    if (res.ok) {
      assert.equal(res.value.irRequest.model, "logical-key");
      assert.equal(res.value.body.model, "upstream-target");
    }
  }
});

test.concurrent("rows single-text-turn / text-content: one user text turn translates in all six directions", () => {
  const coordinator = createDefaultTranslationCoordinator();
  for (const [source, target] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator, source, target, sourceBodyFor(source));
    assert.equal(res.ok, true, `${source}->${target}`);
    if (res.ok) {
      const first = res.value.irRequest.items[0];
      assert.equal(first?.type, "message", `${source}->${target}`);
      if (first?.type === "message") {
        assert.equal(first.role, "user");
      }
    }
  }
});

test.concurrent("row multi-turn-text: alternating turns pass through C↔R unchanged and merge into M", () => {
  const chat = new ChatIngressDecoder();
  const chatBody = {
    model: "m",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Tell me more" },
    ],
  };
  const decodeRes = chat.decodeRequest(chatBody);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const encoded = new ResponsesEgressEncoder().encodeRequest(decodeRes.value, "t");
    const input = encoded.input as Array<{ role: string }>;
    assert.deepEqual(
      input.map((i) => i.role),
      ["user", "assistant", "user"],
    );
  }

  // Into M: consecutive same-role turns merge; alternating turns are preserved
  const ir: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "A" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "B" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "C" }] },
    ],
  };
  const encodedM = new MessagesEgressEncoder().encodeRequest(ir, "t");
  const messages = encodedM.messages as Array<{ role: string; content: Array<{ text: string }> }>;
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.deepEqual(
    messages[0]?.content.map((c) => c.text),
    ["A", "B"],
  );
});

test.concurrent("row anthropic-turn-merging: adjacency alone never rejects and merging is deterministic", () => {
  const ir: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "A" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "B" }] },
    ],
  };
  const preflight = preflightRequest(ir, "openai-chat->anthropic-messages");
  assert.equal(preflight.ok, true);

  const encoded = new MessagesEgressEncoder().encodeRequest(ir, "t");
  const messages = encoded.messages as Array<{ role: string; content: Array<{ text: string }> }>;
  assert.equal(messages.length, 1);
  assert.deepEqual(
    messages[0]?.content.map((c) => c.text),
    ["A", "B"],
  );
});

test.concurrent("row assistant-prefill: final assistant prefill translates in all six directions", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const prefillBodies: Record<Protocol, JsonObject> = {
    "openai-chat": {
      model: "m",
      messages: [
        { role: "user", content: "Count to three." },
        { role: "assistant", content: "1, 2" },
      ],
    },
    "openai-responses": {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Count to three." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "1, 2" }] },
      ],
    },
    "anthropic-messages": {
      model: "m",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Count to three." },
        { role: "assistant", content: "1, 2" },
      ],
    },
  };

  for (const [source, target] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator, source, target, prefillBodies[source]);
    assert.equal(res.ok, true, `${source}->${target}`);
    if (res.ok) {
      const assistant = res.value.irRequest.items.find((item) => item.type === "message" && item.role === "assistant");
      assert.ok(assistant, `${source}->${target} must preserve the assistant prefill`);
    }
  }
});

test.concurrent("row system-instruction: system instruction maps to C system, R system item, M system block", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    model: "m",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ],
  };

  const toM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatBody);
  assert.equal(toM.ok, true);
  if (toM.ok) {
    const system = (toM.value.body as { system: Array<{ text: string }> }).system;
    assert.deepEqual(
      system.map((b) => b.text),
      ["You are helpful."],
    );
  }

  const toR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(toR.ok, true);
  if (toR.ok) {
    const input = toR.value.body.input as Array<{ role: string; content: Array<{ text: string }> }>;
    assert.equal(input[0]?.role, "system");
    assert.equal(input[0]?.content[0]?.text, "You are helpful.");
  }
});

test.concurrent("row developer-instruction: C↔R direct; into M collapses advisory; M-origin directions reject", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    model: "m",
    messages: [
      { role: "developer", content: "Do X." },
      { role: "user", content: "Hi" },
    ],
  };

  // C -> R: developer authority preserved
  const toR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(toR.ok, true);
  if (toR.ok) {
    const input = toR.value.body.input as Array<{ role: string }>;
    assert.equal(input[0]?.role, "developer");
  }

  // C -> M: advisory developer collapses into ordered system blocks
  const toM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatBody);
  assert.equal(toM.ok, true);
  if (toM.ok) {
    const system = (toM.value.body as { system: Array<{ text: string }> }).system;
    assert.deepEqual(
      system.map((b) => b.text),
      ["Do X."],
    );
  }

  // M-origin directions are T3: an IR developer instruction rejects before dispatch
  const ir: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [
      { type: "instruction", authority: "developer", separation: "advisory", text: "Do X." },
      { type: "message", role: "user", content: [{ type: "text", text: "Hi" }] },
    ],
  };
  for (const dir of ["anthropic-messages->openai-chat", "anthropic-messages->openai-responses"] as const) {
    const res = preflightRequest(ir, dir);
    assert.equal(res.ok, false, dir);
    if (!res.ok) {
      assert.equal(res.error.capability, "developer-instruction");
    }
  }
});

test.concurrent("row mixed-instruction-authority: C↔R preserves order and authority; into M collapses all-advisory; required rejects", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    model: "m",
    messages: [
      { role: "system", content: "S" },
      { role: "developer", content: "D" },
      { role: "user", content: "Hi" },
    ],
  };

  const toR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(toR.ok, true);
  if (toR.ok) {
    const input = toR.value.body.input as Array<{ role: string }>;
    assert.deepEqual(
      input.map((i) => i.role),
      ["system", "developer", "user"],
    );
  }

  const toM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatBody);
  assert.equal(toM.ok, true);
  if (toM.ok) {
    const system = (toM.value.body as { system: Array<{ text: string }> }).system;
    assert.deepEqual(
      system.map((b) => b.text),
      ["S", "D"],
    );
  }

  // Required separation into M fails closed
  const requiredIr: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [
      { type: "instruction", authority: "system", separation: "required", text: "S" },
      { type: "message", role: "user", content: [{ type: "text", text: "Hi" }] },
    ],
  };
  const res = preflightRequest(requiredIr, "openai-chat->anthropic-messages");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "mixed-instruction-authority");
  }
});

test.concurrent("row mid-conversation-instruction: C→R preserves it; every M-bound direction rejects", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    model: "m",
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: "Remember the rules." },
      { role: "user", content: "What were they?" },
    ],
  };

  const toR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(toR.ok, true);
  if (toR.ok) {
    const input = toR.value.body.input as Array<{ role: string }>;
    assert.deepEqual(
      input.map((i) => i.role),
      ["user", "system", "user"],
    );
  }

  const toM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatBody);
  assert.equal(toM.ok, false);
  if (!toM.ok) {
    assert.equal(toM.error.capability, "mid-conversation-instruction");
  }
});

test.concurrent("row message-name: Chat message name attribution rejects as unsupported", () => {
  const decoder = new ChatIngressDecoder();
  const res = decoder.decodeRequest({
    model: "m",
    messages: [{ role: "user", name: "alice", content: "Hi" }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "message-name");
  }
});

test.concurrent("row responses-message-phase: Responses phase/status input items reject as unsupported", () => {
  const decoder = new ResponsesIngressDecoder();
  const res = decoder.decodeRequest({
    model: "m",
    input: [{ type: "message", role: "user", phase: "completed", content: [{ type: "input_text", text: "Hi" }] }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "responses-message-phase");
  }
});

test.concurrent("row multiple-candidates: Chat n>1 rejects before dispatch", () => {
  const decoder = new ChatIngressDecoder();
  const res = decoder.decodeRequest({
    model: "m",
    messages: [{ role: "user", content: "Hi" }],
    n: 2,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "multiple-candidates");
  }
});

test.concurrent("rows single-completed-output / response-envelope-synthesis: one synthesized target-native envelope per outcome", () => {
  const chatDecoder = new ChatIngressDecoder();
  const responsesEgress = new ResponsesEgressEncoder();
  const chatOutcome = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  );
  assert.equal(chatOutcome.ok, true);
  if (chatOutcome.ok) {
    const encoded = responsesEgress.encodeOutcome(chatOutcome.value);
    const body = encoded.body as {
      object: string;
      id: string;
      status: string;
      output: Array<{ id: string; role: string }>;
    };
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.output.length, 1);
    assert.equal(body.output[0]?.role, "assistant");
  }
});

test.concurrent("row ordered-output-parts: multi-part outcomes preserve semantic order", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const chatEgress = new ChatEgressEncoder();
  const res = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [
        { type: "text", text: "First. " },
        { type: "text", text: "Second." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 4 },
    },
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(
      res.value.parts.map((p) => (p.type === "text" ? p.text : "")),
      ["First. ", "Second."],
    );
    const encoded = chatEgress.encodeOutcome(res.value);
    const body = encoded.body as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "First. Second.");
  }
});

test.concurrent("row finish-natural: stop maps to C stop / R completed / M end_turn", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const responsesEgress = new ResponsesEgressEncoder();
  const chatEgress = new ChatEgressEncoder();

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
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(mRes.ok, true);
  if (mRes.ok) {
    assert.equal(mRes.value.finish.reason, "stop");
    const rBody = responsesEgress.encodeOutcome(mRes.value).body as { status: string };
    assert.equal(rBody.status, "completed");
    const cBody = chatEgress.encodeOutcome(mRes.value).body as { choices: Array<{ finish_reason: string }> };
    assert.equal(cBody.choices[0]?.finish_reason, "stop");
  }
});

test.concurrent("row finish-length: length maps to C length / R incomplete max_output_tokens / M max_tokens", () => {
  const chatDecoder = new ChatIngressDecoder();
  const responsesEgress = new ResponsesEgressEncoder();
  const messagesEgress = new MessagesEgressEncoder();
  const chatEgress = new ChatEgressEncoder();

  // C length -> R incomplete with max_output_tokens detail and M max_tokens
  const cRes = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "t",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  );
  assert.equal(cRes.ok, true);
  if (cRes.ok) {
    assert.equal(cRes.value.finish.reason, "length");
    const rBody = responsesEgress.encodeOutcome(cRes.value).body as {
      status: string;
      incomplete_details?: { reason: string };
    };
    assert.equal(rBody.status, "incomplete");
    assert.equal(rBody.incomplete_details?.reason, "max_output_tokens");
    const mBody = messagesEgress.encodeOutcome(cRes.value).body as { stop_reason: string };
    assert.equal(mBody.stop_reason, "max_tokens");
  }

  // R incomplete max_output_tokens -> C length
  const rDecoder = new ResponsesIngressDecoder();
  const rRes = rDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_1",
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      model: "t",
      output: [
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  );
  assert.equal(rRes.ok, true);
  if (rRes.ok) {
    assert.equal(rRes.value.finish.reason, "length");
    const cBody = chatEgress.encodeOutcome(rRes.value).body as { choices: Array<{ finish_reason: string }> };
    assert.equal(cBody.choices[0]?.finish_reason, "length");
  }
});

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
    const mBody = messagesEgress.encodeOutcome(cRes.value).body as {
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
    assert.equal(mRes.value.usage?.input, 15);
    assert.equal(mRes.value.usage?.cacheReadInput, 3);
    assert.equal(mRes.value.usage?.cacheWriteInput, 2);
    assert.equal(mRes.value.usage?.total, undefined);
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
});

test.concurrent("preflight outcome: non-plain-text outcome discoveries terminate fail-closed with matrix capability IDs", () => {
  const base = {
    responseId: "resp_1",
    model: "logical-key",
    parts: [{ type: "text" as const, partId: "p1", text: "Hi" }],
  };
  const cases: ReadonlyArray<readonly [IrOutcome, string, Direction]> = [
    [{ ...base, finish: { reason: "tool_calls" } }, "finish-tool-calls", "openai-chat->openai-responses"],
    [{ ...base, finish: { reason: "refusal" } }, "refusal-content", "openai-chat->openai-responses"],
    [{ ...base, finish: { reason: "content_filter" } }, "finish-content-filter", "openai-chat->openai-responses"],
    [{ ...base, finish: { reason: "context_limit" } }, "finish-context-limit", "anthropic-messages->openai-chat"],
    [{ ...base, finish: { reason: "other" } }, "finish-other-unknown", "openai-chat->openai-responses"],
    [
      {
        ...base,
        finish: { reason: "stop" },
        parts: [
          { type: "tool_call", partId: "p1", call: { type: "function", callId: "c1", name: "f", argumentsText: "{}" } },
        ],
      },
      "function-tool-definition",
      "openai-chat->openai-responses",
    ],
  ];
  for (const [outcome, capability, direction] of cases) {
    const res = preflightOutcome(outcome, direction);
    assert.equal(res.ok, false, capability);
    if (!res.ok) {
      assert.equal(res.error.capability, capability);
    }
  }
});

test.concurrent("row semantic-stream-lifecycle: streaming lifecycle translates across all six directions", () => {
  const coordinator = createDefaultTranslationCoordinator();
  for (const [source, target] of ALL_DIRECTIONS) {
    const body = { ...sourceBodyFor(source), stream: true };
    const res = coordinator.translateStreamRequest({
      sourceProtocol: source,
      targetProtocol: target,
      sourceBody: body,
      logicalModel: "logical-key",
      targetModel: "upstream-target",
      targetDefaultMaxTokens: target === "anthropic-messages" ? 2048 : undefined,
    });
    assert.equal(res.ok, true, `${source}->${target}`);
    if (res.ok) {
      assert.equal(res.value.irRequest.delivery, "stream");
      assert.equal(res.value.body.stream, true);
    }
  }
});

test.concurrent("row text-stream-delta: text delta frames encode and decode correctly across all codecs", () => {
  const coordinator = createDefaultTranslationCoordinator();
  for (const [source, target] of ALL_DIRECTIONS) {
    const sessionBundle = coordinator.createStreamSession({
      sourceProtocol: source,
      targetProtocol: target,
      logicalModel: "logical-key",
      responseId: "resp_test",
    });

    const events = [
      { type: "response_start" as const, responseId: "resp_test", model: "logical-key" },
      { type: "part_start" as const, responseId: "resp_test", partId: "p1", part: { type: "text" as const } },
      { type: "text_delta" as const, responseId: "resp_test", partId: "p1", text: "Hello stream" },
      { type: "part_end" as const, responseId: "resp_test", partId: "p1", partType: "text" as const },
      { type: "response_end" as const, responseId: "resp_test", finish: { reason: "stop" as const } },
    ];

    for (const evt of events) {
      const encodeRes = sessionBundle.clientEncoder.encode(evt);
      assert.equal(encodeRes.ok, true, `${source}->${target}`);
    }
  }
});

test.concurrent("row stream-final-usage: final usage arrives on end chunk or usage block", () => {
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
});

test.concurrent("row sse-named-events: Responses and Messages emit named SSE events", () => {
  const coordinator = createDefaultTranslationCoordinator();

  const respSession = coordinator.createStreamSession({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    logicalModel: "logical-key",
    responseId: "resp_named",
  });
  const respFrames = respSession.clientEncoder.encode({
    type: "response_start",
    responseId: "resp_named",
    model: "logical-key",
  });
  assert.equal(respFrames.ok, true);
  if (respFrames.ok) {
    assert.equal(respFrames.value[0]?.event, "response.created");
  }

  const msgSession = coordinator.createStreamSession({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    logicalModel: "logical-key",
    responseId: "resp_named",
  });
  const msgFrames = msgSession.clientEncoder.encode({
    type: "response_start",
    responseId: "resp_named",
    model: "logical-key",
  });
  assert.equal(msgFrames.ok, true);
  if (msgFrames.ok) {
    assert.equal(msgFrames.value[0]?.event, "message_start");
  }
});

test.concurrent("row chat-done-sentinel: Chat decoder requires [DONE] and encoder emits [DONE]", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const sessionBundle = coordinator.createStreamSession({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    logicalModel: "logical-key",
    responseId: "resp_done",
  });

  const endFrames = sessionBundle.clientEncoder.encode({
    type: "response_end",
    responseId: "resp_done",
    finish: { reason: "stop" },
  });
  assert.equal(endFrames.ok, true);
  if (endFrames.ok) {
    const lastFrame = endFrames.value[endFrames.value.length - 1];
    assert.equal(lastFrame?.data, "[DONE]");
  }
});

test.concurrent("row responses-sequence-number: Responses encoder generates strictly monotonic sequence numbers", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const sessionBundle = coordinator.createStreamSession({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    logicalModel: "logical-key",
    responseId: "resp_seq",
  });

  const f1 = sessionBundle.clientEncoder.encode({
    type: "response_start",
    responseId: "resp_seq",
    model: "logical-key",
  });
  const f2 = sessionBundle.clientEncoder.encode({
    type: "text_delta",
    responseId: "resp_seq",
    partId: "p1",
    text: "hi",
  });

  assert.equal(f1.ok && f2.ok, true);
  if (f1.ok && f2.ok) {
    const seq1 = JSON.parse(f1.value[0]?.data ?? "{}").sequence_number;
    const seq2 = JSON.parse(f1.value[1]?.data ?? "{}").sequence_number;
    const seq3 = JSON.parse(f2.value[0]?.data ?? "{}").sequence_number;
    assert.equal(seq1, 1);
    assert.equal(seq2, 2);
    assert.equal(seq3, 3);
  }
});

test.concurrent("row messages-ping: Messages decoder safely consumes ping keepalive frames", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const sessionBundle = coordinator.createStreamSession({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    logicalModel: "logical-key",
    responseId: "resp_ping",
  });

  const pingRes = sessionBundle.providerDecoder.push({ event: "ping", data: '{"type":"ping"}' });
  assert.equal(pingRes.ok, true);
  if (pingRes.ok) {
    assert.equal(pingRes.value.length, 0);
  }
});

test.concurrent("row stream-obfuscation: request decoder accepts include_obfuscation and encoder sets false on provider", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const res = coordinator.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    sourceBody: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_obfuscation: false },
    },
    logicalModel: "logical-key",
    targetModel: "upstream-target",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    const streamOpts = (res.value.body as Record<string, unknown>).stream_options as Record<string, unknown>;
    assert.equal(streamOpts.include_obfuscation, false);
  }
});
