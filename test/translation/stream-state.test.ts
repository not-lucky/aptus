import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import type { IrStreamEvent } from "../../src/translation/ir.ts";
import { createIrStreamStateMachine } from "../../src/translation/stream-state.ts";

test("state machine: legal plain-text stream lifecycle passes validation", () => {
  const sm = createIrStreamStateMachine({ expectedResponseId: "resp_1", expectedModel: "gpt-main" });

  const events: IrStreamEvent[] = [
    { type: "response_start", responseId: "resp_1", model: "gpt-main" },
    { type: "part_start", responseId: "resp_1", partId: "p1", part: { type: "text" } },
    { type: "text_delta", responseId: "resp_1", partId: "p1", text: "Hello " },
    { type: "text_delta", responseId: "resp_1", partId: "p1", text: "world" },
    { type: "part_end", responseId: "resp_1", partId: "p1", partType: "text" },
    {
      type: "response_end",
      responseId: "resp_1",
      finish: { reason: "stop" },
      usage: { input: 10, output: 5, total: 15 },
    },
  ];

  for (const evt of events) {
    const res = sm.feed(evt);
    assert.equal(res.ok, true, `Event '${evt.type}' failed: ${!res.ok ? res.error.message : ""}`);
  }

  assert.equal(sm.isTerminal(), true);
  assert.equal(sm.getOpenPartIds().size, 0);
});

test("state machine: supports interleaved open text parts", () => {
  const sm = createIrStreamStateMachine();

  const events: IrStreamEvent[] = [
    { type: "response_start", responseId: "r1", model: "m1" },
    { type: "part_start", responseId: "r1", partId: "p1", part: { type: "text" } },
    { type: "part_start", responseId: "r1", partId: "p2", part: { type: "text" } },
    { type: "text_delta", responseId: "r1", partId: "p1", text: "A" },
    { type: "text_delta", responseId: "r1", partId: "p2", text: "B" },
    { type: "text_delta", responseId: "r1", partId: "p1", text: "A2" },
    { type: "part_end", responseId: "r1", partId: "p2", partType: "text" },
    { type: "part_end", responseId: "r1", partId: "p1", partType: "text" },
    { type: "response_end", responseId: "r1", finish: { reason: "length" } },
  ];

  for (const evt of events) {
    const res = sm.feed(evt);
    assert.equal(res.ok, true);
  }

  assert.equal(sm.isTerminal(), true);
});

test("state machine: rejects events before response_start", () => {
  const sm = createIrStreamStateMachine();
  const res = sm.feed({ type: "part_start", responseId: "r1", partId: "p1", part: { type: "text" } });
  assert.equal(res.ok, false);
});

test("state machine: rejects duplicate response_start", () => {
  const sm = createIrStreamStateMachine();
  assert.equal(sm.feed({ type: "response_start", responseId: "r1", model: "m1" }).ok, true);
  assert.equal(sm.feed({ type: "response_start", responseId: "r1", model: "m1" }).ok, false);
});

test("state machine: rejects response_end when parts remain open", () => {
  const sm = createIrStreamStateMachine();
  sm.feed({ type: "response_start", responseId: "r1", model: "m1" });
  sm.feed({ type: "part_start", responseId: "r1", partId: "p1", part: { type: "text" } });
  const res = sm.feed({ type: "response_end", responseId: "r1", finish: { reason: "stop" } });
  assert.equal(res.ok, false);
});

test("state machine: rejects events after terminal state", () => {
  const sm = createIrStreamStateMachine();
  sm.feed({ type: "response_start", responseId: "r1", model: "m1" });
  sm.feed({ type: "response_end", responseId: "r1", finish: { reason: "stop" } });
  assert.equal(sm.isTerminal(), true);

  const res = sm.feed({ type: "part_start", responseId: "r1", partId: "p1", part: { type: "text" } });
  assert.equal(res.ok, false);
});

