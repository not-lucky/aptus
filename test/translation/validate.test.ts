import assert from "node:assert/strict";
import { test } from "vitest";
import type { IrOutcome, IrRequest } from "../../src/translation/ir.ts";
import { validateIrOutcome, validateIrRequest } from "../../src/translation/validate.ts";

test.concurrent("translation validate: admits valid IrRequest", () => {
  const req: IrRequest = {
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
  const result = validateIrRequest(req);
  assert.equal(result.ok, true);
});

test.concurrent("translation validate: rejects empty model or whitespace model", () => {
  const req: IrRequest = {
    model: "   ",
    delivery: "complete",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
    ],
  };
  const result = validateIrRequest(req);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "invalid_request");
  }
});

test.concurrent("translation validate: rejects request with no items", () => {
  const req: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [] as unknown as IrRequest["items"],
  };
  const result = validateIrRequest(req);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "invalid_request");
  }
});

test.concurrent("translation validate: rejects request with only instructions (no user or assistant turn)", () => {
  const req: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [
      {
        type: "instruction",
        authority: "system",
        separation: "advisory",
        text: "You are a helpful assistant.",
      },
    ],
  };
  const result = validateIrRequest(req);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "invalid_request");
  }
});

test.concurrent("translation validate: admits valid IrOutcome with usage", () => {
  const out: IrOutcome = {
    responseId: "resp_123",
    model: "claude-3-7-sonnet",
    parts: [
      {
        type: "text",
        partId: "p_1",
        text: "Hi there!",
      },
    ],
    finish: { reason: "stop" },
    usage: {
      input: 10,
      output: 5,
      total: 15,
    },
  };
  const result = validateIrOutcome(out);
  assert.equal(result.ok, true);
});

test.concurrent("translation validate: rejects IrOutcome with negative usage", () => {
  const out: IrOutcome = {
    responseId: "resp_123",
    model: "claude-3-7-sonnet",
    parts: [{ type: "text", partId: "p_1", text: "Hi" }],
    finish: { reason: "stop" },
    usage: {
      input: -1,
      output: 5,
    },
  };
  const result = validateIrOutcome(out);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "invalid_request");
  }
});

test.concurrent("translation validate: admits valid IrOutcome with empty parts array", () => {
  const out: IrOutcome = {
    responseId: "resp_123",
    model: "claude-3-7-sonnet",
    parts: [],
    finish: { reason: "stop" },
  };
  const result = validateIrOutcome(out);
  assert.equal(result.ok, true);
});

test.concurrent("translation validate: rejects IrOutcome with duplicate part IDs", () => {
  const out: IrOutcome = {
    responseId: "resp_123",
    model: "claude-3-7-sonnet",
    parts: [
      { type: "text", partId: "same_id", text: "Part 1" },
      { type: "text", partId: "same_id", text: "Part 2" },
    ],
    finish: { reason: "stop" },
  };
  const result = validateIrOutcome(out);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "invalid_request");
    assert.ok(result.error.message.includes("duplicate partId"));
  }
});

