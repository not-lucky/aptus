import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MATRIX,
  getCapabilityRow,
} from "../../src/translation/matrix.ts";

const DIRECTIONS = [
  "openai-chat->openai-responses",
  "openai-chat->anthropic-messages",
  "openai-responses->openai-chat",
  "openai-responses->anthropic-messages",
  "anthropic-messages->openai-chat",
  "anthropic-messages->openai-responses",
] as const;

test.concurrent("translation matrix: defines exactly 184 capability rows", () => {
  assert.equal(MATRIX.length, 184);
});

test.concurrent("translation matrix: all rows have unique IDs and all 6 direction tiers defined", () => {
  const seenIds = new Set<string>();
  for (const row of MATRIX) {
    assert.ok(row.id && row.id.trim().length > 0, "Capability row must have non-empty ID");
    assert.ok(!seenIds.has(row.id), `Duplicate capability ID: ${row.id}`);
    seenIds.add(row.id);

    assert.ok(row.name && row.name.length > 0, `Row ${row.id} missing name`);
    assert.ok(row.irSymbol !== undefined, `Row ${row.id} missing irSymbol`);
    assert.ok(row.caveat !== undefined, `Row ${row.id} missing caveat`);

    for (const dir of DIRECTIONS) {
      const tier = row.tiers[dir];
      assert.ok(
        tier === "T1" || tier === "T2" || tier === "T3" || tier === "—",
        `Invalid tier ${tier} for ${row.id} in direction ${dir}`,
      );
    }
  }
});

test.concurrent("translation matrix: getCapabilityRow correctly retrieves capability rows by ID", () => {
  const plainTextCapabilities = [
    "logical-model-selection",
    "single-text-turn",
    "multi-turn-text",
    "assistant-prefill",
    "system-instruction",
    "developer-instruction",
    "mixed-instruction-authority",
    "mid-conversation-instruction",
    "message-name",
    "responses-message-phase",
    "anthropic-turn-merging",
    "multiple-candidates",
    "text-content",
    "single-completed-output",
    "ordered-output-parts",
    "response-envelope-synthesis",
    "finish-natural",
    "finish-length",
    "usage-input-output-total",
  ];

  for (const cap of plainTextCapabilities) {
    const row = getCapabilityRow(cap);
    assert.ok(row !== undefined, `Row missing for capability ${cap}`);
    assert.equal(row.id, cap);
  }

  assert.equal(getCapabilityRow("non-existent-capability"), undefined);
});


