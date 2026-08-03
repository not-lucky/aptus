import assert from "node:assert/strict";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { postJson, seededSecrets, startThreeOriginCli, waitFor } from "../helpers/cli-process.ts";
import { createThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trace-degradation");

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

async function chatRequest(cli: { readonly clientPort: number }, secret: string): Promise<Response> {
  return postJson(
    cli.clientPort,
    "/chat/completions",
    bearer(secret),
    JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main" }),
  );
}

async function ready(cli: {
  readonly operationsPort: number;
}): Promise<{ status: number; body: { status: string; traceReady: boolean } }> {
  const response = await fetch(`http://127.0.0.1:${cli.operationsPort}/health/ready`);
  return { status: response.status, body: (await response.json()) as { status: string; traceReady: boolean } };
}

test.concurrent("process: an unwritable trace root degrades readiness while traffic stays 200, then recovers", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("degrade");
  const cli = await startThreeOriginCli(harness, {
    casePrefix: "aptus-trace-degradation",
    caseName: "degrade",
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trace-degradation",
  });
  try {
    // 1. Initial request succeeds and readiness is healthy.
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const initial = await chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    assert.equal(initial.status, 200);
    assert.deepEqual(new Uint8Array(await initial.arrayBuffer()), COMPLETE_CHAT_BYTES);
    const initialReady = await ready(cli);
    assert.equal(initialReady.status, 200);
    assert.equal(initialReady.body.traceReady, true);

    // 2. Block the trace root deterministically without chmod (a no-op as
    // root): move the live directory aside and put a regular file at its path,
    // so the per-session mkdir fails with ENOTDIR regardless of UID.
    const blockedRoot = `${cli.traceRoot}.bak`;
    renameSync(cli.traceRoot, blockedRoot);
    writeFileSync(cli.traceRoot, "blocked");

    // 3. The next request still succeeds (trace failures never fail traffic).
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const degraded = await chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    assert.equal(degraded.status, 200);
    assert.deepEqual(new Uint8Array(await degraded.arrayBuffer()), COMPLETE_CHAT_BYTES);

    // 4. Readiness turns degraded while liveness stays 200, and the
    // trace_start failure is recorded. (The trace root is a plain file here,
    // so trace directories must not be listed.)
    await waitFor(async () => (await ready(cli)).status === 503, "ready 503 degraded", cli.child);
    const degradedReady = await ready(cli);
    assert.equal(degradedReady.body.status, "degraded");
    assert.equal(degradedReady.body.traceReady, false);
    const live = await fetch(`http://127.0.0.1:${cli.operationsPort}/health/live`);
    assert.equal(live.status, 200);

    const metricsRes = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /aptus_trace_write_failures_total\{operation="trace_start"\} 1/);
    assert.match(cli.stdout, /aptus\.trace\.failure/);

    // 5. Restore the real directory.
    unlinkSync(cli.traceRoot);
    renameSync(blockedRoot, cli.traceRoot);

    // 6. The next request writes its trace successfully and readiness recovers.
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const recovered = await chatRequest(cli, env.APTUS_CLIENT_PRIMARY);
    assert.equal(recovered.status, 200);
    assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), COMPLETE_CHAT_BYTES);
    await waitFor(async () => (await ready(cli)).status === 200, "ready 200 recovered", cli.child);
    const recoveredReady = await ready(cli);
    assert.equal(recoveredReady.body.status, "ok");
    assert.equal(recoveredReady.body.traceReady, true);

    // 7. Exactly the three Chat dispatches; the other origins saw none.
    assert.equal(harness.chatOrigin.dispatchCount(), 3);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});
