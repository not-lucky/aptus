import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "vitest";
import { postJson, seededSecrets, startAptusCli, traceFiles, waitFor, type RunningCli } from "../helpers/cli-process.ts";
import {
  COMPLETE_MESSAGES_BYTES,
  ERROR_MESSAGES_BYTES,
  MINIMAL_MESSAGES_REQUEST,
  SSE_MESSAGES_BYTES,
  SSE_MESSAGES_POST200_ERROR_BYTES,
} from "../helpers/messages-fixtures.ts";
import { createProviderOrigin, type ProviderOrigin } from "../helpers/provider-origin.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-messages");

function startCli(origin: ProviderOrigin, caseName: string): Promise<RunningCli> {
  return startAptusCli({
    casePrefix: "aptus-messages",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-messages",
    replacements: {
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${origin.baseUrl}`,
    },
  });
}

test.concurrent("process: complete Messages native path applies mutation and relays exact bytes", async () => {
  const origin = await createProviderOrigin({ basePath: "" });
  const env = seededEnv("complete");
  const cli = await startCli(origin, "complete");
  try {
    origin.enqueue({ status: 200, headers: { "x-request-id": "msg-rid-1" }, body: COMPLETE_MESSAGES_BYTES });

    // Client sends request using x-api-key authentication to /v1/messages
    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, unknown_field: { test: true } }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-aptus-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), COMPLETE_MESSAGES_BYTES);

    // Origin observed x-api-key auth, static anthropic-version, and model replacement
    const recorded = origin.lastRequest();
    assert.ok(recorded);
    assert.equal(recorded.method, "POST");
    assert.equal(recorded.url, "/v1/messages");
    assert.ok(
      recorded.headers.some(([name, value]) => name === "x-api-key" && value === env.ANTHROPIC_KEY_A),
      "missing x-api-key auth",
    );
    assert.ok(
      recorded.headers.some(([name, value]) => name === "anthropic-version" && value === "2023-06-01"),
      "missing anthropic-version header",
    );
    const recordedBody = JSON.parse(new TextDecoder().decode(recorded.body)) as Record<string, unknown>;
    assert.equal(recordedBody.model, "claude-opus-4-1");
    assert.equal(recordedBody.max_tokens, 1024);
    assert.deepEqual(recordedBody.unknown_field, { test: true });

    // Trace checks
    const names = traceFiles(cli.traceRoot);
    assert.ok(names.includes("000_manifest.json"));
    assert.ok(names.includes("999_terminal.json"));
    assert.ok(names.some((name) => /^\d{3}_provider_response\.json$/.test(name)));

    // Second request to alias /messages with x-api-key authorization header and omitted max_tokens (to verify config default 4096)
    origin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    const responseAlias = await postJson(
      cli.clientPort,
      "/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ model: "claude-main", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(responseAlias.status, 200);
    assert.deepEqual(new Uint8Array(await responseAlias.arrayBuffer()), COMPLETE_MESSAGES_BYTES);

    const recorded2 = origin.lastRequest();
    assert.ok(recorded2);
    const recordedBody2 = JSON.parse(new TextDecoder().decode(recorded2.body)) as Record<string, unknown>;
    assert.equal(recordedBody2.max_tokens, 4096);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: SSE Messages relays exact stream preserving pings and input_json_delta", async () => {
  const origin = await createProviderOrigin({ basePath: "" });
  const env = seededEnv("sse");
  const cli = await startCli(origin, "sse");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [
        { bytes: SSE_MESSAGES_BYTES.subarray(0, 200), delayMs: 0 },
        { bytes: SSE_MESSAGES_BYTES.subarray(200), delayMs: 25 },
      ],
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, SSE_MESSAGES_BYTES);

    const streamText = new TextDecoder().decode(bytes);
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /event: ping/);
    assert.match(streamText, /event: content_block_delta/);
    assert.match(streamText, /"partial_json"/);
    assert.match(streamText, /event: custom_native_event/);
    assert.match(streamText, /event: message_delta/);
    assert.match(streamText, /event: message_stop/);
    assert.doesNotMatch(streamText, /data: \[DONE\]/);

    // Verify trace files hold exact bytes
    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const names = readdirSync(join(cli.traceRoot, dir)).sort();
    const providerStream = names.find((name) => name.endsWith("_provider_stream.sse"));
    const clientStream = names.find((name) => name.endsWith("_client_stream.sse"));
    assert.ok(providerStream && clientStream);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, providerStream))), SSE_MESSAGES_BYTES);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, clientStream))), SSE_MESSAGES_BYTES);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Messages post-200 in-band error is relayed without forged terminator", async () => {
  const origin = await createProviderOrigin({ basePath: "" });
  const env = seededEnv("post200");
  const cli = await startCli(origin, "post200");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [{ bytes: SSE_MESSAGES_POST200_ERROR_BYTES }],
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, SSE_MESSAGES_POST200_ERROR_BYTES);
    assert.doesNotMatch(new TextDecoder().decode(bytes), /event: message_stop/);

    // Native relay does not semantically decode stream, so cleanly relayed stream records complete at HTTP 200
    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const terminalJson = JSON.parse(readFileSync(join(cli.traceRoot, dir, "999_terminal.json"), "utf8")) as {
      kind: string;
      status?: number;
    };
    assert.equal(terminalJson.kind, "complete");
    assert.equal(terminalJson.status, 200);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Messages terminal HTTP 404 error is relayed with failed trace", async () => {
  const origin = await createProviderOrigin({ basePath: "" });
  const env = seededEnv("error404");
  const cli = await startCli(origin, "error404");
  try {
    origin.enqueue({
      status: 404,
      headers: { "content-type": "application/json" },
      body: ERROR_MESSAGES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify(MINIMAL_MESSAGES_REQUEST),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), ERROR_MESSAGES_BYTES);

    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const terminalJson = JSON.parse(readFileSync(join(cli.traceRoot, dir, "999_terminal.json"), "utf8")) as {
      kind: string;
      failure?: { category: string };
    };
    assert.equal(terminalJson.kind, "failed");
    assert.equal(terminalJson.failure?.category, "not_found");
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Messages client abort mid-stream cancels provider body", async () => {
  const origin = await createProviderOrigin({ basePath: "" });
  const env = seededEnv("abort");
  const cli = await startCli(origin, "abort");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "held-open",
      segments: [{ bytes: 'event: message_start\ndata: {"type":"message_start"}\n\n' }],
    });

    await new Promise<void>((resolveTest, rejectTest) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: cli.clientPort,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.APTUS_CLIENT_PRIMARY,
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
      request.end(JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, stream: true }));
    });

    await waitFor(() => origin.lastRequest()?.closedAtMs !== undefined, "origin socket close", cli.child);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});
