import assert from "node:assert/strict";
import { test } from "vitest";
import type { IrOutcome, IrRequest } from "../../src/translation/ir.ts";
import { preflightOutcome, preflightRequest } from "../../src/translation/preflight.ts";

test("translation preflight: admits plain-text complete request", () => {
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

  const directions = [
    "openai-chat->openai-responses",
    "openai-chat->anthropic-messages",
    "openai-responses->openai-chat",
    "openai-responses->anthropic-messages",
    "anthropic-messages->openai-chat",
    "anthropic-messages->openai-responses",
  ] as const;

  for (const dir of directions) {
    const res = preflightRequest(req, dir);
    assert.equal(res.ok, true, `Failed for direction ${dir}`);
  }
});

test("translation preflight: rejects streaming request with semantic-stream-lifecycle", () => {
  const req: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "stream",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
    ],
  };

  const res = preflightRequest(req, "openai-chat->anthropic-messages");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "semantic-stream-lifecycle");
  }
});

test("translation preflight: rejects tools with function-tool-definition", () => {
  const req: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        inputSchema: {},
      },
    ],
  };

  const res = preflightRequest(req, "openai-chat->anthropic-messages");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "function-tool-definition");
  }
});

test("translation preflight: rejects mid-conversation instruction into Messages", () => {
  const req: IrRequest = {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
      {
        type: "instruction",
        authority: "system",
        separation: "advisory",
        text: "Mid-conversation instruction",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "What did I say?" }],
      },
    ],
  };

  const res = preflightRequest(req, "openai-chat->anthropic-messages");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "mid-conversation-instruction");
  }
});

test("translation preflight: rejects outcome refusal with refusal-content", () => {
  const out: IrOutcome = {
    responseId: "resp_1",
    model: "claude-3-7-sonnet",
    parts: [
      {
        type: "refusal",
        partId: "part_1",
        text: "I cannot fulfill this request.",
      },
    ],
    finish: { reason: "refusal" },
  };

  const res = preflightOutcome(out, "anthropic-messages->openai-chat");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "refusal-content");
  }
});
