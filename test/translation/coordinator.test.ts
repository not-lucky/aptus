import assert from "node:assert/strict";
import { test } from "vitest";
import type { Protocol } from "../../src/domain/contracts.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";

const DIRECTIONS: ReadonlyArray<readonly [Protocol, Protocol]> = [
  ["openai-chat", "openai-responses"],
  ["openai-chat", "anthropic-messages"],
  ["openai-responses", "openai-chat"],
  ["openai-responses", "anthropic-messages"],
  ["anthropic-messages", "openai-chat"],
  ["anthropic-messages", "openai-responses"],
];

test("translation coordinator: translates requests and outcomes across all six directions", () => {
  const coordinator = createDefaultTranslationCoordinator();

  for (const [sourceProtocol, targetProtocol] of DIRECTIONS) {
    let sourceBody: import("../../src/domain/contracts.ts").JsonObject;

    if (sourceProtocol === "openai-chat") {
      sourceBody = {
        model: "logical-model",
        messages: [{ role: "user", content: "Hello across protocols!" }],
      };
    } else if (sourceProtocol === "openai-responses") {
      sourceBody = {
        model: "logical-model",
        input: "Hello across protocols!",
      };
    } else {
      sourceBody = {
        model: "logical-model",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello across protocols!" }],
      };
    }

    const reqResult = coordinator.translateCompleteRequest({
      sourceProtocol,
      targetProtocol,
      sourceBody,
      logicalModel: "canonical-logical-model",
      targetModel: "upstream-target-model",
      targetDefaultMaxTokens: targetProtocol === "anthropic-messages" ? 2048 : undefined,
    });

    assert.equal(reqResult.ok, true, `Request failed for ${sourceProtocol}->${targetProtocol}`);
    if (reqResult.ok) {
      assert.equal(reqResult.value.body.model, "upstream-target-model");
      assert.equal(reqResult.value.irRequest.model, "canonical-logical-model");

      if (targetProtocol === "anthropic-messages") {
        assert.equal(reqResult.value.body.max_tokens, 2048);
      }
    }

    let targetOutcomeBody: import("../../src/domain/contracts.ts").JsonObject;

    if (targetProtocol === "openai-chat") {
      targetOutcomeBody = {
        id: "chatcmpl-01",
        object: "chat.completion",
        created: 1775606400,
        model: "upstream-target-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Response text" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    } else if (targetProtocol === "openai-responses") {
      targetOutcomeBody = {
        id: "resp_01",
        object: "response",
        status: "completed",
        model: "upstream-target-model",
        output: [
          {
            type: "message",
            id: "msg_01",
            role: "assistant",
            content: [{ type: "output_text", text: "Response text" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
    } else {
      targetOutcomeBody = {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "upstream-target-model",
        content: [{ type: "text", text: "Response text" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }

    const outcomeResult = coordinator.translateCompleteOutcome({
      sourceProtocol,
      targetProtocol,
      status: 200,
      headers: { "content-type": "application/json" },
      body: targetOutcomeBody,
      logicalModel: "canonical-logical-model",
    });

    assert.equal(outcomeResult.ok, true, `Outcome failed for ${sourceProtocol}->${targetProtocol}`);
    if (outcomeResult.ok) {
      assert.equal(outcomeResult.value.status, 200);
      assert.equal(outcomeResult.value.body.model, "canonical-logical-model");
      assert.equal(outcomeResult.value.irOutcome.model, "canonical-logical-model");
    }
  }
});

test("translation coordinator: fails closed when Anthropic target is missing max_tokens default configuration", () => {
  const coordinator = createDefaultTranslationCoordinator();

  const reqResult = coordinator.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: {
      model: "logical-model",
      messages: [{ role: "user", content: "Hello!" }],
    },
    logicalModel: "logical-model",
    targetModel: "claude-3-7-sonnet",
    targetDefaultMaxTokens: undefined, // Missing!
  });

  assert.equal(reqResult.ok, false);
  if (!reqResult.ok) {
    assert.equal(reqResult.error.capability, "output-token-limit");
  }
});
