import assert from "node:assert/strict";
import { test } from "vitest";
import { type DeliverySink, type DeliveryTransport, pumpDelivery } from "../../src/http/delivery.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

interface SinkCalls {
  appended: Uint8Array[];
  completed: number;
  discarded: number;
}

function fakeSink(): { sink: DeliverySink; calls: SinkCalls } {
  const calls: SinkCalls = { appended: [], completed: 0, discarded: 0 };
  const sink: DeliverySink = {
    append: async (chunk) => {
      calls.appended.push(chunk);
    },
    complete: async () => {
      calls.completed++;
    },
    discard: async () => {
      calls.discarded++;
    },
  };
  return { sink, calls };
}

interface TransportCalls {
  writes: Uint8Array[];
  ended: number;
}

function fakeTransport(): {
  transport: DeliveryTransport;
  calls: TransportCalls;
  emit(event: "drain" | "close"): void;
  setWriteResult(predicate: () => boolean): void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const calls: TransportCalls = { writes: [], ended: 0 };
  let writeResult: (() => boolean) | undefined;
  const transport: DeliveryTransport = {
    write(chunk: Uint8Array) {
      calls.writes.push(chunk);
      return writeResult === undefined ? true : writeResult();
    },
    end() {
      calls.ended++;
    },
    once(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: "drain" | "close"): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  };
  return {
    transport,
    calls,
    emit,
    setWriteResult: (predicate: () => boolean) => {
      writeResult = predicate;
    },
  };
}

/** Real stream reader over enqueued chunks, counting pull invocations. */
function chunkedReader(chunks: readonly Uint8Array[]): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pulls: () => number;
} {
  let index = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index++;
    },
  });
  return { reader: stream.getReader(), pulls: () => pulls };
}

function markCounter(): { coordinator: { markClientFirstByte(): void }; marks: () => number } {
  let marks = 0;
  return {
    coordinator: {
      markClientFirstByte() {
        marks++;
      },
    },
    marks: () => marks,
  };
}

test("pumps chunks to the transport and sink and ends cleanly", async () => {
  const chunks = [bytes("a"), bytes("b"), bytes("c")];
  const { reader, pulls } = chunkedReader(chunks);
  const { transport, calls: transportCalls, emit } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator, marks } = markCounter();
  let delivered = 0;
  let settled = 0;

  const result = await pumpDelivery({
    reader,
    transport,
    signal: new AbortController().signal,
    coordinator,
    sink,
    onDelivered: async () => {
      delivered++;
    },
    onSettled: async () => {
      settled++;
    },
  });

  assert.equal(result, "complete");
  assert.deepEqual(transportCalls.writes, chunks);
  assert.deepEqual(sinkCalls.appended, chunks);
  assert.equal(sinkCalls.completed, 1);
  assert.equal(sinkCalls.discarded, 0);
  assert.equal(transportCalls.ended, 1);
  assert.equal(delivered, 1);
  assert.equal(settled, 1);
  assert.ok(marks() >= chunks.length, "first byte marked per accepted chunk");
  assert.equal(pulls(), chunks.length + 1, "one extra pull for the closing read");
  emit("drain"); // no lingering listeners after settle
  emit("close");
});

test("empty body still records first byte and ends", async () => {
  const { reader } = chunkedReader([]);
  const { transport, calls: transportCalls } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator, marks } = markCounter();
  let delivered = 0;
  let settled = 0;

  const result = await pumpDelivery({
    reader,
    transport,
    signal: new AbortController().signal,
    coordinator,
    sink,
    onDelivered: async () => {
      delivered++;
    },
    onSettled: async () => {
      settled++;
    },
  });

  assert.equal(result, "complete");
  assert.equal(transportCalls.writes.length, 0);
  assert.equal(sinkCalls.appended.length, 0);
  assert.equal(sinkCalls.completed, 1);
  assert.equal(transportCalls.ended, 1);
  assert.equal(delivered, 1);
  assert.equal(settled, 1);
  assert.equal(marks(), 1, "terminal mark records first byte for empty bodies");
});

test("in-memory delivery without a sink still ends cleanly", async () => {
  const chunks = [bytes("x"), bytes("y")];
  const { reader } = chunkedReader(chunks);
  const { transport, calls: transportCalls } = fakeTransport();
  const { coordinator } = markCounter();
  let delivered = 0;
  let settled = 0;

  const result = await pumpDelivery({
    reader,
    transport,
    signal: new AbortController().signal,
    coordinator,
    onDelivered: async () => {
      delivered++;
    },
    onSettled: async () => {
      settled++;
    },
  });

  assert.equal(result, "complete");
  assert.deepEqual(transportCalls.writes, chunks);
  assert.equal(transportCalls.ended, 1);
  assert.equal(delivered, 1);
  assert.equal(settled, 1);
});

