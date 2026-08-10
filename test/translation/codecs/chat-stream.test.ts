import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ChatClientStreamEncoder,
  ChatProviderStreamDecoder,
  ChatStreamRequestDecoder,
  ChatStreamRequestEncoder,
} from "../../../src/translation/codecs/chat/stream.ts";
import type { StreamSession } from "../../../src/translation/contracts.ts";
import type { IrStreamEvent } from "../../../src/translation/ir.ts";

const session: StreamSession = {
  responseId: "resp_123",
  model: "gpt-main",
  createPartId: () => "p_1",
};

test.concurrent("chat stream request: decodes and encodes stream options", () => {
  const decoder = new ChatStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "gpt-main",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.irRequest.delivery, "stream");
    assert.equal(res.value.sourceWireOptions.includeUsage, true);

    const encoder = new ChatStreamRequestEncoder();
    const encoded = encoder.encodeRequest(res.value.irRequest, "upstream-gpt", res.value.sourceWireOptions);
    assert.equal(encoded.model, "upstream-gpt");
    assert.equal(encoded.stream, true);
    assert.deepEqual(encoded.stream_options, { include_usage: true, include_obfuscation: false });
  }
});

test.concurrent("chat stream decoder: decodes chunks, usage, and [DONE]", () => {
  const decoder = new ChatProviderStreamDecoder(session);

  const chunk1 = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 100,
    model: "upstream",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello " }, finish_reason: null }],
  };
  const res1 = decoder.push({ data: JSON.stringify(chunk1) });
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.value.length, 3); // response_start, part_start, text_delta
    assert.equal(res1.value[0]?.type, "response_start");
    assert.equal(res1.value[1]?.type, "part_start");
    assert.equal(res1.value[2]?.type, "text_delta");
  }

  const chunk2 = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 100,
    model: "upstream",
    choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }],
  };
  const res2 = decoder.push({ data: JSON.stringify(chunk2) });
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.value.length, 2); // text_delta, part_end
    assert.equal(res2.value[0]?.type, "text_delta");
    assert.equal(res2.value[1]?.type, "part_end");
  }

  const usageChunk = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 100,
    model: "upstream",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  const res3 = decoder.push({ data: JSON.stringify(usageChunk) });
  assert.equal(res3.ok, true);
  if (res3.ok) {
    assert.equal(res3.value.length, 0);
  }

  const doneChunk = { data: "[DONE]" };
  const res4 = decoder.push(doneChunk);
  assert.equal(res4.ok, true);
  if (res4.ok) {
    assert.equal(res4.value.length, 1);
    assert.equal(res4.value[0]?.type, "response_end");
    if (res4.value[0]?.type === "response_end") {
      assert.equal(res4.value[0].finish.reason, "stop");
      assert.deepEqual(res4.value[0].usage, { input: 5, output: 3, total: 8 });
    }
  }

  assert.equal(decoder.finish().ok, true);
});

test.concurrent("chat stream encoder: encodes clean frames and usage only when requested", () => {
  const encoder = new ChatClientStreamEncoder(session, { includeUsage: true }, () => 1700000000);

  const startEvt: IrStreamEvent = { type: "response_start", responseId: "resp_123", model: "gpt-main" };
  const deltaEvt: IrStreamEvent = { type: "text_delta", responseId: "resp_123", partId: "p1", text: "Hello" };
  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "stop" },
    usage: { input: 5, output: 3, total: 8 },
  };

  const f1 = encoder.encode(startEvt);
  assert.equal(f1.ok, true);
  if (f1.ok) {
    const chunk = JSON.parse(f1.value[0]?.data ?? "{}");
    assert.equal(chunk.id, "chatcmpl-resp_123");
    assert.equal(chunk.choices[0]?.delta.role, "assistant");
  }

  const f2 = encoder.encode(deltaEvt);
  assert.equal(f2.ok, true);
  if (f2.ok) {
    const chunk = JSON.parse(f2.value[0]?.data ?? "{}");
    assert.equal(chunk.choices[0]?.delta.content, "Hello");
  }

  const f3 = encoder.encode(endEvt);
  assert.equal(f3.ok, true);
  if (f3.ok) {
    assert.equal(f3.value.length, 3); // finish chunk, usage chunk, [DONE]
    const finishChunk = JSON.parse(f3.value[0]?.data ?? "{}");
    assert.equal(finishChunk.choices[0]?.finish_reason, "stop");

    const usageChunk = JSON.parse(f3.value[1]?.data ?? "{}");
    assert.equal(usageChunk.choices.length, 0);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });

    assert.equal(f3.value[2]?.data, "[DONE]");
  }
});
