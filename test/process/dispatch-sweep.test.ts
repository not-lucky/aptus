import assert from "node:assert/strict";
import { test } from "vitest";

/**
 * Dispatch-count cross-check sweep.
 *
 * This table is a manual descriptor -> counts audit of the dispatch-count
 * assertions made by the live process suites. Each descriptor is the exact
 * `test.concurrent("...")` name in the owning file, so renaming a scenario in
 * the live test forces a matching edit here (no second paraphrase to drift).
 * The live process suites are the authoritative evidence; this sweep only
 * cross-checks the table's internal consistency (unique descriptors, valid
 * counts, harness wiring rules, zero-dispatch and single-target invariants).
 * When a live test changes a dispatch count, this table must change with it or
 * fail the consistency checks below.
 */

/** Which provider harness a scenario runs against. */
type HarnessKind = "three-origin" | "primary-backup" | "single-origin";

/** Which single origin a `single-origin` harness wires (and asserts). */
type SingleOriginTarget = "chat" | "responses" | "messages";

interface ScenarioCounts {
  readonly chatOrigin: number;
  readonly responsesOrigin: number;
  readonly messagesOrigin: number;
  /**
   * Backup origin count for the 2-origin routes-retries harness. Undefined for
   * three-origin and single-origin scenarios.
   */
  readonly backupOrigin?: number;
}

interface ScenarioEntry {
  readonly file: string;
  /** Exact `test.concurrent(...)` name in the owning file. */
  readonly descriptor: string;
  readonly harness: HarnessKind;
  /** Which origin a single-origin scenario wires; undefined otherwise. */
  readonly target?: SingleOriginTarget;
  readonly counts: ScenarioCounts;
}

/** Three-origin scenarios that deliberately dispatch to more than one origin. */
const MULTI_ORIGIN_DESCRIPTORS: ReadonlySet<string> = new Set([
  "process: both path aliases per protocol aggregate into one endpoint metric label",
  "process: concurrent requests across 3 simultaneous origins succeed with byte parity",
  "process: mixed-protocol route skips incompatible candidates with zero dispatch",
]);

