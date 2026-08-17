import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

/**
 * End-to-end coverage over the full HTTP pipeline: generation controls,
 * detailed usage accounting, wire-only sidecar mappings, zero-dispatch
 * rejections, and output-only discovery termination with foreign detail
 * retained solely in Trace.
 */

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-gen");

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
    casePrefix: "aptus-trans-gen",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-gen",
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

/** The Messages client endpoint requires the Anthropic-style x-api-key scheme. */
const apiKey = (secret: string): { name: string; value: string } => ({
  name: "x-api-key",
  value: secret,
});

function parsedTargetBody(origin: {
  lastRequest(): { readonly body: Uint8Array } | undefined;
}): Record<string, unknown> {
  const request = origin.lastRequest();
  assert.ok(request, "origin should have received one translated request");
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}

/** Reads the first trace directory's stage file whose name contains the fragment. */
function readTraceStage(cli: RunningInProcessAptus, fragment: string): Record<string, unknown> | undefined {
  const dirs = readdirSync(cli.traceRoot)
    .filter((name) => !name.startsWith("."))
    .sort();
  const dir = dirs[dirs.length - 1];
  assert.ok(dir, "Trace directory should exist");
  const files = readdirSync(join(cli.traceRoot, dir)).sort();
  const file = files.find((f) => f.includes(fragment) && !f.includes("_head"));
  if (file === undefined) return undefined;
  return JSON.parse(readFileSync(join(cli.traceRoot, dir, file), "utf8")) as Record<string, unknown>;
}

