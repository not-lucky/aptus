import assert from "node:assert/strict";
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

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-tools-stream");

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
    casePrefix: "aptus-trans-tools-stream",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-tools-stream",
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

const STREAM_CHAT_TOOL_BYTES = new TextEncoder().encode(
  [
    'data: {"id":"chatcmpl-tool-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-tool-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":"}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-tool-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"San Francisco, CA\\"}"}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-tool-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n"),
);

const STREAM_RESPONSES_TOOL_BYTES = new TextEncoder().encode(
  [
    'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_weather_1","status":"in_progress"}}',
    "",
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"item":{"type":"function_call","id":"fc_weather","call_id":"call_weather","name":"get_weather","arguments":""}}',
    "",
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_weather","delta":"{\\"location\\":"}',
    "",
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_weather","delta":"\\"San Francisco, CA\\"}"}',
    "",
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":5,"item":{"type":"function_call","id":"fc_weather","call_id":"call_weather","name":"get_weather","arguments":"{\\"location\\":\\"San Francisco, CA\\"}"}}',
    "",
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":6,"response":{"id":"resp_weather_1","status":"completed","output":[{"type":"function_call","id":"fc_weather","call_id":"call_weather","name":"get_weather","arguments":"{\\"location\\":\\"San Francisco, CA\\"}"}]}}',
    "",
    "",
  ].join("\n"),
);

const STREAM_MESSAGES_TOOL_BYTES = new TextEncoder().encode(
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_weather_1","type":"message","role":"assistant","content":[],"model":"claude-3-5","stop_reason":null,"stop_sequence":null}}',
    "",
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_weather","name":"get_weather","input":{}}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":"}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"San Francisco, CA\\"}"}}',
    "",
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    "",
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}',
    "",
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
    "",
  ].join("\n"),
);

