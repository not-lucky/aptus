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
} from "../helpers/cli-process.ts";
import { COMPLETE_MESSAGES_BYTES, MINIMAL_MESSAGES_REQUEST } from "../helpers/messages-fixtures.ts";
import { COMPLETE_RESPONSES_BYTES, MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const PLAIN_TEXT_CHAT_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1775606400,
  model: "gpt-5.4",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "hello from origin",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

const PLAIN_TEXT_CHAT_BYTES = new TextEncoder().encode(JSON.stringify(PLAIN_TEXT_CHAT_BODY));

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans");

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
        displayName: Responses Main
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null
    pricing:
      inputUsdPerMillionTokens: "2.50"
      outputUsdPerMillionTokens: "15.00"
      cacheReadUsdPerMillionTokens: "0.25"
      cacheWriteUsdPerMillionTokens: null
`;

const ROUTE_CATALOG = `    catalog:
      openai:
        created: 1775606400
        ownedBy: aptus
      anthropic:
        createdAt: "2026-04-08T00:00:00Z"
        displayName: Route
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null`;

const TRANSLATION_ROUTES_SNIPPET = `  - name: route-c-to-r
    candidates: [responses-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-c-to-m
    candidates: [claude-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-r-to-c
    candidates: [gpt-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-r-to-m
    candidates: [claude-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-m-to-c
    candidates: [gpt-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-m-to-r
    candidates: [responses-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
`;

function startTranslationCli(
  harness: ThreeOriginHarness,
  caseName: string,
): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-trans",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main, route-c-to-r, route-c-to-m, route-r-to-c, route-r-to-m, route-m-to-c, route-m-to-r]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
      "routes:\n": `routes:\n${TRANSLATION_ROUTES_SNIPPET}`,
    },
  });
}

function traceDirectories(traceRoot: string): string[] {
  return readdirSync(traceRoot)
    .filter((name) => !name.startsWith("."))
    .sort();
}

const RESPONSES_TEXT = "Once upon a time in a starlit glade, a tiny unicorn learned to gallop across rainbows.";

/** Parses the exact body bytes the given origin last received. */
function parsedTargetBody(origin: {
  lastRequest(): { readonly body: Uint8Array } | undefined;
}): unknown {
  const request = origin.lastRequest();
  assert.ok(request, "origin should have received one translated request");
  return JSON.parse(new TextDecoder().decode(request.body));
}

test.concurrent("process: plain-text complete translation succeeds in all six directions", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("six-dirs");
  const cli = await startTranslationCli(harness, "six-dirs");

  try {
    // 1. C -> R
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    const cToRRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "route-c-to-r" }),
    );
    assert.equal(cToRRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.responsesOrigin), {
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
    });
    const cToRBody = (await cToRRes.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    assert.equal(cToRBody.object, "chat.completion");
    assert.equal(cToRBody.choices[0]?.message.content, RESPONSES_TEXT);
    assert.equal(cToRBody.choices[0]?.finish_reason, "stop");
    assert.equal(cToRBody.usage.prompt_tokens, 12);
    assert.equal(cToRBody.usage.completion_tokens, 24);

    // 2. C -> M
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    const cToMRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "route-c-to-m" }),
    );
    assert.equal(cToMRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.messagesOrigin), {
      model: "claude-opus-4-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: false,
      max_tokens: 4096,
    });
    const cToMBody = (await cToMRes.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    assert.equal(cToMBody.object, "chat.completion");
    assert.equal(cToMBody.choices[0]?.message.content, "Hello from Messages");
    assert.equal(cToMBody.choices[0]?.finish_reason, "stop");
    assert.equal(cToMBody.usage.prompt_tokens, 25);
    assert.equal(cToMBody.usage.completion_tokens, 15);

    // 3. R -> C
    harness.chatOrigin.enqueue({ status: 200, body: PLAIN_TEXT_CHAT_BYTES });
    const rToCRes = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, model: "route-r-to-c" }),
    );
    assert.equal(rToCRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.chatOrigin), {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Tell me a three sentence bedtime story about a unicorn." }],
      stream: false,
    });
    const rToCBody = (await rToCRes.json()) as {
      object: string;
      output: Array<{ content: Array<{ text: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(rToCBody.object, "response");
    assert.equal(rToCBody.output[0]?.content[0]?.text, "hello from origin");
    assert.equal(rToCBody.usage.input_tokens, 3);
    assert.equal(rToCBody.usage.output_tokens, 5);

    // 4. R -> M
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    const rToMRes = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, model: "route-r-to-m" }),
    );
    assert.equal(rToMRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.messagesOrigin), {
      model: "claude-opus-4-1",
      messages: [{ role: "user", content: [{ type: "text", text: "Tell me a three sentence bedtime story about a unicorn." }] }],
      stream: false,
      max_tokens: 4096,
    });
    const rToMBody = (await rToMRes.json()) as {
      object: string;
      output: Array<{ content: Array<{ text: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(rToMBody.object, "response");
    assert.equal(rToMBody.output[0]?.content[0]?.text, "Hello from Messages");
    assert.equal(rToMBody.usage.input_tokens, 25);
    assert.equal(rToMBody.usage.output_tokens, 15);

    // 5. M -> C
    harness.chatOrigin.enqueue({ status: 200, body: PLAIN_TEXT_CHAT_BYTES });
    const mToCRes = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, model: "route-m-to-c" }),
    );
    assert.equal(mToCRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.chatOrigin), {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello, Claude" }],
      stream: false,
    });
    const mToCBody = (await mToCRes.json()) as {
      type: string;
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(mToCBody.type, "message");
    assert.equal(mToCBody.content[0]?.text, "hello from origin");
    assert.equal(mToCBody.usage.input_tokens, 3);
    assert.equal(mToCBody.usage.output_tokens, 5);

    // 6. M -> R
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    const mToRRes = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, model: "route-m-to-r" }),
    );
    assert.equal(mToRRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.responsesOrigin), {
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello, Claude" }] }],
      stream: false,
    });
    const mToRBody = (await mToRRes.json()) as {
      type: string;
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(mToRBody.type, "message");
    assert.equal(mToRBody.content[0]?.text, RESPONSES_TEXT);
    assert.equal(mToRBody.usage.input_tokens, 12);
    assert.equal(mToRBody.usage.output_tokens, 24);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: worked example plain-text records exact trace stages and token accounting", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("worked-plain-text");
  const cli = await startTranslationCli(harness, "worked-plain-text");

  try {
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "route-c-to-m" }),
    );
    assert.equal(res.status, 200);

    const traceDir = traceDirectories(cli.traceRoot)[0];
    assert.ok(traceDir, "Trace directory should exist");

    const stageFiles = readdirSync(join(cli.traceRoot, traceDir)).sort();
    assert.ok(stageFiles.some((f) => f.includes("translation_ingress")));
    assert.ok(stageFiles.some((f) => f.includes("ir_request")));
    assert.ok(stageFiles.some((f) => f.includes("translation_egress")));
    assert.ok(stageFiles.some((f) => f.includes("ir_outcome")));

    const ingressTrace = JSON.parse(
      readFileSync(join(cli.traceRoot, traceDir, stageFiles.find((f) => f.includes("translation_ingress"))!), "utf8"),
    ) as { sourceProtocol: string; targetProtocol: string; publicName: string };
    assert.equal(ingressTrace.sourceProtocol, "openai-chat");
    assert.equal(ingressTrace.targetProtocol, "anthropic-messages");
    assert.equal(ingressTrace.publicName, "route-c-to-m");

    const irReqTrace = JSON.parse(
      readFileSync(join(cli.traceRoot, traceDir, stageFiles.find((f) => f.includes("ir_request"))!), "utf8"),
    ) as { ok: boolean; ir: { model: string; delivery: string } };
    assert.equal(irReqTrace.ok, true);
    assert.equal(irReqTrace.ir.model, "route-c-to-m");
    assert.equal(irReqTrace.ir.delivery, "complete");

    const irOutTrace = JSON.parse(
      readFileSync(join(cli.traceRoot, traceDir, stageFiles.find((f) => f.includes("ir_outcome"))!), "utf8"),
    ) as { model: string; finish: { reason: string }; usage: { input: number; output: number } };
    assert.equal(irOutTrace.model, "route-c-to-m");
    assert.equal(irOutTrace.finish.reason, "stop");
    assert.ok(irOutTrace.usage.input > 0);
    assert.ok(irOutTrace.usage.output > 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: worked example multiple-candidates fails closed with zero dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("multiple-candidates");
  const cli = await startTranslationCli(harness, "multiple-candidates");

  try {
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, n: 2, model: "route-c-to-m" }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { type?: string; code?: string } };
    assert.equal(body.error?.type, "invalid_request_error");

    // Zero origin dispatches
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);

    const traceDir = traceDirectories(cli.traceRoot)[0];
    assert.ok(traceDir, "Trace directory should exist");
    const stageFiles = readdirSync(join(cli.traceRoot, traceDir)).sort();
    const skipFile = stageFiles.find((f) => f.includes("candidate_skip"));
    assert.ok(skipFile, "Candidate skip trace should be recorded");

    const skipTrace = JSON.parse(readFileSync(join(cli.traceRoot, traceDir, skipFile), "utf8")) as {
      category: string;
      capability: string;
    };
    assert.equal(skipTrace.category, "unsupported_capability");
    assert.equal(skipTrace.capability, "multiple-candidates");

    // The translated failure phase is recorded as its own Trace stage
    const failureFile = stageFiles.find((f) => f.includes("translation_failure"));
    assert.ok(failureFile, "Translation failure Trace stage should be recorded");
    const failureTrace = JSON.parse(readFileSync(join(cli.traceRoot, traceDir, failureFile), "utf8")) as {
      category: string;
      capability: string;
    };
    assert.equal(failureTrace.category, "unsupported_capability");
    assert.equal(failureTrace.capability, "multiple-candidates");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: same-protocol native passthrough stays byte-exact and bypasses IR", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("native-bypass");
  const cli = await startTranslationCli(harness, "native-bypass");

  try {
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model: "gpt-main" }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), COMPLETE_CHAT_BYTES);

    const traceDir = traceDirectories(cli.traceRoot)[0];
    assert.ok(traceDir, "Trace directory should exist");
    const stageFiles = readdirSync(join(cli.traceRoot, traceDir));

    // Native path must NOT contain translation trace files
    assert.ok(!stageFiles.some((f) => f.includes("translation_ingress")));
    assert.ok(!stageFiles.some((f) => f.includes("ir_request")));
    assert.ok(!stageFiles.some((f) => f.includes("translation_egress")));
    assert.ok(!stageFiles.some((f) => f.includes("ir_outcome")));
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});
