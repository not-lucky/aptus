import assert from "node:assert/strict";
import { test } from "vitest";
import { ResponsesEgressEncoder } from "../../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../../src/translation/codecs/responses/ingress.ts";

test("translation codec responses: decodes and encodes request", () => {
  const decoder = new ResponsesIngressDecoder();
  const encoder = new ResponsesEgressEncoder();

  const responsesBody = {
    model: "gpt-5.4",
    instructions: "You are helpful.",
    input: "Hello Responses!",
  };

  const decodeRes = decoder.decodeRequest(responsesBody);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const ir = decodeRes.value;
    assert.equal(ir.model, "gpt-5.4");
    assert.equal(ir.items.length, 2);

    const encoded = encoder.encodeRequest(ir, "gpt-5.4-target");
    assert.equal(encoded.model, "gpt-5.4-target");
    const input = encoded.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    assert.equal(input.length, 2);
    assert.equal(input[0]?.role, "system");
    assert.equal(input[0]?.content[0]?.text, "You are helpful.");
    assert.equal(input[1]?.role, "user");
    assert.equal(input[1]?.content[0]?.text, "Hello Responses!");
  }
});

test("translation codec responses: rejects parallel_tool_calls fail-closed", () => {
  const decoder = new ResponsesIngressDecoder();
  const decodeRes = decoder.decodeRequest({
    model: "gpt-5.4",
    input: "Hello!",
    parallel_tool_calls: true,
  });
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.equal(decodeRes.error.capability, "parallel-tool-calls");
  }
});

test("translation codec responses: decodes and encodes outcome", () => {
  const decoder = new ResponsesIngressDecoder();
  const encoder = new ResponsesEgressEncoder();

  const responsesResponse = {
    id: "resp_01abc",
    object: "response",
    status: "completed",
    model: "gpt-5.4",
    output: [
      {
        type: "message",
        id: "msg_01",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Hello from Responses!",
          },
        ],
      },
    ],
    usage: {
      input_tokens: 15,
      output_tokens: 12,
      total_tokens: 27,
    },
  };

  const decodeRes = decoder.decodeOutcome(200, {}, responsesResponse);
  assert.equal(decodeRes.ok, true);
  if (decodeRes.ok) {
    const outcome = decodeRes.value;
    assert.equal(outcome.finish.reason, "stop");
    assert.equal(outcome.usage?.input, 15);
    assert.equal(outcome.usage?.output, 12);

    const encoded = encoder.encodeOutcome(outcome);
    assert.equal(encoded.status, 200);
    const body = encoded.body as { object: string; status: string; output: Array<{ content: Array<{ text: string }> }>; usage: { input_tokens: number } };
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.output[0]?.content[0]?.text, "Hello from Responses!");
    assert.equal(body.usage.input_tokens, 15);
  }
});
