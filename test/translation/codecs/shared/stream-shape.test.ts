/**
 * Unit tests for the shared StreamShapeTracker: the wire-agnostic shape laws
 * (terminal-once, start-once, typed part routing, identity dedup, refusal
 * pairing, argument budget, once-only argument parse) that the three provider
 * decoders previously each re-derived and re-tested on their own wires.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { StreamShapeTracker } from "../../../../src/translation/codecs/shared/stream-shape.ts";
import type { IrStreamEvent } from "../../../../src/translation/ir.ts";

function makeTracker(maxArgumentBytes?: number, createPartId: () => string = makeCounter()): StreamShapeTracker {
  return new StreamShapeTracker({
    session: { responseId: "resp", model: "m", createPartId },
    maxArgumentBytes,
    wireLabel: "Test",
  });
}

let counter = 0;
function makeCounter(): () => string {
  const base = ++counter;
  return () => `p${base}-${++counter}`;
}

describe("stream shape tracker", () => {
  it("terminal-once: guardFrame fails every frame after markTerminal", () => {
    const tracker = makeTracker();
    assert.equal(tracker.guardFrame().ok, true);
    tracker.markTerminal();
    assert.equal(tracker.isTerminal(), true);
    const guard = tracker.guardFrame();
    assert.equal(guard.ok, false);
    if (!guard.ok) assert.equal(guard.error.category, "invalid_request");
  });

  it("start-once: ensureStarted is lazy and never fails; start fails a duplicate", () => {
    const lazy = makeTracker();
    const lazyEvents: IrStreamEvent[] = [];
    lazy.ensureStarted(lazyEvents);
    lazy.ensureStarted(lazyEvents);
    assert.equal(lazyEvents.length, 1);
    assert.equal(lazyEvents[0]?.type, "response_start");

    const strict = makeTracker();
    const first: IrStreamEvent[] = [];
    assert.equal(strict.start(first).ok, true);
    assert.equal(first.length, 1);
    const second = strict.start([]);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.category, "invalid_request");
  });

  it("lazy text parts reuse the open part on type match and force a new part on mismatch", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    const first = tracker.openTextPart(events, "current", "reuse-typed");
    assert.equal(events.length, 1);
    assert.equal(tracker.textDelta(events, "current", "hi", { lazy: true }).ok, true);
    assert.equal(events.length, 2);
    assert.equal((events[1] as { partId: string }).partId, first);

    // A refusal part in the slot makes the next lazy text delta open a fresh
    // text part; the abandoned refusal part stays open (terminal check catches it).
    const refusalStart = events.length;
    tracker.openRefusalPart(events, "current", "force-new");
    assert.ok(events.length > refusalStart);
    assert.equal(tracker.textDelta(events, "current", "more", { lazy: true }).ok, true);
    const lastEvent = events[events.length - 1] as { type: string; partId: string };
    assert.equal(lastEvent.type, "text_delta");
    assert.notEqual(lastEvent.partId, first);
  });

  it("non-lazy deltas require an already-open typed part", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    const missing = tracker.textDelta(events, "block:0", "hi");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.category, "invalid_request");

    tracker.openTextPart(events, "block:0", "force-new");
    assert.equal(tracker.textDelta(events, "block:0", "hi").ok, true);

    tracker.openFunctionPart(events, "block:1", "call_1", "fn");
    const wrongType = tracker.textDelta(events, "block:1", "hi");
    assert.equal(wrongType.ok, false);
  });

  it("identity claims persist after the owning part closes", () => {
    const tracker = makeTracker();
    assert.equal(tracker.claimIdentity("block:0").ok, true);
    assert.equal(tracker.hasIdentity("block:0"), true);
    const reuse = tracker.claimIdentity("block:0");
    assert.equal(reuse.ok, false);
    if (!reuse.ok) assert.equal(reuse.error.category, "invalid_request");
  });

  it("function parts dedup call ids when asked and never fabricate a second part for one slot", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    const first = tracker.openFunctionPart(events, "tool:0", "call_a", "fn", { dedupCallId: true });
    assert.equal(first.ok, true);
    const duplicate = tracker.openFunctionPart(events, "tool:1", "call_a", "other", { dedupCallId: true });
    assert.equal(duplicate.ok, false);
    const busySlot = tracker.openFunctionPart(events, "tool:0", "call_b", "fn2");
    assert.equal(busySlot.ok, false);
  });

  it("tool argument deltas route by call id, claim the budget, and parse once at close", () => {
    const tracker = makeTracker(10);
    const events: IrStreamEvent[] = [];
    assert.equal(tracker.openFunctionPart(events, "tool:0", "call_a", "fn").ok, true);

    const mismatch = tracker.toolArgumentsDelta(events, "tool:0", "{}", "call_other");
    assert.equal(mismatch.ok, false);

    const overBudget = tracker.toolArgumentsDelta(events, "tool:0", "123456789012345");
    assert.equal(overBudget.ok, false);
    if (!overBudget.ok) assert.equal(overBudget.error.category, "payload_too_large");

    assert.equal(tracker.toolArgumentsDelta(events, "tool:0", '{"a":').ok, true);
    assert.equal(tracker.toolArgumentsDelta(events, "tool:0", "1}").ok, true);
    assert.equal(tracker.argumentDeltaCount("tool:0"), 2);

    assert.equal(tracker.closePart(events, "tool:0", "function_call").ok, true);
    const partEnd = events[events.length - 1] as { type: string; partType: string; arguments?: unknown };
    assert.equal(partEnd.partType, "function_call");
    assert.deepEqual(partEnd.arguments, { a: 1 });
  });

  it("an unparseable argument accumulation closes as raw text without a forged object", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    tracker.openFunctionPart(events, "tool:0", "call_a", "fn");
    tracker.toolArgumentsDelta(events, "tool:0", "{not json");
    assert.equal(tracker.closePart(events, "tool:0", "function_call").ok, true);
    const partEnd = events[events.length - 1] as { arguments?: unknown };
    assert.equal(partEnd.arguments, undefined);
  });

  it("refusal deltas pair with one open refusal part and feed sawRefusal", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    assert.equal(tracker.sawRefusal(), false);
    assert.equal(tracker.refusalDelta(events, "refusal", "No. ").ok, true);
    assert.equal(tracker.refusalDelta(events, "refusal", "Fine.").ok, true);
    assert.equal(tracker.sawRefusal(), true);
    // Both deltas share the single opened refusal part.
    const partStarts = events.filter((e) => e.type === "part_start");
    assert.equal(partStarts.length, 1);
    assert.equal(tracker.closePart(events, "refusal", "refusal").ok, true);
    const typeMismatch = tracker.closePart(events, "refusal", "refusal");
    assert.equal(typeMismatch.ok, false);
  });

  it("startedFunctionPartCount counts opened function parts for finish derivation", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    assert.equal(tracker.startedFunctionPartCount(), 0);
    tracker.openFunctionPart(events, "tool:0", "call_a", "fn");
    assert.equal(tracker.startedFunctionPartCount(), 1);
    assert.equal(tracker.closePart(events, "tool:0", "function_call").ok, true);
    assert.equal(tracker.startedFunctionPartCount(), 1);
  });

  it("findFunctionPart correlates by slot, call id, part id, or output index with conflict rejection", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    tracker.openFunctionPart(events, "item_0", "call_0", "fn0", { outputIndex: 0 });
    tracker.openFunctionPart(events, "item_1", "call_1", "fn1", { outputIndex: 1 });

    assert.equal(tracker.findFunctionPart("item_0", undefined)?.slot, "item_0");
    assert.equal(tracker.findFunctionPart("call_1", undefined)?.slot, "item_1");
    // A key with a conflicting output index does not fall back.
    assert.equal(tracker.findFunctionPart("item_0", 1), undefined);
    // An unknown key never falls back to a valid output index.
    assert.equal(tracker.findFunctionPart("item_missing", 0), undefined);
    // Omitted key resolves by output index alone.
    assert.equal(tracker.findFunctionPart(undefined, 1)?.slot, "item_1");
    assert.equal(tracker.findFunctionPart(undefined, 9), undefined);
  });

  it("closeAllFunctionParts closes every open function part in open order with parsed arguments", () => {
    const tracker = makeTracker();
    const events: IrStreamEvent[] = [];
    tracker.openFunctionPart(events, "tool:0", "call_a", "fn0");
    tracker.openTextPart(events, "text", "reuse-typed");
    tracker.openFunctionPart(events, "tool:1", "call_b", "fn1");
    tracker.toolArgumentsDelta(events, "tool:1", "{}");

    tracker.closeAllFunctionParts(events);
    const partEnds = events.filter((e) => e.type === "part_end");
    assert.deepEqual(
      partEnds.map((e) => (e as { partType: string }).partType),
      ["function_call", "function_call"],
    );
    assert.equal((partEnds[1] as { arguments?: unknown }).arguments !== undefined, true);
    assert.equal(tracker.partTypeOf("tool:0"), undefined);
    assert.equal(tracker.partTypeOf("text"), "text");
  });

  it("responseEnd and error emit the terminal event and mark the stream terminal", () => {
    const endTracker = makeTracker();
    const endEvents: IrStreamEvent[] = [];
    endTracker.responseEnd(endEvents, { reason: "stop" });
    assert.equal(endEvents[0]?.type, "response_end");
    assert.equal(endTracker.isTerminal(), true);

    const errorTracker = makeTracker();
    const errorEvents: IrStreamEvent[] = [];
    errorTracker.error(errorEvents, { category: "provider", message: "boom", retryable: false });
    assert.equal(errorEvents[0]?.type, "error");
    assert.equal(errorTracker.isTerminal(), true);
  });
});
