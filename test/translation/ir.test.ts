import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  IrFinish,
  IrOutcome,
  IrOutputPart,
  IrRequest,
  IrUsage,
} from "../../src/translation/ir.ts";

test("translation ir: constructs fully typed IrRequest", () => {
  const request: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [
      {
        type: "instruction",
        authority: "system",
        separation: "advisory",
        text: "You are a helpful assistant.",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
    ],
  };

  assert.equal(request.model, "claude-3-7-sonnet");
  assert.equal(request.delivery, "complete");
  assert.equal(request.items.length, 2);
  assert.equal(request.items[0]?.type, "instruction");
  assert.equal(request.items[1]?.type, "message");
});

test("translation ir: constructs fully typed IrOutcome", () => {
  const finish: IrFinish = { reason: "stop" };
  const parts: IrOutputPart[] = [
    {
      type: "text",
      partId: "part_01",
      text: "Hello! How can I help you today?",
    },
  ];
  const usage: IrUsage = {
    input: 10,
    output: 8,
    total: 18,
  };

  const outcome: IrOutcome = {
    responseId: "resp_01",
    model: "claude-3-7-sonnet",
    parts,
    finish,
    usage,
  };

  assert.equal(outcome.responseId, "resp_01");
  assert.equal(outcome.finish.reason, "stop");
  assert.equal(outcome.parts.length, 1);
  assert.equal(outcome.parts[0]?.type, "text");
  assert.equal((outcome.parts[0] as { text: string }).text, "Hello! How can I help you today?");
  assert.equal(outcome.usage?.total, 18);
});