test("state machine: fail-closed profile rejections for non-text features", () => {
  const sm = createIrStreamStateMachine();
  sm.feed({ type: "response_start", responseId: "r1", model: "m1" });

  const refusalStart = sm.feed({
    type: "part_start",
    responseId: "r1",
    partId: "pref",
    part: { type: "refusal" },
  });
  assert.equal(refusalStart.ok, false);
  if (!refusalStart.ok) {
    assert.equal(refusalStart.error.capability, "refusal-content");
  }

  const toolStart = sm.feed({
    type: "part_start",
    responseId: "r1",
    partId: "ptool",
    part: { type: "function_call", callId: "c1", name: "fn" },
  });
  assert.equal(toolStart.ok, false);
  if (!toolStart.ok) {
    assert.equal(toolStart.error.capability, "function-tool-definition");
  }

  const refusalDelta = sm.feed({
    type: "refusal_delta",
    responseId: "r1",
    partId: "p1",
    text: "refusal",
  });
  assert.equal(refusalDelta.ok, false);
  if (!refusalDelta.ok) {
    assert.equal(refusalDelta.error.capability, "refusal-stream-delta");
  }

  const toolDelta = sm.feed({
    type: "tool_arguments_delta",
    responseId: "r1",
    partId: "p1",
    callId: "c1",
    text: "{}",
  });
  assert.equal(toolDelta.ok, false);
  if (!toolDelta.ok) {
    assert.equal(toolDelta.error.capability, "tool-stream-delta");
  }

  const citation = sm.feed({
    type: "citation",
    responseId: "r1",
    partId: "p1",
    citation: { source: { type: "url", url: "https://example.com" } },
  });
  assert.equal(citation.ok, false);
  if (!citation.ok) {
    assert.equal(citation.error.capability, "citation-stream-timing");
  }

  const unsupportedFinish = sm.feed({
    type: "response_end",
    responseId: "r1",
    finish: { reason: "tool_calls" },
  });
  assert.equal(unsupportedFinish.ok, false);
  if (!unsupportedFinish.ok) {
    assert.equal(unsupportedFinish.error.capability, "finish-tool-calls");
  }
});

test("state machine: property test for arbitrary text delta sequences", () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }), (deltaChunks) => {
      const sm = createIrStreamStateMachine({ expectedResponseId: "r-prop", expectedModel: "m-prop" });
      assert.equal(sm.feed({ type: "response_start", responseId: "r-prop", model: "m-prop" }).ok, true);
      assert.equal(
        sm.feed({ type: "part_start", responseId: "r-prop", partId: "p-prop", part: { type: "text" } }).ok,
        true,
      );

      for (const chunk of deltaChunks) {
        assert.equal(sm.feed({ type: "text_delta", responseId: "r-prop", partId: "p-prop", text: chunk }).ok, true);
      }

      assert.equal(sm.feed({ type: "part_end", responseId: "r-prop", partId: "p-prop", partType: "text" }).ok, true);
      assert.equal(sm.feed({ type: "response_end", responseId: "r-prop", finish: { reason: "stop" } }).ok, true);
      assert.equal(sm.isTerminal(), true);
    }),
    { numRuns: 50 },
  );
});

