/**
 * End-to-end worked examples covering the main translation shapes:
 * 1. plain-text
 * 2. inline-image
 * 3. function-loop (including invalid-JSON variant)
 * 4. structured-output
 * 5. citation
 * 6. refusal
 * 7. interrupted-stream
 * 8. native-only-state
 * 9. multiple-candidates
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { MessagesClientStreamEncoder } from "../../src/translation/codecs/messages/stream.ts";
import { ResponsesProviderStreamDecoder } from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrStreamEvent, JsonObject } from "../../src/translation/ir.ts";
import { createSseDecoder, createSseEncoder } from "../../src/translation/sse.ts";
import { TranslatedStreamPump } from "../../src/translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../../src/translation/stream-state.ts";
import { COMPLETE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";
import { COMPLETE_RESPONSES_BYTES } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";
import { createSessionBundle } from "../translation/owned-rows-helpers.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-ex");

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
`;

function startWorkedExamplesCli(harness: ThreeOriginHarness, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-ex",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-ex",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main, route-c-to-r, route-r-to-c, route-r-to-m, route-m-to-r]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
      "routes:\n": `routes:\n${TRANSLATION_ROUTES_SNIPPET}`,
    },
  });
}

const coord = createDefaultTranslationCoordinator();

// =====================================================================
// Example 1: plain-text
// =====================================================================

test.concurrent("worked example 1: plain-text streamed turns across all six directions", () => {
  const directions = [
    { source: "openai-chat" as const, target: "openai-responses" as const },
    { source: "openai-chat" as const, target: "anthropic-messages" as const },
    { source: "openai-responses" as const, target: "openai-chat" as const },
    { source: "openai-responses" as const, target: "anthropic-messages" as const },
    { source: "anthropic-messages" as const, target: "openai-chat" as const },
    { source: "anthropic-messages" as const, target: "openai-responses" as const },
  ];

  for (const dir of directions) {
    let sourceBody: JsonObject;
    if (dir.source === "openai-chat") {
      sourceBody = {
        model: "wire-model",
        stream: true,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello!" },
        ],
      };
    } else if (dir.source === "openai-responses") {
      sourceBody = {
        model: "wire-model",
        stream: true,
        input: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello!" },
        ],
      };
    } else {
      sourceBody = {
        model: "wire-model",
        stream: true,
        max_tokens: 1024,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Hello!" }],
      };
    }

    const res = coord.translateRequest({ stream: true,
      sourceProtocol: dir.source,
      targetProtocol: dir.target,
      sourceBody,
      logicalModel: "gpt-4o",
      targetModel: "wire-target",
      targetDefaultMaxTokens: dir.target === "anthropic-messages" ? 2048 : undefined,
    });
    assert.equal(res.ok, true);

    const session = createSessionBundle({
      sourceProtocol: dir.source,
      targetProtocol: dir.target,
      logicalModel: "gpt-4o",
    });

    assert.ok(session.providerDecoder !== undefined);
    assert.ok(session.clientEncoder !== undefined);
  }

  // End-to-end stream pump execution with live bytes: C client -> R provider
  const cToRSession = createSessionBundle({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    logicalModel: "gpt-4o",
  });
  const stateMachine = createIrStreamStateMachine({
    expectedResponseId: cToRSession.session.responseId,
    expectedModel: "gpt-4o",
    direction: "openai-chat->openai-responses",
  });
  const pump = new TranslatedStreamPump(
    createSseDecoder(),
    createSseEncoder(),
    cToRSession.providerDecoder,
    stateMachine,
    cToRSession.clientEncoder,
    () => {},
  );

  const upstreamSse =
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello world"}\n\n' +
    'event: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';

  const pushRes = pump.pushBytes(new TextEncoder().encode(upstreamSse));
  assert.equal(pushRes.ok, true);
  assert.ok(pushRes.value.length > 0);
  const clientText = pushRes.value.map((b) => new TextDecoder().decode(b)).join("");
  assert.ok(clientText.includes("data: "));
  assert.ok(clientText.includes("Hello world"));
  assert.ok(clientText.includes("[DONE]"));
  assert.equal(pump.isTerminal(), true);
  const finishRes = pump.finish();
  assert.equal(finishRes.ok, true);
});

test.concurrent("worked examples 8 & 9: same-protocol native passthrough admits native-only state and multi-candidates", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("ex-native-state");
  const cli = await startWorkedExamplesCli(harness, "ex-native-state");

  try {
    // 1. Chat native with n: 2 succeeds on native passthrough
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const chatRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "gpt-main",
        messages: [{ role: "user", content: "Hello" }],
        n: 2,
      }),
    );
    assert.equal(chatRes.status, 200);

    // 2. Responses native with previous_response_id succeeds on native passthrough
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    const respRes = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "responses-main",
        input: "Follow up",
        previous_response_id: "resp_native_123",
      }),
    );
    assert.equal(respRes.status, 200);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

// =====================================================================
// Example 2: inline-image
// =====================================================================

test.concurrent("worked example 2: inline-image HTTPS URL + inline PNG", () => {
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  // Chat request with HTTPS URL and inline PNG
  const chatBody: JsonObject = {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/photo.png" } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${pngB64}` } },
        ],
      },
    ],
  };

  // C -> R passes (T1)
  const cToR = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatBody,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(cToR.ok, true);

  // C -> M passes with media-type preflight (T2)
  const cToM = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: chatBody,
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(cToM.ok, true);

  // Provider image id fails closed under provider-image-id
  const chatWithId: JsonObject = {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", file_id: "file-xyz123" } as unknown as JsonObject],
      },
    ],
  };
  const cWithId = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatWithId,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(cWithId.ok, false);
});

// =====================================================================
// Example 3: function-loop & invalid-JSON variant
// =====================================================================

test.concurrent("worked example 3: function-loop parallel calls & invalid-JSON variant", () => {
  // 1. Parallel function calls with correlated tool results
  const chatReqWithTools: JsonObject = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "What is the weather and time in Paris?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Get current time",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      },
    ],
  };

  // Responses provider outcome with two function calls translates to Chat tool_calls
  const respOutcomeWith2Calls: JsonObject = {
    id: "resp_calls_2",
    object: "response",
    status: "completed",
    model: "gpt-4o",
    output: [
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"location":"Paris"}' },
      { type: "function_call", call_id: "call_2", name: "get_time", arguments: '{"location":"Paris"}' },
    ],
  };

  const toChatCalls = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respOutcomeWith2Calls,
    logicalModel: "gpt-4o",
  });
  assert.equal(toChatCalls.ok, true);
  if (toChatCalls.ok) {
    const choice = (toChatCalls.value.body.choices as JsonObject[])[0];
    const toolCalls = (choice?.message as JsonObject)?.tool_calls as JsonObject[];
    assert.equal(toolCalls.length, 2);
  }

  const toM = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: chatReqWithTools,
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(toM.ok, true);
  if (toM.ok) {
    const tools = toM.value.body.tools as JsonObject[];
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.name, "get_weather");
    assert.equal(tools[1]?.name, "get_time");
  }

  // 2. Invalid JSON arguments variant: source OpenAI returns malformed JSON
  // Invalid JSON arguments variant: source OpenAI returns malformed JSON
  const session = {
    responseId: "fn-loop-1",
    model: "claude-3-5-sonnet",
    createPartId: () => "part_fn_1",
  };

  const msgEncoder = new MessagesClientStreamEncoder(session);

  // part_end with function_call where arguments is absent (due to JSON parse failure)
  const partStart: IrStreamEvent = {
    type: "part_start",
    responseId: session.responseId,
    partId: "part_fn_1",
    part: { type: "function_call", callId: "call_123", name: "get_weather" },
  };
  assert.equal(msgEncoder.encode(partStart).ok, true);

  // When invalid JSON arrives, arguments cannot be parsed, so arguments is undefined on part_end
  const partEndInvalid: IrStreamEvent = {
    type: "part_end",
    responseId: session.responseId,
    partId: "part_fn_1",
    partType: "function_call",
    arguments: undefined, // omitted because JSON was invalid
  };

  const endResult = msgEncoder.encode(partEndInvalid);
  assert.equal(endResult.ok, false);
  if (!endResult.ok) {
    assert.equal(endResult.error.category, "invalid_request");
  }
});

// =====================================================================
// Example 4: structured-output
// =====================================================================

test.concurrent("worked example 4: structured-output JSON schema with strict: true", () => {
  const schemaObj = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  };

  const chatBody: JsonObject = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Where am I?" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Location",
        strict: true,
        schema: schemaObj,
      },
    },
  };

  // C -> R preserves strict subset (T1)
  const cToR = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatBody,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const textFmt = (cToR.value.body.text as JsonObject)?.format as JsonObject;
    assert.equal(textFmt?.type, "json_schema");
    assert.equal(textFmt?.strict, true);
  }

  // C -> M with strict: true fails closed (T3)
  const cToM = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: chatBody,
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "structured-strict-guarantee");
  }

  // M -> OpenAI: schema without name synthesizes wire-only name "response" (T2)
  const mBodyWithSchema: JsonObject = {
    model: "claude-3-5-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Output json" }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      },
    },
  };

  const mToC = coord.translateRequest({ stream: false,
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    sourceBody: mBodyWithSchema,
    logicalModel: "claude-3-5-sonnet",
    targetModel: "gpt-4o",
  });
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    const rf = mToC.value.body.response_format as JsonObject;
    assert.equal((rf?.json_schema as JsonObject)?.name, "response");
  }
});

// =====================================================================
// Example 5: citation
// =====================================================================

test.concurrent("worked example 5: citation fail-closed locator reconstruction", () => {
  // Citations that require locator reconstruction into Chat or Messages fail closed
  const respOutcomeWithCitation: JsonObject = {
    id: "resp_cit",
    object: "response",
    status: "completed",
    model: "gpt-4o",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Here is cited text.",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com",
                title: "Example Title",
                start_index: 0,
                end_index: 10,
              },
            ],
          },
        ],
      },
    ],
  };

  // Responses provider outcome -> Chat client rejects under url-citation-source
  const toChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respOutcomeWithCitation,
    logicalModel: "gpt-4o",
  });
  assert.equal(toChat.ok, false);
  if (!toChat.ok) {
    assert.equal(toChat.error.capability, "url-citation-source");
  }

  // Responses provider outcome with document citation -> Messages client rejects under citation-document-location
  const respOutcomeWithDocCitation: JsonObject = {
    id: "resp_cit_doc",
    object: "response",
    status: "completed",
    model: "gpt-4o",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Quoted from file.",
            annotations: [
              {
                type: "file_citation",
                file_id: "file_doc1",
                quote: "Quoted from file.",
              },
            ],
          },
        ],
      },
    ],
  };
  // In translation, file citations that lack locator reconstruction fail closed
  const toMDoc = coord.translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respOutcomeWithDocCitation,
    logicalModel: "gpt-4o",
  });
  assert.equal(toMDoc.ok, false);
});

// =====================================================================
// Example 6: refusal
// =====================================================================
test.concurrent("worked example 6: refusal outcome preserved C↔R and rejected into M", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("worked-ex-6");
  const cli = await startWorkedExamplesCli(harness, "worked-ex-6");

  try {
    // 1. Process level: C -> R: Chat client requests route-c-to-r, Responses origin returns refusal item
    const respRefusalBytes = new TextEncoder().encode(
      JSON.stringify({
        id: "resp_refusal_ex6",
        object: "response",
        created_at: 1775606400,
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "msg_ref_ex6",
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
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);

    // 2. Process level: C -> M: Messages client requests route-r-to-c, Chat returns refusal
    // Chat client to Anthropic Messages target with refusal rejects with refusal-content
    const chatRefusalBytes = new TextEncoder().encode(
      JSON.stringify({
        id: "chatcmpl-refusal-m",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, refusal: "I cannot assist with that request." },
            finish_reason: "stop",
          },
        ],
      }),
    );
    harness.chatOrigin.enqueue({ status: 200, body: chatRefusalBytes });

    const mRes = await fetch(`http://127.0.0.1:${cli.clientPort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.APTUS_CLIENT_PRIMARY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "route-r-to-c",
        max_tokens: 100,
        messages: [{ role: "user", content: "Forbidden instructions" }],
      }),
    });
    // Messages target has no refusal channel (T3) -> 400 invalid_request / unsupported_capability
    assert.equal(mRes.status, 400);
    const mErr = (await mRes.json()) as Record<string, unknown>;
    assert.match(JSON.stringify(mErr), /refusal-content/);
    assert.equal(harness.chatOrigin.dispatchCount(), 1);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }

  // 3. Coordinator check: Anthropic outcome with stop_reason "refusal" but ordinary text blocks never fabricates refusal text
  const mRefusalOutcome: JsonObject = {
    id: "msg_refusal_normative",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "text", text: "I cannot fulfill this request." }],
    stop_reason: "refusal",
    usage: { input_tokens: 15, output_tokens: 10 },
  };
  const mToChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: mRefusalOutcome,
    logicalModel: "claude-3-5-sonnet",
  });
  assert.equal(mToChat.ok, false);
  if (!mToChat.ok) {
    assert.equal(mToChat.error.capability, "refusal-terminal-reason");
  }
});

// =====================================================================
// Example 7: interrupted-stream & post-header in-band error
// =====================================================================

test.concurrent("worked example 7: interrupted-stream post-header error and abrupt termination", async () => {
  // 1. Process level: Messages client calls route-m-to-r with stream: true; Responses upstream emits text delta, then event: error
  const harness = await createThreeOriginHarness();
  const env = seededEnv("worked-ex-7");
  const cli = await startWorkedExamplesCli(harness, "worked-ex-7");

  try {
    const sseResponsesError = new TextEncoder().encode(
      [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_err_ex7","status":"in_progress"},"sequence_number":1}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_err_ex7"},"sequence_number":2}',
        "",
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Initial content","sequence_number":3}',
        "",
        'event: error\ndata: {"type":"error","code":"server_error","message":"Upstream server error","param":null}\n\n',
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
        max_tokens: 100,
        messages: [{ role: "user", content: "Stream me" }],
      }),
    });

    // Wire status is 200 because headers were sent before the in-band error
    assert.equal(response.status, 200);
    const text = await response.text();
    // Messages client receives text delta, then target-native error event, without message_stop
    assert.ok(text.includes("Initial content"));
    assert.ok(text.includes("event: error"));
    assert.ok(text.includes("Upstream server error"));
    assert.equal(text.includes("message_stop"), false);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);

    // Assert exact ordered Trace stages and terminal outcome (M-7)
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const traceDir = readdirSync(cli.traceRoot).find((d) => !d.startsWith("."));
    assert.ok(traceDir !== undefined, "Trace directory must exist");
    const stageFiles = readdirSync(join(cli.traceRoot, traceDir!)).sort();
    assert.deepEqual(stageFiles, [
      "000_manifest.json",
      "001_client_request.json",
      "002_authentication.json",
      "003_resolution.json",
      "004_translation_ingress.json",
      "005_ir_request.json",
      "006_translation_egress.json",
      "007_key_selection.json",
      "008_provider_request.json",
      "009_provider_response_head.json",
      "010_provider_stream.sse",
      "011_ir_events.jsonl",
      "012_client_stream.sse",
      "999_terminal.json",
    ]);

    const terminal = JSON.parse(readFileSync(join(cli.traceRoot, traceDir!, "999_terminal.json"), "utf8"));
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure.category, "provider");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }

  // 2. Unit level: Pump short-circuiting and abrupt EOF checks
  const session = {
    responseId: "interrupted-stream-1",
    model: "gpt-4o",
    createPartId: () => "p1",
  };

  const sseDecoder = createSseDecoder();
  const sseEncoder = createSseEncoder();
  const providerDecoder = new ResponsesProviderStreamDecoder(session);
  const clientEncoder = new MessagesClientStreamEncoder(session);
  const stateMachine = createIrStreamStateMachine({
    expectedResponseId: session.responseId,
    expectedModel: session.model,
    direction: "anthropic-messages->openai-responses",
  });

  const pump = new TranslatedStreamPump(sseDecoder, sseEncoder, providerDecoder, stateMachine, clientEncoder, () => {});

  // 1. Two text deltas arrive
  const textChunk0 = 'event: response.created\ndata: {"type":"response.created"}\n\n';
  const textChunk1 =
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"}}\n\n';
  const textChunk2 =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\n';
  const textChunk3 =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}\n\n';

  const res1 = pump.pushBytes(new TextEncoder().encode(textChunk0 + textChunk1 + textChunk2 + textChunk3));
  assert.equal(res1.ok, true);
  assert.ok(res1.value.length > 0);

  // 2. Post-header error arrives
  const errorChunk =
    'event: error\ndata: {"type":"error","code":"server_error","message":"Upstream failure","param":null}\n\n';
  const res2 = pump.pushBytes(new TextEncoder().encode(errorChunk));
  assert.equal(res2.ok, true);
  // Messages client receives native SSE error frame
  const decodedFrames = new TextDecoder().decode(res2.value[0]);
  assert.ok(decodedFrames.includes("event: error"));
  assert.ok(decodedFrames.includes("Upstream failure"));

  // Pump reaches terminal state without emitting message_stop or usage.
  // A later provider completion frame is ignored after the in-band error and
  // cannot produce a second terminal result.
  assert.equal(pump.isTerminal(), true);
  const postError = pump.pushBytes(
    new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'),
  );
  assert.equal(postError.ok, true);
  if (postError.ok) assert.equal(postError.value.length, 0);
  const finishRes = pump.finish();
  assert.equal(finishRes.ok, true);
  assert.equal(finishRes.value.length, 0); // No trailing terminator emitted

  // 3. Abrupt EOF mid-stream without a terminal event ends without success and emits no terminator
  const sessionAbrupt = {
    responseId: "abrupt-eof-1",
    model: "gpt-4o",
    createPartId: () => "p1",
  };
  const pumpAbrupt = new TranslatedStreamPump(
    createSseDecoder(),
    createSseEncoder(),
    new ResponsesProviderStreamDecoder(sessionAbrupt),
    createIrStreamStateMachine({
      expectedResponseId: sessionAbrupt.responseId,
      expectedModel: sessionAbrupt.model,
      direction: "anthropic-messages->openai-responses",
    }),
    new MessagesClientStreamEncoder(sessionAbrupt),
    () => {},
  );
  const pushDelta = pumpAbrupt.pushBytes(new TextEncoder().encode(textChunk0 + textChunk1 + textChunk2));
  assert.equal(pushDelta.ok, true);
  assert.equal(pumpAbrupt.isTerminal(), false);
  const abruptFinish = pumpAbrupt.finish();
  assert.equal(abruptFinish.ok, false);
  if (!abruptFinish.ok) {
    assert.equal(abruptFinish.error.category, "stream_interrupted");
  }
});

// =====================================================================
// Example 8: native-only-state
// =====================================================================

test.concurrent("worked example 8: native-only-state fails closed in translation", () => {
  // Responses previous_response_id
  const respBodyWithPreviousId: JsonObject = {
    model: "gpt-4o",
    input: "Follow-up turn",
    previous_response_id: "resp_previous123",
  };

  const toChat = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    sourceBody: respBodyWithPreviousId,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(toChat.ok, false);
  if (!toChat.ok) {
    assert.equal(toChat.error.capability, "responses-previous-id");
  }

  // Responses item_reference fails closed in translation
  const respWithItemRef: JsonObject = {
    model: "gpt-4o",
    input: [
      {
        type: "item_reference",
        id: "ref_1",
      },
    ],
  };
  const toChatRef = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    sourceBody: respWithItemRef,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(toChatRef.ok, false);
  if (!toChatRef.ok) {
    assert.equal(toChatRef.error.capability, "responses-item-reference");
  }

  // Anthropic signed thinking
  const mWithThinking: JsonObject = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            signature: "sig_abc123",
          },
          { type: "text", text: "Answer" },
        ],
      },
      { role: "user", content: "Next" },
    ],
  };

  const mToChat = coord.translateRequest({ stream: false,
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    sourceBody: mWithThinking,
    logicalModel: "claude-3-7-sonnet",
    targetModel: "gpt-4o",
  });
  assert.equal(mToChat.ok, false);
  if (!mToChat.ok) {
    assert.equal(mToChat.error.capability, "readable-reasoning");
  }

  // Anthropic pause_turn outcome fails closed in translation
  const mOutcomePause: JsonObject = {
    id: "msg_pause",
    type: "message",
    role: "assistant",
    model: "claude-3-7-sonnet",
    content: [{ type: "text", text: "Paused" }],
    stop_reason: "pause_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const mPauseToChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: mOutcomePause,
    logicalModel: "claude-3-7-sonnet",
  });
  assert.equal(mPauseToChat.ok, false);
  if (!mPauseToChat.ok) {
    assert.equal(mPauseToChat.error.capability, "anthropic-pause-turn");
  }
});

// =====================================================================
// Example 9: multiple-candidates
// =====================================================================

test.concurrent("worked example 9: multiple-candidates Chat n: 2 rejects before dispatch", () => {
  const chatWithN2: JsonObject = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    n: 2,
  };

  const toR = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatWithN2,
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(toR.ok, false);
  if (!toR.ok) {
    assert.equal(toR.error.capability, "multiple-candidates");
  }

  const toM = coord.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: chatWithN2,
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(toM.ok, false);
  if (!toM.ok) {
    assert.equal(toM.error.capability, "multiple-candidates");
  }
});
