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

test.concurrent("chat stream decoder: duplicate tool_call id across different indices fails closed", () => {
  const decoder = new ChatProviderStreamDecoder(session);
  const chunk1 = decoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 100,
      model: "upstream",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_dup", type: "function", function: { name: "fn1", arguments: "{}" } }],
          },
        },
      ],
    }),
  });
  assert.equal(chunk1.ok, true);

  const chunk2 = decoder.push({
    data: JSON.stringify({
      id: "c2",
      object: "chat.completion.chunk",
      created: 101,
      model: "upstream",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, id: "call_dup", type: "function", function: { name: "fn2", arguments: "{}" } }],
          },
        },
      ],
    }),
  });
  assert.equal(chunk2.ok, false);
  if (!chunk2.ok) {
    assert.equal(chunk2.error.category, "invalid_request");
  }
});

test.concurrent("chat stream decoder: unrecognized extra keys on tool_calls or function fail closed", () => {
  const decoder = new ChatProviderStreamDecoder(session);
  const extraKeyChunk = decoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 100,
      model: "upstream",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "fn1", arguments: "{}" },
                extra_field: true,
              },
            ],
          },
        },
      ],
    }),
  });
  assert.equal(extraKeyChunk.ok, false);
  if (!extraKeyChunk.ok) {
    assert.equal(extraKeyChunk.error.category, "invalid_request");
  }
});

test.concurrent("chat stream decoder: malformed choices and tool_calls fail closed without uncaught exceptions", () => {
  const decoder = new ChatProviderStreamDecoder(session);

  // choices with null element
  const resNullChoice = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [null],
    }),
  });
  assert.equal(resNullChoice.ok, false);
  if (!resNullChoice.ok) {
    assert.equal(resNullChoice.error.category, "invalid_request");
  }

  // tool_calls with null element
  const resNullToolCall = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { tool_calls: [null] } }],
    }),
  });
  assert.equal(resNullToolCall.ok, false);
  if (!resNullToolCall.ok) {
    assert.equal(resNullToolCall.error.category, "invalid_request");
  }

  // tool_call with null function object on new index
  const resNullFn = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: null }] } }],
    }),
  });
  assert.equal(resNullFn.ok, false);
  if (!resNullFn.ok) {
    assert.equal(resNullFn.error.category, "invalid_request");
  }

  // tool_call with non-string arguments
  const resNonStringArgs = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: 123 } }] } },
      ],
    }),
  });
  assert.equal(resNonStringArgs.ok, false);
  if (!resNonStringArgs.ok) {
    assert.equal(resNonStringArgs.error.category, "invalid_request");
  }

  // non-object chunk
  const resNonObject = decoder.push({
    data: JSON.stringify("not an object"),
  });
  assert.equal(resNonObject.ok, false);
  if (!resNonObject.ok) {
    assert.equal(resNonObject.error.category, "invalid_request");
  }

  // non-object in-band error
  const resNonObjectErr = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [],
      error: "string error instead of object",
    }),
  });
  assert.equal(resNonObjectErr.ok, false);
  if (!resNonObjectErr.ok) {
    assert.equal(resNonObjectErr.error.category, "invalid_request");
  }
});

test.concurrent("chat stream decoder: decodes multi-tool interleaved deltas and finish_reason tool_calls", () => {
  const decoder = new ChatProviderStreamDecoder(session);
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant" } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"loc":' } },
              { index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"SF"}' } },
              { index: 1, function: { arguments: '"PST"}' } },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];

  const allEvents: IrStreamEvent[] = [];
  for (const f of frames) {
    const res = decoder.push({
      data: JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 100,
        model: "upstream",
        ...f,
      }),
    });
    assert.equal(res.ok, true);
    if (res.ok) allEvents.push(...res.value);
  }

  const doneRes = decoder.push({ data: "[DONE]" });
  assert.equal(doneRes.ok, true);
  if (doneRes.ok) allEvents.push(...doneRes.value);

  assert.equal(allEvents.filter((e) => e.type === "part_start" && e.part.type === "function_call").length, 2);
  const deltaEvents = allEvents.filter((e) => e.type === "tool_arguments_delta");
  assert.equal(deltaEvents.length, 4);
  const endEvents = allEvents.filter((e) => e.type === "part_end" && e.partType === "function_call");
  assert.equal(endEvents.length, 2);
  if (endEvents[0]?.type === "part_end" && endEvents[0].partType === "function_call") {
    assert.deepEqual(endEvents[0].arguments, { loc: "SF" });
  }
  if (endEvents[1]?.type === "part_end" && endEvents[1].partType === "function_call") {
    assert.deepEqual(endEvents[1].arguments, { tz: "PST" });
  }
  const respEnd = allEvents.find((e) => e.type === "response_end");
  assert.ok(respEnd);
  if (respEnd?.type === "response_end") {
    assert.equal(respEnd.finish.reason, "tool_calls");
  }
});

