import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  waitFor,
} from "../helpers/cli-process.ts";
import { COMPLETE_MESSAGES_BYTES, MINIMAL_MESSAGES_REQUEST } from "../helpers/messages-fixtures.ts";
import { COMPLETE_RESPONSES_BYTES, MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-parity");

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

function startCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-parity",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-parity",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main, multi-protocol-route]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
      "routes:\n": `routes:\n${MULTI_ROUTE_SNIPPET}`,
    },
  });
}

function traceDirectories(traceRoot: string): string[] {
  return readdirSync(traceRoot)
    .filter((name) => !name.startsWith("."))
    .sort();
}

function traceSourceProtocol(traceRoot: string, dir: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(traceRoot, dir, "000_manifest.json"), "utf8")) as {
    sourceProtocol?: string;
  };
  return manifest.sourceProtocol;
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
    await cli.stop();
  }
});

test.concurrent("process: mixed-protocol route skips incompatible candidates with zero dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("skips");
  const cli = await startCli(harness, "skips");
  try {
    // 1. Ingress Chat request with tools targeting multi-protocol-route [claude-main (M), gpt-main (C), responses-main (R)]
    // Should skip candidate 0 (claude-main) with zero dispatch due to unsupported tool translation in plain-text,
    // then match and dispatch candidate 1 (gpt-main) natively
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

    const chatResponse = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "multi-protocol-route",
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    );
    assert.equal(chatResponse.status, 200);
    assert.deepEqual(new Uint8Array(await chatResponse.arrayBuffer()), COMPLETE_CHAT_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1, "chatOrigin should have 1 request");
    assert.equal(harness.messagesOrigin.dispatchCount(), 0, "messagesOrigin should have 0 requests");
    assert.equal(harness.responsesOrigin.dispatchCount(), 0, "responsesOrigin should have 0 requests");

    // The Chat trace records the candidate_skip stage for candidate 0 (claude-main).
    await waitFor(
      () =>
        traceDirectories(cli.traceRoot).some((dir) =>
          readdirSync(join(cli.traceRoot, dir)).some((f) => f.includes("candidate_skip")),
        ),
      "candidate skip trace write",
    );
    const chatTraceDir = traceDirectories(cli.traceRoot).find(
      (dir) => traceSourceProtocol(cli.traceRoot, dir) === "openai-chat",
    );
    assert.ok(chatTraceDir, "chat trace directory not found");
    const chatStageFiles = readdirSync(join(cli.traceRoot, chatTraceDir));
    const skipFile = chatStageFiles.find((f) => f.includes("candidate_skip"));
    assert.ok(skipFile, "candidate_skip file should exist");
    assert.deepEqual(JSON.parse(readFileSync(join(cli.traceRoot, chatTraceDir, skipFile), "utf8")), {
      candidateIndex: 0,
      provider: "anthropic-primary",
      targetProtocol: "anthropic-messages",
      category: "unsupported_capability",
      capability: "function-tool-definition",
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

    // 3. Ingress Responses request with tools targeting multi-protocol-route
    // Should skip candidate 0 (claude-main) and candidate 1 (gpt-main) with zero dispatch due to unsupported tool translation, then match candidate 2 (responses-main) natively
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const responsesResponse = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_RESPONSES_REQUEST,
        model: "multi-protocol-route",
        tools: [{ type: "function", name: "get_weather" }],
      }),
    );
    assert.equal(responsesResponse.status, 200);
    assert.deepEqual(new Uint8Array(await responsesResponse.arrayBuffer()), COMPLETE_RESPONSES_BYTES);

    assert.equal(harness.chatOrigin.dispatchCount(), 1, "chatOrigin should still have 1 request");
    assert.equal(harness.messagesOrigin.dispatchCount(), 1, "messagesOrigin should still have 1 request");
    assert.equal(harness.responsesOrigin.dispatchCount(), 1, "responsesOrigin should now have 1 request");

    // Verify metrics on operations port carry per-protocol labels for skips, attempts, and ingress.
    // Accepted-request counters are recorded after HTTP delivery, so poll until they appear.
    let metricsText = "";
    await waitFor(async () => {
      const metricsRes = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
      metricsText = await metricsRes.text();
      return (
        /aptus_http_requests_total\{[^}]*endpoint_protocol="openai-chat"[^}]*\}/.test(metricsText) &&
        /aptus_http_requests_total\{[^}]*endpoint_protocol="openai-responses"[^}]*\}/.test(metricsText) &&
        /aptus_http_requests_total\{[^}]*endpoint_protocol="anthropic-messages"[^}]*\}/.test(metricsText)
      );
    }, "protocol metrics");

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
    await cli.stop();
  }
});
