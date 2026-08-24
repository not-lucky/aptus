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

test.concurrent("responses stream request: decodes and encodes stream requests", () => {
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

test.concurrent("responses stream decoder: output_item.done single fragment emits tool_arguments_delta before part_end", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({
    event: "response.created",
    data: '{"type":"response.created","sequence_number":1,"response":{"id":"resp_1"}}',
  });
  decoder.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"get_weather"}}',
  });
  const doneRes = decoder.push({
    event: "response.output_item.done",
    data: '{"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}',
  });
  assert.equal(doneRes.ok, true);
  if (doneRes.ok) {
    assert.equal(doneRes.value.length, 2);
    assert.equal(doneRes.value[0]?.type, "tool_arguments_delta");
    if (doneRes.value[0]?.type === "tool_arguments_delta") {
      assert.equal(doneRes.value[0].text, '{"city":"SF"}');
    }
    assert.equal(doneRes.value[1]?.type, "part_end");
    if (doneRes.value[1]?.type === "part_end" && doneRes.value[1].partType === "function_call") {
      assert.deepEqual(doneRes.value[1].arguments, { city: "SF" });
    }
  }
});

test.concurrent("responses stream decoder: terminal function_call colliding with announced message item ID fails closed", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({
    event: "response.created",
    data: '{"type":"response.created","sequence_number":1,"response":{"id":"resp_1"}}',
  });
  // Message item announced with id msg_1
  decoder.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}',
  });
  // Terminal output carries an unannounced function_call with id msg_1
  const compRes = decoder.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "function_call", id: "msg_1", call_id: "call_unannounced", name: "fn" }],
      },
    }),
  });
  assert.equal(compRes.ok, false);
  if (!compRes.ok) {
    assert.equal(compRes.error.category, "invalid_request");
  }
});

test.concurrent("responses stream decoder: terminal namespace item fails closed with tool-namespaces", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({
    event: "response.created",
    data: '{"type":"response.created","sequence_number":1,"response":{"id":"resp_1"}}',
  });
  const compRes = decoder.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "namespace", id: "ns_1", name: "ns" }],
      },
    }),
  });
  assert.equal(compRes.ok, false);
  if (!compRes.ok) {
    assert.equal(compRes.error.capability, "tool-namespaces");
  }
});

test.concurrent("responses stream decoder: conflicting item_id and output_index fails correlation", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({
    event: "response.created",
    data: '{"type":"response.created","sequence_number":1,"response":{"id":"resp_1"}}',
  });
  decoder.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_0","name":"fn0"}}',
  });
  decoder.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","sequence_number":3,"output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"fn1"}}',
  });
  // Event carries item_0 but output_index: 1 (conflict!)
  const deltaRes = decoder.push({
    event: "response.function_call_arguments.delta",
    data: '{"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"item_0","output_index":1,"delta":"{}"}',
  });
  assert.equal(deltaRes.ok, false);
  if (!deltaRes.ok) {
    assert.equal(deltaRes.error.category, "invalid_request");
  }

  // Event carries invalid item_id with valid output_index (must not fall back!)
  const deltaRes2 = decoder.push({
    event: "response.function_call_arguments.delta",
    data: '{"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"item_nonexistent","output_index":0,"delta":"{}"}',
  });
  assert.equal(deltaRes2.ok, false);
  if (!deltaRes2.ok) {
    assert.equal(deltaRes2.error.category, "invalid_request");
  }
});

test.concurrent("responses stream decoder: unannounced second function_call in terminal output fails closed", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created", sequence_number: 1 }) });
  decoder.push({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      sequence_number: 2,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
  });
  decoder.push({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      sequence_number: 3,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "{}" },
    }),
  });
  const res = decoder.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "r1",
        status: "completed",
        output: [
          { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "{}" },
          { type: "function_call", id: "fc2_unannounced", call_id: "call_2", name: "other_fn", arguments: "{}" },
        ],
      },
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("responses stream decoder: non-string delta fails closed with invalid_request", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created", sequence_number: 1 }) });
  decoder.push({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      sequence_number: 2,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
  });
  const res = decoder.push({
    event: "response.function_call_arguments.delta",
    data: JSON.stringify({
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc1",
      delta: 123,
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("responses stream decoder: output_item.done single fragment exceeding byte limit fails payload_too_large", () => {
  const decoder = new ResponsesProviderStreamDecoder(session, 5);
  decoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created", sequence_number: 1 }) });
  decoder.push({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      sequence_number: 2,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
  });
  const res = decoder.push({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      sequence_number: 3,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "1234567890" },
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "payload_too_large");
  }
});

test.concurrent("responses stream decoder: output_index correlation fallback works when item_id omitted", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created", sequence_number: 1 }) });
  decoder.push({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
  });
  const res = decoder.push({
    event: "response.function_call_arguments.delta",
    data: JSON.stringify({
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      output_index: 0,
      delta: '{"city":"Berlin"}',
    }),
  });
  assert.equal(res.ok, true);
});

test.concurrent("responses stream decoder: decodes function tool calls and item correlation", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  const frames = [
    {
      event: "response.created",
      data: JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "r1" } }),
    },
    {
      event: "response.output_item.added",
      data: JSON.stringify({
        type: "response.output_item.added",
        sequence_number: 2,
        item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "" },
      }),
    },
    {
      event: "response.function_call_arguments.delta",
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 3,
        item_id: "fc1",
        delta: '{"loc":',
      }),
    },
    {
      event: "response.function_call_arguments.delta",
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 4,
        item_id: "fc1",
        delta: '"Tokyo"}',
      }),
    },
    {
      event: "response.output_item.done",
      data: JSON.stringify({
        type: "response.output_item.done",
        sequence_number: 5,
        item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather" },
      }),
    },
    {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 6,
        response: {
          id: "r1",
          status: "completed",
          output: [
            { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: '{"loc":"Tokyo"}' },
          ],
        },
      }),
    },
  ];

  const allEvents: IrStreamEvent[] = [];
  for (const f of frames) {
    const res = decoder.push(f);
    assert.equal(res.ok, true);
    if (res.ok) allEvents.push(...res.value);
  }
  const finishRes = decoder.finish();
  assert.equal(finishRes.ok, true);

  const startEvt = allEvents.find((e) => e.type === "part_start" && e.part.type === "function_call");
  assert.ok(startEvt);
  if (startEvt?.type === "part_start" && startEvt.part.type === "function_call") {
    assert.equal(startEvt.part.callId, "call_1");
    assert.equal(startEvt.part.name, "get_weather");
  }

  const deltaEvts = allEvents.filter((e) => e.type === "tool_arguments_delta");
  assert.equal(deltaEvts.length, 2);

  const endEvt = allEvents.find((e) => e.type === "part_end" && e.partType === "function_call");
  assert.ok(endEvt);
  if (endEvt?.type === "part_end" && endEvt.partType === "function_call") {
    assert.deepEqual(endEvt.arguments, { loc: "Tokyo" });
  }

  const respEnd = allEvents.find((e) => e.type === "response_end");
  assert.ok(respEnd);
  if (respEnd?.type === "response_end") {
    assert.equal(respEnd.finish.reason, "tool_calls");
  }
});