test.concurrent("chat stream decoder: rejects custom tool calls with custom-tool-streaming", () => {
  const decoder = new ChatProviderStreamDecoder(session);
  const res = decoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 100,
      model: "upstream",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c1", type: "custom", function: { name: "custom_fn", arguments: "{}" } }],
          },
        },
      ],
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "custom-tool-streaming");
  }
});

test.concurrent("chat stream decoder: enforces maxArgumentBytes on tool arguments buffer", () => {
  const decoder = new ChatProviderStreamDecoder(session, 10);
  const res = decoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 100,
      model: "upstream",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "fn", arguments: "12345678901" } }],
          },
        },
      ],
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "payload_too_large");
  }
});

test.concurrent("chat stream request: projects tool fields onto provider stream body", () => {
  const decoder = new ChatStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "gpt-main",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
    parallel_tool_calls: false,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    const encoded = new ChatStreamRequestEncoder().encodeRequest(
      res.value.irRequest,
      "upstream-gpt",
      res.value.sourceWireOptions,
      res.value.requestWireOptions,
    );
    assert.deepEqual(encoded.tools, [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    ]);
    assert.deepEqual(encoded.tool_choice, { type: "function", function: { name: "get_weather" } });
    assert.equal(encoded.parallel_tool_calls, false);
  }
});

test.concurrent("chat stream request: stream_options null is treated as absent (include_usage off)", () => {
  // An explicit null wrapper is absence on the request side: decode succeeds
  // and usage inclusion stays off instead of failing closed.
  const decoder = new ChatStreamRequestDecoder();
  const res = decoder.decodeRequest({
    model: "gpt-main",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: null,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.irRequest.delivery, "stream");
    assert.equal(res.value.sourceWireOptions.includeUsage, false);
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

test.concurrent("chat stream encoder: emits detailed usage subdivisions only when include_usage is on", () => {
  const endEvt: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "stop" },
    usage: { input: 10, output: 4, cacheReadInput: 3, cacheWriteInput: 2, reasoningOutput: 5 },
  };

  const encoder = new ChatClientStreamEncoder(session, { includeUsage: true }, () => 1700000000);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "gpt-main" });
  const f = encoder.encode(endEvt);
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(f.value.length, 3); // finish chunk, usage chunk, [DONE]
    const usageChunk = JSON.parse(f.value[1]?.data ?? "{}");
    assert.equal(usageChunk.choices.length, 0);
    assert.deepEqual(usageChunk.usage, {
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  }

  // With include_usage off, no usage chunk is emitted even when usage is present.
  const gatedEncoder = new ChatClientStreamEncoder(session, {}, () => 1700000000);
  gatedEncoder.encode({ type: "response_start", responseId: "resp_123", model: "gpt-main" });
  const gated = gatedEncoder.encode(endEvt);
  assert.equal(gated.ok, true);
  if (gated.ok) {
    assert.equal(gated.value.length, 2); // finish chunk, [DONE]
    for (const frame of gated.value) {
      if (frame.data !== "[DONE]") {
        assert.equal(JSON.parse(frame.data).usage, undefined);
      }
    }
  }
});

test.concurrent("chat stream encoder: emits no final usage chunk when the provider never reported usage", () => {
  // The provider never sent a terminal usage chunk, so response_end carries no
  // usage; include_usage=true must not synthesize a zeroed final chunk.
  const endWithoutUsage: IrStreamEvent = {
    type: "response_end",
    responseId: "resp_123",
    finish: { reason: "stop" },
  };

  const encoder = new ChatClientStreamEncoder(session, { includeUsage: true }, () => 1700000000);
  encoder.encode({ type: "response_start", responseId: "resp_123", model: "gpt-main" });
  const f = encoder.encode(endWithoutUsage);
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(f.value.length, 2); // finish chunk, [DONE] — no usage chunk
    const finishChunk = JSON.parse(f.value[0]?.data ?? "{}");
    assert.equal(finishChunk.choices[0]?.finish_reason, "stop");
    assert.equal("usage" in finishChunk, false);
    assert.equal(f.value[1]?.data, "[DONE]");
  }

  // Full decoder→encoder parity: a provider stream with include_usage requested
  // but no usage chunk produces the same no-usage client framing.
  const decoder = new ChatProviderStreamDecoder(session);
  const deltaRes = decoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 100,
      model: "upstream",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
    }),
  });
  assert.equal(deltaRes.ok, true);
  const doneRes = decoder.push({ data: "[DONE]" });
  assert.equal(doneRes.ok, true);
  if (doneRes.ok) {
    const endEvt = doneRes.value.find((evt) => evt.type === "response_end");
    assert.ok(endEvt);
    assert.equal(endEvt.type === "response_end" ? endEvt.usage : true, undefined);
    const clientEncoder = new ChatClientStreamEncoder(session, { includeUsage: true }, () => 1700000000);
    clientEncoder.encode({ type: "response_start", responseId: "resp_123", model: "gpt-main" });
    const encodedEnd = clientEncoder.encode(endEvt);
    assert.equal(encodedEnd.ok, true);
    if (encodedEnd.ok) {
      assert.equal(encodedEnd.value.length, 2); // finish chunk, [DONE] — no usage chunk
    }
  }
});
