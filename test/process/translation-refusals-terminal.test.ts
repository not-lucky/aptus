import assert from "node:assert/strict";
import { test } from "vitest";
import { postJson, type RunningInProcessAptus, seededSecrets, startAptusInProcess } from "../helpers/cli-process.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-refusal");

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
  - name: responses-backup
    aliases: []
    provider: openai-responses-primary
    upstreamModel: gpt-5.4-backup
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
        displayName: Responses Backup
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
  - name: route-m-to-r
    candidates: [responses-main]
    retryOn: []
    fallbackOn: []
${ROUTE_CATALOG}
  - name: route-c-to-r-fallback
    candidates: [responses-main, responses-backup]
    retryOn: []
    fallbackOn: [provider]
${ROUTE_CATALOG}
`;

function startRefusalCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-refusal",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-refusal",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main, route-c-to-r, route-r-to-c, route-r-to-m, route-m-to-r, route-c-to-r-fallback]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
      "routes:\n": `routes:\n${TRANSLATION_ROUTES_SNIPPET}`,
    },
  });
}

test.concurrent("process: complete refusal outcomes translate C↔R with status 200", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("refusal-complete");
  const cli = await startRefusalCli(harness, "refusal-complete");

  try {
    // 1. C -> R: Chat client requests route-c-to-r, Responses origin returns refusal item
    const respRefusalBytes = new TextEncoder().encode(
      JSON.stringify({
        id: "resp_refusal_01",
        object: "response",
        created_at: 1775606400,
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "msg_ref_01",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I cannot assist with hazardous materials." }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: respRefusalBytes });

    const cToRRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        messages: [{ role: "user", content: "Make a weapon." }],
        model: "route-c-to-r",
      }),
    );

    assert.equal(cToRRes.status, 200);
    const cBody = (await cToRRes.json()) as Record<string, unknown>;
    const choice = (cBody.choices as Record<string, unknown>[])[0];
    assert.equal(choice?.finish_reason, "stop");
    const msg = choice?.message as Record<string, unknown>;
    assert.equal(msg?.content, null);
    assert.equal(msg?.refusal, "I cannot assist with hazardous materials.");

    // 2. R -> C: Responses client requests route-r-to-c, Chat origin returns refusal
    const chatRefusalBytes = new TextEncoder().encode(
      JSON.stringify({
        id: "chatcmpl-refusal-01",
        object: "chat.completion",
        created: 1775606400,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: "Policy prohibits this generation.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    harness.chatOrigin.enqueue({ status: 200, body: chatRefusalBytes });

    const rToCRes = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        input: "Make a weapon.",
        model: "route-r-to-c",
      }),
    );

    assert.equal(rToCRes.status, 200);
    const rBody = (await rToCRes.json()) as Record<string, unknown>;
    assert.equal(rBody.status, "completed");
    const output = rBody.output as Record<string, unknown>[];
    assert.equal(output.length, 1);
    assert.equal(output[0]?.type, "message");
    const content = output[0]?.content as Record<string, unknown>[];
    assert.equal(content[0]?.type, "refusal");
    assert.equal(content[0]?.refusal, "Policy prohibits this generation.");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: pre-client-byte in-band stream error falls back to the next candidate", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("inband-error-fallback");
  const cli = await startRefusalCli(harness, "inband-error-fallback");

  try {
    // Chat client calls a two-candidate Responses route with
    // fallbackOn: [provider]. The first upstream fails with an error-only
    // SSE stream. The Chat client encoder emits no frame for an error, so
    // the pump drains to EOF with zero client chunks and the attempt layer
    // hands the failure to fallback policy before any client byte exists.
    const sseErrorOnly = new TextEncoder().encode(
      [
        'event: error\ndata: {"type":"error","code":"server_error","message":"First candidate failed","param":null}\n\n',
        "",
        "",
      ].join("\n"),
    );
    const sseSuccess = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_backup","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_backup"},"sequence_number":2}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_backup","delta":"Backup reply","sequence_number":3}',
        "",
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"msg_backup","text":"Backup reply","sequence_number":4}',
        "",
        'event: response.content_part.done\ndata: {"type":"response.content_part.done","part":{"type":"output_text","text":"Backup reply","annotations":[]},"sequence_number":5}',
        "",
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","id":"msg_backup","role":"assistant","content":[{"type":"output_text","text":"Backup reply","annotations":[]}]},"sequence_number":6}',
        "",
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_backup","status":"completed"},"sequence_number":7}',
        "",
        "",
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: sseErrorOnly });
    harness.responsesOrigin.enqueue({ status: 200, body: sseSuccess });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-c-to-r-fallback",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    // The failing attempt produced zero client bytes, so route fallback
    // policy dispatched the next candidate: total dispatch count is 2 and
    // the client stream comes entirely from the backup.
    assert.equal(harness.responsesOrigin.dispatchCount(), 2);
    assert.ok(text.includes("Backup reply"));
    assert.ok(text.includes("data: [DONE]"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: first-frame in-band stream error opens the Messages lifecycle before the error frame", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("inband-error-first-to-m");
  const cli = await startRefusalCli(harness, "inband-error-first-to-m");

  try {
    // Messages client calls route-m-to-r with stream: true. The Responses
    // upstream fails on its very first frame: the error event is the whole
    // provider stream. The translated M stream must open the message
    // lifecycle (message_start) before the error frame — a bare first
    // `event: error` is not a documented M stream shape.
    const sseResponsesErrorFirst = new TextEncoder().encode(
      [
        'event: error\ndata: {"type":"error","code":"server_error","message":"Instant provider failure","param":null}\n\n',
        "",
        "",
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: sseResponsesErrorFirst });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.APTUS_CLIENT_PRIMARY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "route-m-to-r",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    // message_start precedes the error frame; no success terminator follows.
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes("event: error"));
    assert.ok(text.includes('"message":"Instant provider failure"'));
    assert.ok(text.indexOf("message_start") < text.indexOf("event: error"));
    assert.equal(text.includes("message_stop"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: streaming refusal deltas translate across C and R", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("refusal-stream");
  const cli = await startRefusalCli(harness, "refusal-stream");

  try {
    // Chat client calls route-c-to-r with stream: true
    // Responses upstream emits refusal stream
    const sseResponsesRefusal = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ref_stream","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_ref_stream"},"sequence_number":2}',
        "",
        'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"I cannot ","sequence_number":3}',
        "",
        'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"fulfill this.","sequence_number":4}',
        "",
        'event: response.refusal.done\ndata: {"type":"response.refusal.done","sequence_number":5}',
        "",
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ref_stream","status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}},"sequence_number":6}',
        "",
        "",
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: sseResponsesRefusal });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-c-to-r",
        stream: true,
        messages: [{ role: "user", content: "Explosives guide" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const text = await response.text();
    assert.ok(text.includes('"refusal":"I cannot "'));
    assert.ok(text.includes('"refusal":"fulfill this."'));
    assert.ok(text.includes("[DONE]"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: streaming refusal deltas translate R->C (Chat origin to Responses client)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("refusal-stream-r-to-c");
  const cli = await startRefusalCli(harness, "refusal-stream-r-to-c");

  try {
    // Responses client calls route-r-to-c with stream: true
    // Chat upstream emits streaming refusal chunks
    const sseChatRefusal = new TextEncoder().encode(
      [
        'data: {"id":"chatcmpl-stream-ref","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-stream-ref","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"refusal":"Refusal prefix. "},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-stream-ref","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"refusal":"Refusal suffix."},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-stream-ref","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );

    harness.chatOrigin.enqueue({ status: 200, body: sseChatRefusal });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-r-to-c",
        stream: true,
        input: "Dangerous instructions",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const text = await response.text();
    assert.ok(text.includes("event: response.refusal.delta"));
    assert.ok(text.includes("Refusal prefix. "));
    assert.ok(text.includes("Refusal suffix."));
    assert.ok(text.includes("event: response.refusal.done"));
    assert.ok(text.includes("event: response.completed"));
    assert.ok(text.includes('"status":"completed"'));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: post-header in-band stream error translates into target-native error frame", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("inband-error");
  const cli = await startRefusalCli(harness, "inband-error");

  try {
    // Responses client calls route-r-to-m with stream: true
    // Anthropic upstream sends text deltas then event: error
    const sseAnthropicError = new TextEncoder().encode(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Starting response..."}}',
        "",
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic overloaded"}}',
        "",
        "",
      ].join("\n"),
    );

    harness.messagesOrigin.enqueue({ status: 200, body: sseAnthropicError });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-r-to-m",
        stream: true,
        input: "Hello",
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    // Responses client receives text delta, then target-native error frame, without response.completed
    assert.ok(text.includes("Starting response..."));
    assert.ok(text.includes("event: error"));
    assert.ok(text.includes("Anthropic overloaded"));
    assert.equal(text.includes("response.completed"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: post-header in-band stream error translates from Responses to Messages client", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("inband-error-to-m");
  const cli = await startRefusalCli(harness, "inband-error-to-m");

  try {
    // Messages client calls route-m-to-r with stream: true
    // Responses upstream emits text delta, then event: error
    const sseResponsesError = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_err_to_m","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_err_to_m"},"sequence_number":2}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Initial content","sequence_number":3}',
        "",
        'event: error\ndata: {"type":"error","code":"server_error","message":"Upstream server error","param":null}\n\n',
        "",
        "",
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: sseResponsesError });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.APTUS_CLIENT_PRIMARY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "route-m-to-r",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    // Messages client receives text delta, then target-native Anthropic error frame, without message_stop
    assert.ok(text.includes("Initial content"));
    assert.ok(text.includes("event: error"));
    assert.ok(text.includes('"type":"api_error"'));
    assert.ok(text.includes('"message":"Upstream server error"'));
    assert.equal(text.includes("message_stop"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: post-header in-band stream error to Chat client terminates without DONE", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("inband-error-to-c");
  const cli = await startRefusalCli(harness, "inband-error-to-c");

  try {
    // Chat client calls route-c-to-r with stream: true
    // Responses upstream emits text delta, then event: error
    const sseResponsesError = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_err_to_c","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_err_to_c"},"sequence_number":2}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Chat prefix","sequence_number":3}',
        "",
        'event: error\ndata: {"type":"error","code":"server_error","message":"Fatal provider fault","param":null}\n\n',
        "",
        "",
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({ status: 200, body: sseResponsesError });

    const response = await fetch(`http://127.0.0.1:${cli.clientPort}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-c-to-r",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    // Chat client receives prefix chunk, then connection closes without data: [DONE]
    assert.ok(text.includes("Chat prefix"));
    assert.equal(text.includes("[DONE]"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: non-2xx provider responses translate into client-native error envelopes", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("provider-error");
  const cli = await startRefusalCli(harness, "provider-error");

  try {
    // Upstream returns 429 rate limit
    harness.chatOrigin.enqueue({
      status: 429,
      body: new TextEncoder().encode(
        JSON.stringify({
          error: {
            message: "Rate limit reached for requests",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
      ),
    });

    const res429 = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        input: "Hello",
        model: "route-r-to-c",
      }),
    );

    assert.equal(res429.status, 429);
    const errBody = (await res429.json()) as Record<string, unknown>;
    assert.ok(errBody.error !== undefined);

    // Upstream returns 401 Unauthorized
    harness.chatOrigin.enqueue({
      status: 401,
      body: new TextEncoder().encode(
        JSON.stringify({
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      ),
    });

    const res401 = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        input: "Hello",
        model: "route-r-to-c",
      }),
    );

    assert.equal(res401.status, 401);
    const body401 = (await res401.json()) as Record<string, unknown>;
    assert.ok(body401.error !== undefined);

    // Upstream returns 403 Forbidden
    harness.chatOrigin.enqueue({
      status: 403,
      body: new TextEncoder().encode(
        JSON.stringify({
          error: {
            message: "Project does not have access to model",
            type: "permission_error",
          },
        }),
      ),
    });

    const res403 = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        input: "Hello",
        model: "route-r-to-c",
      }),
    );

    assert.equal(res403.status, 403);

    // Upstream returns 503 Unavailable
    harness.chatOrigin.enqueue({
      status: 503,
      body: new TextEncoder().encode(
        JSON.stringify({
          error: {
            message: "The server is temporarily overloaded",
            type: "server_error",
          },
        }),
      ),
    });

    const res503 = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        input: "Hello",
        model: "route-r-to-c",
      }),
    );
    assert.equal(res503.status, 503);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: zero dispatch on terminal T3 request rows (HTTP 400)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("zero-dispatch-terminal");
  const cli = await startRefusalCli(harness, "zero-dispatch-terminal");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // Unknown behavior-bearing Chat field rejects before dispatch.
    const unknownField = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({ model: "route-c-to-r", messages: [{ role: "user", content: "hi" }], future_field_zzz: 1 }),
    );
    assert.equal(unknownField.status, 400);
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);

    // Legacy max_tokens on Chat rejects before dispatch.
    const legacyMaxTokens = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({ model: "route-c-to-r", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
    );
    assert.equal(legacyMaxTokens.status, 400);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);

    // Prompt-cache retention on Chat rejects before dispatch.
    const retention = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        prompt_cache_retention: "in_memory",
      }),
    );
    assert.equal(retention.status, 400);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);

    // Preview multi_agent on Responses rejects before dispatch.
    const multiAgent = await postJson(
      cli.clientPort,
      "/responses",
      authHeaders,
      JSON.stringify({ model: "route-r-to-c", input: "hi", multi_agent: true }),
    );
    assert.equal(multiAgent.status, 400);
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: T1 happy paths R->M and M->R dispatch exactly once", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("t1-remaining-directions");
  const cli = await startRefusalCli(harness, "t1-remaining-directions");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // R -> M: Responses client, Messages origin answers.
    harness.messagesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "msg_rm_01",
          type: "message",
          role: "assistant",
          model: "claude-main",
          content: [{ type: "text", text: "Hello from Messages" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      ),
    });
    const rToM = await postJson(
      cli.clientPort,
      "/responses",
      authHeaders,
      JSON.stringify({ model: "route-r-to-m", input: "Hello world" }),
    );
    assert.equal(rToM.status, 200);
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
    const rToMBody = (await rToM.json()) as Record<string, unknown>;
    assert.equal(rToMBody.status, "completed");

    // M -> R: Messages client, Responses origin answers.
    harness.responsesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "resp_mr_01",
          object: "response",
          created_at: 1775606400,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              type: "message",
              id: "msg_mr_01",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from Responses", annotations: [] }],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        }),
      ),
    });
    const mToR = await postJson(
      cli.clientPort,
      "/messages",
      // The Messages client endpoint requires the Anthropic-style scheme.
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ model: "route-m-to-r", max_tokens: 64, messages: [{ role: "user", content: "Hello" }] }),
    );
    assert.equal(mToR.status, 200);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const mToRBody = (await mToR.json()) as Record<string, unknown>;
    assert.equal(mToRBody.stop_reason, "end_turn");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});