test("state machine: property test for legal interleaved multi-part streams", () => {
  // Generate 1-5 parts, each with 1-8 text_delta chunks. Interleave all events
  // across parts while preserving each part's start -> deltas -> end ordering,
  // then wrap with response_start / response_end. The state machine must
  // accept every event and reach terminal.
  const partsArb = fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 5 }).chain((deltaCounts) => {
    const partIds = deltaCounts.map((_, i) => `p${i}`);
    // Max total events = 5 parts * (1 start + 8 deltas + 1 end) = 50.
    const maxEvents = deltaCounts.reduce((sum, n) => sum + n + 2, 0);
    return fc.record({
      deltaCounts: fc.constant(deltaCounts),
      partIds: fc.constant(partIds),
      // Random selector sequence: at each merge step pick an active part.
      choices: fc.array(fc.nat(), { minLength: maxEvents, maxLength: maxEvents }),
    });
  });

  fc.assert(
    fc.property(partsArb, ({ deltaCounts, partIds, choices }) => {
      const sm = createIrStreamStateMachine();
      const responseId = "r-multi";
      assert.equal(sm.feed({ type: "response_start", responseId, model: "m" }).ok, true);

      // For each part, the ordered event sequence is [start, delta1..deltaN, end].
      const partEvents: IrStreamEvent[][] = partIds.map((partId, i) => {
        const seq: IrStreamEvent[] = [{ type: "part_start", responseId, partId, part: { type: "text" } }];
        const deltaCount = deltaCounts[i] ?? 0;
        for (let d = 0; d < deltaCount; d++) {
          seq.push({ type: "text_delta", responseId, partId, text: `d${d}` });
        }
        seq.push({ type: "part_end", responseId, partId, partType: "text" });
        return seq;
      });

      // Pointer-based merge: each part advances through its own sequence, so
      // start -> deltas -> end ordering is structurally preserved regardless
      // of how parts are interleaved. The loop only runs while at least one
      // part has remaining events, so `activeIdx` is always non-empty.
      const queues = partEvents.map((seq) => [...seq]);
      let remaining = queues.length;
      let ci = 0;
      while (remaining > 0) {
        const activeIdx = queues.map((q, i) => (q.length > 0 ? i : -1)).filter((i) => i >= 0);
        const pick = activeIdx[(choices[ci++] ?? 0) % activeIdx.length] ?? 0;
        const queue = queues[pick];
        if (queue === undefined) {
          continue;
        }
        const evt = queue.shift();
        if (evt === undefined) {
          continue;
        }
        if (queue.length === 0) {
          remaining--;
        }
        const partId = "partId" in evt ? evt.partId : "";
        const res = sm.feed(evt);
        assert.equal(res.ok, true, `Legal interleaved event '${evt.type}' for ${partId} rejected`);
      }

      assert.equal(sm.feed({ type: "response_end", responseId, finish: { reason: "stop" } }).ok, true);
      assert.equal(sm.isTerminal(), true);
      assert.equal(sm.getOpenPartIds().size, 0);
    }),
    { numRuns: 50 },
  );
});

test("state machine: property test for part-correlation violations", () => {
  // Generate illegal part-correlation events and assert the state machine
  // rejects each. Covers three violation classes:
  //   1. text_delta for an unknown/closed partId.
  //   2. part_end for a closed/unknown partId (mismatched partType is not
  //      reachable because part_start rejects refusal/custom_call first).
  //   3. response_end while at least one part remains open.
  const violationArb = fc.oneof(
    // 1. text_delta for a never-opened partId (response_start only).
    fc.record({
      kind: fc.constant("delta-unknown" as const),
      partId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== ""),
    }),
    // 2. text_delta for a closed partId (open then close one part, then delta it).
    fc.record({
      kind: fc.constant("delta-closed" as const),
      partId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== ""),
    }),
    // 3. part_end for a never-opened partId.
    fc.record({
      kind: fc.constant("end-unknown" as const),
      partId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== ""),
    }),
    // 4. response_end while one part remains open.
    fc.record({
      kind: fc.constant("end-open" as const),
      partId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== ""),
    }),
  );

  fc.assert(
    fc.property(violationArb, ({ kind, partId }) => {
      const sm = createIrStreamStateMachine();
      const responseId = "r-viol";
      assert.equal(sm.feed({ type: "response_start", responseId, model: "m" }).ok, true);

      let violatingEvent: IrStreamEvent;

      switch (kind) {
        case "delta-unknown": {
          // No part opened — delta targets a partId that was never started.
          violatingEvent = { type: "text_delta", responseId, partId, text: "x" };
          break;
        }
        case "delta-closed": {
          // Open and close the part, then send a delta to the closed part.
          assert.equal(sm.feed({ type: "part_start", responseId, partId, part: { type: "text" } }).ok, true);
          assert.equal(sm.feed({ type: "part_end", responseId, partId, partType: "text" }).ok, true);
          violatingEvent = { type: "text_delta", responseId, partId, text: "x" };
          break;
        }
        case "end-unknown": {
          // No part opened — part_end targets a partId that was never started.
          violatingEvent = { type: "part_end", responseId, partId, partType: "text" };
          break;
        }
        case "end-open": {
          // Open a part and leave it open, then attempt response_end.
          assert.equal(sm.feed({ type: "part_start", responseId, partId, part: { type: "text" } }).ok, true);
          violatingEvent = { type: "response_end", responseId, finish: { reason: "stop" } };
          break;
        }
      }

      const res = sm.feed(violatingEvent);
      assert.equal(res.ok, false, `Violation '${kind}' for partId '${partId}' was incorrectly accepted`);
    }),
    { numRuns: 50 },
  );
});
