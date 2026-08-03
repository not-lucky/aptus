import assert from "node:assert/strict";
import { test } from "vitest";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import { classifyAbortReason } from "../../src/routing/attempt.ts";
import type { TerminalFact, TraceSession } from "../../src/domain/contracts.ts";

test("classifyAbortReason classifies timeout, shutdown, and client correctly", () => {
  const timeoutCtrl = new AbortController();
  timeoutCtrl.abort("timeout");
  assert.equal(classifyAbortReason(timeoutCtrl.signal), "timeout");

  const shutdownCtrl = new AbortController();
  shutdownCtrl.abort("shutdown");
  assert.equal(classifyAbortReason(shutdownCtrl.signal), "shutdown");

  const clientCtrl = new AbortController();
  clientCtrl.abort("client");
  assert.equal(classifyAbortReason(clientCtrl.signal), "client");

  const defaultCtrl = new AbortController();
  defaultCtrl.abort();
  assert.equal(classifyAbortReason(defaultCtrl.signal), "client");
});

test("AbortSignal.any preserves the reason of the first aborting signal", () => {
  const perRequest = new AbortController();
  const shutdown = new AbortController();

  const signal = AbortSignal.any([perRequest.signal, shutdown.signal]);

  shutdown.abort("shutdown");
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, "shutdown");
  assert.equal(classifyAbortReason(signal), "shutdown");
});

test("TerminalCoordinator tracks attempt counts and uses them on cancellation", async () => {
  let completedFact: any = null;
  const mockTrace: TraceSession = {
    recordJson: async () => {},
    recordBytes: async () => {},
    openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
    finish: async () => {},
  };
  const mockObserver = {
    requestTerminal: () => {},
    observe: () => {},
    completed: (fields: any) => {
      completedFact = fields;
    },
    httpTerminal: () => {},
    firstByte: () => {},
  };

  const coordinator = createTerminalCoordinator({
    aptusRequestId: "test-req-id" as any,
    endpointProtocol: "openai-chat",
    startedMs: 0,
    trace: mockTrace,
    observer: mockObserver as any,
  });

  coordinator.markIngress(false);

  // Initially 0 attempts
  assert.equal(coordinator.getAttempts(), 0);

  // Dispatch records attempt 1
  coordinator.recordAttempt(1);
  assert.equal(coordinator.getAttempts(), 1);

  // Dispatch records attempt 2
  coordinator.recordAttempt(2);
  assert.equal(coordinator.getAttempts(), 2);

  // Finalize cancellation with attempts: 0 (e.g. from client disconnect race)
  const fact: TerminalFact = {
    terminal: { kind: "cancelled", by: "shutdown" },
    outcomeCategory: "cancelled",
    status: 499,
    attempts: 0, // client-app had 0 or lost race, coordinator should use recorded 2
    stream: false,
    durationMs: 100,
    canonicalPublicName: "gpt-main",
  };

  await coordinator.finalize(fact);
  await coordinator.finalized;

  assert.equal(completedFact?.attempts, 2);
  assert.equal(completedFact?.outcomeCategory, "cancelled");
});

test("TerminalCoordinator falls back to shutdown_abort when trace.finish rejects on shutdown cancellation", async () => {
  let finishCalls: any[] = [];
  const mockTrace: TraceSession = {
    recordJson: async () => {},
    recordBytes: async () => {},
    openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
    finish: async (terminal) => {
      finishCalls.push(terminal);
      if (terminal.kind === "cancelled" && terminal.by === "shutdown") {
        throw new Error("Disk write failed during shutdown");
      }
    },
  };
  const mockObserver = {
    requestTerminal: () => {},
    observe: () => {},
    completed: () => {},
    httpTerminal: () => {},
    firstByte: () => {},
  };

  const coordinator = createTerminalCoordinator({
    aptusRequestId: "test-req-id" as any,
    endpointProtocol: "openai-chat",
    startedMs: 0,
    trace: mockTrace,
    observer: mockObserver as any,
  });

  coordinator.markIngress(false);

  const fact: TerminalFact = {
    terminal: { kind: "cancelled", by: "shutdown" },
    outcomeCategory: "cancelled",
    status: 499,
    attempts: 1,
    stream: false,
    durationMs: 100,
    canonicalPublicName: "gpt-main",
  };

  await coordinator.finalize(fact);
  await coordinator.finalized;

  assert.equal(finishCalls.length, 2);
  assert.deepEqual(finishCalls[0], { kind: "cancelled", by: "shutdown" });
  assert.deepEqual(finishCalls[1], { kind: "incomplete", reason: "shutdown_abort" });
});