test.concurrent("process: C->R streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r-tools");
  const cli = await startCli(harness, "c-to-r-tools");
  try {
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_RESPONSES_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("get_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("tool_calls"));
    assert.ok(streamText.includes("data: [DONE]"));

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

test.concurrent("process: M->C two parallel interleaved function calls streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m-two-calls");
  const cli = await startCli(harness, "c-to-m-two-calls");
  try {
    const twoCallChatStream = new TextEncoder().encode(
      [
        'data: {"id":"chatcmpl-two","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-two","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_loc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}},{"index":1,"id":"call_time","type":"function","function":{"name":"get_time","arguments":"{\\"tz\\":"}}]},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-two","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}},{"index":1,"function":{"arguments":"\\"UTC\\"}"}}]},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-two","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );

    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: twoCallChatStream,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [{ role: "user", content: "weather and time?" }],
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
          { name: "get_time", input_schema: { type: "object" } },
        ],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("message_start"));
    assert.ok(streamText.includes("call_loc"));
    assert.ok(streamText.includes("get_weather"));
    assert.ok(streamText.includes("Paris"));
    assert.ok(streamText.includes("call_time"));
    assert.ok(streamText.includes("get_time"));
    assert.ok(streamText.includes("UTC"));
    assert.ok(streamText.includes("message_delta"));
    assert.ok(streamText.includes("message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M->R two parallel interleaved function calls streaming translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-r-two-calls");
  const cli = await startCli(harness, "m-to-r-two-calls");
  try {
    const twoCallResponsesStream = new TextEncoder().encode(
      [
        'event: response.created',
        'data: {"type":"response.created","sequence_number":1,"response":{"id":"resp_two"}}',
        '',
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_loc","name":"get_weather"}}',
        '',
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","sequence_number":3,"output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_time","name":"get_time"}}',
        '',
        'event: response.function_call_arguments.delta',
        'data: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"item_0","output_index":0,"delta":"{\\"city\\":\\"Paris\\"}"}',
        '',
        'event: response.function_call_arguments.delta',
        'data: {"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"item_1","output_index":1,"delta":"{\\"tz\\":\\"UTC\\"}"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_loc","name":"get_weather"}}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","sequence_number":7,"output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_time","name":"get_time"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","sequence_number":8,"response":{"id":"resp_two","status":"completed","output":[]}}',
        '',
        '',
      ].join("\n"),
    );

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: twoCallResponsesStream,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 1024,
        messages: [{ role: "user", content: "weather and time?" }],
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
          { name: "get_time", input_schema: { type: "object" } },
        ],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("message_start"));
    assert.ok(streamText.includes("call_loc"));
    assert.ok(streamText.includes("get_weather"));
    assert.ok(streamText.includes("Paris"));
    assert.ok(streamText.includes("call_time"));
    assert.ok(streamText.includes("get_time"));
    assert.ok(streamText.includes("UTC"));
    assert.ok(streamText.includes("message_delta"));
    assert.ok(streamText.includes("message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});


test.concurrent("process: interrupted tool stream closes without success terminator", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("stream-interrupted-tool");
  const cli = await startCli(harness, "stream-interrupted-tool");
  try {
    const partialToolSse =
      'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"r_int"}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"item":{"type":"function_call","id":"fc_int","call_id":"call_int","name":"fn","arguments":""}}\n\n' +
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_int","delta":"{\\"loc\\":\\"SF\\"}"}\n\n';

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "post-header-disconnect",
      segments: [{ bytes: new TextEncoder().encode(partialToolSse) }, { bytes: new Uint8Array(0), delayMs: 100 }],
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "fn", parameters: { type: "object" } } }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response).catch((err) => `caught: ${err}`);
    assert.ok(!streamText.includes("[DONE]"));

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const files = traceFiles(cli.traceRoot);
    assert.equal(files.includes("012_client_stream.sse"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: custom tool discovery in provider stream terminates without success", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("custom-tool-stream-disc");
  const cli = await startCli(harness, "custom-tool-stream-disc");
  try {
    const customToolSse =
      'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"r_custom"}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"item":{"type":"custom_tool_call","id":"ct1","name":"custom_fn"}}\n\n';

    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: new TextEncoder().encode(customToolSse),
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    );

    assert.ok(response.status === 400 || response.status === 200);
    if (response.status === 200) {
      const streamText = await readFullStreamText(response).catch((err) => `caught: ${err}`);
      assert.ok(!streamText.includes("[DONE]"));
    }
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const files = traceFiles(cli.traceRoot);
    assert.equal(files.includes("012_client_stream.sse"), false);
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: C->M streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-m-tools");
  const cli = await startCli(harness, "c-to-m-tools");
  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_MESSAGES_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-c-to-m",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("get_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("tool_calls"));
    assert.ok(streamText.includes("data: [DONE]"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R->C streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-c-tools");
  const cli = await startCli(harness, "r-to-c-tools");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_CHAT_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-c",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is the weather?" }] }],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
            strict: false,
          },
        ],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("function_call"));
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("response.completed"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: R->M streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-m-tools");
  const cli = await startCli(harness, "r-to-m-tools");
  try {
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_MESSAGES_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/responses",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-r-to-m",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is the weather?" }] }],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
            strict: false,
          },
        ],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("function_call"));
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("response.completed"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M->C streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-c-tools");
  const cli = await startCli(harness, "m-to-c-tools");
  try {
    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_CHAT_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("tool_use"));
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: M->R streamed function tool call translation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-r-tools");
  const cli = await startCli(harness, "m-to-r-tools");
  try {
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: STREAM_RESPONSES_TOOL_BYTES,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 1024,
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        stream: true,
      }),
    );

    assert.equal(response.status, 200);
    const streamText = await readFullStreamText(response);
    assert.ok(streamText.includes("tool_use"));
    assert.ok(streamText.includes("call_weather"));
    assert.ok(streamText.includes("San Francisco, CA"));
    assert.ok(streamText.includes("message_stop"));
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});

test.concurrent("process: invalid JSON stream fail-closes into M and discards 012 trace", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-invalid-json-stream");
  const cli = await startCli(harness, "m-invalid-json-stream");
  try {
    const invalidChatStream = new TextEncoder().encode(
      [
        'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"fn","arguments":"{invalid-json"}}]},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );

    harness.chatOrigin.enqueue({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      mode: "sse",
      body: invalidChatStream,
    });

    const response = await postJson(
      cli.clientPort,
      "/v1/messages",
      anthropicAuth(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "fn", input_schema: { type: "object" } }],
        stream: true,
      }),
    );

    const streamText = await readFullStreamText(response);
    assert.equal(streamText.includes("tool_use"), false);
    assert.equal(streamText.includes("message_stop"), false);

    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const files = traceFiles(cli.traceRoot);
    assert.equal(files.includes("012_client_stream.sse"), false, "012_client_stream.sse must be discarded on mid-stream failure");
  } finally {
    await cli.stop();
    await harness.closeAll();
  }
});
