import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "vitest";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST, SSE_CHAT_BYTES } from "../helpers/chat-fixtures.js";
import { type ChatOrigin, createChatOrigin } from "../helpers/chat-origin.js";
import { postJson, seededSecrets, startAptusCli, traceFiles, waitFor, type RunningCli } from "../helpers/cli-process.js";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-native");

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

function startCli(origin: ChatOrigin, caseName: string): Promise<RunningCli> {
  return startAptusCli({
    casePrefix: "aptus-native",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-native",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${origin.baseUrl}`,
    },
  });
}

test.concurrent("process: complete Chat native path applies mutation and relays exact bytes", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("complete");
  const cli = await startCli(origin, "complete");
  try {
    origin.enqueue({ status: 200, headers: { "x-request-id": "rid-1" }, body: COMPLETE_CHAT_BYTES });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, unknown: [1, 2] }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-aptus-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), COMPLETE_CHAT_BYTES);

    // Origin observed the mutated request with Bearer auth and model replacement.
    const recorded = origin.lastRequest();
    assert.ok(recorded);
    assert.equal(recorded.method, "POST");
    assert.equal(recorded.url, "/v1/chat/completions");
    assert.ok(
      recorded.headers.some(([name, value]) => name === "authorization" && value === `Bearer ${env.OPENAI_CHAT_KEY_A}`),
    );
    const recordedBody = JSON.parse(new TextDecoder().decode(recorded.body)) as Record<string, unknown>;
    assert.equal(recordedBody.model, "gpt-5.4");
    assert.equal(recordedBody.temperature, 0.2);
    assert.equal(recordedBody.store, false);
    assert.deepEqual(recordedBody.unknown, [1, 2]);

    // Trace has the documented stage sequence and terminal.
    const names = traceFiles(cli.traceRoot);
    assert.ok(names.includes("000_manifest.json"));
    assert.ok(names.includes("999_terminal.json"));
    assert.ok(names.some((name) => /^\d{3}_provider_response\.json$/.test(name)));

    // Metrics expose the attempt, request, and trace counters.
    const metrics = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
    const text = await metrics.text();
    assert.match(text, /aptus_provider_attempts_total/);
    assert.match(text, /aptus_http_requests_total/);
    assert.match(text, /aptus_trace_write_failures_total/);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: SSE Chat relays a byte-identical stream preserving [DONE]", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("sse");
  const cli = await startCli(origin, "sse");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [{ bytes: SSE_CHAT_BYTES }],
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, SSE_CHAT_BYTES);
    assert.match(new TextDecoder().decode(bytes), /data: \[DONE\]/);

    // Both stream trace files hold the exact bytes.
    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const names = readdirSync(join(cli.traceRoot, dir)).sort();
    const providerStream = names.find((name) => name.endsWith("_provider_stream.sse"));
    const clientStream = names.find((name) => name.endsWith("_client_stream.sse"));
    assert.ok(providerStream && clientStream);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, providerStream))), SSE_CHAT_BYTES);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, clientStream))), SSE_CHAT_BYTES);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: redirect loop is rejected as a provider failure without infinite dispatch", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("redirect");
  const cli = await startCli(origin, "redirect");
  try {
    origin.enqueue({ status: 302, redirect: { location: "/v1/chat/completions", count: 5 } });
    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify(MINIMAL_CHAT_REQUEST),
    );
    // A gateway-origin failure surfaces as a 502 provider failure.
    assert.equal(response.status, 502);
    assert.equal(origin.dispatchCount(), 2);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: client abort mid-stream cancels the provider body", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("abort");
  const cli = await startCli(origin, "abort");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "held-open",
      segments: [{ bytes: "data: start\n\n" }],
    });

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
        (response) => {
          assert.equal(response.statusCode, 200);
          response.once("data", () => {
            request.destroy();
            resolveTest();
          });
          response.on("error", rejectTest);
        },
      );
      request.on("error", rejectTest);
      request.end(JSON.stringify({ ...MINIMAL_CHAT_REQUEST, stream: true }));
    });

    // The origin observed the socket close from the cancellation.
    await waitFor(() => origin.lastRequest()?.closedAtMs !== undefined, "origin socket close", cli.child);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});