/** Reads an SSE response body to completion and returns it as text. */
async function drainStream(response: { body: ReadableStream<Uint8Array> | null }): Promise<string> {
  assert.ok(response.body, "streaming response should have a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Builds a Chat provider SSE stream: two deltas, a finish chunk, an optional usage chunk, [DONE]. */
function chatProviderSse(usageJson: string, includeUsage = true): Uint8Array {
  const chunk = (choices: string): string =>
    `data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":${choices}}`;
  const frames = [
    chunk('[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]'),
    "",
    chunk('[{"index":0,"delta":{"content":"hi there"},"finish_reason":null}]'),
    "",
    chunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
    "",
  ];
  if (includeUsage) {
    frames.push(chunk(`[],"usage":${usageJson}`), "");
  }
  frames.push("data: [DONE]", "", "");
  return new TextEncoder().encode(frames.join("\n"));
}

test.concurrent("process: C→R complete translation carries generation controls and detailed usage", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r-controls");
  const cli = await startCli(harness, "c-to-r-controls");

  try {
    const responsesOutcome = new TextEncoder().encode(
      JSON.stringify({
        id: "resp_ctl",
        object: "response",
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "msg_ctl",
            role: "assistant",
            content: [{ type: "output_text", text: "controlled", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
        service_tier: "default",
      }),
    );
    harness.responsesOrigin.enqueue({ status: 200, body: responsesOutcome });

    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.4,
        top_p: 0.6,
        max_completion_tokens: 256,
        verbosity: "low",
        reasoning_effort: "medium",
      }),
    );

    assert.equal(res.status, 200);

    // Exact provider-side projection of the controls.
    assert.deepEqual(parsedTargetBody(harness.responsesOrigin), {
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
      temperature: 0.4,
      top_p: 0.6,
      max_output_tokens: 256,
      text: { verbosity: "low" },
      reasoning: { effort: "medium" },
    });

    // Client-visible usage carries the subdivisions on the documented details objects.
    const body = (await res.json()) as {
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: Record<string, number>;
        completion_tokens_details?: Record<string, number>;
      };
      service_tier?: string;
    };
    assert.equal(body.usage.prompt_tokens, 10);
    assert.equal(body.usage.completion_tokens, 4);
    assert.equal(body.usage.total_tokens, 14);
    assert.deepEqual(body.usage.prompt_tokens_details, { cached_tokens: 3 });
    assert.deepEqual(body.usage.completion_tokens_details, { reasoning_tokens: 2 });
    assert.equal(body.service_tier, "default");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: C→M complete translation resolves user max value and rejects wire-only T3 rows before dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m-controls");
  const cli = await startCli(harness, "c-to-m-controls");

  try {
    // Admitted controls translate; the caller limit beats the configured default.
    harness.messagesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "msg_ctl",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 3 },
        }),
      ),
    });

    const okRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "hi" }],
        temperature: 1,
        stop: ["END"],
        max_completion_tokens: 333,
      }),
    );
    assert.equal(okRes.status, 200);
    assert.deepEqual(parsedTargetBody(harness.messagesOrigin), {
      model: "claude-opus-4-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: false,
      temperature: 1,
      max_tokens: 333,
      stop_sequences: ["END"],
    });

    // Detailed usage reconstruction for the C client.
    const okBody = (await okRes.json()) as {
      usage: { prompt_tokens: number; prompt_tokens_details?: Record<string, number> };
    };
    assert.equal(okBody.usage.prompt_tokens, 10); // 7 + 2 + 1
    assert.deepEqual(okBody.usage.prompt_tokens_details, { cached_tokens: 2, cache_write_tokens: 1 });

    // Wire-only T3 rows reject with zero dispatches.
    for (const [extra, capability] of [
      [{ store: true }, "responses-storage"],
      [{ safety_identifier: "s" }, "safety-identifier"],
      [{ service_tier: "flex" }, "service-tier"],
      [{ verbosity: "low" }, "text-verbosity"],
      [{ reasoning_effort: "high" }, "reasoning-effort-common"],
    ] as const) {
      const res = await postJson(
        cli.clientPort,
        "/chat/completions",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({ model: "route-c-to-m", messages: [{ role: "user", content: "hi" }], ...extra }),
      );
      assert.equal(res.status, 400, capability);
      const failure = (await res.json()) as { error?: { code?: string; message?: string } };
      assert.equal(failure.error?.code, null);
      assert.ok((failure.error?.message ?? "").includes(capability), `${capability}: ${failure.error?.message ?? ""}`);
    }

    // Zero provider dispatches happened for every rejection above (only the
    // admitted request reached the origin).
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: continuation/state handles and container reuse reject with their exact IDs and dispatch nothing", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("state-handles-zero-dispatch");
  const cli = await startCli(harness, "state-handles-zero-dispatch");

  try {
    // Responses-native continuation/state handles reject on the R→M direction
    // with their exact matrix capability IDs before any dispatch.
    for (const [extra, capability] of [
      [{ previous_response_id: "resp_prev" }, "responses-previous-id"],
      [{ conversation: "cnv_1" }, "responses-conversation"],
      [{ background: true }, "responses-background"],
      [{ context_management: { edits: [] } }, "responses-compaction"],
    ] as const) {
      const res = await postJson(
        cli.clientPort,
        "/responses",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({ model: "route-r-to-m", input: "hi", ...extra }),
      );
      assert.equal(res.status, 400, capability);
      const failure = (await res.json()) as { error?: { code?: string; message?: string } };
      assert.equal(failure.error?.code, null);
      assert.ok((failure.error?.message ?? "").includes(capability), `${capability}: ${failure.error?.message ?? ""}`);
    }

    // The Messages-native container-reuse param rejects out of M with its own
    // row's ID (distinct from the provider-container resource).
    const containerRes = await postJson(
      cli.clientPort,
      "/messages",
      apiKey(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        container: "cnt_1",
      }),
    );
    assert.equal(containerRes.status, 400);
    const containerFailure = (await containerRes.json()) as { error?: { code?: string; message?: string } };
    assert.ok((containerFailure.error?.message ?? "").includes("anthropic-container-reuse"));

    // Every rejection above failed closed before any provider dispatch.
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: streaming C→M collapses detailed usage and projects it onto the Chat final usage chunk", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m-stream-usage");
  const cli = await startCli(harness, "c-to-m-stream-usage");

  try {
    // Anthropic provider stream: cumulative usage carries cache subdivisions
    // plus the thinking breakdown under output_tokens_details.
    const sseBytes = new TextEncoder().encode(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"cache_read_input_tokens":4,"cache_creation_input_tokens":1,"output_tokens":1}}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
        "",
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        "",
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6,"output_tokens_details":{"thinking_tokens":3}}}',
        "",
        'event: message_stop\ndata: {"type":"message_stop"}',
        "",
        "",
      ].join("\n"),
    );
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: sseBytes,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    // The Chat client sees valid framing with the natural stop reason; no
    // matched stop string exists on a C source, so none is fabricated.
    assert.ok(streamText.includes('"finish_reason":"stop"'));
    assert.ok(!streamText.includes("END"));
    assert.ok(streamText.includes("data: [DONE]"));

    // The final usage chunk reconstructs the IR totals with subdivisions:
    // prompt_tokens is the inclusive total (9 base + 4 read + 1 write).
    assert.ok(streamText.includes('"prompt_tokens":14'));
    assert.ok(streamText.includes('"cached_tokens":4'));
    assert.ok(streamText.includes('"cache_write_tokens":1'));
    assert.ok(streamText.includes('"completion_tokens":6'));
    assert.ok(streamText.includes('"reasoning_tokens":3'));

    // The provider request projected the output limit and include_usage gating.
    const req = harness.messagesOrigin.lastRequest();
    assert.ok(req);
    const reqBody = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
    assert.equal(reqBody.max_tokens, 256);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R provider stream with a reasoning output item terminates without a success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-reasoning-discovery");
  const cli = await startCli(harness, "r-reasoning-discovery");

  try {
    const sseBytes = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_r","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"},"sequence_number":2}',
        "",
        "",
      ].join("\n"),
    );
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: sseBytes,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ model: "route-c-to-r", messages: [{ role: "user", content: "hi" }], stream: true }),
    );

    // The bootstrap fails before any client headers are committed: the client
    // sees the mapped unsupported_capability status (400 per
    // statusFromCategory), never a success terminator ([DONE]).
    assert.equal(response.status, 400);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }
    assert.equal(streamText.includes("[DONE]"), false);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");

    // Stream bootstrap failures record the fail-closed capability on the
    // terminal trace stage.
    const terminal = readTraceStage(cli, "999_terminal") as
      | { kind: string; failure?: { capability?: string } }
      | undefined;
    assert.ok(terminal !== undefined, "terminal trace should exist");
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.capability, "readable-reasoning");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M provider outcome with inference_geo terminates fail-closed and the foreign detail stays only in Trace", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-inference-geo");
  const cli = await startCli(harness, "m-inference-geo");

  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "msg_geo",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, inference_geo: "global" },
        }),
      ),
    });

    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ model: "route-c-to-m", messages: [{ role: "user", content: "hi" }] }),
    );

    assert.equal(res.status, 400);
    const failure = (await res.json()) as { error?: { code?: string; type?: string; message?: string } };
    assert.equal(failure.error?.type, "invalid_request_error");
    assert.ok(
      (failure.error?.message ?? "").includes("inference-geography"),
      "client-facing message should name the failing capability",
    );

    // The foreign detail appears only in the recorded provider_response Trace
    // stage — never in the IR or the client payload.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminalGeo = readTraceStage(cli, "999_terminal") as { kind: string; failure?: { capability?: string } };
    assert.equal(terminalGeo.kind, "failed");
    assert.equal(terminalGeo.failure?.capability, "inference-geography");
    const providerResponse = readTraceStage(cli, "provider_response");
    assert.ok(providerResponse !== undefined, "provider_response trace should exist");
    assert.equal(JSON.stringify(providerResponse).includes("inference_geo"), true);

    // Outcome translation fails before the IR is built: translation_failure
    // records the capability but never the foreign value, and no ir_outcome
    // stage can exist for this attempt.
    const translationFailure = readTraceStage(cli, "translation_failure");
    assert.ok(translationFailure !== undefined, "translation_failure trace should exist");
    const failureJson = JSON.stringify(translationFailure);
    assert.ok(failureJson.includes("inference-geography"));
    assert.equal(failureJson.includes("inference_geo"), false);
    assert.equal(failureJson.includes('"global"'), false);
    assert.equal(readTraceStage(cli, "ir_outcome"), undefined);
    assert.equal(JSON.stringify(failure).includes("global"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: the remaining four directions translate generation controls and detailed usage end-to-end", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("four-directions-complete");
  const cli = await startCli(harness, "four-directions-complete");

  try {
    // ---- R client -> Chat provider (route-r-to-c) ----
    harness.chatOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "chat_rc",
          object: "chat.completion",
          created: 1775606400,
          model: "gpt-main",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop", logprobs: null }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 2,
            total_tokens: 10,
            prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
      ),
    });
    const rToC = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-c",
        input: "hi",
        temperature: 0.25,
        top_p: 0.75,
        max_output_tokens: 128,
        text: { verbosity: "low" },
        reasoning: { effort: "high" },
      }),
    );
    assert.equal(rToC.status, 200);
    const rToCReq = parsedTargetBody(harness.chatOrigin);
    assert.equal(rToCReq.model, "gpt-5.4");
    assert.deepEqual(rToCReq.messages, [{ role: "user", content: "hi" }]);
    assert.equal(rToCReq.stream, false);
    assert.equal(rToCReq.temperature, 0.25);
    assert.equal(rToCReq.top_p, 0.75);
    assert.equal(rToCReq.max_completion_tokens, 128);
    assert.equal(rToCReq.verbosity, "low");
    assert.equal(rToCReq.reasoning_effort, "high");
    const rToCBody = (await rToC.json()) as {
      usage: {
        input_tokens: number;
        input_tokens_details?: Record<string, number>;
        output_tokens_details?: Record<string, number>;
      };
    };
    assert.equal(rToCBody.usage.input_tokens, 8);
    assert.deepEqual(rToCBody.usage.input_tokens_details, { cached_tokens: 3, cache_write_tokens: 1 });
    assert.deepEqual(rToCBody.usage.output_tokens_details, { reasoning_tokens: 2 });

    // ---- R client -> Messages provider (route-r-to-m): user output limit wins ----
    harness.messagesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "msg_rm",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 3 },
        }),
      ),
    });
    const rToM = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-m",
        input: "hi",
        temperature: 0.5,
        top_p: 0.5,
        max_output_tokens: 77,
      }),
    );
    assert.equal(rToM.status, 200);
    assert.deepEqual(parsedTargetBody(harness.messagesOrigin), {
      model: "claude-opus-4-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: false,
      temperature: 0.5,
      top_p: 0.5,
      max_tokens: 77,
    });
    // The M input formula is visible to the R client: 7 + 2 + 1.
    const rToMBody = (await rToM.json()) as {
      usage: { input_tokens: number; input_tokens_details?: Record<string, number> };
    };
    assert.equal(rToMBody.usage.input_tokens, 10);
    assert.deepEqual(rToMBody.usage.input_tokens_details, { cached_tokens: 2, cache_write_tokens: 1 });

    // ---- M client -> Chat provider (route-m-to-c) ----
    harness.chatOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "chat_mc",
          object: "chat.completion",
          created: 1775606400,
          model: "gpt-main",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop", logprobs: null }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
          },
        }),
      ),
    });
    const mToC = await postJson(
      cli.clientPort,
      "/messages",
      apiKey(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 88,
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.6,
        top_p: 0.4,
        stop_sequences: ["END"],
        metadata: { user_id: "u7" },
      }),
    );
    assert.equal(mToC.status, 200);
    const mToCReq = parsedTargetBody(harness.chatOrigin);
    assert.equal(mToCReq.max_completion_tokens, 88);
    assert.equal(mToCReq.temperature, 0.6);
    assert.equal(mToCReq.top_p, 0.4);
    assert.equal(mToCReq.stop, "END"); // single-entry scalar spelling
    const mToCBody = (await mToC.json()) as {
      usage: {
        input_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens_details?: Record<string, number>;
      };
    };
    // The M egress reconstructs base input below the cached subdivisions.
    assert.equal(mToCBody.usage.input_tokens, 4); // 8 - 3 - 1
    assert.equal(mToCBody.usage.cache_read_input_tokens, 3);
    assert.equal(mToCBody.usage.cache_creation_input_tokens, 1);

    // ---- M client -> Responses provider (route-m-to-r) ----
    harness.responsesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "resp_mr",
          object: "response",
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              type: "message",
              id: "msg_mr",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        }),
      ),
    });
    const mToR = await postJson(
      cli.clientPort,
      "/messages",
      apiKey(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(mToR.status, 200);
    assert.deepEqual(parsedTargetBody(harness.responsesOrigin), {
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
      max_output_tokens: 64,
    });
    const mToRBody = (await mToR.json()) as {
      usage: { input_tokens: number; cache_read_input_tokens?: number; output_tokens_details?: Record<string, number> };
      stop_reason: string;
      stop_sequence: string | null;
    };
    // M accounting: base input excludes the cached subdivision (12 - 5).
    assert.equal(mToRBody.usage.input_tokens, 7);
    assert.equal(mToRBody.usage.cache_read_input_tokens, 5);
    assert.deepEqual(mToRBody.usage.output_tokens_details, { thinking_tokens: 1 });

    // Every admitted request dispatched exactly once on its own origin.
    assert.equal(harness.chatOrigin.dispatchCount(), 2);
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: streaming translates across all six directions with collapsed usage and include_usage gating", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("six-directions-streaming");
  const cli = await startCli(harness, "six-directions-streaming");

  try {
    const chatUsage = '{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}';
    const responsesSse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s","status":"in_progress"}}',
      "",
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","role":"assistant"},"sequence_number":1}',
      "",
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}',
      "",
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi there"}',
      "",
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hi there"}',
      "",
      'event: response.content_part.done\ndata: {"type":"response.content_part.done","part":{"type":"output_text","text":"hi there"}}',
      "",
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant"}}',
      "",
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_s",
          status: "completed",
          usage: {
            input_tokens: 6,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
          service_tier: "flex",
        },
      })}`,
      "",
      "",
    ].join("\n");
    const messagesSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"cache_read_input_tokens":4,"cache_creation_input_tokens":1,"output_tokens":1}}}',
      "",
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      "",
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      "",
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6,"output_tokens_details":{"thinking_tokens":3}}}',
      "",
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    const sseHeaders = { "content-type": "text/event-stream; charset=utf-8" };

    // ---- C -> R: include_usage gates the final usage chunk ----
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: new TextEncoder().encode(responsesSse),
    });
    const cToRUsage = await drainStream(
      await postJson(
        cli.clientPort,
        "/chat/completions",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({
          model: "route-c-to-r",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 61,
        }),
      ),
    );
    assert.ok(cToRUsage.includes('"finish_reason":"stop"'));
    assert.ok(cToRUsage.includes('"prompt_tokens":6'));
    assert.ok(cToRUsage.includes('"cached_tokens":2'));
    assert.ok(cToRUsage.includes('"reasoning_tokens":1'));
    assert.ok(cToRUsage.includes('"service_tier":"flex"'));
    assert.ok(cToRUsage.includes("data: [DONE]"));
    assert.equal(parsedTargetBody(harness.responsesOrigin).max_output_tokens as unknown, 61);

    // Without include_usage no final usage chunk may be synthesized.
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: new TextEncoder().encode(responsesSse),
    });
    const cToRNoUsage = await drainStream(
      await postJson(
        cli.clientPort,
        "/chat/completions",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({ model: "route-c-to-r", messages: [{ role: "user", content: "hi" }], stream: true }),
      ),
    );
    assert.ok(cToRNoUsage.includes("data: [DONE]"));
    assert.equal(cToRNoUsage.includes('"prompt_tokens"'), false);

    // ---- C -> M: cumulative provider usage collapses onto the final chunk ----
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: new TextEncoder().encode(messagesSse),
    });
    const cToM = await drainStream(
      await postJson(
        cli.clientPort,
        "/chat/completions",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({
          model: "route-c-to-m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      ),
    );
    assert.ok(cToM.includes('"prompt_tokens":14')); // 9 + 4 + 1
    assert.ok(cToM.includes('"reasoning_tokens":3'));
    assert.ok(cToM.includes("data: [DONE]"));

    // ---- R -> C: the Chat usage chunk becomes the R completed payload ----
    harness.chatOrigin.enqueue({ status: 200, headers: sseHeaders, mode: "sse", body: chatProviderSse(chatUsage) });
    const rToC = await drainStream(
      await postJson(
        cli.clientPort,
        "/responses",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({ model: "route-r-to-c", input: "hi", stream: true, max_output_tokens: 55 }),
      ),
    );
    assert.ok(rToC.includes("event: response.completed"));
    assert.ok(rToC.includes('"input_tokens":5'));
    assert.ok(rToC.includes('"total_tokens":7'));
    assert.equal(parsedTargetBody(harness.chatOrigin).max_completion_tokens as unknown, 55);

    // ---- R -> M ----
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: new TextEncoder().encode(messagesSse),
    });
    const rToM = await drainStream(
      await postJson(
        cli.clientPort,
        "/responses",
        bearer(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({ model: "route-r-to-m", input: "hi", stream: true, max_output_tokens: 66 }),
      ),
    );
    assert.ok(rToM.includes("event: response.completed"));
    assert.ok(rToM.includes('"input_tokens":14'));
    assert.ok(rToM.includes('"cached_tokens":4'));
    assert.ok(rToM.includes('"reasoning_tokens":3'));
    assert.equal(parsedTargetBody(harness.messagesOrigin).max_tokens as unknown, 66);

    // ---- M -> C: an M client cannot express include_usage; the provider is
    // requested without usage and, honoring the gate, sends none — so the M
    // client receives no fabricated usage (declared loss) ----
    harness.chatOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: chatProviderSse(chatUsage, false),
    });
    const mToC = await drainStream(
      await postJson(
        cli.clientPort,
        "/messages",
        apiKey(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({
          model: "route-m-to-c",
          max_tokens: 44,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      ),
    );
    assert.ok(mToC.includes("event: message_stop"));
    assert.equal(mToC.includes('"input_tokens"'), false);
    const mToCReq = parsedTargetBody(harness.chatOrigin);
    assert.equal(mToCReq.stream, true);
    assert.equal(mToCReq.max_completion_tokens, 44);
    assert.deepEqual((mToCReq.stream_options as Record<string, unknown>).include_usage, false);

    // ---- M -> R: the R completed usage reconstructs M accounting ----
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: sseHeaders,
      mode: "sse",
      body: new TextEncoder().encode(responsesSse),
    });
    const mToR = await drainStream(
      await postJson(
        cli.clientPort,
        "/messages",
        apiKey(env.APTUS_CLIENT_PRIMARY),
        JSON.stringify({
          model: "route-m-to-r",
          max_tokens: 33,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      ),
    );
    assert.ok(mToR.includes("event: message_delta"));
    assert.ok(mToR.includes('"cache_read_input_tokens":2'));
    assert.ok(mToR.includes('"input_tokens":4')); // 6 - 2 reconstructed base

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: a thinking block discovered mid-stream terminates the client stream without a success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-thinking-midstream");
  const cli = await startCli(harness, "m-thinking-midstream");

  try {
    const sseBytes = new TextEncoder().encode(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}',
        "",
        "",
      ].join("\n"),
    );
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: sseBytes,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    // The discovery is rejected before any client headers are committed (the
    // harness delivers the provider stream as one buffered body), so the
    // client sees the mapped 400 — never a success terminator ([DONE]).
    assert.equal(response.status, 400);
    const streamText = await drainStream(response);
    assert.equal(streamText.includes("[DONE]"), false);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = readTraceStage(cli, "999_terminal") as
      | { kind: string; failure?: { capability?: string } }
      | undefined;
    assert.ok(terminal !== undefined, "terminal trace should exist");
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.capability, "readable-reasoning");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: a redacted_thinking block discovered mid-stream terminates the client stream without a success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-redacted-midstream");
  const cli = await startCli(harness, "m-redacted-midstream");

  try {
    const sseBytes = new TextEncoder().encode(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_rt","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"enc"}}',
        "",
        "",
      ].join("\n"),
    );
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: sseBytes,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    // The discovery is rejected before any client headers are committed (the
    // harness delivers the provider stream as one buffered body), so the
    // client sees the mapped 400 — never a success terminator ([DONE]).
    assert.equal(response.status, 400);
    const streamText = await drainStream(response);
    assert.equal(streamText.includes("[DONE]"), false);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = readTraceStage(cli, "999_terminal") as
      | { kind: string; failure?: { capability?: string } }
      | undefined;
    assert.ok(terminal !== undefined, "terminal trace should exist");
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.capability, "redacted-reasoning");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R provider stream with an encrypted reasoning item terminates without a success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-encrypted-reasoning");
  const cli = await startCli(harness, "r-encrypted-reasoning");

  try {
    const sseBytes = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_enc","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_enc","encrypted_content":"enc-secret"},"sequence_number":2}',
        "",
        "",
      ].join("\n"),
    );
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: sseBytes,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ model: "route-c-to-r", messages: [{ role: "user", content: "hi" }], stream: true }),
    );

    // Fail-closed before any success terminator reaches the client wire.
    assert.equal(response.status, 400);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }
    assert.equal(streamText.includes("[DONE]"), false);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = readTraceStage(cli, "999_terminal") as
      | { kind: string; failure?: { capability?: string } }
      | undefined;
    assert.ok(terminal !== undefined, "terminal trace should exist");
    assert.equal(terminal.kind, "failed");
    // The encrypted_content variant re-IDs to encrypted-reasoning, distinct from
    // the readable-reasoning trigger of a plain reasoning item.
    assert.equal(terminal.failure?.capability, "encrypted-reasoning");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: complete-path M outcome with a thinking block terminates fail-closed and foreign detail stays only in Trace", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-thinking-complete");
  const cli = await startCli(harness, "m-thinking-complete");

  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          id: "msg_think",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-1",
          content: [{ type: "thinking", thinking: "secret-reasoning-text", signature: "sig-abc" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    });

    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({ model: "route-c-to-m", messages: [{ role: "user", content: "hi" }] }),
    );

    assert.equal(res.status, 400);
    const failure = (await res.json()) as { error?: { code?: string; type?: string; message?: string } };
    assert.equal(failure.error?.type, "invalid_request_error");
    assert.ok(
      (failure.error?.message ?? "").includes("readable-reasoning"),
      "client-facing message should name the failing capability",
    );
    // The provider-owned reasoning text never reaches the client payload.
    assert.equal(JSON.stringify(failure).includes("secret-reasoning-text"), false);

    // The foreign thinking block appears only in the recorded provider_response
    // Trace stage — never in the IR or any client-facing artifact.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = readTraceStage(cli, "999_terminal") as { kind: string; failure?: { capability?: string } };
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.capability, "readable-reasoning");
    const providerResponse = readTraceStage(cli, "provider_response");
    assert.ok(providerResponse !== undefined, "provider_response trace should exist");
    assert.equal(JSON.stringify(providerResponse).includes('"thinking"'), true);

    // Outcome decoding fails before the IR is built: translation_failure names
    // the capability but never carries the foreign reasoning text, and no
    // ir_outcome stage can exist for this attempt.
    const translationFailure = readTraceStage(cli, "translation_failure");
    assert.ok(translationFailure !== undefined, "translation_failure trace should exist");
    const failureJson = JSON.stringify(translationFailure);
    assert.ok(failureJson.includes("readable-reasoning"));
    assert.equal(failureJson.includes("secret-reasoning-text"), false);
    assert.equal(readTraceStage(cli, "ir_outcome"), undefined);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});
