import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { postJson, type RunningInProcessAptus, seededSecrets, startAptusInProcess } from "../helpers/cli-process.ts";
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

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-struct");

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
    casePrefix: "aptus-trans-struct",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-struct",
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

const CONFORMING_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    user: { type: "string" },
  },
  required: ["user"],
  additionalProperties: false,
};

test.concurrent("process: end-to-end C->R translation preserves strict schema format and relays response", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r-struct");
  const cli = await startTranslationCli(harness, "c-to-r-struct");

  try {
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-r",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "user_schema",
            schema: CONFORMING_OBJECT_SCHEMA,
            strict: true,
          },
        },
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonObject;
    assert.equal(body.object, "chat.completion");

    // Responses origin received the translated request with text.format
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const lastReq = harness.responsesOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      text?: { format?: { type?: string; name?: string; strict?: boolean; schema?: JsonObject } };
    };
    assert.equal(targetPayload.text?.format?.type, "json_schema");
    assert.equal(targetPayload.text?.format?.name, "user_schema");
    assert.equal(targetPayload.text?.format?.strict, true);
    assert.deepEqual(targetPayload.text?.format?.schema, CONFORMING_OBJECT_SCHEMA);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: zero dispatch on strict:true, description, M-subset violation, legacy json_object into M, strict violation into C/R", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("zero-dispatch-struct");
  const cli = await startTranslationCli(harness, "zero-dispatch-struct");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // 1. strict: true into M -> 400 structured-strict-guarantee, 0 dispatch
    const strictIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-m",
        response_format: {
          type: "json_schema",
          json_schema: { name: "test", schema: CONFORMING_OBJECT_SCHEMA, strict: true },
        },
      }),
    );
    assert.equal(strictIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);

    // 2. description into M -> 400 structured-name-description, 0 dispatch
    const descIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-m",
        response_format: {
          type: "json_schema",
          json_schema: { name: "test", description: "non-empty description", schema: CONFORMING_OBJECT_SCHEMA },
        },
      }),
    );
    assert.equal(descIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);

    // 3. M-subset violation ($defs) into M -> 400 structured-json-schema, 0 dispatch
    const defsIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-m",
        response_format: {
          type: "json_schema",
          json_schema: { name: "test", schema: { type: "object", $defs: {} } },
        },
      }),
    );
    assert.equal(defsIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);

    // 4. legacy json_object into M -> 400 legacy-json-object, 0 dispatch
    const legacyIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-m",
        response_format: { type: "json_object" },
      }),
    );
    assert.equal(legacyIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);

    // 5. strict violation (missing additionalProperties: false) into R -> 400 structured-strict-guarantee, 0 dispatch
    const strictViolIntoR = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-r",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "test",
            schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            strict: true,
          },
        },
      }),
    );
    assert.equal(strictViolIntoR.status, 400);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: trace detail preserves exact RFC 6901 pointer for schema violation", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("trace-detail-struct");
  const cli = await startTranslationCli(harness, "trace-detail-struct");

  try {
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "route-c-to-r",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "test",
            schema: {
              type: "object",
              properties: {
                "user/name": {
                  type: "object",
                  properties: {
                    field: { anyOf: [{ type: "string" }] },
                  },
                  required: ["field"],
                  additionalProperties: false,
                },
              },
              required: ["user/name"],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      }),
    );

    assert.equal(res.status, 400);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);

    const traceDir = traceDirectories(cli.traceRoot)[0];
    assert.ok(traceDir, "Trace directory should exist");
    const stageFiles = readdirSync(join(cli.traceRoot, traceDir)).sort();
    const failureFile = stageFiles.find((f) => f.includes("translation_failure"));
    assert.ok(failureFile, "Translation failure trace should exist");

    const failureTrace = JSON.parse(readFileSync(join(cli.traceRoot, traceDir, failureFile), "utf8")) as {
      category: string;
      capability: string;
      message: string;
    };
    assert.equal(failureTrace.category, "unsupported_capability");
    assert.equal(failureTrace.capability, "structured-strict-guarantee");
    assert.equal(failureTrace.message, "/properties/user~1name/properties/field/anyOf: anyOf");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: same-protocol native passthrough preserves format fields and bypasses IR", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("native-bypass-struct");
  const cli = await startTranslationCli(harness, "native-bypass-struct");

  try {
    // 1. Chat native with response_format
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    const chatRes = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_CHAT_REQUEST,
        model: "gpt-main",
        response_format: { type: "json_object" },
      }),
    );
    assert.equal(chatRes.status, 200);
    assert.equal(harness.chatOrigin.dispatchCount(), 1);
    const chatLast = harness.chatOrigin.lastRequest();
    assert.ok(chatLast);
    const chatPayload = JSON.parse(new TextDecoder().decode(chatLast.body)) as { response_format?: { type?: string } };
    assert.equal(chatPayload.response_format?.type, "json_object");

    // 2. Responses native with text.format
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    const respRes = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        ...MINIMAL_RESPONSES_REQUEST,
        model: "responses-main",
        text: { format: { type: "json_object" } },
      }),
    );
    assert.equal(respRes.status, 200);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);

    // 3. Messages native with output_config
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    const msgRes = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({
        ...MINIMAL_MESSAGES_REQUEST,
        model: "claude-main",
        output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      }),
    );
    assert.equal(msgRes.status, 200);
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});
