import assert from "node:assert/strict";
import { test } from "vitest";
import { systemClock, systemRandomSource, systemSleeper } from "../../src/routing/timing.js";
import { TestClock, TestRandomSource, TestSleeper } from "../helpers/test-timing.js";

test("systemClock provides monotonic and wall-clock times", () => {
  const monotonic = systemClock.nowMonotonicMs();
  const wall = systemClock.nowWall();
  assert.ok(typeof monotonic === "number" && monotonic > 0);
  assert.ok(wall instanceof Date);
});

test("systemSleeper completes sleep and honors 0ms", async () => {
  await systemSleeper.sleep(0);
  await systemSleeper.sleep(-5);
});

test("systemSleeper aborts if signal already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  await assert.rejects(() => systemSleeper.sleep(100, controller.signal), /pre-aborted/);
});

test("systemSleeper aborts when signal fires during sleep", async () => {
  const controller = new AbortController();
  const sleepPromise = systemSleeper.sleep(10_000, controller.signal);
  controller.abort(new Error("mid-sleep abort"));
  await assert.rejects(() => sleepPromise, /mid-sleep abort/);
});

test("systemRandomSource returns numbers in [0, 1)", () => {
  for (let i = 0; i < 50; i++) {
    const val = systemRandomSource.next();
    assert.ok(val >= 0 && val < 1);
  }
});

test("TestClock tracks and advances monotonic and wall time", () => {
  const initialWall = new Date("2026-06-01T12:00:00.000Z");
  const clock = new TestClock(1000, initialWall);

  assert.equal(clock.nowMonotonicMs(), 1000);
  assert.equal(clock.nowWall().toISOString(), "2026-06-01T12:00:00.000Z");

  clock.advance(500);
  assert.equal(clock.nowMonotonicMs(), 1500);
  assert.equal(clock.nowWall().toISOString(), "2026-06-01T12:00:00.500Z");

  assert.throws(() => clock.advance(-10), /Cannot rewind monotonic time/);

  clock.setMonotonic(3000);
  assert.equal(clock.nowMonotonicMs(), 3000);

  clock.setWall(new Date("2026-12-31T23:59:59.000Z"));
  assert.equal(clock.nowWall().toISOString(), "2026-12-31T23:59:59.000Z");
});

test("TestSleeper records sleep durations and auto-advances clock", async () => {
  const clock = new TestClock(100);
  const sleeper = new TestSleeper(clock);

  await sleeper.sleep(50);
  assert.equal(clock.nowMonotonicMs(), 150);
  assert.deepEqual(sleeper.sleeps, [50]);

  await sleeper.sleep(200);
  assert.equal(clock.nowMonotonicMs(), 350);
  assert.deepEqual(sleeper.sleeps, [50, 200]);

  const controller = new AbortController();
  controller.abort(new Error("aborted"));
  await assert.rejects(() => sleeper.sleep(50, controller.signal), /aborted/);
});

test("TestRandomSource returns sequence and loops or resets", () => {
  const random = new TestRandomSource([0.1, 0.5, 0.9]);
  assert.equal(random.next(), 0.1);
  assert.equal(random.next(), 0.5);
  assert.equal(random.next(), 0.9);
  assert.equal(random.next(), 0.1); // loops

  random.reset();
  assert.equal(random.next(), 0.1);
});
