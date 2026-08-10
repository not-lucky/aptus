import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
  ResponsesStreamRequestDecoder,
  ResponsesStreamRequestEncoder,
} from "../../../src/translation/codecs/responses/stream.ts";
import type { StreamSession } from "../../../src/translation/contracts.ts";
import type { IrStreamEvent } from "../../../src/translation/ir.ts";

const session: StreamSession = {
  responseId: "resp_123",
  model: "responses-main",
  createPartId: () => "p_1",
};

test("responses stream request: decodes and encodes stream requests", () => {
  const decoder = new ResponsesStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "responses-main",
    input: "hello",
    stream: true,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.irRequest.delivery, "stream");
    const encoder = new ResponsesStreamRequestEncoder();
    const encoded = encoder.encodeRequest(res.value.irRequest, "upstream-resp", {});
    assert.equal(encoded.model, "upstream-resp");
    assert.equal(encoded.stream, true);
  }
});

test("responses stream decoder: enforces event matching and sequence_number ordering", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);

  // Missing event
  const resNoEvent = decoder.push({ data: '{"type":"response.created"}' });
  assert.equal(resNoEvent.ok, false);

  // Event mismatch
  const resMismatch = decoder.push({
    event: "response.created",
    data: '{"type":"response.in_progress","sequence_number":1}',
  });
  assert.equal(resMismatch.ok, false);

  // Normal lifecycle
  const dec2 = new ResponsesProviderStreamDecoder(session);
  const r1 = dec2.push({
    event: "response.created",
    data: '{"type":"response.created","response":{"id":"r1"},"sequence_number":1}',
  });
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.value[0]?.type, "response_start");
  }

  const r2 = dec2.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","item":{"type":"message","id":"m1"},"sequence_number":2}',
  });
  assert.equal(r2.ok, true);

  const r3 = dec2.push({
    event: "response.content_part.added",
    data: '{"type":"response.content_part.added","part":{"type":"output_text","text":""},"sequence_number":3}',
  });
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.value[0]?.type, "part_start");
  }

  const r4 = dec2.push({
    event: "response.output_text.delta",
    data: '{"type":"response.output_text.delta","delta":"Hi","sequence_number":4}',
  });
  assert.equal(r4.ok, true);
  if (r4.ok) {
    assert.equal(r4.value[0]?.type, "text_delta");
  }

  const r5 = dec2.push({
    event: "response.output_text.done",
    data: '{"type":"response.output_text.done","sequence_number":5}',
  });
  assert.equal(r5.ok, true);
  if (r5.ok) {
    assert.equal(r5.value[0]?.type, "part_end");
  }

  const r6 = dec2.push({
    event: "response.completed",
    data: '{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":4}},"sequence_number":6}',
  });
  assert.equal(r6.ok, true);
  if (r6.ok) {
    assert.equal(r6.value[0]?.type, "response_end");
  }

  assert.equal(dec2.finish().ok, true);
});

test("responses stream encoder: regenerates monotonic sequence_numbers", () => {
  const encoder = new ResponsesClientStreamEncoder(session);

  const startEvt: IrStreamEvent = { type: "response_start", responseId: "resp_123", model: "responses-main" };
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
    finish: { reason: "stop" },
    usage: { input: 10, output: 4 },
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

  const allFrames = [...f1.value!, ...f2.value!, ...f3.value!, ...f4.value!, ...f5.value!];
  let lastSeq = 0;
  for (const frame of allFrames) {
    const json = JSON.parse(frame.data);
    assert.ok(typeof json.sequence_number === "number");
    assert.equal(json.sequence_number, lastSeq + 1);
    lastSeq = json.sequence_number;
    assert.equal(frame.event, json.type);
  }
});
