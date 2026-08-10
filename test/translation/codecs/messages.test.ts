import assert from "node:assert/strict";
import { test } from "vitest";
import { MessagesEgressEncoder } from "../../../src/translation/codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "../../../src/translation/codecs/messages/ingress.ts";
import type { IrRequest } from "../../../src/translation/ir.ts";

test.concurrent("translation codec messages: decodes and encodes request", () => {
  const decoder = new MessagesIngressDecoder();
  const encoder = new MessagesEgressEncoder();

  const messagesBody = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    system: "You are helpful.",
    messages: [{ role: "user", content: "Hello Messages!" }],
  };

  const decodeRes = decoder.decodeRequest(messagesBody);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const ir = decodeRes.value;
    assert.equal(ir.model, "claude-3-7-sonnet");
    assert.equal(ir.items.length, 2);

    const encoded = encoder.encodeRequest(ir, "claude-3-7-sonnet-target");
    assert.equal(encoded.model, "claude-3-7-sonnet-target");
    const system = encoded.system as Array<{ type: string; text: string }>;
    assert.equal(system[0]?.text, "You are helpful.");
    const messages = encoded.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content[0]?.text, "Hello Messages!");
  }
});

test.concurrent("translation codec messages: rejects mid_conv_system role as mid-conversation-instruction", () => {
  const decoder = new MessagesIngressDecoder();
  const decodeRes = decoder.decodeRequest({
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: [{ role: "mid_conv_system", content: "Mid-conversation instruction" }],
  });
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.equal(decodeRes.error.capability, "mid-conversation-instruction");
  }
});

test.concurrent("translation codec messages: rejects output_config as structured-json-schema", () => {
  const decoder = new MessagesIngressDecoder();
  const decodeRes = decoder.decodeRequest({
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello!" }],
    output_config: { format: { type: "json_schema" } },
  });
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.equal(decodeRes.error.capability, "structured-json-schema");
  }
});

test.concurrent("translation codec messages: merges consecutive same-role turns into Messages", () => {
  const encoder = new MessagesEgressEncoder();

  const ir: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Turn 1. " }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Turn 2." }],
      },
    ],
  };

  const encoded = encoder.encodeRequest(ir, "claude-3-7-sonnet");
  const messages = encoded.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content.length, 2);
  assert.equal(messages[0]?.content[0]?.text, "Turn 1. ");
  assert.equal(messages[0]?.content[1]?.text, "Turn 2.");
});

test.concurrent("translation codec messages: decodes and encodes outcome", () => {
  const decoder = new MessagesIngressDecoder();
  const encoder = new MessagesEgressEncoder();

  const messagesResponse = {
    id: "msg_12345",
    type: "message",
    role: "assistant",
    model: "claude-3-7-sonnet",
    content: [{ type: "text", text: "Hello from Claude!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 20,
      output_tokens: 15,
    },
  };

  const decodeRes = decoder.decodeOutcome(200, {}, messagesResponse);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const outcome = decodeRes.value;
    assert.equal(outcome.finish.reason, "stop");
    assert.equal(outcome.usage?.input, 20);
    assert.equal(outcome.usage?.output, 15);
    assert.equal(outcome.usage?.total, undefined);

    const encoded = encoder.encodeOutcome(outcome);
    assert.equal(encoded.status, 200);
    const body = encoded.body as { id: string; type: string; content: Array<{ text: string }>; stop_reason: string; usage: { input_tokens: number } };
    assert.equal(body.id, "msg_12345");
    assert.equal(body.type, "message");
    assert.equal(body.content[0]?.text, "Hello from Claude!");
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.input_tokens, 20);
  }
});
