import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { COMPLETE_CHAT_BYTES } from "../helpers/chat-fixtures.ts";
import { postJson, type RunningInProcessAptus, seededSecrets, startAptusInProcess } from "../helpers/cli-process.ts";
import { COMPLETE_MESSAGES_BYTES } from "../helpers/messages-fixtures.ts";
import { COMPLETE_RESPONSES_BYTES } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness, type ThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-trans-media");

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
    casePrefix: "aptus-trans-media",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-trans-media",
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

const SAMPLE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SAMPLE_PDF_B64 = "JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iag==";

test.concurrent("process: end-to-end C->R media translation dispatches correctly and relays 200", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r-media");
  const cli = await startTranslationCli(harness, "c-to-r-media");

  try {
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const dataUri = `data:image/png;base64,${SAMPLE_PNG_B64}`;
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-c-to-r",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this image and PDF:" },
              { type: "image_url", image_url: { url: dataUri, detail: "low" } },
              { type: "file", file: { file_data: SAMPLE_PDF_B64, filename: "doc.pdf" } },
            ],
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonObject;
    assert.equal(body.object, "chat.completion");

    // Responses origin received the translated request
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const lastReq = harness.responsesOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      input?: Array<{ content?: Array<{ type: string; image_url?: string; file_data?: string }> }>;
    };
    const parts = targetPayload.input?.[0]?.content;
    assert.ok(parts);
    assert.equal(parts[0]?.type, "input_text");
    assert.equal(parts[1]?.type, "input_image");
    assert.equal(parts[1]?.image_url, dataUri);
    assert.equal(parts[2]?.type, "input_file");
    assert.equal(parts[2]?.file_data, SAMPLE_PDF_B64);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: upstream citation outcome fails closed without unhandled exception", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("process-citation-failure");
  // Enqueue Responses origin outcome containing a provider file_citation annotation
  harness.responsesOrigin.enqueue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "resp_cite_upstream",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Information with citation",
              annotations: [
                {
                  type: "file_citation",
                  file_id: "upstream_file_99",
                  filename: "doc.pdf",
                },
              ],
            },
          ],
        },
      ],
    }),
  });

  const cli = await startTranslationCli(harness, "process-citation-failure");
  try {
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: "Query that triggers citation" }],
      }),
    );

    // When upstream origin returns citations that cannot be translated to the client protocol,
    // the gateway fails closed with an HTTP 400 error rather than crashing or relaying corrupted output.
    assert.equal(res.status, 400, `Expected HTTP 400 status but got ${res.status}`);
    const errBody = (await res.json()) as { error?: { message?: string } };
    assert.ok(
      String(errBody.error?.message).includes("file-document-citation-source"),
    );
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: zero dispatch on unsupported media capabilities (HTTP 400)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("zero-dispatch-media");
  const cli = await startTranslationCli(harness, "zero-dispatch-media");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // 1. image detail: "low" into M -> 400 image-detail-auto-low-high, 0 dispatch
    const detailIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        model: "route-c-to-m",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://example.com/pic.jpg", detail: "low" } },
            ],
          },
        ],
      }),
    );
    assert.equal(detailIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
    const detailBody = (await detailIntoM.json()) as JsonObject;
    assert.ok(
      String((detailBody.error as Record<string, unknown> | undefined)?.message).includes(
        "image-detail-auto-low-high",
      ),
    );

    // 2. file_id into M -> 400 provider-file-id, 0 dispatch
    const fileIdIntoM = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        model: "route-c-to-m",
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { file_id: "file_xyz" } }],
          },
        ],
      }),
    );
    assert.equal(fileIdIntoM.status, 400);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
    const fileIdBody = (await fileIdIntoM.json()) as JsonObject;
    assert.ok(
      String((fileIdBody.error as Record<string, unknown> | undefined)?.message).includes(
        "provider-file-id",
      ),
    );
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: zero dispatch on oversized payload (HTTP 413 payload_too_large)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("zero-dispatch-413");
  const cli = await startTranslationCli(harness, "zero-dispatch-413");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // Inline base64 > 32 MiB
    const hugeBase64 = "A".repeat(44_739_248);
    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      authHeaders,
      JSON.stringify({
        model: "route-c-to-r",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${hugeBase64}` } }],
          },
        ],
      }),
    );

    assert.equal(res.status, 413);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: end-to-end R->M translation with document URL dispatches and relays", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-to-m-doc");
  const cli = await startTranslationCli(harness, "r-to-m-doc");

  try {
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });

    const docUrl = "https://example.com/spec.pdf";
    const res = await postJson(
      cli.clientPort,
      "/responses",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-r-to-m",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Read this document:" },
              { type: "input_file", file_url: docUrl, filename: "spec.pdf" },
            ],
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonObject;
    assert.equal(body.object, "response");

    // Anthropic Messages origin received translated document block
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);
    const lastReq = harness.messagesOrigin.lastRequest();
    assert.ok(lastReq);
    const payload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      messages?: Array<{ content?: Array<{ type: string; source?: { type: string; url?: string }; title?: string }> }>;
    };
    const blocks = payload.messages?.[0]?.content;
    assert.ok(blocks);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(blocks[1]?.type, "document");
    assert.equal(blocks[1]?.source?.type, "url");
    assert.equal(blocks[1]?.source?.url, docUrl);
    assert.equal(blocks[1]?.title, "spec.pdf");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: end-to-end M->R translation with media and prompt cache breakpoint", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-to-r-media");
  const cli = await startTranslationCli(harness, "m-to-r-media");

  try {
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: SAMPLE_PNG_B64 },
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: "Describe this" },
            ],
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonObject;
    assert.equal(body.type, "message");

    // Responses origin received translated image with prompt cache breakpoint
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const lastReq = harness.responsesOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      input?: Array<{ content?: Array<{ type: string; image_url?: string; prompt_cache_breakpoint?: unknown }> }>;
    };
    const parts = targetPayload.input?.[0]?.content;
    assert.ok(parts);
    assert.equal(parts[0]?.type, "input_image");
    assert.equal(parts[0]?.image_url, `data:image/png;base64,${SAMPLE_PNG_B64}`);
    assert.deepEqual(parts[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(parts[1]?.type, "input_text");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: end-to-end C->R providerFileRef passthrough via sidecar", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-to-r-fileref");
  const cli = await startTranslationCli(harness, "c-to-r-fileref");

  try {
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    const res = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-c-to-r",
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { file_id: "file_upstream_42", filename: "report.pdf" } }],
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonObject;
    assert.equal(body.object, "chat.completion");

    // Responses origin received input_file with file_id and filename
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const lastReq = harness.responsesOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      input?: Array<{ content?: Array<{ type: string; file_id?: string; filename?: string }> }>;
    };
    const parts = targetPayload.input?.[0]?.content;
    assert.ok(parts);
    assert.equal(parts[0]?.type, "input_file");
    assert.equal(parts[0]?.file_id, "file_upstream_42");
    assert.equal(parts[0]?.filename, "report.pdf");
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: C-origin .txt file_data relays byte-verbatim to Responses and rejects into Messages", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("c-txt-bytes");
  const cli = await startTranslationCli(harness, "c-txt-bytes");

  try {
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });

    // Non-canonical base64 with internal whitespace must survive the relay
    // untouched: a Chat file part is a bytes part, never text-decoded.
    const verbatim = "aG Vsb G8=\n";
    const toR = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-c-to-r",
        messages: [
          { role: "user", content: [{ type: "file", file: { file_data: verbatim, filename: "notes.txt" } }] },
        ],
      }),
    );
    assert.equal(toR.status, 200);
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
    const lastReq = harness.responsesOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      input?: Array<{ content?: Array<{ type: string; file_data?: string; filename?: string }> }>;
    };
    const part = targetPayload.input?.[0]?.content?.[0];
    assert.equal(part?.type, "input_file");
    assert.equal(part?.file_data, verbatim);
    assert.equal(part?.filename, "notes.txt");

    // The same body targeting Messages rejects before dispatch: a text/plain
    // bytes document is not an admitted M media type.
    const toM = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({
        model: "route-c-to-m",
        messages: [
          { role: "user", content: [{ type: "file", file: { file_data: verbatim, filename: "notes.txt" } }] },
        ],
      }),
    );
    assert.equal(toM.status, 400);
    const errBody = (await toM.json()) as JsonObject;
    assert.ok(
      String((errBody.error as Record<string, unknown> | undefined)?.message).includes("document-inline-bytes"),
    );
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: R .txt text decode fails closed on invalid base64 and non-UTF-8 (zero dispatch)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("r-txt-decode");
  const cli = await startTranslationCli(harness, "r-txt-decode");

  try {
    const authHeaders = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // Invalid base64 rejects with invalid_request instead of silently decoding
    // through Node's illegal-character-skipping base64 decoder.
    const invalidB64 = await postJson(
      cli.clientPort,
      "/responses",
      authHeaders,
      JSON.stringify({
        model: "route-r-to-m",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_file", file_data: "not base64!!", filename: "report.txt" }],
          },
        ],
      }),
    );
    assert.equal(invalidB64.status, 400);
    const invalidBody = (await invalidB64.json()) as JsonObject;
    assert.ok(
      String((invalidBody.error as Record<string, unknown> | undefined)?.message).includes("base64"),
    );

    // Non-UTF-8 bytes cannot become a UTF-8 text document source; they reject
    // instead of being replacement-charged to U+FFFD.
    const nonUtf8 = await postJson(
      cli.clientPort,
      "/responses",
      authHeaders,
      JSON.stringify({
        model: "route-r-to-m",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_file", file_data: Buffer.from([0xff, 0xfe]).toString("base64"), filename: "report.txt" },
            ],
          },
        ],
      }),
    );
    assert.equal(nonUtf8.status, 400);
    const nonUtf8Body = (await nonUtf8.json()) as JsonObject;
    assert.ok(
      String((nonUtf8Body.error as Record<string, unknown> | undefined)?.message).includes("UTF-8"),
    );

    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: request-side Messages text citations fail closed before dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("m-request-citations");
  const cli = await startTranslationCli(harness, "m-request-citations");

  try {
    const authHeaders = { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY };

    // User text block carrying a web_search_result_location citation.
    const userSearch = await postJson(
      cli.clientPort,
      "/v1/messages",
      authHeaders,
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                citations: [{ type: "web_search_result_location", cited_text: "x", url: "https://a.example" }],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(userSearch.status, 400);
    const userSearchBody = (await userSearch.json()) as JsonObject;
    assert.ok(
      String((userSearchBody.error as Record<string, unknown> | undefined)?.message).includes("url-citation-source"),
    );

    // System text block carrying a locator citation (no file_id on the
    // request side; the citation surface itself is Blocked in every direction).
    const systemLocator = await postJson(
      cli.clientPort,
      "/v1/messages",
      authHeaders,
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        system: [{ type: "text", text: "rules", citations: [{ type: "char_location", cited_text: "x", document_index: 0 }] }],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(systemLocator.status, 400);
    const systemLocatorBody = (await systemLocator.json()) as JsonObject;
    assert.ok(
      String((systemLocatorBody.error as Record<string, unknown> | undefined)?.message).includes(
        "file-document-citation-source",
      ),
    );

    assert.equal(harness.chatOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: provider outcome citations that cannot be parsed fail closed instead of dropping", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("outcome-citation-drop");
  const cli = await startTranslationCli(harness, "outcome-citation-drop");

  try {
    // Anthropic upstream returns an outcome whose only citation is of an
    // unrecognized type. The gateway must terminate with unsupported_capability
    // rather than relay a success that silently omits the citation.
    harness.messagesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        id: "msg_unknown_cite",
        role: "assistant",
        content: [{ type: "text", text: "Cited claim", citations: [{ type: "mystery_location", cited_text: "x" }] }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const mOutcome = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ model: "route-c-to-m", messages: [{ role: "user", content: "query" }] }),
    );
    assert.equal(mOutcome.status, 400);
    const mOutcomeBody = (await mOutcome.json()) as JsonObject;
    assert.ok(
      String((mOutcomeBody.error as Record<string, unknown> | undefined)?.message).includes("url-citation-source"),
    );
    assert.equal(harness.messagesOrigin.dispatchCount(), 1);

    // Responses upstream returns an output_text annotation of an unrecognized
    // type; the outcome must fail closed for the Messages client too.
    harness.responsesOrigin.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "resp_unknown_annot",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Cited claim", annotations: [{ type: "file_path", path: "x" }] }],
          },
        ],
      }),
    });
    const rOutcome = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({ model: "route-m-to-r", max_tokens: 1024, messages: [{ role: "user", content: "query" }] }),
    );
    assert.equal(rOutcome.status, 400);
    const rOutcomeBody = (await rOutcome.json()) as JsonObject;
    assert.ok(
      String((rOutcomeBody.error as Record<string, unknown> | undefined)?.message).includes("url-citation-source"),
    );
    assert.equal(harness.responsesOrigin.dispatchCount(), 1);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: filename-less document relays without a filename key", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("filename-less-doc");
  const cli = await startTranslationCli(harness, "filename-less-doc");

  try {
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });

    const res = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({
        model: "route-m-to-c",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: SAMPLE_PDF_B64 } }],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(harness.chatOrigin.dispatchCount(), 1);

    const lastReq = harness.chatOrigin.lastRequest();
    assert.ok(lastReq);
    const targetPayload = JSON.parse(new TextDecoder().decode(lastReq.body)) as {
      messages?: Array<{ content?: Array<{ type: string; file?: Record<string, unknown> }> }>;
    };
    const file = targetPayload.messages?.[0]?.content?.[0]?.file;
    assert.ok(file !== undefined);
    assert.equal(file.file_data, SAMPLE_PDF_B64);
    // No source name exists, so none may be invented on the upstream wire.
    assert.equal("filename" in file, false);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: closed-world media decode rejects out-of-schema shapes (zero dispatch)", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("closed-world-decode");
  const cli = await startTranslationCli(harness, "closed-world-decode");

  try {
    const chatAuth = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };

    // Chat pins image_url to the {url, detail?} object form; the bare-string
    // spelling belongs to Responses and rejects at Chat ingress.
    const stringImageUrl = await postJson(
      cli.clientPort,
      "/chat/completions",
      chatAuth,
      JSON.stringify({
        model: "route-c-to-r",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://example.com/photo.png" }] }],
      }),
    );
    assert.equal(stringImageUrl.status, 400);
    const stringImageUrlBody = (await stringImageUrl.json()) as JsonObject;
    assert.ok(
      String((stringImageUrlBody.error as Record<string, unknown> | undefined)?.message).includes("image_url"),
    );

    // Messages pins inline image media types to jpeg/png/gif/webp; SVG is
    // outside the closed-world schema even though a data URI would carry it.
    const mSvg = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY },
      JSON.stringify({
        model: "route-m-to-r",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: SAMPLE_PNG_B64 } },
            ],
          },
        ],
      }),
    );
    assert.equal(mSvg.status, 400);
    const mSvgBody = (await mSvg.json()) as JsonObject;
    assert.ok(
      String((mSvgBody.error as Record<string, unknown> | undefined)?.message).includes("media_type"),
    );

    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});
