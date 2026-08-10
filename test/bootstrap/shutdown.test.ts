import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "vitest";
import { createGracefulShutdown } from "../../src/bootstrap/shutdown.ts";

interface MockServer {
  listening: boolean;
  closeCalled: boolean;
  closeIdleCalled: boolean;
  closeAllCalled: boolean;
  triggerClose: () => void;
  close(callback?: () => void): this;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

/**
 * Builds a mock HTTP server. `closeAllConnections()` resolves the pending
 * `close()` callback, mirroring the real server where destroying every active
 * connection lets the close callback fire.
 */
function mockServer(): Server & MockServer {
  let closeCallback: (() => void) | undefined;
  const mock: MockServer = {
    listening: true,
    closeCalled: false,
    closeIdleCalled: false,
    closeAllCalled: false,
    close(callback?: () => void) {
      mock.closeCalled = true;
      closeCallback = callback;
      return this;
    },
    closeIdleConnections() {
      mock.closeIdleCalled = true;
    },
    closeAllConnections() {
      mock.closeAllCalled = true;
      closeCallback?.();
    },
    triggerClose() {
      closeCallback?.();
    },
  };
  return mock as unknown as Server & MockServer;
}

/** Mock cancellation registry with a fixed active count. */
function mockCancellations(active: number): {
  size(): number;
  registeredCount(): number;
  register(): () => void;
  abortAll(): void;
  awaitSettled(): Promise<void>;
} {
  return {
    size: () => active,
    // Nothing registers during shutdown in these tests, so the cumulative
    // count equals the active count.
    registeredCount: () => active,
    register: () => () => {},
    abortAll: () => {},
    awaitSettled: async () => {},
  };
}

/** Captures observer events without touching the real telemetry stack. */
function mockObserver(): {
  shutdownStarted(fields: unknown): void;
  shutdownCompleted(fields: unknown): void;
  started: unknown[];
  completed: unknown[];
} {
  const started: unknown[] = [];
  const completed: unknown[] = [];
  return {
    shutdownStarted(fields: unknown) {
      started.push(fields);
    },
    shutdownCompleted(fields: unknown) {
      completed.push(fields);
    },
    started,
    completed,
  };
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.concurrent("createGracefulShutdown returns the active shutdown promise on multiple calls and drains without aborting", async () => {
  const client = mockServer();
  const operations = mockServer();
  const observer = mockObserver();
  let drainingCalls = 0;
  let abortActiveCalls = 0;

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 1000,
    cancellations: mockCancellations(2),
    observer: observer as never,
    onDraining() {
      drainingCalls++;
    },
    onAbortActive() {
      abortActiveCalls++;
    },
  });

  const firstPromise = shutdown.run();
  const secondPromise = shutdown.run();
  const thirdPromise = shutdown.run();

  assert.equal(firstPromise, secondPromise);
  assert.equal(secondPromise, thirdPromise);
  assert.equal(drainingCalls, 1);
  assert.equal(client.closeCalled, true);
  assert.equal(client.closeIdleCalled, true);

  // Still waiting on client close
  let resolved = false;
  void firstPromise.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);

  // Trigger client close then operations close
  client.triggerClose();
  await waitForCondition(() => operations.closeCalled);
  operations.triggerClose();
  await firstPromise;

  assert.equal(resolved, true);
  assert.equal(operations.closeCalled, true);
  // Natural drain aborts nothing: no forced abort, no connection severing.
  assert.equal(abortActiveCalls, 0);
  assert.equal(client.closeAllCalled, false);
  // Both active requests finished within the drain window.
  assert.equal(observer.completed.length, 1);
  assert.equal((observer.completed[0] as { drained: number }).drained, 2);
  assert.equal((observer.completed[0] as { aborted: number }).aborted, 0);
  assert.equal((observer.completed[0] as { durationMs: number }).durationMs >= 0, true);

  // Subsequent call after shutdown completes also returns the same resolved promise
  const fourthPromise = shutdown.run();
  assert.equal(fourthPromise, firstPromise);
  await fourthPromise;
  assert.equal(abortActiveCalls, 0, "late run() must not force-abort after natural drain");
});

test.concurrent("createGracefulShutdown abort forces immediate active abort and reports the exact aborted count", async () => {
  const client = mockServer();
  const operations = mockServer();
  const observer = mockObserver();
  let abortActiveCalls = 0;
  const shutdownController = new AbortController();

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 10000,
    shutdownController,
    cancellations: mockCancellations(2),
    observer: observer as never,
    onDraining() {},
    onAbortActive() {
      abortActiveCalls++;
    },
  });

  void shutdown.run();
  shutdown.abort();
  // The forced abort resolves the client close synchronously; wait for
  // the sequence to reach `closeOperations` before releasing the operations mock.
  await waitForCondition(() => operations.closeCalled);
  operations.triggerClose();
  await shutdown.run();

  assert.equal(abortActiveCalls, 1);
  assert.equal(client.closeAllCalled, true);
  assert.equal(shutdownController.signal.aborted, true);
  assert.equal(shutdownController.signal.reason, "shutdown");
  // Both requests were still registered when the second signal arrived.
  assert.equal(observer.completed.length, 1);
  assert.equal((observer.completed[0] as { drained: number }).drained, 0);
  assert.equal((observer.completed[0] as { aborted: number }).aborted, 2);
});

