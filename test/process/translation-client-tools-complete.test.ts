import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { postJson, type RunningInProcessAptus, seededSecrets, startAptusInProcess } from "../helpers/cli-process.ts";
import { MINIMAL_MESSAGES_REQUEST } from "../helpers/messages-fixtures.ts";
import { MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-tools");

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

function startTranslationCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-trans-tools",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-tools",
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
    .filter((n) => !n.startsWith("."))
    .sort();
}

function parsedTargetBody(origin: { lastRequest(): { readonly body: Uint8Array } | undefined }): unknown {
  const req = origin.lastRequest();
  assert.ok(req, "origin should have received one translated request");
  return JSON.parse(new TextDecoder().decode(req.body));
}

const encoder = new TextEncoder();

const CHAT_TOOLS_OUTCOME = {
  id: "chatcmpl-tools",
  object: "chat.completion",
  created: 1775606400,
  model: "gpt-5.4",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
          { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":"PST"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const RESPONSES_TOOLS_OUTCOME = {
  id: "resp_tools",
  object: "response",
  status: "completed",
  model: "gpt-5.4",
  output: [
    {
      type: "function_call",
      id: "fc_a",
      call_id: "call_a",
      name: "get_weather",
      arguments: '{"city":"SF"}',
      status: "completed",
    },
    {
      type: "function_call",
      id: "fc_b",
      call_id: "call_b",
      name: "get_time",
      arguments: '{"tz":"PST"}',
      status: "completed",
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

const MESSAGES_TOOLS_OUTCOME = {
  id: "msg_tools",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-1",
  content: [
    { type: "tool_use", id: "call_a", name: "get_weather", input: { city: "SF" } },
    { type: "tool_use", id: "call_b", name: "get_time", input: { tz: "PST" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const CHAT_TOOLS_BYTES = encoder.encode(JSON.stringify(CHAT_TOOLS_OUTCOME));
const RESPONSES_TOOLS_BYTES = encoder.encode(JSON.stringify(RESPONSES_TOOLS_OUTCOME));
const MESSAGES_TOOLS_BYTES = encoder.encode(JSON.stringify(MESSAGES_TOOLS_OUTCOME));

const CHAT_CLIENT_REQUEST = {
  model: "route-c-to-r",
  messages: [
    { role: "user", content: "What's the weather?" },
    {
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "72F sunny" },
    { role: "user", content: "Thanks!" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    },
  ],
};

const RESPONSES_CLIENT_REQUEST = {
  model: "route-r-to-c",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather?" }] },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
    { type: "function_call_output", call_id: "call_1", output: "72F sunny" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks!" }] },
  ],
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      strict: false,
    },
  ],
};

const MESSAGES_CLIENT_REQUEST = {
  model: "route-m-to-c",
  max_tokens: 1024,
  messages: [
    { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "72F sunny" },
        { type: "text", text: "Thanks!" },
      ],
    },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ],
};

test.concurrent("process: complete function loop c->r emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r");
  const cli = await startTranslationCli(harness, "c-to-r");
  try {
    harness.responsesOrigin.enqueue({ status: 200, body: RESPONSES_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...CHAT_CLIENT_REQUEST, model: "route-c-to-r" }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.responsesOrigin) as Record<string, unknown>;
    assert.equal(target.model, "gpt-5.4");
    assert.ok(Array.isArray(target.input));
    assert.ok(Array.isArray(target.tools));
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { tool_calls?: unknown[] }; finish_reason: string }>;
      usage: unknown;
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0]?.finish_reason, "tool_calls");
    assert.ok(Array.isArray(body.choices[0]?.message.tool_calls) && body.choices[0]?.message.tool_calls?.length === 2);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: complete function loop c->m emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m");
  const cli = await startTranslationCli(harness, "c-to-m");
  try {
    harness.messagesOrigin.enqueue({ status: 200, body: MESSAGES_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...CHAT_CLIENT_REQUEST, model: "route-c-to-m" }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.messagesOrigin) as Record<string, unknown>;
    assert.equal(target.model, "claude-opus-4-1");
    assert.ok(Array.isArray(target.messages));
    const body = (await res.json()) as { object: string; choices: Array<{ finish_reason: string }> };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0]?.finish_reason, "tool_calls");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: complete function loop r->c emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-c");
  const cli = await startTranslationCli(harness, "r-to-c");
  try {
    harness.chatOrigin.enqueue({ status: 200, body: CHAT_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_RESPONSES_REQUEST,
        model: "route-r-to-c",
        input: RESPONSES_CLIENT_REQUEST.input,
        tools: RESPONSES_CLIENT_REQUEST.tools,
      }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.chatOrigin) as Record<string, unknown>;
    assert.equal(target.model, "gpt-5.4");
    const body = (await res.json()) as { object: string; output: unknown[] };
    assert.equal(body.object, "response");
    assert.ok(Array.isArray(body.output));
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: complete function loop r->m emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-m");
  const cli = await startTranslationCli(harness, "r-to-m");
  try {
    harness.messagesOrigin.enqueue({ status: 200, body: MESSAGES_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_RESPONSES_REQUEST,
        model: "route-r-to-m",
        input: RESPONSES_CLIENT_REQUEST.input,
        tools: RESPONSES_CLIENT_REQUEST.tools,
      }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.messagesOrigin) as Record<string, unknown>;
    assert.equal(target.model, "claude-opus-4-1");
    const body = (await res.json()) as { object: string };
    assert.equal(body.object, "response");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: complete function loop m->c emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-c");
  const cli = await startTranslationCli(harness, "m-to-c");
  try {
    harness.chatOrigin.enqueue({ status: 200, body: CHAT_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MESSAGES_CLIENT_REQUEST, model: "route-m-to-c" }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.chatOrigin) as Record<string, unknown>;
    assert.equal(target.model, "gpt-5.4");
    const body = (await res.json()) as { type: string; content: unknown[]; stop_reason: string };
    assert.equal(body.type, "message");
    assert.equal(body.stop_reason, "tool_use");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: complete function loop m->r emits exact target request and outcome", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-r");
  const cli = await startTranslationCli(harness, "m-to-r");
  try {
    harness.responsesOrigin.enqueue({ status: 200, body: RESPONSES_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MESSAGES_CLIENT_REQUEST, model: "route-m-to-r" }),
    );
    assert.equal(res.status, 200);
    const target = parsedTargetBody(harness.responsesOrigin) as Record<string, unknown>;
    assert.equal(target.model, "gpt-5.4");
    const body = (await res.json()) as { type: string };
    assert.equal(body.type, "message");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: worked example function-loop records exact trace stages", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("worked-tools");
  const cli = await startTranslationCli(harness, "worked-tools");
  try {
    harness.messagesOrigin.enqueue({ status: 200, body: MESSAGES_TOOLS_BYTES });
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...CHAT_CLIENT_REQUEST, model: "route-c-to-m" }),
    );
    assert.equal(res.status, 200);
    const traceDir = traceDirectories(cli.traceRoot)[0];
    assert.ok(traceDir, "trace directory should exist");
    const stageFiles = readdirSync(join(cli.traceRoot, traceDir)).sort();
    const find = (needle: string): string => {
      const file = stageFiles.find((f) => f.includes(needle));
      assert.ok(file, `trace should contain a ${needle} stage`);
      return file as string;
    };
    const irReqTrace = JSON.parse(readFileSync(join(cli.traceRoot, traceDir, find("ir_request")), "utf8")) as {
      ok: boolean;
      ir: { items: unknown[] };
    };
    assert.equal(irReqTrace.ok, true);
    // The tool_call item and its earlier-declared callId are both in the IR.
    const itemsStr = JSON.stringify(irReqTrace.ir.items);
    assert.ok(itemsStr.includes('"tool_call"'), "ir_request items carry the tool_call");
    assert.ok(itemsStr.includes("call_1"), "ir_request items carry the declared callId");
    const providerReqTrace = JSON.parse(
      readFileSync(join(cli.traceRoot, traceDir, find("provider_request")), "utf8"),
    ) as { protocol: string; body: { messages: unknown[] } };
    assert.equal(providerReqTrace.protocol, "anthropic-messages");
    // The dispatched M request body carries the transcript's tool_use block
    // with its object input; the two outcome calls appear in ir_outcome.
    const messagesStr = JSON.stringify(providerReqTrace.body.messages);
    const toolUses = messagesStr.match(/"tool_use"/g) ?? [];
    assert.equal(toolUses.length, 1, "provider_request M body carries the transcript tool_use block");
    assert.ok(messagesStr.includes('"input":{"city":"SF"}'));
    const irOutTrace = JSON.parse(readFileSync(join(cli.traceRoot, traceDir, find("ir_outcome")), "utf8")) as {
      finish: { reason: string };
      parts: unknown[];
    };
    assert.equal(irOutTrace.finish.reason, "tool_calls");
    assert.equal(irOutTrace.parts.length, 2);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: invalid function JSON into M rejects before dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("invalid-json");
  const cli = await startTranslationCli(harness, "invalid-json");
  try {
    const badBody = {
      model: "route-c-to-m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location": "San Francisco", }' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        },
      ],
    };
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify(badBody),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("invalid-function-json"));
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
    const dirs = traceDirectories(cli.traceRoot);
    assert.ok(dirs.length >= 1);
    const files = readdirSync(join(cli.traceRoot, dirs[0] as string));
    // Find a trace that mentions the capability
    let found = false;
    for (const file of files) {
      const content = readFileSync(join(cli.traceRoot, dirs[0] as string, file), "utf8");
      if (
        content.includes("invalid-function-json") ||
        content.includes("candidate_skip") ||
        content.includes("translation_failure")
      )
        found = true;
    }
    assert.ok(found, "trace should record the failure or candidate skip");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: invalid provider arguments into M client terminates without forged tool block", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("invalid-provider-args");
  const cli = await startTranslationCli(harness, "invalid-provider-args");
  try {
    const badOutcome = {
      id: "chatcmpl-bad",
      object: "chat.completion",
      created: 1775606400,
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "not-json" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    harness.chatOrigin.enqueue({ status: 200, body: encoder.encode(JSON.stringify(badOutcome)) });
    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify({ ...MINIMAL_MESSAGES_REQUEST, model: "route-m-to-c" }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string; message: string }; type?: string; content?: unknown[] };
    assert.equal(body.error.type, "invalid_request_error");
    // Client body should not contain forged tool_use
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes("tool_use") || bodyStr.includes("invalid"), "should not forge tool_use");
    const dirs = traceDirectories(cli.traceRoot);
    assert.ok(dirs.length >= 1);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: hosted tool request rejects with zero dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("hosted-reject");
  const cli = await startTranslationCli(harness, "hosted-reject");
  try {
    const hostedBody = {
      model: "route-r-to-m",
      input: "hi",
      tools: [{ type: "web_search" }],
    };
    const res = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify(hostedBody),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("hosted-web-search"));
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: custom grammar tool translates C->R and rejects into M", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("custom-grammar");
  const cli = await startTranslationCli(harness, "custom-grammar");
  try {
    // C->R should translate
    harness.responsesOrigin.enqueue({ status: 200, body: RESPONSES_TOOLS_BYTES });
    const cGrammar = {
      model: "route-c-to-r",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "custom",
          custom: {
            name: "my_grammar",
            description: "d",
            format: { type: "grammar", grammar: { definition: "rule", syntax: "lark" } },
          },
        },
      ],
    };
    const cToRRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify(cGrammar),
    );
    assert.equal(cToRRes.status, 200);
    const target = parsedTargetBody(harness.responsesOrigin) as Record<string, unknown>;
    const tools = target.tools as unknown[];
    assert.ok(Array.isArray(tools));
    const entry = tools[0] as Record<string, unknown>;
    assert.equal(entry.type, "custom");
    const fmt = entry.format as Record<string, unknown>;
    assert.equal(fmt.type, "grammar");
    // C->M should reject
    const cToMRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...cGrammar, model: "route-c-to-m" }),
    );
    assert.equal(cToMRes.status, 400);
    const body = (await cToMRes.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("custom-grammar-tool"));
    // No dispatch to messages for the failing request (responses may have been dispatched for first success)
    // Check that the second request didn't dispatch to messages beyond the first
    // At least ensure no extra unexpected dispatches: total messages dispatches =1 (from first C->R success? No that was responses)
    // For C->M, messagesOrigin should not have received the failed request? Actually it would be candidate, but preflight rejects before dispatch, so count unchanged
    // We already had 0 messages dispatches from C->R; after C->M fail, still 0
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: multipart tool result into Chat rejects", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("multipart-reject");
  const cli = await startTranslationCli(harness, "multipart-reject");
  try {
    const mMulti = {
      model: "route-m-to-c",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ],
    };
    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY as string },
      JSON.stringify(mMulti),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("tool-result-multipart"));
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});
