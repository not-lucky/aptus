import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "vitest";
import { MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { type RunningCli, seededSecrets, startThreeOriginCli, traceFiles, waitFor } from "../helpers/cli-process.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-cancellation");

function startCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningCli> {
  return startThreeOriginCli(harness, {
    casePrefix: "aptus-cancellation",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-cancellation",
  });
}

/** Fetches the /metrics text from the operations listener. */
async function metricsText(cli: RunningCli): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
  return response.text();
}

/** The newest non-dot trace directory under the trace root. */
function traceDir(cli: RunningCli): string {
  const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir, "no trace directory committed");
  return dir;
}

/** Reads the newest trace directory's terminal file. */
function terminalJson(cli: RunningCli): { kind: string; by?: string } {
  const dir = traceDir(cli);
  const names = readdirSync(join(cli.traceRoot, dir));
  assert.ok(names.includes("999_terminal.json"), `missing 999_terminal.json in ${names.join(",")}`);
  const raw = readFileSync(join(cli.traceRoot, dir, "999_terminal.json"), "utf8");
  return JSON.parse(raw) as { kind: string; by?: string };
}

/** Reads the newest trace directory's cancellation stage, if any. */
function cancellationStage(cli: RunningCli): { phase?: string; by?: string } | undefined {
  const dir = traceDir(cli);
  const names = readdirSync(join(cli.traceRoot, dir));
  const stage = names.find((name) => /^\d{3}_cancellation\.json$/.test(name));
  if (stage === undefined) return undefined;
  return JSON.parse(readFileSync(join(cli.traceRoot, dir, stage), "utf8")) as { phase?: string; by?: string };
}