test("backs off further writes while the transport is full", async () => {
  const chunks = [bytes("a"), bytes("b")];
  const { reader } = chunkedReader(chunks);
  const { transport, calls: transportCalls, emit, setWriteResult } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator } = markCounter();
  let backpressured = false;
  setWriteResult(() => {
    if (!backpressured) {
      backpressured = true;
      return false;
    }
    return true;
  });

  const pumping = pumpDelivery({
    reader,
    transport,
    signal: new AbortController().signal,
    coordinator,
    sink,
  });

  // The first chunk wrote into a full buffer; the pump must wait for drain
  // before reading and writing the next chunk.
  for (let i = 0; i < 100 && transportCalls.writes.length < 1; i++) {
    await Promise.resolve();
  }
  assert.equal(transportCalls.writes.length, 1, "first chunk written");
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  assert.equal(transportCalls.writes.length, 1, "no further write while waiting for drain");

  emit("drain");
  const result = await pumping;
  assert.equal(result, "complete");
  assert.equal(transportCalls.writes.length, 2);
  assert.equal(transportCalls.ended, 1);
  assert.equal(sinkCalls.discarded, 0);
});

test("abort during a read discards the sink, never ends, and settles", async () => {
  const reader = new ReadableStream<Uint8Array>({}).getReader();
  const { transport, calls: transportCalls } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator, marks } = markCounter();
  const controller = new AbortController();
  let delivered = 0;
  let settled = 0;

  const pumping = pumpDelivery({
    reader,
    transport,
    signal: controller.signal,
    coordinator,
    sink,
    onDelivered: async () => {
      delivered++;
    },
    onSettled: async () => {
      settled++;
    },
  });
  controller.abort();
  const result = await pumping;

  assert.equal(result, "aborted");
  assert.equal(sinkCalls.discarded, 1);
  assert.equal(transportCalls.ended, 0);
  assert.equal(delivered, 0);
  assert.equal(settled, 1);
  assert.equal(marks(), 0);
});

test("cancelOnAbort cancels the reader on abort and removes the close listener after settling", async () => {
  const controller = new AbortController();
  const state = { canceled: 0 };
  const reader = {
    read: () => new Promise<never>(() => undefined),
    cancel: () => {
      state.canceled++;
      return Promise.resolve();
    },
    releaseLock: () => undefined,
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const { transport, emit } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator } = markCounter();

  const pumping = pumpDelivery({
    reader,
    transport,
    signal: controller.signal,
    coordinator,
    sink,
    cancelOnAbort: true,
  });

  controller.abort();
  const result = await pumping;
  assert.equal(result, "aborted");
  assert.equal(state.canceled, 1);
  assert.equal(sinkCalls.discarded, 1);

  emit("close"); // listener must have been removed on settle
  assert.equal(state.canceled, 1);
});

test("close event with cancelOnAbort cancels the reader", async () => {
  const controller = new AbortController();
  const state = { canceled: 0 };
  const reader = {
    read: () => new Promise<never>(() => undefined),
    cancel: () => {
      state.canceled++;
      return Promise.resolve();
    },
    releaseLock: () => undefined,
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const { transport, emit } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator } = markCounter();

  const pumping = pumpDelivery({
    reader,
    transport,
    signal: controller.signal,
    coordinator,
    sink,
    cancelOnAbort: true,
  });

  emit("close");
  assert.equal(state.canceled, 1, "transport close cancels the streaming source");

  // Both one-shot cancel listeners fire independently: close already cancelled,
  // so the abort cancels the reader a second time (matching the original wiring).
  controller.abort();
  const result = await pumping;
  assert.equal(result, "aborted");
  assert.equal(state.canceled, 2, "abort after close cancels again, then listeners are removed");
  assert.equal(sinkCalls.discarded, 1);

  emit("close"); // listeners removed after settle
  assert.equal(state.canceled, 2);
});

test("reader error discards the sink, rethrows, and still settles", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });
  const reader = stream.getReader();
  const { transport } = fakeTransport();
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator } = markCounter();
  let settled = 0;

  await assert.rejects(
    pumpDelivery({
      reader,
      transport,
      signal: new AbortController().signal,
      coordinator,
      sink,
      onSettled: async () => {
        settled++;
      },
    }),
    /boom/,
  );
  assert.equal(sinkCalls.discarded, 1);
  assert.equal(settled, 1);
});

test("transport write error discards the sink, rethrows, and still settles", async () => {
  const { reader } = chunkedReader([bytes("a")]);
  const { transport } = fakeTransport();
  transport.write = () => {
    throw new Error("socket gone");
  };
  const { sink, calls: sinkCalls } = fakeSink();
  const { coordinator } = markCounter();
  let settled = 0;

  await assert.rejects(
    pumpDelivery({
      reader,
      transport,
      signal: new AbortController().signal,
      coordinator,
      sink,
      onSettled: async () => {
        settled++;
      },
    }),
    /socket gone/,
  );
  assert.equal(sinkCalls.discarded, 1);
  assert.equal(settled, 1);
});
