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
    },
    triggerClose() {
      closeCallback?.();
    },
  };
  return mock as unknown as Server & MockServer;
}

test("createGracefulShutdown returns the active shutdown promise on multiple calls", async () => {
  const client = mockServer();
  const operations = mockServer();
  let drainingCalls = 0;
  let abortActiveCalls = 0;

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 1000,
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);

  // Trigger client close then operations close
  client.triggerClose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  operations.triggerClose();
  await firstPromise;

  assert.equal(resolved, true);
  assert.equal(operations.closeCalled, true);
  assert.equal(abortActiveCalls, 1);

  // Subsequent call after shutdown completes also returns the same resolved promise
  const fourthPromise = shutdown.run();
  assert.equal(fourthPromise, firstPromise);
  await fourthPromise;
});

test("createGracefulShutdown abort forces immediate active abort", async () => {
  const client = mockServer();
  const operations = mockServer();
  let abortActiveCalls = 0;

  const shutdown = createGracefulShutdown({
    client,
    operations,
    drainMs: 10000,
    onDraining() {},
    onAbortActive() {
      abortActiveCalls++;
    },
  });

  void shutdown.run();
  shutdown.abort();

  assert.equal(abortActiveCalls, 1);
  assert.equal(client.closeAllCalled, true);
});
