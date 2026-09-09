import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";
import { type ChatOrigin, createChatOrigin } from "../helpers/chat-origin.ts";
import { createProviderOrigin, type ProviderOrigin } from "../helpers/provider-origin.ts";
import { MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.ts";

/**
 * Process-level pins for the shared stream-relay engine's terminal outcomes.
 *
 * These exercise the real HTTP ingress, dispatcher, trace recorder, and the unified
 * {@link runStreamRelay} engine together. They complement the engine unit tests
 * (`test/routing/stream-relay.test.ts`) and the adapter functional tests
 * (`test/routing/relay-stream.test.ts`, `test/routing/translated-stream-relay.test.ts`)
 * by asserting what the client and the trace directory observably contain after each
 * non-clean terminal: no forged success marker, a `failed` terminal written before the
 * HTTP layer tears down, and the uniform sink rule (terminal → committed stream file,
 * transport abort/error → no partial stream file survives).
 */

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-stream-terminal");

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

function startChatCli(origin: ChatOrigin, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-stream-terminal",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-stream-terminal",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${origin.baseUrl}`,
    },
  });
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

function startResponsesCli(origin: ProviderOrigin, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-stream-terminal",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-stream-terminal",
    replacements: {
      "    baseUrl: https://api.openai.com/v1\n": `    baseUrl: ${origin.baseUrl}\n`,
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
    },
  });
}

/** The newest non-dot trace directory under the trace root. */
function traceDir(cli: RunningInProcessAptus): string {
  const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir, "no trace directory committed");
  return join(cli.traceRoot, dir);
}

/** Reads the newest trace directory's terminal file. */
function terminalJson(cli: RunningInProcessAptus): { kind: string; failure?: { category: string } } {
  const dir = traceDir(cli);
  const names = readdirSync(dir);
  assert.ok(names.includes("999_terminal.json"), `missing 999_terminal.json in ${names.join(",")}`);
  return JSON.parse(readFileSync(join(dir, "999_terminal.json"), "utf8")) as {
    kind: string;
    failure?: { category: string };
  };
}

/** File names in the newest trace directory (sink commits appear here). */
function traceNames(cli: RunningInProcessAptus): string[] {
  return readdirSync(traceDir(cli)).sort();
}

/**
 * Reads a response body to the end, tolerating an abrupt connection teardown.
 *
 * The engine errors the downstream stream (rather than closing it) for interrupted and
 * transport-failed terminals, and the HTTP layer destroys the socket once headers are
 * committed — so the body read rejects after whatever bytes already arrived.
 */
async function readBodyToleratingReset(response: Response): Promise<{ text: string; reset: boolean }> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let reset = false;
  while (true) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await reader.read();
    } catch {
      reset = true;
      break;
    }
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode(new Uint8Array(0), { stream: false });
  return { text, reset };
}

/** Two Chat delta frames with no `[DONE]` terminator. */
const CHAT_TRUNCATED_SSE = new TextEncoder().encode(
  [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":"alpha"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"beta"},"finish_reason":null}]}',
    "",
    "",
  ].join("\n"),
);

test.concurrent("process: native Chat stream ending without [DONE] interrupts with a failed 502 terminal and no success marker", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("chat-truncated");
  const cli = await startChatCli(origin, "chat-truncated");
  try {
    // Clean provider EOF after two delta frames, but no `[DONE]` terminator.
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [{ bytes: CHAT_TRUNCATED_SSE }],
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);

    const { text, reset } = await readBodyToleratingReset(response);
    // Both deltas were relayed byte-identically before the interruption...
    assert.ok(text.includes('"alpha"'), `delta alpha must reach the client: ${text}`);
    assert.ok(text.includes('"beta"'), `delta beta must reach the client: ${text}`);
    // ...and no success terminator may be invented for a stream that never ended cleanly.
    assert.ok(!text.includes("[DONE]"), "truncated stream must not gain a forged [DONE]");
    // The engine errors the downstream stream for an interrupted EOF, so the client
    // observes an abrupt end, never a clean completion.
    assert.equal(reset, true, "interrupted EOF must tear the downstream stream down");

    // The engine finalizes the interrupted failure before the HTTP layer tears down:
    // a second (client-app) finalize must not clobber it with an internal fault.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = terminalJson(cli);
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.category, "stream_interrupted");

    // Uniform sink rule for an EOF terminal: the provider stream ends (committed with
    // its partial bytes), while the downstream client stream is discarded on the error.
    const names = traceNames(cli);
    assert.ok(
      names.some((name) => name.endsWith("_provider_stream.sse")),
      `truncated provider stream must be committed: ${names.join(",")}`,
    );
    assert.equal(
      names.some((name) => name.endsWith("_client_stream.sse")),
      false,
      "no partial downstream client stream file may survive an interrupted relay",
    );

    // No retry or fallback dispatch follows a post-header stream terminal.
    assert.equal(origin.dispatchCount(), 1);
  } finally {
    await origin.close();
    await cli.stop();
  }
});

test.concurrent("process: native Chat mid-stream transport reset discards partial stream files with a failed terminal", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("chat-reset");
  const cli = await startChatCli(origin, "chat-reset");
  try {
    // The origin sends one complete delta frame, then destroys the socket mid-stream
    // (the delayed empty segment lets the head and chunk flush before the destroy).
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "post-header-disconnect",
      segments: [
        { bytes: 'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n' },
        { bytes: "", delayMs: 100 },
      ],
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);

    const { text, reset } = await readBodyToleratingReset(response);
    assert.ok(text.includes('"partial"'), `relayed bytes must reach the client before the reset: ${text}`);
    assert.ok(!text.includes("[DONE]"));
    assert.equal(reset, true, "a destroyed provider socket must surface as a downstream stream error");

    // The transport error is a genuine failure, not a cancellation: the client never
    // aborted, so the terminal must be failed with the stream-interrupted category.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = terminalJson(cli);
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.category, "stream_interrupted");

    // Sink hygiene: a mid-stream transport error discards both partial sinks, so no
    // truncated `_provider_stream.sse` or `_client_stream.sse` file may survive.
    const names = traceNames(cli);
    assert.equal(
      names.some((name) => name.endsWith("_provider_stream.sse")),
      false,
      `no partial provider stream file may survive a transport reset: ${names.join(",")}`,
    );
    assert.equal(
      names.some((name) => name.endsWith("_client_stream.sse")),
      false,
      `no partial client stream file may survive a transport reset: ${names.join(",")}`,
    );

    // Post-header transport failures cannot retry or fall back.
    assert.equal(origin.dispatchCount(), 1);
  } finally {
    await origin.close();
    await cli.stop();
  }
});

test.concurrent("process: native Responses stream ending without a terminal event interrupts with a failed terminal", async () => {
  const origin = await createProviderOrigin({ basePath: "/v1" });
  const env = seededEnv("responses-truncated");
  const cli = await startResponsesCli(origin, "responses-truncated");
  try {
    // A lifecycle that begins normally but ends after deltas, with no terminal event
    // (no response.completed / response.failed / response.incomplete / error).
    const truncated = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"},"sequence_number":2}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello","sequence_number":3}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" truncated","sequence_number":4}',
        "",
        "",
      ].join("\n"),
    );
    origin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      mode: "sse",
      segments: [{ bytes: truncated }],
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ ...MINIMAL_RESPONSES_REQUEST, stream: true }),
    );
    assert.equal(response.status, 200);

    const { text, reset } = await readBodyToleratingReset(response);
    // Bytes are relayed exactly as the provider sent them (native pass-through)...
    assert.ok(text.includes('"delta":"Hello"'), `delta bytes must reach the client: ${text}`);
    assert.ok(text.includes('"delta":" truncated"'));
    // ...with no invented [DONE] and no clean completion for a missing terminal event.
    assert.ok(!text.includes("data: [DONE]"));
    assert.equal(reset, true, "a missing Responses terminal event must error the downstream stream");

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = terminalJson(cli);
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.category, "stream_interrupted");

    const names = traceNames(cli);
    assert.ok(
      names.some((name) => name.endsWith("_provider_stream.sse")),
      `truncated provider stream must be committed: ${names.join(",")}`,
    );
    assert.equal(
      names.some((name) => name.endsWith("_client_stream.sse")),
      false,
      "no partial downstream client stream file may survive an interrupted relay",
    );

    assert.equal(origin.dispatchCount(), 1);
  } finally {
    await origin.close();
    await cli.stop();
  }
});
