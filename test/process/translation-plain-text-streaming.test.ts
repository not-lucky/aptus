import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { SSE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-stream");

const PLAIN_TEXT_SSE_RESPONSES_BYTES = new TextEncoder().encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01abc123","status":"in_progress"},"sequence_number":1}',
    "",
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_01"},"sequence_number":2}',
    "",
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from Responses","sequence_number":3}',
    "",
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":4}',
    "",
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_01abc123","status":"completed","usage":{"input_tokens":12,"output_tokens":24,"total_tokens":36}},"sequence_number":5}',
    "",
    "",
  ].join("\n"),
);

const PLAIN_TEXT_SSE_MESSAGES_BYTES = new TextEncoder().encode(
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_013Zva2CMHLNnXjNJJKqJ2EF","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}',
    "",
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: ping\ndata: {"type":"ping"}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    "",
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    "",
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}',
    "",
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
    "",
  ].join("\n"),
);

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

function startCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-trans-stream",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-stream",
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

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

const anthropicAuth = (secret: string): { name: string; value: string } => ({
  name: "x-api-key",
  value: secret,
});

async function readFullStreamText(response: Response): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode(new Uint8Array(0), { stream: false });
  return text;
}

test.concurrent("process: C->R streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r");
  const cli = await startCli(harness, "c-to-r");
  try {
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: PLAIN_TEXT_SSE_RESPONSES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const streamText = await readFullStreamText(response);

    assert.ok(streamText.includes("Hello from Responses"));
    assert.ok(streamText.includes("data: [DONE]"));

    // Check upstream request
    const req = harness.responsesOrigin.lastRequest();
    assert.ok(req);
    assert.equal(req.url, "/v1/responses");
    const reqBody = JSON.parse(new TextDecoder().decode(req.body));
    assert.equal(reqBody.stream, true);

    // Verify trace files
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const files = traceFiles(cli.traceRoot);
    assert.ok(files.includes("010_provider_stream.sse"));
    assert.ok(files.includes("011_ir_events.jsonl"));
    assert.ok(files.includes("012_client_stream.sse"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: C->M streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m");
  const cli = await startCli(harness, "c-to-m");
  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: PLAIN_TEXT_SSE_MESSAGES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("Hello"));
    assert.ok(streamText.includes(" world"));
    assert.ok(streamText.includes("data: [DONE]"));

    const req = harness.messagesOrigin.lastRequest();
    assert.ok(req);
    assert.equal(req.url, "/v1/messages");
    const reqBody = JSON.parse(new TextDecoder().decode(req.body));
    assert.equal(reqBody.stream, true);
    assert.equal(typeof reqBody.max_tokens, "number");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R->C streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-c");
  const cli = await startCli(harness, "r-to-c");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: SSE_CHAT_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-c",
        input: "hi",
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("event: response.created"));
    assert.ok(streamText.includes("event: response.output_text.delta"));
    assert.ok(streamText.includes("Hello"));
    assert.ok(streamText.includes("event: response.completed"));
    assert.ok(!streamText.includes("[DONE]"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R->M streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-m");
  const cli = await startCli(harness, "r-to-m");
  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: PLAIN_TEXT_SSE_MESSAGES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-m",
        input: "hi",
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("event: response.created"));
    assert.ok(streamText.includes("event: response.output_text.delta"));
    assert.ok(streamText.includes("event: response.completed"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M->C streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-c");
  const cli = await startCli(harness, "m-to-c");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: SSE_CHAT_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("event: message_start"));
    assert.ok(streamText.includes("event: content_block_delta"));
    assert.ok(streamText.includes("event: message_delta"));
    assert.ok(streamText.includes("event: message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M->R streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-r");
  const cli = await startCli(harness, "m-to-r");
  try {
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: PLAIN_TEXT_SSE_RESPONSES_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("event: message_start"));
    assert.ok(streamText.includes("event: content_block_delta"));
    assert.ok(streamText.includes("event: message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: upstream fragmented chunk delivery works seamlessly", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("fragmented");
  const cli = await startCli(harness, "fragmented");
  try {
    // Deliver SSE bytes as 3-byte slices
    const fullBytes = PLAIN_TEXT_SSE_RESPONSES_BYTES;
    const segments: Array<{ bytes: Uint8Array }> = [];
    for (let i = 0; i < fullBytes.length; i += 3) {
      segments.push({ bytes: fullBytes.subarray(i, Math.min(fullBytes.length, i + 3)) });
    }

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      segments,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("Hello from Responses"));
    assert.ok(streamText.includes("data: [DONE]"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: post-header stream disconnect closes without success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("post-header-disc");
  const cli = await startCli(harness, "post-header-disc");
  try {
    // Partial frames followed by disconnect
    const partialSse =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"},"sequence_number":1}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"m1"},"sequence_number":2}\n\n' +
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","part":{"type":"output_text","text":""},"sequence_number":3}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial hello","sequence_number":4}\n\n';

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "post-header-disconnect",
      segments: [{ bytes: new TextEncoder().encode(partialSse) }, { bytes: new Uint8Array(0), delayMs: 100 }],
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response).catch((err) => `caught: ${err}`);

    // Stream must NOT contain [DONE]
    assert.ok(!streamText.includes("[DONE]"));

    // Terminal outcome recorded as failed
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const traceDir = readdirSync(cli.traceRoot).find((d) => !d.startsWith("."));
    const terminal = JSON.parse(readFileSync(join(cli.traceRoot, traceDir!, "999_terminal.json"), "utf8"));
    assert.equal(terminal.kind, "failed");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: pre-header bootstrap failure surfaces as source-native HTTP error", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("pre-header-fail");
  const cli = await startCli(harness, "pre-header-fail");
  try {
    // Return 500 error from upstream provider
    harness.responsesOrigin.enqueue({
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "Internal server error" } }),
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { message: string } };
    assert.ok(body.error.message);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: client cancellation mid-stream cancels upstream and logs cancelled terminal", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("client-cancel");
  const cli = await startCli(harness, "client-cancel");
  try {
    const sseChunk1 =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"},"sequence_number":1}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"m1"},"sequence_number":2}\n\n' +
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","part":{"type":"output_text","text":""},"sequence_number":3}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"First chunk","sequence_number":4}\n\n';

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      segments: [
        { bytes: new TextEncoder().encode(sseChunk1) },
        {
          bytes: new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Second chunk","sequence_number":5}\n\n',
          ),
          delayMs: 3000,
        },
      ],
    });

    const abortController = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${cli.clientPort}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}`,
      },
      body: JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: abortController.signal,
    });

    const response = await fetchPromise;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    // Read first chunk
    const first = await reader.read();
    assert.equal(first.done, false);

    // Abort client connection
    abortController.abort();
    await reader.cancel().catch(() => undefined);

    // Terminal recorded as cancelled
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const traceDir = readdirSync(cli.traceRoot).find((d) => !d.startsWith("."));
    const terminal = JSON.parse(readFileSync(join(cli.traceRoot, traceDir!, "999_terminal.json"), "utf8"));
    assert.equal(terminal.kind, "cancelled");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: native stream requests continue bypassing translation without regression", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("native-stream");
  const cli = await startCli(harness, "native-stream");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: SSE_CHAT_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "gpt-main",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("Hello"));
    assert.ok(streamText.includes("[DONE]"));

    // Native stream does NOT generate translation traces
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const files = traceFiles(cli.traceRoot);
    assert.ok(!files.includes("004_translation_ingress.json"));
    assert.ok(!files.includes("005_ir_request.json"));
    assert.ok(!files.includes("011_ir_events.jsonl"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});
