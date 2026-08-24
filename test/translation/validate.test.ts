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

test.concurrent("translation validate: requires allowed-tool subset entries to be declared", () => {
  const declaredTool = {
    type: "function" as const,
    name: "get_weather",
    inputSchema: { type: "object" },
  };
  const request: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    tools: [declaredTool],
    items: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello!" }] }],
  };

  const admitted = validateIrRequest(request, {
    allowedToolSubset: { mode: "auto", tools: [declaredTool] },
  });
  assert.equal(admitted.ok, true);

  const undeclared = validateIrRequest(request, {
    allowedToolSubset: {
      mode: "auto",
      tools: [{ ...declaredTool, name: "missing_tool" }],
    },
  });
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) {
    assert.equal(undeclared.error.category, "invalid_request");
    assert.match(undeclared.error.message, /undeclared tool 'missing_tool'/);
  }

  const missingTopLevelTools = validateIrRequest(
    { ...request, tools: undefined },
    { allowedToolSubset: { mode: "auto", tools: [declaredTool] } },
  );
  assert.equal(missingTopLevelTools.ok, false);
  if (!missingTopLevelTools.ok) {
    assert.equal(missingTopLevelTools.error.category, "invalid_request");
    assert.match(missingTopLevelTools.error.message, /undeclared tool 'get_weather'/);
  }
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

test.concurrent("translation validate: enforces function argument parse invariant", () => {
  const requestWithCall = (call: unknown): IrRequest => ({
    model: "logical-key",
    delivery: "complete",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "Call the tool" }] },
      { type: "tool_call", call: call as never },
    ],
  });

  const valid = validateIrRequest(
    requestWithCall({
      type: "function",
      callId: "call_1",
      name: "get_weather",
      argumentsText: '{"city":"SF","units":"metric"}',
      arguments: { units: "metric", city: "SF" },
    }),
  );
  assert.equal(valid.ok, true, "parsed object may use a different property order");

  const invalidTextWithoutParsedObject = validateIrRequest(
    requestWithCall({
      type: "function",
      callId: "call_1",
      name: "get_weather",
      argumentsText: "not-json",
    }),
  );
  assert.equal(invalidTextWithoutParsedObject.ok, true, "raw invalid JSON remains representable");

  const invalidTextWithParsedObject = validateIrRequest(
    requestWithCall({
      type: "function",
      callId: "call_1",
      name: "get_weather",
      argumentsText: "not-json",
      arguments: {},
    }),
  );
  assert.equal(invalidTextWithParsedObject.ok, false);
  if (!invalidTextWithParsedObject.ok) {
    assert.equal(invalidTextWithParsedObject.error.category, "invalid_request");
    assert.match(invalidTextWithParsedObject.error.message, /must parse/);
  }

  const mismatchedObject = validateIrRequest(
    requestWithCall({
      type: "function",
      callId: "call_1",
      name: "get_weather",
      argumentsText: '{"city":"SF"}',
      arguments: { city: "New York" },
    }),
  );
  assert.equal(mismatchedObject.ok, false);
  if (!mismatchedObject.ok) {
    assert.equal(mismatchedObject.error.category, "invalid_request");
    assert.match(mismatchedObject.error.message, /deep-equal/);
  }
});

// =====================================================================
// validateGenerationControls: direct defense-in-depth coverage
// =====================================================================

/** Builds a minimal valid request carrying the given generation controls. */
function requestWithGeneration(generation: IrRequest["generation"]): IrRequest {
  return {
    model: "claude-3-7-sonnet",
    delivery: "complete",
    generation,
    items: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello!" }] }],
  };
}

test.concurrent("validate generation controls: admits every field at its IR boundaries", () => {
  const validCases: ReadonlyArray<IrRequest["generation"]> = [
    { temperature: 0 },
    { temperature: 1 },
    { topP: 0 },
    { topP: 1 },
    { maxOutputTokens: 1 },
    { stopSequences: ["END"] },
    { verbosity: "low" },
    { reasoning: { effort: "max" } },
  ];
  for (const generation of validCases) {
    const result = validateIrRequest(requestWithGeneration(generation));
    assert.equal(result.ok, true, JSON.stringify(generation));
  }
});

test.concurrent("validate generation controls: rejects out-of-range and non-finite temperature/topP", () => {
  for (const field of ["temperature", "topP"] as const) {
    for (const value of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateIrRequest(requestWithGeneration({ [field]: value }));
      assert.equal(result.ok, false, `${field}=${String(value)}`);
      if (!result.ok) {
        assert.equal(result.error.category, "invalid_request");
        assert.ok(result.error.message.includes(`generation.${field}`));
      }
    }
  }
});

test.concurrent("validate generation controls: rejects non-positive or fractional maxOutputTokens", () => {
  for (const value of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateIrRequest(requestWithGeneration({ maxOutputTokens: value }));
    assert.equal(result.ok, false, `maxOutputTokens=${String(value)}`);
    if (!result.ok) {
      assert.equal(result.error.category, "invalid_request");
      assert.ok(result.error.message.includes("generation.maxOutputTokens"));
    }
  }
});

test.concurrent("validate generation controls: rejects empty arrays and non-empty-string violations in stopSequences", () => {
  for (const stopSequences of [[], [""], ["ok", ""], [42]] as unknown[][]) {
    const result = validateIrRequest(
      requestWithGeneration({
        stopSequences: stopSequences as IrRequest["generation"] extends { stopSequences?: infer S } ? S : never,
      }),
    );
    assert.equal(result.ok, false, JSON.stringify(stopSequences));
    if (!result.ok) {
      assert.equal(result.error.category, "invalid_request");
      assert.ok(result.error.message.includes("generation.stopSequences"));
    }
  }
});

test.concurrent("validate generation controls: rejects non-admitted verbosity and reasoning effort literals", () => {
  const badVerbosity = validateIrRequest(
    requestWithGeneration({
      verbosity: "tally" as IrRequest["generation"] extends { verbosity?: infer V } ? V : never,
    }),
  );
  assert.equal(badVerbosity.ok, false);
  if (!badVerbosity.ok) {
    assert.equal(badVerbosity.error.category, "invalid_request");
    assert.ok(badVerbosity.error.message.includes("generation.verbosity"));
  }

  const badEffort = validateIrRequest(
    requestWithGeneration({
      reasoning: {
        effort: "absurd" as IrRequest["generation"] extends { reasoning?: infer R }
          ? R extends { effort?: infer E }
            ? E
            : never
          : never,
      },
    }),
  );
  assert.equal(badEffort.ok, false);
  if (!badEffort.ok) {
    assert.equal(badEffort.error.category, "invalid_request");
    assert.ok(badEffort.error.message.includes("reasoning.effort"));
  }
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
