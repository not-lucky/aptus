import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "vitest";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import {
  postJson,
  type RunningCli,
  seededSecrets,
  startThreeOriginCli,
  waitFor,
  waitForExit,
} from "../helpers/cli-process.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-shutdown");

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

/** Drain window for every shutdown scenario; the fast request must finish inside it. */
const DRAIN_MS = 600;

function startCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningCli> {
  return startThreeOriginCli(harness, {
    casePrefix: "aptus-shutdown",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-shutdown",
    replacements: {
      "  shutdownDrainMs: 30000": `  shutdownDrainMs: ${DRAIN_MS}`,
    },
  });
}

function chatRequest(cli: RunningCli, secret: string, stream = false): Promise<Response> {
  return postJson(
    cli.clientPort,
    "/chat/completions",
    bearer(secret),
    JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main", stream }),
  );
}

async function readyStatus(
  cli: RunningCli,
): Promise<{ status: number; body: { status: string; traceReady: boolean } }> {
  const response = await fetch(`http://127.0.0.1:${cli.operationsPort}/health/ready`);
  return { status: response.status, body: (await response.json()) as { status: string; traceReady: boolean } };
}

/**
 * Runs the fast-completes / held-aborts drain scenario for one signal.
 *
 * The fast request's body is held by the origin (`deferred` mode) and released
 * by the test only after the signal lands, so the request is deterministically
 * still in flight at drain start yet completes inside the drain window — no
 * wall-clock race with the signal. The held request blocks the gateway's
 * complete-body spool past the drain deadline and is cut off with
 * `cancelled:shutdown`.
 */
async function runDrainScenario(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  const harness = await createThreeOriginHarness();
  const env = seededEnv(signal.toLowerCase());
  const cli = await startCli(harness, signal.toLowerCase());
  try {
    // First response: head served on dispatch, body held until the test
    // releases it after the signal lands (deterministic in-flight state).
    const fastRelease = harness.chatOrigin.enqueueDeferred({ status: 200 });
    // Second response: head arrives, body never ends -> blocks in spooling.
    harness.chatOrigin.enqueue({ status: 200, mode: "held-open" });

    const fast = chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    await waitFor(() => harness.chatOrigin.dispatchCount() === 1, "fast request dispatched", cli.child);
    const held = chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    await waitFor(() => harness.chatOrigin.dispatchCount() === 2, "held request dispatched", cli.child);

    const signalMs = Date.now();
    cli.child.kill(signal);

    // During drain: readiness is 503 degraded (traceReady stays true) while
    // liveness stays 200 ok and /metrics remains scrapable.
    await waitFor(async () => (await readyStatus(cli)).status === 503, "ready 503 during drain", cli.child);
    const ready = await readyStatus(cli);
    assert.equal(ready.body.status, "degraded");
    assert.equal(ready.body.traceReady, true);
    const live = await fetch(`http://127.0.0.1:${cli.operationsPort}/health/live`);
    assert.equal(live.status, 200);
    const metricsRes = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /aptus_shutdown_active_requests 2/);

    // Release the fast request's body: it completes inside the drain window.
    fastRelease.complete(COMPLETE_CHAT_BYTES);
    const fastRes = await fast;
    assert.equal(fastRes.status, 200);
    assert.deepEqual(new Uint8Array(await fastRes.arrayBuffer()), COMPLETE_CHAT_BYTES);

    // The held request is cut off at the drain deadline, not before.
    await assert.rejects(held);
    assert.ok(
      Date.now() - signalMs >= 400,
      `held request must wait for the drain deadline, aborted after ${Date.now() - signalMs}ms`,
    );

    // The process exits cleanly with the shutdown telemetry flushed.
    const exit = await waitForExit(cli.child);
    assert.equal(exit.code, 0, `stdout: ${cli.stdout}`);
    assert.equal(exit.signal, null);
    assert.match(cli.stdout, /aptus\.shutdown\.started/);
    assert.match(cli.stdout, /aptus\.shutdown\.completed/);
    assert.match(cli.stdout, /aptus\.request\.cancelled/);
    assert.match(cli.stdout, /"by":"shutdown"/);
    assert.match(cli.stdout, /"drained":1/);
    assert.match(cli.stdout, /"aborted":1/);

    // Exactly the two Chat dispatches; the other origins saw none.
    assert.equal(harness.chatOrigin.dispatchCount(), 2);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
}

test.concurrent("process: SIGTERM drains fast request to completion and aborts the held request at the deadline", async () => {
  await runDrainScenario("SIGTERM");
});

test.concurrent("process: SIGINT drains fast request to completion and aborts the held request at the deadline", async () => {
  await runDrainScenario("SIGINT");
});

test.concurrent("process: second signal during drain aborts immediately with {drained: 0, aborted: N}", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("abort");
  const cli = await startCli(harness, "abort");
  try {
    harness.chatOrigin.enqueue({ status: 200, mode: "held-open" });

    const held = chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    await waitFor(() => harness.chatOrigin.dispatchCount() === 1, "held request dispatched", cli.child);

    // First signal starts the drain.
    cli.child.kill("SIGTERM");
    await waitFor(async () => (await readyStatus(cli)).status === 503, "ready 503 during drain", cli.child);

    // Second signal forces the abort without waiting for the deadline.
    const secondSignalMs = Date.now();
    cli.child.kill("SIGINT");
    await assert.rejects(held);
    const exit = await waitForExit(cli.child);
    assert.equal(exit.code, 0, `stdout: ${cli.stdout}`);
    assert.ok(
      Date.now() - secondSignalMs < 400,
      `second signal must abort well under the ${DRAIN_MS}ms drain, took ${Date.now() - secondSignalMs}ms`,
    );
    assert.match(cli.stdout, /aptus\.shutdown\.completed/);
    assert.match(cli.stdout, /"drained":0/);
    assert.match(cli.stdout, /"aborted":1/);
    assert.match(cli.stdout, /"by":"shutdown"/);

    assert.equal(harness.chatOrigin.dispatchCount(), 1);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: idle SIGTERM closes without traces and reports zero drained and aborted", async () => {
  const harness = await createThreeOriginHarness();
  const cli = await startCli(harness, "idle");
  try {
    cli.child.kill("SIGTERM");
    const exit = await waitForExit(cli.child);
    assert.equal(exit.code, 0, `stdout: ${cli.stdout}`);
    assert.equal(exit.signal, null);
    assert.match(cli.stdout, /aptus\.shutdown\.completed/);
    assert.match(cli.stdout, /"drained":0/);
    assert.match(cli.stdout, /"aborted":0/);

    // No request traces were committed (the dot-prefixed startup probe is cleaned up).
    assert.deepEqual(
      readdirSync(cli.traceRoot).filter((name) => !name.startsWith(".")),
      [],
    );

    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});
