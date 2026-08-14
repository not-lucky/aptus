import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
  MessagesStreamRequestDecoder,
  MessagesStreamRequestEncoder,
} from "../../../src/translation/codecs/messages/stream.ts";
import type { StreamSession } from "../../../src/translation/contracts.ts";
import type { IrStreamEvent } from "../../../src/translation/ir.ts";

const session: StreamSession = {
  responseId: "resp_123",
  model: "claude-main",
  createPartId: () => "p_1",
};

test.concurrent("messages stream request: decodes max_tokens and encodes messages", () => {
  const decoder = new MessagesStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "claude-main",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.irRequest.delivery, "stream");
    const encoder = new MessagesStreamRequestEncoder();
    const encoded = encoder.encodeRequest(res.value.irRequest, "upstream-claude", {});
    assert.equal(encoded.model, "upstream-claude");
    assert.equal(encoded.stream, true);
  }
});

test.concurrent("messages stream decoder: consumes ping and aggregates cumulative usage", () => {
  const decoder = new MessagesProviderStreamDecoder(session);

  const r1 = decoder.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":5}}}',
  });
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.value[0]?.type, "response_start");
  }

  const rPing = decoder.push({ event: "ping", data: '{"type":"ping"}' });
  assert.equal(rPing.ok, true);
  if (rPing.ok) {
    assert.equal(rPing.value.length, 0);
  }

  const r2 = decoder.push({
    event: "content_block_start",
    data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  });
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.value[0]?.type, "part_start");
  }

  const r3 = decoder.push({
    event: "content_block_delta",
    data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
  });
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.value[0]?.type, "text_delta");
  }

  const r4 = decoder.push({
    event: "content_block_stop",
    data: '{"type":"content_block_stop","index":0}',
  });
  assert.equal(r4.ok, true);
  if (r4.ok) {
    assert.equal(r4.value[0]?.type, "part_end");
  }

  const r5 = decoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8,"cache_creation_input_tokens":2}}',
  });
  assert.equal(r5.ok, true);
  if (r5.ok) {
    assert.equal(r5.value.length, 0);
  }

  const r6 = decoder.push({
    event: "message_stop",
    data: '{"type":"message_stop"}',
  });
  assert.equal(r6.ok, true);
  if (r6.ok) {
    assert.equal(r6.value.length, 1);
    assert.equal(r6.value[0]?.type, "response_end");
    if (r6.value[0]?.type === "response_end") {
      assert.equal(r6.value[0].finish.reason, "stop");
      // Collapse cumulative usage: input 10 + cache_read 5 + cache_creation 2 = 17
      // input tokens; cache subdivisions ride as observations on the totals.
      assert.deepEqual(r6.value[0].usage, { input: 17, output: 8, cacheReadInput: 5, cacheWriteInput: 2 });
    }
  }

  assert.equal(decoder.finish().ok, true);
});

test.concurrent("messages stream decoder: collapses cumulative message_delta usage instead of summing", () => {
  const decoder = new MessagesProviderStreamDecoder(session);

  decoder.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}',
  });
  decoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":8}}',
  });
  const stop = decoder.push({ event: "message_stop", data: '{"type":"message_stop"}' });

  assert.equal(stop.ok, true);
  if (stop.ok) {
    const end = stop.value[0];
    assert.equal(end?.type, "response_end");
    if (end?.type === "response_end") {
      // message_delta usage is cumulative, so the final value must win (10 + 5 = 15),
      // not be re-added to message_start (which would double to 30).
      assert.deepEqual(end.usage, { input: 15, output: 8, cacheReadInput: 5 });
    }
  }
});

test.concurrent("messages stream encoder: encodes canonical named sequence with message_delta usage carrier", () => {
  const encoder = new MessagesClientStreamEncoder(session);

  const startEvt: IrStreamEvent = { type: "response_start", responseId: "resp_123", model: "claude-main" };
  const partStartEvt: IrStreamEvent = {
    type: "part_start",
    responseId: "resp_123",
    partId: "p1",
    part: { type: "text" },
  };
  const deltaEvt: IrStreamEvent = { type: "text_delta", responseId: "resp_123", partId: "p1", text: "Hello" };
  const partEndEvt: IrStreamEvent = {
    type: "part_end",
    responseId: "resp_123",
    partId: "p1",
    partType: "text",
  };
  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "length" },
    usage: { input: 17, output: 8 },
  };

  const f1 = encoder.encode(startEvt);
  assert.equal(f1.ok, true);
  const f2 = encoder.encode(partStartEvt);
  assert.equal(f2.ok, true);
  const f3 = encoder.encode(deltaEvt);
  assert.equal(f3.ok, true);
  const f4 = encoder.encode(partEndEvt);
  assert.equal(f4.ok, true);
  const f5 = encoder.encode(endEvt);
  assert.equal(f5.ok, true);

  assert.equal(f1.value![0]?.event, "message_start");
  assert.equal(f2.value![0]?.event, "content_block_start");
  assert.equal(f3.value![0]?.event, "content_block_delta");
  assert.equal(f4.value![0]?.event, "content_block_stop");
  assert.equal(f5.value![0]?.event, "message_delta");
  assert.equal(f5.value![1]?.event, "message_stop");

  const msgDeltaJson = JSON.parse(f5.value![0]?.data ?? "{}");
  assert.equal(msgDeltaJson.delta.stop_reason, "max_tokens");
  assert.deepEqual(msgDeltaJson.usage, { input_tokens: 17, output_tokens: 8 });
});