const SCENARIOS: readonly ScenarioEntry[] = [
  // test/process/cancellation.test.ts
  {
    file: "cancellation",
    descriptor: "process: client disconnect before response head aborts dispatch with cancelled:client",
    harness: "three-origin",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "cancellation",
    descriptor: "process: client disconnect during admission aborts before any dispatch with no cancelled counter",
    harness: "three-origin",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "cancellation",
    descriptor: "process: client disconnect mid-stream stops the relay with cancelled:client and no partial stream files",
    harness: "three-origin",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  // test/process/shutdown.test.ts
  {
    file: "shutdown",
    descriptor: "process: SIGTERM drains fast request to completion and aborts the held request at the deadline",
    harness: "three-origin",
    counts: { chatOrigin: 2, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "shutdown",
    descriptor: "process: SIGINT drains fast request to completion and aborts the held request at the deadline",
    harness: "three-origin",
    counts: { chatOrigin: 2, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "shutdown",
    descriptor: "process: second signal during drain aborts immediately with {drained: 0, aborted: N}",
    harness: "three-origin",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "shutdown",
    descriptor: "process: idle SIGTERM closes without traces and reports zero drained and aborted",
    harness: "three-origin",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0 },
  },
  // test/process/catalog.test.ts
  {
    file: "catalog",
    descriptor: "process: Bearer and x-api-key catalogs are served locally with zero provider dispatch",
    harness: "three-origin",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "catalog",
    descriptor: "process: restricted allow:[] client gets an empty catalog and 404 on create with zero dispatch",
    harness: "three-origin",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0 },
  },
  // test/process/trace-degradation.test.ts
  {
    file: "trace-degradation",
    descriptor: "process: an unwritable trace root degrades readiness while traffic stays 200, then recovers",
    harness: "three-origin",
    counts: { chatOrigin: 3, responsesOrigin: 0, messagesOrigin: 0 },
  },
  // test/process/path-aliases-metrics.test.ts
  {
    file: "path-aliases-metrics",
    descriptor: "process: both path aliases per protocol aggregate into one endpoint metric label",
    harness: "three-origin",
    counts: { chatOrigin: 2, responsesOrigin: 2, messagesOrigin: 2 },
  },
  // test/process/three-origin-parity.test.ts
  {
    file: "three-origin-parity",
    descriptor: "process: concurrent requests across 3 simultaneous origins succeed with byte parity",
    harness: "three-origin",
    counts: { chatOrigin: 1, responsesOrigin: 1, messagesOrigin: 1 },
  },
  {
    file: "three-origin-parity",
    descriptor: "process: mixed-protocol route skips incompatible candidates with zero dispatch",
    harness: "three-origin",
    counts: { chatOrigin: 1, responsesOrigin: 1, messagesOrigin: 1 },
  },
  // test/process/routes-retries.test.ts (2-origin primary/backup harness)
  {
    file: "routes-retries",
    descriptor: "process: two 429s with three keys rotate keys before wait and succeed on third attempt",
    harness: "primary-backup",
    counts: { chatOrigin: 3, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  {
    file: "routes-retries",
    descriptor: "process: 503 retries exhausted on primary origin falls back to backup origin",
    harness: "primary-backup",
    counts: { chatOrigin: 3, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 1 },
  },
  {
    file: "routes-retries",
    descriptor: "process: pre-header disconnect falls back to backup origin",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 1 },
  },
  {
    file: "routes-retries",
    descriptor: "process: protocol-mismatch-only route returns 400 with zero origin dispatches",
    harness: "primary-backup",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  {
    file: "routes-retries",
    descriptor: "process: stalled response head times out with no retry and a 504 terminal",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  {
    file: "routes-retries",
    descriptor: "process: retry wait past the request deadline expires with a 504 and no extra dispatch",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  {
    file: "routes-retries",
    descriptor: "process: classified timeout (504) with fallbackOn: [timeout] moves to the next candidate",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 1 },
  },
  {
    file: "routes-retries",
    descriptor: "process: classified timeout (504) without fallbackOn: [timeout] never falls back",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  {
    file: "routes-retries",
    descriptor: "process: post-header disconnect on a stream cannot fall back after client bytes",
    harness: "primary-backup",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0, backupOrigin: 0 },
  },
  // test/process/chat-native.test.ts (single Chat origin)
  {
    file: "chat-native",
    descriptor: "process: complete Chat native path applies mutation and relays exact bytes",
    harness: "single-origin",
    target: "chat",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "chat-native",
    descriptor: "process: SSE Chat relays a byte-identical stream preserving [DONE]",
    harness: "single-origin",
    target: "chat",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "chat-native",
    descriptor: "process: redirect loop is rejected as a provider failure without infinite dispatch",
    harness: "single-origin",
    target: "chat",
    counts: { chatOrigin: 2, responsesOrigin: 0, messagesOrigin: 0 },
  },
  {
    file: "chat-native",
    descriptor: "process: client abort mid-stream cancels the provider body",
    harness: "single-origin",
    target: "chat",
    counts: { chatOrigin: 1, responsesOrigin: 0, messagesOrigin: 0 },
  },
  // test/process/responses-native.test.ts (single Responses origin)
  {
    file: "responses-native",
    descriptor: "process: complete Responses native path applies mutation and relays exact bytes",
    harness: "single-origin",
    target: "responses",
    counts: { chatOrigin: 0, responsesOrigin: 2, messagesOrigin: 0 },
  },
  {
    file: "responses-native",
    descriptor: "process: SSE Responses relays exact named events with no [DONE]",
    harness: "single-origin",
    target: "responses",
    counts: { chatOrigin: 0, responsesOrigin: 1, messagesOrigin: 0 },
  },
  {
    file: "responses-native",
    descriptor: "process: Responses stream terminal variants (failed, incomplete, error) are exact",
    harness: "single-origin",
    target: "responses",
    counts: { chatOrigin: 0, responsesOrigin: 3, messagesOrigin: 0 },
  },
  {
    file: "responses-native",
    descriptor: "process: Responses terminal non-2xx HTTP error is relayed with failed trace",
    harness: "single-origin",
    target: "responses",
    counts: { chatOrigin: 0, responsesOrigin: 1, messagesOrigin: 0 },
  },
  {
    file: "responses-native",
    descriptor: "process: Responses client abort mid-stream cancels provider body",
    harness: "single-origin",
    target: "responses",
    counts: { chatOrigin: 0, responsesOrigin: 1, messagesOrigin: 0 },
  },
  // test/process/messages-native.test.ts (single Messages origin)
  {
    file: "messages-native",
    descriptor: "process: complete Messages native path applies mutation and relays exact bytes",
    harness: "single-origin",
    target: "messages",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 2 },
  },
  {
    file: "messages-native",
    descriptor: "process: SSE Messages relays exact stream preserving pings and input_json_delta",
    harness: "single-origin",
    target: "messages",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 1 },
  },
  {
    file: "messages-native",
    descriptor: "process: Messages post-200 in-band error is relayed without forged terminator",
    harness: "single-origin",
    target: "messages",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 1 },
  },
  {
    file: "messages-native",
    descriptor: "process: Messages terminal HTTP 404 error is relayed with failed trace",
    harness: "single-origin",
    target: "messages",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 1 },
  },
  {
    file: "messages-native",
    descriptor: "process: Messages client abort mid-stream cancels provider body",
    harness: "single-origin",
    target: "messages",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 1 },
  },
  // test/process/dry-run.test.ts (single Chat origin, zero dispatch)
  {
    file: "dry-run",
    descriptor: "process: dry run with stream:true returns vendor JSON and zero dispatch",
    harness: "single-origin",
    target: "chat",
    counts: { chatOrigin: 0, responsesOrigin: 0, messagesOrigin: 0 },
  },
];

