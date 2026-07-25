import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { completeYaml } from "../config/yaml.js";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.js";
import { COMPLETE_MESSAGES_BYTES, MINIMAL_MESSAGES_REQUEST } from "../helpers/messages-fixtures.js";
import { COMPLETE_RESPONSES_BYTES, MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.js";
import { type ThreeOriginHarness, createThreeOriginHarness } from "../helpers/three-origin-harness.js";

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
    env[ENV_NAMES[index] as string] = `aptus-parity-${caseName}-${index}`;
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

const MULTI_ROUTE_SNIPPET = `  - name: multi-protocol-route
    aliases: [all-protocols]
    candidates: [claude-main, gpt-main, responses-main]
    retryOn: [rate_limit, unavailable, provider]
    fallbackOn: [rate_limit, unavailable, provider, timeout]
    catalog:
      openai:
        created: 1775606400
        ownedBy: aptus
      anthropic:
        createdAt: "2026-04-08T00:00:00Z"
        displayName: Multi Protocol Route
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null
`;

async function startCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningCli> {
  const dir = mkdtempSync(join(tmpdir(), `aptus-parity-${caseName}-`));
  const traceRoot = join(dir, "traces");
  const env = seededEnv(caseName);

  const baseConfig = completeYaml({
    "  port: 8080": "  port: 0",
    "  port: 9090": "  port: 0",
    "  root: ./traces": `  root: ${traceRoot}`,
    "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
    "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
    "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
    "      allow: [gpt-main, claude-main, reliable-chat]":
      "      allow: [gpt-main, claude-main, reliable-chat, responses-main, multi-protocol-route]",
    "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
    "routes:\n": `routes:\n${MULTI_ROUTE_SNIPPET}`,
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

async function waitFor(condition: () => boolean, label: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function traceDirectories(traceRoot: string): string[] {
  return readdirSync(traceRoot).filter((name) => !name.startsWith(".")).sort();
}

function traceSourceProtocol(traceRoot: string, dir: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(traceRoot, dir, "000_manifest.json"), "utf8")) as {
    sourceProtocol?: string;
  };
  return manifest.sourceProtocol;
}

async function postJson(
  port: number,
  path: string,
  auth: { name: string; value: string },
  body: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [auth.name]: auth.value },
    body,
  });
}