test.concurrent("messages stream encoder: reconstructs input_tokens from cache subdivisions and emits thinking_tokens", () => {
  const encoder = new MessagesClientStreamEncoder(session);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "claude-main" });

  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "stop" },
    usage: { input: 10, output: 4, cacheReadInput: 3, cacheWriteInput: 2, reasoningOutput: 5 },
  };
  const f = encoder.encode(endEvt);
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(f.value[0]?.event, "message_delta");
    const msgDeltaJson = JSON.parse(f.value[0]?.data ?? "{}");
    // input_tokens = input - cacheReadInput - cacheWriteInput = 10 - 3 - 2 = 5;
    // thinking_tokens rides under output_tokens_details as an observation.
    assert.deepEqual(msgDeltaJson.usage, {
      input_tokens: 5,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 5 },
    });
  }
});

test.concurrent("messages stream decoder: usage.inference_geo on message_start or message_delta fails closed", () => {
  // Output-side discovery on message_start: no success terminator may follow.
  const startDecoder = new MessagesProviderStreamDecoder(session);
  const startRes = startDecoder.push({
    event: "message_start",
    data:
      '{"type":"message_start","message":{"id":"msg_geo","type":"message","role":"assistant","content":[],"model":"claude","usage":{"input_tokens":10,"output_tokens":1,"inference_geo":"global"}}}',
  });
  assert.equal(startRes.ok, false);
  if (!startRes.ok) assert.equal(startRes.error.capability, "inference-geography");

  // Output-side discovery on message_delta: same fail-closed row.
  const deltaDecoder = new MessagesProviderStreamDecoder(session);
  deltaDecoder.push({
    event: "message_start",
    data:
      '{"type":"message_start","message":{"id":"msg_geo","type":"message","role":"assistant","content":[],"model":"claude","usage":{"input_tokens":10,"output_tokens":1}}}',
  });
  const deltaRes = deltaDecoder.push({
    event: "message_delta",
    data:
      '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8,"inference_geo":"global"}}',
  });
  assert.equal(deltaRes.ok, false);
  if (!deltaRes.ok) assert.equal(deltaRes.error.capability, "inference-geography");
});

test.concurrent("messages stream encoder: tracks monotonic part indices across multiple stream parts", () => {
  const encoder = new MessagesClientStreamEncoder(session);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "claude-main" });

  const p1Start = encoder.encode({ type: "part_start", responseId: "resp_123", partId: "part_a", part: { type: "text" } });
  const p1Delta = encoder.encode({ type: "text_delta", responseId: "resp_123", partId: "part_a", text: "Part 1" });
  const p1End = encoder.encode({ type: "part_end", responseId: "resp_123", partId: "part_a", partType: "text" });

  const p2Start = encoder.encode({ type: "part_start", responseId: "resp_123", partId: "part_b", part: { type: "text" } });
  const p2Delta = encoder.encode({ type: "text_delta", responseId: "resp_123", partId: "part_b", text: "Part 2" });
  const p2End = encoder.encode({ type: "part_end", responseId: "resp_123", partId: "part_b", partType: "text" });

  assert.equal(p1Start.ok, true);
  assert.equal(p1Delta.ok, true);
  assert.equal(p1End.ok, true);
  assert.equal(p2Start.ok, true);
  assert.equal(p2Delta.ok, true);
  assert.equal(p2End.ok, true);

  if (p1Start.ok && p1Delta.ok && p1End.ok && p2Start.ok && p2Delta.ok && p2End.ok) {
    assert.equal(JSON.parse(p1Start.value[0]!.data).index, 0);
    assert.equal(JSON.parse(p1Delta.value[0]!.data).index, 0);
    assert.equal(JSON.parse(p1End.value[0]!.data).index, 0);

    assert.equal(JSON.parse(p2Start.value[0]!.data).index, 1);
    assert.equal(JSON.parse(p2Delta.value[0]!.data).index, 1);
    assert.equal(JSON.parse(p2End.value[0]!.data).index, 1);
  }
});