test.concurrent("createGracefulShutdown deadline timer aborts remaining requests and reports {drained: 0, aborted: N}", async () => {
  const client = mockServer();
  const operations = mockServer();
  const observer = mockObserver();
  let abortActiveCalls = 0;
  const shutdownController = new AbortController();

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 20,
    shutdownController,
    cancellations: mockCancellations(3),
    observer: observer as never,
    onDraining() {},
    onAbortActive() {
      abortActiveCalls++;
    },
  });

  // The client never drains naturally: the timer fires first.
  const promise = shutdown.run();
  await waitForCondition(() => operations.closeCalled);
  operations.triggerClose();
  await promise;

  assert.equal(abortActiveCalls, 1);
  assert.equal(client.closeAllCalled, true);
  assert.equal(shutdownController.signal.aborted, true);
  assert.equal(shutdownController.signal.reason, "shutdown");
  assert.equal(observer.completed.length, 1);
  assert.equal((observer.completed[0] as { drained: number }).drained, 0);
  assert.equal((observer.completed[0] as { aborted: number }).aborted, 3);
});

test.concurrent("createGracefulShutdown idle shutdown reports zero drained and zero aborted", async () => {
  const client = mockServer();
  const operations = mockServer();
  const observer = mockObserver();
  let abortActiveCalls = 0;

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 1000,
    cancellations: mockCancellations(0),
    observer: observer as never,
    onDraining() {},
    onAbortActive() {
      abortActiveCalls++;
    },
  });

  void shutdown.run();
  client.triggerClose();
  // Let the natural-drain sequence reach `closeOperations` before releasing
  // the operations mock.
  await waitForCondition(() => operations.closeCalled);
  operations.triggerClose();
  await shutdown.run();

  assert.equal(abortActiveCalls, 0);
  assert.equal(observer.completed.length, 1);
  assert.equal((observer.completed[0] as { drained: number }).drained, 0);
  assert.equal((observer.completed[0] as { aborted: number }).aborted, 0);
});

test.concurrent("createGracefulShutdown orders retention stop after drain and before operations close, emitting observer events", async () => {
  const client = mockServer();
  const operations = mockServer();
  const order: string[] = [];
  const startedEvents: unknown[] = [];
  const completedEvents: unknown[] = [];

  const mockObserver = {
    shutdownStarted(fields: unknown) {
      order.push("observer:shutdownStarted");
      startedEvents.push(fields);
    },
    shutdownCompleted(fields: unknown) {
      order.push("observer:shutdownCompleted");
      completedEvents.push(fields);
    },
  };

  const mockRetention = {
    stop() {
      order.push("retention:stop");
    },
  };

  const mockCancellationsRegistry = {
    size() {
      return 2;
    },
    registeredCount() {
      return 2;
    },
    register() {
      return () => {};
    },
    abortAll() {},
    async awaitSettled() {
      order.push("cancellations:awaitSettled");
    },
  };

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 50,
    observer: mockObserver as never,
    retentionScheduler: mockRetention as never,
    cancellations: mockCancellationsRegistry as never,
    onDraining() {
      order.push("onDraining");
    },
    onAbortActive() {
      order.push("onAbortActive");
    },
    onShutdown() {
      order.push("onShutdown");
    },
  });

  const shutdownPromise = shutdown.run();

  // Initially onDraining and shutdownStarted fired
  assert.equal(order[0], "observer:shutdownStarted");
  assert.equal(order[1], "onDraining");

  // Client finishes draining naturally (no forced abort on this path)
  client.triggerClose();
  await waitForCondition(() => operations.closeCalled);
  operations.triggerClose();
  await shutdownPromise;

  // Verify full ordering: drain -> awaitSettled -> retention:stop -> closeOperations -> onShutdown -> observer:shutdownCompleted
  assert.deepEqual(order, [
    "observer:shutdownStarted",
    "onDraining",
    "cancellations:awaitSettled",
    "retention:stop",
    "onShutdown",
    "observer:shutdownCompleted",
  ]);
  assert.equal(startedEvents.length, 1);
  assert.equal(completedEvents.length, 1);
  assert.equal((completedEvents[0] as { drained: number }).drained, 2);
  assert.equal((completedEvents[0] as { aborted: number }).aborted, 0);
});