test("process: dispatch-count sweep is internally consistent across every scenario", () => {
  // Every descriptor (the exact live test name) appears exactly once.
  const descriptors = SCENARIOS.map((entry) => entry.descriptor);
  assert.equal(new Set(descriptors).size, descriptors.length, "scenario descriptors must be unique");

  for (const entry of SCENARIOS) {
    const { counts, harness, target } = entry;
    for (const count of [counts.chatOrigin, counts.responsesOrigin, counts.messagesOrigin]) {
      assert.ok(Number.isInteger(count) && count >= 0, `${entry.descriptor}: counts must be non-negative integers`);
    }
    if (counts.backupOrigin !== undefined) {
      assert.ok(
        Number.isInteger(counts.backupOrigin) && counts.backupOrigin >= 0,
        `${entry.descriptor}: backup count must be a non-negative integer`,
      );
    }

    if (harness === "three-origin") {
      // The backup origin is not wired in the three-origin harness.
      assert.equal(counts.backupOrigin, undefined, `${entry.descriptor}: three-origin scenarios have no backup origin`);
      assert.equal(target, undefined, `${entry.descriptor}: three-origin scenarios have no single target`);
    } else if (harness === "primary-backup") {
      // The 2-origin routes harness asserts both primary and backup counts.
      assert.ok(
        counts.backupOrigin !== undefined,
        `${entry.descriptor}: primary-backup scenarios must assert backup counts`,
      );
      // Routes-retries targets the primary (chat-protocol) origin only.
      assert.equal(counts.responsesOrigin, 0, `${entry.descriptor}: primary-backup scenarios never touch responses`);
      assert.equal(counts.messagesOrigin, 0, `${entry.descriptor}: primary-backup scenarios never touch messages`);
      assert.equal(target, undefined, `${entry.descriptor}: primary-backup scenarios have no single target`);
    } else {
      // Single-origin harnesses wire exactly one origin; the others are unwired
      // and must stay at zero (any dispatch there would be a wiring bug).
      assert.equal(counts.backupOrigin, undefined, `${entry.descriptor}: single-origin scenarios have no backup origin`);
      assert.ok(target !== undefined, `${entry.descriptor}: single-origin scenarios must declare a target`);
      const targetCount = { chat: counts.chatOrigin, responses: counts.responsesOrigin, messages: counts.messagesOrigin }[
        target
      ];
      assert.ok(
        Number.isInteger(targetCount) && targetCount >= 0,
        `${entry.descriptor}: target origin count must be a non-negative integer`,
      );
      for (const origin of ["chat", "responses", "messages"] as const) {
        if (origin !== target) {
          assert.equal(
            { chat: counts.chatOrigin, responses: counts.responsesOrigin, messages: counts.messagesOrigin }[origin],
            0,
            `${entry.descriptor}: unwired ${origin} origin must stay at zero`,
          );
        }
      }
    }

    // Zero-dispatch scenarios must be all-zero across every wired origin.
    const mainNonZero = [counts.chatOrigin, counts.responsesOrigin, counts.messagesOrigin].filter((count) => count > 0);
    if (mainNonZero.length === 0) {
      assert.equal(
        counts.backupOrigin ?? 0,
        0,
        `${entry.descriptor}: zero-dispatch scenarios have zero backup dispatches`,
      );
    }

    // Three-origin single-target scenarios dispatch to exactly one origin;
    // the known multi-origin scenarios dispatch to all three.
    if (harness === "three-origin") {
      if (MULTI_ORIGIN_DESCRIPTORS.has(entry.descriptor)) {
        assert.equal(mainNonZero.length, 3, `${entry.descriptor}: multi-origin scenario must dispatch to all three`);
      } else {
        assert.ok(
          mainNonZero.length <= 1,
          `${entry.descriptor}: single-target scenarios dispatch to at most one origin`,
        );
      }
    }
  }
});