test.concurrent("process: concurrent requests across 3 simultaneous origins succeed with byte parity", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("concurrent");
  const cli = await startCli(harness, "concurrent");
  try {
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });

    // Issue requests across all three protocols concurrently
    const [chatRes, responsesRes, messagesRes] = await Promise.all([
      postJson(
        cli.clientPort,
        "/chat/completions",
        { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
        JSON.stringify(MINIMAL_CHAT_REQUEST),
      ),
      postJson(
        cli.clientPort,
        "/responses",
        { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
        JSON.stringify(MINIMAL_RESPONSES_REQUEST),
      ),
      postJson(
        cli.clientPort,
        "/v1/messages",
        { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
        JSON.stringify(MINIMAL_MESSAGES_REQUEST),
      ),
    ]);

    assert.equal(chatRes.status, 200);
    assert.equal(responsesRes.status, 200);
    assert.equal(messagesRes.status, 200);

    assert.deepEqual(new Uint8Array(await chatRes.arrayBuffer()), COMPLETE_CHAT_BYTES);
    assert.deepEqual(new Uint8Array(await responsesRes.arrayBuffer()), COMPLETE_RESPONSES_BYTES);
    assert.deepEqual(new Uint8Array(await messagesRes.arrayBuffer()), COMPLETE_MESSAGES_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
  } finally {
    await harness.closeAll();
    cli.child.kill("SIGKILL");
  }
});

test.concurrent("process: mixed-protocol route skips incompatible candidates with zero dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("skips");
  const cli = await startCli(harness, "skips");
  try {
    // 1. Ingress Chat request targeting multi-protocol-route [claude-main (M), gpt-main (C), responses-main (R)]
    // Should skip candidate 0 (claude-main) with zero dispatch, then match and dispatch candidate 1 (gpt-main)
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

    const chatResponse = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "multi-protocol-route" }),
    );
    assert.equal(chatResponse.status, 200);
    assert.deepEqual(new Uint8Array(await chatResponse.arrayBuffer()), COMPLETE_CHAT_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1, "chatOrigin should have 1 request");
    assert.equal(harness.messagesOrigin.dispatchCount(), 0, "messagesOrigin should have 0 requests");
    assert.equal(harness.responsesOrigin.dispatchCount(), 0, "responsesOrigin should have 0 requests");

    // The Chat trace records the candidate_skip stage for candidate 0 (claude-main).
    const chatTraceDir = traceDirectories(cli.traceRoot).find(
      (dir) => traceSourceProtocol(cli.traceRoot, dir) === "openai-chat",
    );
    assert.ok(chatTraceDir, "chat trace directory not found");
    assert.deepEqual(JSON.parse(readFileSync(join(cli.traceRoot, chatTraceDir, "004_candidate_skip.json"), "utf8")), {
      candidateIndex: 0,
      provider: "anthropic-primary",
      targetProtocol: "anthropic-messages",
      category: "unsupported_capability",
      capability: "anthropic-messages",
    });

    // 2. Ingress Messages request targeting multi-protocol-route
    // Should immediately match candidate 0 (claude-main)
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });

    const messagesResponse = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, model: "multi-protocol-route" }),
    );
    assert.equal(messagesResponse.status, 200);
    assert.deepEqual(new Uint8Array(await messagesResponse.arrayBuffer()), COMPLETE_MESSAGES_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1, "chatOrigin should still have 1 request");
    assert.equal(harness.messagesOrigin.dispatchCount(), 1, "messagesOrigin should now have 1 request");
    assert.equal(harness.responsesOrigin.dispatchCount(), 0, "responsesOrigin should still have 0 requests");

    // 3. Ingress Responses request targeting multi-protocol-route
    // Should skip candidate 0 (claude-main) and candidate 1 (gpt-main) with zero dispatch, then match candidate 2 (responses-main)
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const responsesResponse = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, model: "multi-protocol-route" }),
    );
    assert.equal(responsesResponse.status, 200);
    assert.deepEqual(new Uint8Array(await responsesResponse.arrayBuffer()), COMPLETE_RESPONSES_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1, "chatOrigin should still have 1 request");
    assert.equal(harness.messagesOrigin.dispatchCount(), 1, "messagesOrigin should still have 1 request");
    assert.equal(harness.responsesOrigin.dispatchCount(), 1, "responsesOrigin should now have 1 request");

    // Verify metrics on operations port carry per-protocol labels for skips, attempts, and ingress.
    const metricsRes = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
    const metricsText = await metricsRes.text();

    // Candidate skips: Chat skipped the Messages candidate; Responses skipped Messages and Chat.
    // Label order follows the counter's labelNames declaration (endpoint_protocol, target_protocol, provider, public_name, outcome_category).
    assert.match(
      metricsText,
      /aptus_candidate_skips_total\{[^}]*endpoint_protocol="openai-chat"[^}]*target_protocol="anthropic-messages"[^}]*outcome_category="unsupported_capability"[^}]*\}/,
    );
    assert.match(
      metricsText,
      /aptus_candidate_skips_total\{[^}]*endpoint_protocol="openai-responses"[^}]*target_protocol="anthropic-messages"[^}]*outcome_category="unsupported_capability"[^}]*\}/,
    );
    assert.match(
      metricsText,
      /aptus_candidate_skips_total\{[^}]*endpoint_protocol="openai-responses"[^}]*target_protocol="openai-chat"[^}]*outcome_category="unsupported_capability"[^}]*\}/,
    );

    // Provider attempts: one successful dispatch per target protocol.
    assert.match(
      metricsText,
      /aptus_provider_attempts_total\{[^}]*target_protocol="openai-chat"[^}]*attempt_result="success"[^}]*\}/,
    );
    assert.match(
      metricsText,
      /aptus_provider_attempts_total\{[^}]*target_protocol="openai-responses"[^}]*attempt_result="success"[^}]*\}/,
    );
    assert.match(
      metricsText,
      /aptus_provider_attempts_total\{[^}]*target_protocol="anthropic-messages"[^}]*attempt_result="success"[^}]*\}/,
    );

    // HTTP ingress: one accepted request per endpoint protocol.
    assert.match(metricsText, /aptus_http_requests_total\{[^}]*endpoint_protocol="openai-chat"[^}]*\}/);
    assert.match(metricsText, /aptus_http_requests_total\{[^}]*endpoint_protocol="openai-responses"[^}]*\}/);
    assert.match(metricsText, /aptus_http_requests_total\{[^}]*endpoint_protocol="anthropic-messages"[^}]*\}/);
  } finally {
    await harness.closeAll();
    cli.child.kill("SIGKILL");
  }
});
