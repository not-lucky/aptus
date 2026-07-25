import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { completeYaml } from "../config/yaml.js";
import { type ProviderOrigin, createProviderOrigin } from "../helpers/provider-origin.js";
import {
  COMPLETE_RESPONSES_BYTES,
  ERROR_RESPONSES_BYTES,
  MINIMAL_RESPONSES_REQUEST,
  SSE_RESPONSES_BYTES,
  SSE_RESPONSES_ERROR_BYTES,
  SSE_RESPONSES_FAILED_BYTES,
  SSE_RESPONSES_INCOMPLETE_BYTES,
} from "../helpers/responses-fixtures.js";

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "src", "bootstrap", "cli.ts");
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

function seededEnv(caseName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < ENV_NAMES.length; index++) {
    env[ENV_NAMES[index] as string] = `aptus-responses-${caseName}-${index}`;
  }
  return env;
}

function mergedEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ENV_NAMES) delete merged[name];
  for (const [key, value] of Object.entries(env)) merged[key] = value;
  return merged;
}

interface RunningCli {
  child: ChildProcess;
  clientPort: number;
  operationsPort: number;
  stdout: string;
  traceRoot: string;
}

const RESPONSES_MODEL_SNIPPET = `  - name: responses-main
    aliases: [responses-default]
    provider: openai-responses-primary
    upstreamModel: gpt-5.4
    defaults:
      temperature: 0.2
    extraBody: {}
    overrides: {}
    catalog:
      openai:
        created: 1775606400
        ownedBy: openai
      anthropic:
        createdAt: "2026-04-08T00:00:00Z"
        displayName: Responses Main through Aptus
        capabilities:
          batch: null
          citations: null
          codeExecution: null
          imageInput: true
          pdfInput: null
          structuredOutput: true
          thinking: true
        maxInputTokens: null
        maxOutputTokens: null
    pricing:
      inputUsdPerMillionTokens: "2.50"
      outputUsdPerMillionTokens: "15.00"
      cacheReadUsdPerMillionTokens: "0.25"
      cacheWriteUsdPerMillionTokens: null
`;

async function startCli(origin: ProviderOrigin, caseName: string): Promise<RunningCli> {
  const dir = mkdtempSync(join(tmpdir(), `aptus-responses-${caseName}-`));
  const traceRoot = join(dir, "traces");
  const env = seededEnv(caseName);

  const baseConfig = completeYaml({
    "  port: 8080": "  port: 0",
    "  port: 9090": "  port: 0",
    "  root: ./traces": `  root: ${traceRoot}`,
    "    baseUrl: https://api.openai.com/v1\n": `    baseUrl: ${origin.baseUrl}\n`,
    "      allow: [gpt-main, claude-main, reliable-chat]":
      "      allow: [gpt-main, claude-main, reliable-chat, responses-main]",
    "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
  });

  writeFileSync(join(dir, "aptus.yaml"), baseConfig);

  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", join(dir, "aptus.yaml")],
    { cwd: dir, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  await waitFor(() => /^aptus ready: /m.test(stdout), "ready line", child);
  const match = /aptus ready: operations http:\/\/[^:]+:(\d+), client http:\/\/[^:]+:(\d+)/.exec(stdout);
  assert.ok(match, `ready line parsed: ${stdout}`);

  return {
    child,
    clientPort: Number(match[2]),
    operationsPort: Number(match[1]),
    stdout,
    traceRoot,
  };
}

function traceFiles(traceRoot: string): string[] {
  const dir = readdirSync(traceRoot).find((name) => !name.startsWith("."));
  if (dir === undefined) return [];
  return readdirSync(join(traceRoot, dir)).sort();
}

async function waitFor(condition: () => boolean, label: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function postJson(port: number, path: string, auth: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body,
  });
}

