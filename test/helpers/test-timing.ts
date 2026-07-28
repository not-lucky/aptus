import type { Clock, RandomSource, Sleeper } from "../../src/routing/timing.ts";

/**
 * Controllable clock test double for deterministic testing.
 */
export class TestClock implements Clock {
  private monotonicMs: number;
  private wallDate: Date;

  public constructor(initialMonotonicMs = 0, initialWallDate: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.monotonicMs = initialMonotonicMs;
    this.wallDate = new Date(initialWallDate.getTime());
  }

  public nowMonotonicMs(): number {
    return this.monotonicMs;
  }

  public nowWall(): Date {
    return new Date(this.wallDate.getTime());
  }

  /**
   * Advances monotonic time and wall-clock time by the given delta in milliseconds.
   *
   * @param deltaMs - Milliseconds to advance.
   */
  public advance(deltaMs: number): void {
    if (deltaMs < 0) {
      throw new Error("Cannot rewind monotonic time");
    }
    this.monotonicMs += deltaMs;
    this.wallDate = new Date(this.wallDate.getTime() + deltaMs);
  }

  /**
   * Sets the monotonic time directly.
   *
   * @param nowMs - Absolute monotonic time in milliseconds.
   */
  public setMonotonic(nowMs: number): void {
    this.monotonicMs = nowMs;
  }

  /**
   * Sets the wall-clock date directly.
   *
   * @param date - Wall-clock date.
   */
  public setWall(date: Date): void {
    this.wallDate = new Date(date.getTime());
  }
}

/**
 * Test sleeper double that records sleep requests and either executes immediately, advances a test clock, or tracks sleep calls.
 */
export class TestSleeper implements Sleeper {
  public readonly sleeps: number[] = [];
  private readonly autoAdvanceClock?: TestClock;

  public constructor(autoAdvanceClock?: TestClock) {
    this.autoAdvanceClock = autoAdvanceClock;
  }

  public sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted"));
    }
    this.sleeps.push(delayMs);
    if (this.autoAdvanceClock !== undefined && delayMs > 0) {
      this.autoAdvanceClock.advance(delayMs);
    }
    return Promise.resolve();
  }
}

/**
 * Test random source double returning a deterministic sequence of numbers.
 */
export class TestRandomSource implements RandomSource {
  private readonly values: readonly number[];
  private index = 0;

  public constructor(values: readonly number[] = [0]) {
    this.values = values.length === 0 ? [0] : values;
  }

  public next(): number {
    const value = this.values[this.index % this.values.length];
    this.index++;
    return value ?? 0;
  }

  /**
   * Resets the sequence index back to 0.
   */
  public reset(): void {
    this.index = 0;
  }
}
