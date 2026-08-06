import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatEgressEncoder } from "../../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../../src/translation/codecs/chat/ingress.ts";


test("translation codec chat: decodes and encodes request", () => {
  const decoder = new ChatIngressDecoder();
  const encoder = new ChatEgressEncoder();

  const chatBody = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello!" },
    ],
  };

  const decodeRes = decoder.decodeRequest(chatBody);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const ir = decodeRes.value;
    assert.equal(ir.model, "gpt-4o");
    assert.equal(ir.items.length, 2);

    const encoded = encoder.encodeRequest(ir, "gpt-4o-target");
    assert.equal(encoded.model, "gpt-4o-target");
    assert.deepEqual(encoded.messages, [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello!" },
    ]);
  }
});

test("translation codec chat: rejects unknown request field", () => {
  const decoder = new ChatIngressDecoder();
  const chatBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello!" }],
    unknown_custom_field: "invalid",
  };

  const decodeRes = decoder.decodeRequest(chatBody);
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.equal(decodeRes.error.capability, "unknown-request-field");
  }
});

test("translation codec chat: rejects parallel_tool_calls fail-closed", () => {
  const decoder = new ChatIngressDecoder();
  const decodeRes = decoder.decodeRequest({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello!" }],
    parallel_tool_calls: false,
  });
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.equal(decodeRes.error.capability, "parallel-tool-calls");
  }
});

test("translation codec chat: rejects n other than 1 with multiple-candidates", () => {
  const decoder = new ChatIngressDecoder();
  for (const n of [0, 2, "2"]) {
    const decodeRes = decoder.decodeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      n,
    });
    assert.equal(decodeRes.ok, false, `n=${String(n)} must fail closed`);
    if (!decodeRes.ok) {
      assert.equal(decodeRes.error.capability, "multiple-candidates");
    }
  }
});

test("translation codec chat: decodes and encodes outcome", () => {
  const decoder = new ChatIngressDecoder();
  const encoder = new ChatEgressEncoder();

  const chatResponse = {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1775606400,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello! How can I assist you?",
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
    },
  };

  const decodeRes = decoder.decodeOutcome(200, {}, chatResponse);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const outcome = decodeRes.value;
    assert.equal(outcome.finish.reason, "stop");
    assert.equal(outcome.usage?.total, 18);

    const encoded = encoder.encodeOutcome(outcome);
    assert.equal(encoded.status, 200);
    const body = encoded.body as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { prompt_tokens: number } };
    assert.equal(body.choices[0]?.message.content, "Hello! How can I assist you?");
    assert.equal(body.choices[0]?.finish_reason, "stop");
    assert.equal(body.usage.prompt_tokens, 10);
  }
});
