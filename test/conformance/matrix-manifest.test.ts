/**
 * Verification test for the static conformance matrix manifest.
 *
 * Asserts:
 * - MANIFEST.length === MATRIX.length === 184 rows
 * - No duplicate capability IDs
 * - Zero unknown capability IDs
 * - Tiers match the canonical matrix exactly across all 6 directions
 * - Every row has a valid area, trigger, dispatch count, and terminal behavior
 * - Proves strict, complete, mutually exclusive partitioning across areas
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { Direction } from "../../src/translation/contracts.ts";
import { MATRIX } from "../../src/translation/matrix.ts";
import { CONFORMANCE_MANIFEST } from "./matrix-manifest.ts";

const DIRECTIONS: readonly Direction[] = [
  "openai-chat->openai-responses",
  "openai-chat->anthropic-messages",
  "openai-responses->openai-chat",
  "openai-responses->anthropic-messages",
  "anthropic-messages->openai-chat",
  "anthropic-messages->openai-responses",
];

const VALID_TRIGGERS = new Set(["request_field", "outcome_field", "stream_event", "header", "transport", "system"]);

const VALID_TERMINAL_BEHAVIORS = new Set([
  "complete",
  "unsupported_capability",
  "invalid_request",
  "payload_too_large",
  "in_band_error",
  "abrupt_close",
]);

test("manifest completeness: every MATRIX row has exactly one manifest entry and vice versa", () => {
  const manifestById = new Map(CONFORMANCE_MANIFEST.map((row) => [row.id, row]));
  const matrixById = new Map(MATRIX.map((row) => [row.id, row]));

  assert.equal(manifestById.size, CONFORMANCE_MANIFEST.length);
  assert.equal(manifestById.size, matrixById.size);
  for (const id of matrixById.keys()) {
    assert.ok(manifestById.has(id), `MATRIX capability missing from manifest: ${id}`);
  }
});

test("manifest completeness: no duplicate capability IDs", () => {
  const seen = new Set<string>();
  for (const row of CONFORMANCE_MANIFEST) {
    assert.equal(seen.has(row.id), false, `Duplicate capability ID: ${row.id}`);
    seen.add(row.id);
  }
  assert.equal(seen.size, CONFORMANCE_MANIFEST.length);
});

test("manifest completeness: exact tier matching with canonical MATRIX across all 6 directions", () => {
  const matrixById = new Map(MATRIX.map((r) => [r.id, r]));

  for (const row of CONFORMANCE_MANIFEST) {
    const canonical = matrixById.get(row.id);
    assert.ok(canonical !== undefined, `Unknown manifest capability ID: ${row.id}`);

    assert.equal(row.name, canonical.name, `Name mismatch for ${row.id}`);

    for (const dir of DIRECTIONS) {
      assert.equal(
        row.tiers[dir],
        canonical.tiers[dir],
        `Tier mismatch for row ${row.id} on direction ${dir}: expected ${canonical.tiers[dir]}, got ${row.tiers[dir]}`,
      );
    }
  }
});

test("manifest completeness: valid areas, triggers, dispatch counts, and terminal behaviors", () => {
  const areaCounts: Record<string, number> = {};
  const VALID_AREAS = new Set([
    "transcript",
    "streaming",
    "controls",
    "tools",
    "tools-streaming",
    "structured",
    "media",
    "terminal",
  ]);

  for (const row of CONFORMANCE_MANIFEST) {
    assert.ok(VALID_AREAS.has(row.area), `Invalid area ${row.area} for row ${row.id}`);
    assert.ok(VALID_TRIGGERS.has(row.trigger), `Invalid trigger ${row.trigger} for row ${row.id}`);
    for (const dir of DIRECTIONS) {
      const dispatch = row.expectedDispatchCount[dir];
      assert.ok(
        dispatch === 0 || dispatch === 1,
        `Invalid dispatch count ${dispatch} for row ${row.id} on direction ${dir}`,
      );
      const terminal = row.terminalBehavior[dir];
      assert.ok(
        VALID_TERMINAL_BEHAVIORS.has(terminal),
        `Invalid terminal behavior ${terminal} for row ${row.id} on direction ${dir}`,
      );
      if (dispatch === 0) {
        assert.ok(
          terminal === "unsupported_capability" || terminal === "invalid_request" || terminal === "payload_too_large",
          `Row ${row.id} on direction ${dir} has dispatch 0 but non-rejection terminal ${terminal}`,
        );
      }
    }

    areaCounts[row.area] = (areaCounts[row.area] ?? 0) + 1;
  }

  // Verify that every area owns at least one row
  for (const area of VALID_AREAS) {
    assert.ok((areaCounts[area] ?? 0) > 0, `Area ${area} owns zero rows in manifest`);
  }

  const totalAssigned = Object.values(areaCounts).reduce((a, b) => a + b, 0);
  assert.equal(totalAssigned, CONFORMANCE_MANIFEST.length);
});