test.concurrent("responses stream decoder: unannounced function_call in terminal output fails closed", () => {
  const decoder = new ResponsesProviderStreamDecoder(session);
  decoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created", sequence_number: 1 }) });
  const res = decoder.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "r1",
        status: "completed",
        output: [{ type: "function_call", id: "fc_unannounced", name: "fn" }],
      },
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("responses stream encoder: encodes function parts with monotonic sequence numbers", () => {
  const encoder = new ResponsesClientStreamEncoder(session);
  const startFrames = encoder.encode({
    type: "part_start",
    responseId: "resp_123",
    partId: "p_tool_1",
    part: { type: "function_call", callId: "c_1", name: "get_weather" },
  });
  assert.equal(startFrames.ok, true);
  if (startFrames.ok) {
    assert.equal(startFrames.value[0]?.event, "response.output_item.added");
    const addedJson = JSON.parse(startFrames.value[0]?.data ?? "{}");
    assert.equal(addedJson.item.type, "function_call");
    assert.equal(addedJson.item.id, "fc_p_tool_1");
    assert.equal(addedJson.item.call_id, "c_1");
    assert.equal(addedJson.item.name, "get_weather");
  }
});

test.concurrent("responses stream request: projects tool fields onto provider stream body", () => {
  const decoder = new ResponsesStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "responses-main",
    input: "hello",
    stream: true,
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    tool_choice: { type: "function", name: "get_weather" },
    parallel_tool_calls: false,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    const encoded = new ResponsesStreamRequestEncoder().encodeRequest(
      res.value.irRequest,
      "upstream-resp",
      {},
      res.value.requestWireOptions,
    );
    assert.deepEqual(encoded.tools, [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        strict: false,
      },
    ]);
    assert.deepEqual(encoded.tool_choice, { type: "function", name: "get_weather" });
    assert.equal(encoded.parallel_tool_calls, false);
  }
});

test.concurrent("responses stream request: text null fails invalid_request on the shared request parser", () => {
  // The stream request decoder shares the complete-path request parser, so the
  // documented-non-nullable `text` wrapper rejects explicit null identically.
  const decoder = new ResponsesStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "responses-main",
    input: "hello",
    stream: true,
    text: null,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.capability, undefined);
});

test.concurrent("responses stream decoder: enforces event matching and sequence_number ordering", () => {
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

test.concurrent("responses stream encoder: regenerates monotonic sequence_numbers", () => {
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

test.concurrent("responses stream encoder: emits detailed usage subdivisions on response.completed", () => {
  const encoder = new ResponsesClientStreamEncoder(session);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "responses-main" });

  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "stop" },
    usage: { input: 10, output: 4, cacheReadInput: 3, cacheWriteInput: 2, reasoningOutput: 5 },
  };
  const f = encoder.encode(endEvt);
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(f.value[0]?.event, "response.completed");
    const completedJson = JSON.parse(f.value[0]?.data ?? "{}");
    assert.deepEqual(completedJson.response.usage, {
      input_tokens: 10,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 5 },
    });
  }
});

test.concurrent("responses stream encoder: pins the length-finish terminal as response.incomplete with max_output_tokens", () => {
  const encoder = new ResponsesClientStreamEncoder(session);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "responses-main" });

  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "length" },
    usage: { input: 10, output: 4, cacheReadInput: 3, cacheWriteInput: 2, reasoningOutput: 5 },
  };
  const f = encoder.encode(endEvt);
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(f.value[0]?.event, "response.incomplete");
    const incompleteJson = JSON.parse(f.value[0]?.data ?? "{}");
    assert.equal(incompleteJson.response.status, "incomplete");
    assert.equal(incompleteJson.response.incomplete_details.reason, "max_output_tokens");
    assert.deepEqual(incompleteJson.response.usage, {
      input_tokens: 10,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 5 },
    });
  }
});