test.concurrent("process: client disconnect before response head aborts dispatch with cancelled:client", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("preheaders");
  const cli = await startCli(harness, "preheaders");
  try {
    // The held head makes the request provably dispatched (past admission)
    // before the client destroys the socket.
    harness.chatOrigin.enqueue({ status: 200, mode: "complete", body: "{}", headDelayMs: 2000 });

    await new Promise<void>((resolveTest, rejectTest) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: cli.clientPort,
          path: "/chat/completions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
          },
        },
        () => rejectTest(new Error("unexpected response head before client destroy")),
      );
      request.on("error", () => undefined);
      request.end(JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main" }));
      void waitFor(() => harness.chatOrigin.dispatchCount() === 1, "request dispatched to origin", cli.child).then(
        () => {
          request.destroy();
          resolveTest();
        },
        rejectTest,
      );
    });

    // The origin observed the socket close from the cancellation.
    await waitFor(
      () => harness.chatOrigin.lastRequest()?.cancelledAtMs !== undefined,
      "origin socket close",
      cli.child,
    );

    // Terminal trace records a client cancellation.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write", cli.child);
    assert.deepEqual(terminalJson(cli), { kind: "cancelled", by: "client" });

    // The cancellation log carries by:client exactly once (the attempt seam
    // owns the emission; the client-app fallback must not duplicate it); the
    // accepted-request counter records the cancelled outcome exactly once
    // (ingress was reached).
    await waitFor(() => /aptus\.request\.cancelled/.test(cli.stdout), "cancelled log", cli.child);
    assert.match(cli.stdout, /"by":"client"/);
    assert.equal((cli.stdout.match(/aptus\.request\.cancelled/g) ?? []).length, 1);
    let text = "";
    await waitFor(
      async () => {
        text = await metricsText(cli);
        return /aptus_http_requests_total\{[^}]*outcome_category="cancelled"/.test(text);
      },
      "cancelled HTTP counter",
      cli.child,
    );
    assert.match(
      text,
      /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="cancelled",stream="false"\} 1/,
    );

    // No retry or fallback dispatch occurred.
    assert.equal(harness.chatOrigin.dispatchCount(), 1);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: client disconnect during admission aborts before any dispatch with no cancelled counter", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("admission");
  const cli = await startCli(harness, "admission");
  try {
    // The body is never completed, so admission is still streaming when the
    // socket is destroyed; no provider is ever contacted.
    await new Promise<void>((resolveTest, rejectTest) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: cli.clientPort,
          path: "/chat/completions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
            "content-length": "100000",
          },
        },
        () => rejectTest(new Error("unexpected response head before admission abort")),
      );
      request.on("error", () => undefined);
      request.write(JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main" }), () => {
        setImmediate(() => {
          request.destroy();
          resolveTest();
        });
      });
    });

    // Terminal trace records a client cancellation from the admission phase.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write", cli.child);
    assert.deepEqual(terminalJson(cli), { kind: "cancelled", by: "client" });
    await waitFor(() => /aptus\.request\.cancelled/.test(cli.stdout), "cancelled log", cli.child);
    assert.match(cli.stdout, /"phase":"admission"/);
    assert.equal((cli.stdout.match(/aptus\.request\.cancelled/g) ?? []).length, 1);

    // Admission aborts never reach the ingress boundary, so the accepted
    // request counter has no cancelled series at all.
    const text = await metricsText(cli);
    assert.doesNotMatch(text, /aptus_http_requests_total\{[^}]*outcome_category="cancelled"/);

    // Zero dispatch on every origin.
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: client disconnect mid-stream stops the relay with cancelled:client and no partial stream files", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("midstream");
  const cli = await startCli(harness, "midstream");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [
        { bytes: 'data: {"delta":"first"}\n\n', delayMs: 0 },
        { bytes: 'data: {"delta":"second"}\n\n', delayMs: 500 },
        { bytes: "data: [DONE]\n\n", delayMs: 500 },
      ],
    });

    let received = "";
    let destroyedAtMs = 0;
    await new Promise<void>((resolveTest) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: cli.clientPort,
          path: "/chat/completions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
          },
        },
        (response) => {
          assert.equal(response.statusCode, 200);
          response.on("data", (chunk: Buffer) => {
            received += chunk.toString();
            // Destroy once the first complete SSE event has arrived.
            if (received.includes('"first"')) {
              destroyedAtMs = Date.now();
              request.destroy();
              resolveTest();
            }
          });
          response.on("error", () => undefined);
        },
      );
      request.on("error", () => undefined);
      request.end(JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main", stream: true }));
    });

    // The provider observed the socket close promptly after the destroy.
    await waitFor(
      () => harness.chatOrigin.lastRequest()?.cancelledAtMs !== undefined,
      "origin socket close",
      cli.child,
    );
    const cancelledAtMs = harness.chatOrigin.lastRequest()?.cancelledAtMs;
    assert.ok(cancelledAtMs !== undefined);
    assert.ok(cancelledAtMs - destroyedAtMs <= 200, `provider cancel within 200ms: ${cancelledAtMs - destroyedAtMs}ms`);

    // No additional bytes may arrive after the destroy, and no forged [DONE].
    assert.doesNotMatch(received, /\[DONE\]/);
    assert.doesNotMatch(received, /"second"/);

    // Terminal trace records a client cancellation from the relay phase.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write", cli.child);
    assert.deepEqual(terminalJson(cli), { kind: "cancelled", by: "client" });
    assert.deepEqual(cancellationStage(cli), { phase: "relay", by: "client" });
    await waitFor(() => /aptus\.request\.cancelled/.test(cli.stdout), "cancelled log", cli.child);
    assert.match(cli.stdout, /"phase":"relay"/);
    assert.match(cli.stdout, /"by":"client"/);
    // Exactly one cancellation log line: the relay's cancel() seam owns the
    // emission and the client-app fallback must not duplicate it.
    assert.equal((cli.stdout.match(/aptus\.request\.cancelled/g) ?? []).length, 1);

    // Client-initiated disconnects discard both byte sinks: no partial stream
    // files are committed.
    const names = traceFiles(cli.traceRoot);
    assert.equal(
      names.some((name) => name.endsWith("_provider_stream.sse")),
      false,
    );
    assert.equal(
      names.some((name) => name.endsWith("_client_stream.sse")),
      false,
    );

    // No retry/fallback dispatch occurred.
    assert.equal(harness.chatOrigin.dispatchCount(), 1);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});
