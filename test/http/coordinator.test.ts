import assert from "node:assert/strict";
import { test } from "vitest";
import type { TerminalFact, TraceSession } from "../../src/domain/contracts.ts";
import type { TraceTerminal } from "../../src/domain/operations.ts";
import { createRequestId } from "../../src/domain/request-id.ts";
import { createTerminalCoordinator } from "../../src/http/coordinator.ts";
import { createTrackingObserver, eventsOf } from "../helpers/tracking-observer.ts";
import { systemClock } from "../../src/routing/timing.ts";

const noopTrace: TraceSession = {
  recordJson: async () => {},
  recordBytes: async () => {},
  openBytes: () => ({ append: async () => {}, complete: async () => {}, discard: async () => {} }),
  finish: async () => {},
};

function completeFact(): TerminalFact {
  return {
    terminal: { kind: "complete", status: 200 },
    outcomeCategory: "complete",
    status: 200,
    attempts: 1,
    stream: false,
    durationMs: 10,
  };
}

test.concurrent("pre-ingress finalization writes the trace terminal but skips accepted-request telemetry", async () => {
  const { observer, events } = createTrackingObserver();
  const terminals: TraceTerminal[] = [];
  const trace: TraceSession = {
    ...noopTrace,
    finish: async (terminal) => {
      terminals.push(terminal);
    },
  };

  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace,
    observer,
  });

  const result = await coordinator.finalize(completeFact());
  await coordinator.finalized;

  assert.equal(result.won, true);
  assert.deepEqual(terminals, [{ kind: "complete", status: 200 }]);
  assert.equal(
    eventsOf(events, "request_terminal").length,
    0,
    "must not emit terminal telemetry before ingress",
  );
});

test.concurrent("post-ingress finalization is atomic across duplicate claims", async () => {
  const { observer, events } = createTrackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);

  const first = await coordinator.finalize(completeFact());
  const second = await coordinator.finalize(completeFact());
  await coordinator.finalized;

  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.equal(eventsOf(events, "request_terminal").length, 1, "one terminal moment despite duplicate claims");
});

test.concurrent("pre-Gateway finalization records HTTP terminal without the completion log", async () => {
  const { observer, events } = createTrackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);

  await coordinator.finalize({
    ...completeFact(),
    attempts: 0,
    canonicalPublicName: "unknown",
    emitCompleted: false,
  });
  await coordinator.finalized;

  const terminals = eventsOf(events, "request_terminal");
  assert.equal(terminals.length, 1, "pre-Gateway failures still record the terminal moment");
  assert.equal(terminals[0]?.emitCompleted, false, "pre-Gateway failures must not emit aptus.request.completed");
  assert.equal(terminals[0]?.firstByteMs, undefined, "no attempt means no first-byte timing");
});

test.concurrent("first-byte timing is carried on the terminal moment with the winning attempt number when marked", async () => {
  const { observer, events } = createTrackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: 0,
    clock: { nowMonotonicMs: () => 45, nowWall: systemClock.nowWall },
    trace: noopTrace,
    observer,
  });

  coordinator.markIngress(false);
  coordinator.markClientFirstByte();

  await coordinator.finalize({ ...completeFact(), attempts: 3 });
  await coordinator.finalized;

  const terminal = eventsOf(events, "request_terminal")[0];
  assert.ok(terminal, "a terminal moment must be emitted after ingress");
  assert.equal(terminal.attempts, 3);
  assert.equal(terminal.firstByteMs, 45);
});

test.concurrent("in-flight decrement uses the admitted stream label, not the terminal stream", async () => {
  const { observer, events } = createTrackingObserver();
  const coordinator = createTerminalCoordinator({
    aptusRequestId: createRequestId(),
    endpointProtocol: "openai-chat",
    startedMs: systemClock.nowMonotonicMs(),
    trace: noopTrace,
    observer,
  });

  // Dry run: ingress admitted stream=true, terminal reports stream=false.
  coordinator.markIngress(true);

  await coordinator.finalize({ ...completeFact(), stream: false, attempts: 0 });
  await coordinator.finalized;

  const terminal = eventsOf(events, "request_terminal")[0];
  assert.ok(terminal, "a terminal moment must be emitted after ingress");
  assert.equal(terminal.admissionStream, true, "decrement must balance the ingress increment");
  assert.equal(terminal.stream, false, "the terminal stream label is carried separately");
});
