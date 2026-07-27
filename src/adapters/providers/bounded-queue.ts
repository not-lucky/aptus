import type { ProviderAdapterLimits } from "./types.js";

type Waiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};
type ProducerWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** Bounded cancellation-aware async queue with high/low-water backpressure. */
export class BoundedAsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly consumers: Waiter<T>[] = [];
  private readonly producers: ProducerWaiter[] = [];
  private readonly onAbort = (): void => this.cancel();
  private terminal: "open" | "closed" | "failed" = "open";
  private failure: unknown;

  /** Creates a queue using already validated capacity and watermarks. */
  public constructor(
    private readonly limits: Pick<
      ProviderAdapterLimits,
      "queueCapacity" | "highWaterMark" | "lowWaterMark"
    >,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.cancel();
  }

  /** Enqueues one value, pausing at high water until low water is reached. */
  public async push(value: T): Promise<void> {
    this.throwIfUnavailable();
    if (this.values.length >= this.limits.highWaterMark) {
      await new Promise<void>((resolve, reject) => {
        this.producers.push({ resolve, reject });
      });
      this.throwIfUnavailable();
    }
    if (this.values.length >= this.limits.queueCapacity) {
      throw new Error("bounded queue capacity exceeded");
    }
    const consumer = this.consumers.shift();
    if (consumer !== undefined) {
      if (this.signal.aborted) {
        consumer.reject(this.signal.reason);
        this.cancel();
        throw this.signal.reason;
      }
      consumer.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  /** Returns the next value, terminal failure, or completed iterator result. */
  public async next(): Promise<IteratorResult<T>> {
    if (this.signal.aborted) {
      this.cancel();
      throw this.signal.reason;
    }
    if (this.terminal === "failed") throw this.failure;
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      this.resumeProducersIfLow();
      if (this.signal.aborted) {
        this.cancel();
        throw this.signal.reason;
      }
      if (this.values.length === 0 && this.terminal === "closed") {
        for (const consumer of this.consumers.splice(0)) {
          consumer.resolve({ done: true, value: undefined });
        }
      }
      return { done: false, value };
    }
    if (this.terminal === "closed") return { done: true, value: undefined };
    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      this.consumers.push({ resolve, reject });
    });
  }

  /** Completes consumers after all already queued values are consumed. */
  public close(): void {
    if (this.terminal !== "open") return;
    this.terminal = "closed";
    this.rejectProducers(new Error("bounded queue closed"));
    if (this.values.length === 0) {
      for (const consumer of this.consumers.splice(0)) {
        consumer.resolve({ done: true, value: undefined });
      }
    }
    this.detachAbort();
  }

  /** Rejects all operations with one terminal failure and clears stored values. */
  public fail(error: unknown): void {
    if (this.terminal !== "open") return;
    this.terminal = "failed";
    this.failure = error;
    this.values.length = 0;
    this.rejectProducers(error);
    for (const consumer of this.consumers.splice(0)) consumer.reject(error);
    this.detachAbort();
  }

  /** Returns the number of retained values. */
  public size(): number {
    return this.values.length;
  }

  private throwIfUnavailable(): void {
    if (this.signal.aborted) {
      this.cancel();
      throw this.signal.reason;
    }
    if (this.terminal === "failed") throw this.failure;
    if (this.terminal === "closed") throw new Error("bounded queue closed");
  }

  private resumeProducersIfLow(): void {
    if (this.values.length > this.limits.lowWaterMark) return;
    for (const producer of this.producers.splice(0)) {
      if (this.signal.aborted) producer.reject(this.signal.reason);
      else producer.resolve();
    }
  }

  private cancel(): void {
    if (this.terminal !== "open") return;
    this.terminal = "failed";
    this.failure = this.signal.reason;
    this.values.length = 0;
    this.rejectProducers(this.signal.reason);
    for (const consumer of this.consumers.splice(0)) {
      consumer.reject(this.signal.reason);
    }
    this.detachAbort();
  }

  private rejectProducers(error: unknown): void {
    for (const producer of this.producers.splice(0)) producer.reject(error);
  }

  private detachAbort(): void {
    this.signal.removeEventListener("abort", this.onAbort);
  }
}