test.concurrent("process: complete Responses native path applies mutation and relays exact bytes", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("complete");
  const cli = await startCli(origin, "complete");
  try {
    origin.enqueue({ status: 200, headers: { "x-request-id": "resp-rid-1" }, body: COMPLETE_RESPONSES_BYTES });

    // Test both /responses and /v1/responses endpoints
    const response = await postJson(
      cli.clientPort,
      "/responses",
      env.APTUS_CLIENT_PRIMARY as string,
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, unknown_custom: [42] }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-aptus-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), COMPLETE_RESPONSES_BYTES);

    // Verify origin received correct mutated request
    const recorded = origin.lastRequest();
    assert.ok(recorded);
    assert.equal(recorded.method, "POST");
    assert.equal(recorded.url, "/v1/responses");
    assert.ok(
      recorded.headers.some(
        ([name, value]) => name === "authorization" && value === `Bearer ${env.OPENAI_RESPONSES_KEY_A}`,
      ),
    );
    const recordedBody = JSON.parse(new TextDecoder().decode(recorded.body)) as Record<string, unknown>;
    assert.equal(recordedBody.model, "gpt-5.4");
    assert.equal(recordedBody.temperature, 0.2);
    assert.deepEqual(recordedBody.unknown_custom, [42]);

    // Trace validation
    const names = traceFiles(cli.traceRoot);
    assert.ok(names.includes("000_manifest.json"));
    assert.ok(names.includes("999_terminal.json"));
    assert.ok(names.some((name) => /^\d{3}_provider_response\.json$/.test(name)));

    // Second request to alias /v1/responses
    origin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    const responseV1 = await postJson(
      cli.clientPort,
      "/v1/responses",
      env.APTUS_CLIENT_PRIMARY as string,
      JSON.stringify(MINIMAL_RESPONSES_REQUEST),
    );
    assert.equal(responseV1.status, 200);
    assert.deepEqual(new Uint8Array(await responseV1.arrayBuffer()), COMPLETE_RESPONSES_BYTES);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: SSE Responses relays exact named events with no [DONE]", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("sse");
  const cli = await startCli(origin, "sse");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [
        { bytes: SSE_RESPONSES_BYTES.subarray(0, 150), delayMs: 0 },
        { bytes: SSE_RESPONSES_BYTES.subarray(150), delayMs: 25 },
      ],
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      env.APTUS_CLIENT_PRIMARY as string,
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, SSE_RESPONSES_BYTES);

    const streamText = new TextDecoder().decode(bytes);
    assert.match(streamText, /event: response\.created/);
    assert.match(streamText, /event: response\.output_text\.delta/);
    assert.match(streamText, /event: response\.unknown_event/);
    assert.match(streamText, /event: response\.completed/);
    assert.doesNotMatch(streamText, /data: \[DONE\]/);

    // Verify stream trace files
    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const names = readdirSync(join(cli.traceRoot, dir)).sort();
    const providerStream = names.find((name) => name.endsWith("_provider_stream.sse"));
    const clientStream = names.find((name) => name.endsWith("_client_stream.sse"));
    assert.ok(providerStream && clientStream);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, providerStream))), SSE_RESPONSES_BYTES);
    assert.deepEqual(new Uint8Array(readFileSync(join(cli.traceRoot, dir, clientStream))), SSE_RESPONSES_BYTES);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Responses stream terminal variants (failed, incomplete, error) are exact", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("terminals");
  const cli = await startCli(origin, "terminals");
  try {
    const terminals = [
      { name: "failed", bytes: SSE_RESPONSES_FAILED_BYTES },
      { name: "incomplete", bytes: SSE_RESPONSES_INCOMPLETE_BYTES },
      { name: "in-band error", bytes: SSE_RESPONSES_ERROR_BYTES },
    ];

    for (const term of terminals) {
      origin.enqueue({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        mode: "sse",
        segments: [{ bytes: term.bytes }],
      });

      const response = await postJson(
        cli.clientPort,
        "/responses",
        env.APTUS_CLIENT_PRIMARY as string,
        JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, stream: true }),
      );
      assert.equal(response.status, 200);
      const received = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(received, term.bytes);
      assert.doesNotMatch(new TextDecoder().decode(received), /data: \[DONE\]/);
    }
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Responses terminal non-2xx HTTP error is relayed with failed trace", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("error");
  const cli = await startCli(origin, "error");
  try {
    origin.enqueue({
      status: 400,
      headers: { "content-type": "application/json" },
      body: ERROR_RESPONSES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      env.APTUS_CLIENT_PRIMARY as string,
      JSON.stringify(MINIMAL_RESPONSES_REQUEST),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), ERROR_RESPONSES_BYTES);

    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const terminalJson = JSON.parse(readFileSync(join(cli.traceRoot, dir, "999_terminal.json"), "utf8")) as {
      kind: string;
      failure?: { category: string };
    };
    assert.equal(terminalJson.kind, "failed");
    assert.equal(terminalJson.failure?.category, "invalid_request");
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: Responses client abort mid-stream cancels provider body", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("abort");
  const cli = await startCli(origin, "abort");
  try {
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "held-open",
      segments: [{ bytes: 'event: response.created\ndata: {"type":"response.created"}\n\n' }],
    });

    await new Promise<void>((resolveTest, rejectTest) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: cli.clientPort,
          path: "/responses",
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
      request.end(JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, stream: true }));
    });

    await waitFor(() => origin.lastRequest()?.closedAtMs !== undefined, "origin socket close", cli.child);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});
