/**
 * Automated Conformance Runner: verifies the behavior of capabilities
 * against the static CONFORMANCE_MANIFEST across all six directions and tiers.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { Protocol } from "../../src/domain/contracts.ts";
import { ChatClientStreamEncoder } from "../../src/translation/codecs/chat/stream.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
} from "../../src/translation/codecs/responses/stream.ts";
import type { Direction } from "../../src/translation/contracts.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { JsonObject } from "../../src/translation/ir.ts";
import type { MatrixRowId } from "../../src/translation/matrix.ts";
import { refusalFinishCapability } from "../../src/translation/preflight.ts";
import { CONFORMANCE_MANIFEST } from "./matrix-manifest.ts";

const coord = createDefaultTranslationCoordinator();

const ALL_DIRECTIONS: readonly Direction[] = [
  "openai-chat->openai-responses",
  "openai-chat->anthropic-messages",
  "openai-responses->openai-chat",
  "openai-responses->anthropic-messages",
  "anthropic-messages->openai-chat",
  "anthropic-messages->openai-responses",
];

test("conformance runner: manifest rows have valid tier distribution across directions", () => {
  let t1Count = 0;
  let t2Count = 0;
  let t3Count = 0;

  for (const row of CONFORMANCE_MANIFEST) {
    for (const dir of ALL_DIRECTIONS) {
      const tier = row.tiers[dir];
      if (tier === "T1") t1Count++;
      else if (tier === "T2") t2Count++;
      else if (tier === "T3") t3Count++;
      else {
        assert.fail(`Invalid tier ${tier} for row ${row.id} in direction ${dir}`);
      }
    }
  }

  // Every manifest cell names a supported tier; each tier is exercised at least once.
  assert.equal(t1Count + t2Count + t3Count, CONFORMANCE_MANIFEST.length * ALL_DIRECTIONS.length);
  assert.ok(t1Count > 0, "Expected T1 capabilities");
  assert.ok(t2Count > 0, "Expected T2 capabilities");
  assert.ok(t3Count > 0, "Expected T3 capabilities");
});

test("conformance runner: T3 outcome capabilities reject fail-closed across protocols", () => {
  const outcomeCases: Array<{
    name: string;
    sourceProtocol: Protocol;
    targetProtocol: Protocol;
    body: JsonObject;
    expectedCapability: string;
  }> = [
    {
      name: "refusal-content into Anthropic Messages",
      sourceProtocol: "anthropic-messages" as const,
      targetProtocol: "openai-chat" as const,
      body: {
        id: "chatcmpl-ref",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "No" }, finish_reason: "stop" }],
      },
      expectedCapability: "refusal-content",
    },
    {
      name: "finish-content-filter into Anthropic Messages",
      sourceProtocol: "anthropic-messages" as const,
      targetProtocol: "openai-chat" as const,
      body: {
        id: "chatcmpl-filter",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "Filtered" }, finish_reason: "content_filter" }],
      },
      expectedCapability: "finish-content-filter",
    },
    {
      name: "refusal-terminal-reason from Anthropic Messages",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "anthropic-messages" as const,
      body: {
        id: "msg-ref",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "Refusal" }],
        stop_reason: "refusal",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      expectedCapability: "refusal-terminal-reason",
    },
    {
      name: "finish-context-limit from Anthropic Messages",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "anthropic-messages" as const,
      body: {
        id: "msg-ctx",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "Context limit" }],
        stop_reason: "model_context_window_exceeded",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      expectedCapability: "finish-context-limit",
    },
    {
      name: "finish-other-unknown across protocols",
      sourceProtocol: "openai-responses" as const,
      targetProtocol: "openai-chat" as const,
      body: {
        id: "chatcmpl-other",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "unknown_stop_reason" }],
      },
      expectedCapability: "finish-other-unknown",
    },
  ];

  for (const c of outcomeCases) {
    const res = coord.translateCompleteOutcome({
      sourceProtocol: c.sourceProtocol,
      targetProtocol: c.targetProtocol,
      status: 200,
      headers: { "content-type": "application/json" },
      body: c.body,
      logicalModel: "gpt-4o",
    });

    assert.equal(res.ok, false, `Expected ${c.name} to reject`);
    if (!res.ok) {
      assert.equal(res.error.capability, c.expectedCapability, `Mismatch on ${c.name}`);
    }
  }
});

test("conformance runner: T3 streaming encoder capabilities reject unsupported stream events", () => {
  const session = {
    responseId: "conf-stream-1",
    model: "claude-3-5-sonnet",
    createPartId: () => "p1",
  };
  const msgEncoder = new MessagesClientStreamEncoder(session);

  // Messages client encoder rejects refusal_delta
  const refusalDeltaRes = msgEncoder.encode({
    type: "refusal_delta",
    responseId: session.responseId,
    partId: "p1",
    text: "Refusal text",
  });
  assert.equal(refusalDeltaRes.ok, false);
  if (!refusalDeltaRes.ok) {
    assert.equal(refusalDeltaRes.error.capability, "refusal-stream-delta");
  }
});

test("conformance runner: every area owns at least one manifest row", () => {
  const areaCounts: Record<string, number> = {};
  for (const row of CONFORMANCE_MANIFEST) {
    areaCounts[row.area] = (areaCounts[row.area] ?? 0) + 1;
  }

  for (const area of [
    "transcript",
    "streaming",
    "controls",
    "tools",
    "tools-streaming",
    "structured",
    "media",
    "terminal",
  ]) {
    assert.ok((areaCounts[area] ?? 0) > 0, `Area ${area} owns zero rows in manifest`);
  }
  const totalAssigned = Object.values(areaCounts).reduce((a, b) => a + b, 0);
  assert.equal(totalAssigned, CONFORMANCE_MANIFEST.length);
});

test("conformance runner: T3 request-level capabilities reject before dispatch", () => {
  // Test a representative sample of T3 request-level capabilities across areas
  const t3RequestCases: Array<{
    capability: string;
    sourceProtocol: Protocol;
    targetProtocol: Protocol;
    body: JsonObject;
  }> = [
    {
      capability: "multiple-candidates",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "openai-responses" as const,
      body: { model: "m", messages: [{ role: "user", content: "hi" }], n: 2 },
    },
    {
      capability: "chat-legacy-max-tokens",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "openai-responses" as const,
      body: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
    },
    {
      capability: "openai-prompt-cache-retention",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "openai-responses" as const,
      body: { model: "m", messages: [{ role: "user", content: "hi" }], prompt_cache_retention: "in_memory" },
    },
    {
      capability: "responses-preview-multi-agent",
      sourceProtocol: "openai-responses" as const,
      targetProtocol: "openai-chat" as const,
      body: { model: "m", input: "hi", multi_agent: true },
    },
    {
      capability: "audio-output",
      sourceProtocol: "openai-chat" as const,
      targetProtocol: "openai-responses" as const,
      body: { model: "m", messages: [{ role: "user", content: "hi" }], modalities: ["text", "audio"] },
    },
  ];

  for (const c of t3RequestCases) {
    const res = coord.translateCompleteRequest({
      sourceProtocol: c.sourceProtocol,
      targetProtocol: c.targetProtocol,
      sourceBody: c.body,
      logicalModel: "m",
      targetModel: "upstream-m",
    });

    assert.equal(res.ok, false, `Expected ${c.capability} to reject`);
    if (!res.ok) {
      assert.equal(res.error.capability, c.capability);
    }
  }
});

test("conformance runner: T1 complete turns translate without zero-dispatch failure", () => {
  // Core text turn C->R, R->C, C->M, M->C
  const cToR = coord.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: { model: "gpt-4o", messages: [{ role: "user", content: "Hello world" }] },
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(cToR.ok, true);

  const rToC = coord.translateCompleteRequest({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    sourceBody: { model: "gpt-4o", input: "Hello world" },
    logicalModel: "gpt-4o",
    targetModel: "gpt-4o",
  });
  assert.equal(rToC.ok, true);

  const cToM = coord.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: { model: "gpt-4o", messages: [{ role: "user", content: "Hello world" }] },
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet-20241022",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(cToM.ok, true);

  const mToC = coord.translateCompleteRequest({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    sourceBody: { model: "claude-3-5-sonnet", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] },
    logicalModel: "claude-3-5-sonnet",
    targetModel: "gpt-4o",
  });
  assert.equal(mToC.ok, true);
});

test("conformance runner: T1 complete turns cover the remaining two directions R->M and M->R", () => {
  const coord = createDefaultTranslationCoordinator();

  const rToM = coord.translateCompleteRequest({
    sourceProtocol: "openai-responses",
    targetProtocol: "anthropic-messages",
    sourceBody: { model: "gpt-4o", input: "Hello world" },
    logicalModel: "gpt-4o",
    targetModel: "claude-3-5-sonnet-20241022",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(rToM.ok, true);

  const mToR = coord.translateCompleteRequest({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-responses",
    sourceBody: { model: "claude-3-5-sonnet", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] },
    logicalModel: "claude-3-5-sonnet",
    targetModel: "gpt-4o",
  });
  assert.equal(mToR.ok, true);
});

// =====================================================================
// Manifest-driven terminal T3 coverage (Task 17 scope)
// =====================================================================
//
// Each builder below produces the trigger body for one source (request) or
// provider (outcome) protocol. Legacy and preview rows fire with their own
// capability only from their native source protocol; every other source
// fails closed with `unknown-request-field` (or stays natively valid, e.g.
// Messages `max_tokens`), which the expectations encode per direction.

function t1RequestBody(source: Protocol): JsonObject {
  if (source === "openai-chat") return { model: "m", messages: [{ role: "user", content: "hi" }] };
  if (source === "openai-responses") return { model: "m", input: "hi" };
  return { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
}

test("conformance runner: terminal request rows reject fail-closed in every T3 direction", () => {
  const coord = createDefaultTranslationCoordinator();
  const manifestById = new Map(CONFORMANCE_MANIFEST.map((row) => [row.id, row]));
  const cases: Array<{
    rowId: MatrixRowId;
    buildBody: (source: Protocol) => JsonObject;
    expect: (source: Protocol) => { ok: true } | { ok: false; capability?: string };
  }> = [
    {
      rowId: "unknown-request-field",
      buildBody: (source) => ({ ...t1RequestBody(source), future_field_zzz: 1 }),
      expect: () => ({ ok: false, capability: "unknown-request-field" }),
    },
    {
      rowId: "chat-legacy-max-tokens",
      buildBody: (source) =>
        source === "openai-chat"
          ? { ...t1RequestBody(source), max_tokens: 5 }
          : source === "openai-responses"
            ? { ...t1RequestBody(source), max_tokens: 5 }
            : t1RequestBody(source),
      // Native Chat rejects with the row; Responses has no such field so it
      // reports unknown; Messages `max_tokens` is natively required and valid.
      expect: (source) =>
        source === "openai-chat"
          ? { ok: false, capability: "chat-legacy-max-tokens" }
          : source === "openai-responses"
            ? { ok: false, capability: "unknown-request-field" }
            : { ok: true },
    },
    {
      rowId: "openai-prompt-cache-retention",
      buildBody: (source) => ({ ...t1RequestBody(source), prompt_cache_retention: "in_memory" }),
      // Chat and Responses share the prompt-cache sidecar, so both reject
      // with the row; Messages sources report unknown.
      expect: (source) =>
        source === "anthropic-messages"
          ? { ok: false, capability: "unknown-request-field" }
          : { ok: false, capability: "openai-prompt-cache-retention" },
    },
    {
      rowId: "responses-preview-multi-agent",
      buildBody: (source) => ({ ...t1RequestBody(source), multi_agent: true }),
      // Native Responses rejects with the row; every other source reports unknown.
      expect: (source) =>
        source === "openai-responses"
          ? { ok: false, capability: "responses-preview-multi-agent" }
          : { ok: false, capability: "unknown-request-field" },
    },
  ];

  for (const { rowId, buildBody, expect } of cases) {
    const row = manifestById.get(rowId);
    assert.ok(row !== undefined, `manifest row missing: ${rowId}`);
    for (const dir of ALL_DIRECTIONS) {
      if (row.tiers[dir] !== "T3") continue;
      const [source, target] = dir.split("->") as [Protocol, Protocol];
      const expected = expect(source);
      const res = coord.translateCompleteRequest({
        sourceProtocol: source,
        targetProtocol: target,
        sourceBody: buildBody(source),
        logicalModel: "m",
        targetModel: "u",
        targetDefaultMaxTokens: 2048,
      });
      if (expected.ok) {
        assert.equal(res.ok, true, `${rowId} ${dir} should stay natively valid`);
      } else {
        assert.equal(res.ok, false, `${rowId} ${dir} should reject`);
        if (!res.ok && expected.capability !== undefined) {
          assert.equal(res.error.capability, expected.capability, `${rowId} ${dir} capability`);
        }
      }
    }
  }
});

test("conformance runner: preview tool rows reject with their row from Responses sources", () => {
  const coord = createDefaultTranslationCoordinator();
  const manifestById = new Map(CONFORMANCE_MANIFEST.map((row) => [row.id, row]));
  const previews: Array<{ rowId: MatrixRowId; tool: JsonObject }> = [
    { rowId: "hosted-web-search-preview", tool: { type: "web_search_preview" } },
    {
      rowId: "hosted-computer-use-preview",
      tool: { type: "computer_use_preview", display_width: 800, display_height: 600, environment: "browser" },
    },
    { rowId: "hosted-local-shell-preview", tool: { type: "local_shell" } },
  ];

  for (const { rowId, tool } of previews) {
    const row = manifestById.get(rowId);
    assert.ok(row !== undefined, `manifest row missing: ${rowId}`);
    for (const dir of ALL_DIRECTIONS) {
      if (row.tiers[dir] !== "T3") continue;
      const [source, target] = dir.split("->") as [Protocol, Protocol];
      if (source !== "openai-responses") continue;
      const res = coord.translateCompleteRequest({
        sourceProtocol: source,
        targetProtocol: target,
        sourceBody: { ...(t1RequestBody(source) as Record<string, JsonObject>), tools: [tool] },
        logicalModel: "m",
        targetModel: "u",
        targetDefaultMaxTokens: 2048,
      });
      assert.equal(res.ok, false, `${rowId} ${dir} should reject`);
      if (!res.ok) {
        assert.equal(res.error.capability, rowId, `${rowId} ${dir} capability`);
      }
    }
  }
});

function refusalOutcomeBody(provider: Protocol): JsonObject {
  if (provider === "openai-chat") {
    return {
      id: "chatcmpl-ref",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "No" }, finish_reason: "stop" }],
    };
  }
  if (provider === "openai-responses") {
    return {
      id: "resp_ref",
      object: "response",
      created_at: 1700000000,
      status: "completed",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          id: "msg_ref",
          role: "assistant",
          content: [{ type: "refusal", refusal: "No" }],
        },
      ],
    };
  }
  return {
    id: "msg_ref",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "text", text: "No" }],
    stop_reason: "refusal",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test("conformance runner: terminal outcome rows reject with exact capabilities in every T3 direction", () => {
  const coord = createDefaultTranslationCoordinator();
  const manifestById = new Map(CONFORMANCE_MANIFEST.map((row) => [row.id, row]));
  for (const dir of ALL_DIRECTIONS) {
    const [source, target] = dir.split("->") as [Protocol, Protocol];
    const hasRefusalPart = target !== "anthropic-messages";
    const expected = refusalFinishCapability(dir, hasRefusalPart);
    // Admitted C/R cells carry T1; every Messages-involving cell carries T3.
    const row = manifestById.get(expected ?? "refusal-content");
    assert.ok(row !== undefined && row.tiers[dir] === (expected === undefined ? "T1" : "T3"));
    const res = coord.translateCompleteOutcome({
      sourceProtocol: source,
      targetProtocol: target,
      status: 200,
      headers: { "content-type": "application/json" },
      body: refusalOutcomeBody(target),
      logicalModel: "m",
    });
    if (expected === undefined) {
      assert.equal(res.ok, true, `refusal ${dir} should translate`);
    } else {
      assert.equal(res.ok, false, `refusal ${dir} should reject`);
      if (!res.ok) {
        assert.equal(res.error.capability, expected, `refusal ${dir} capability`);
      }
    }
  }

  // Unknown finishes reject with finish-other-unknown from every provider.
  const unknownFinishBody = (provider: Protocol): JsonObject => {
    if (provider === "openai-chat") {
      return {
        id: "chatcmpl-unk",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "custom_nope" }],
      };
    }
    if (provider === "openai-responses") {
      return {
        id: "resp_unk",
        object: "response",
        created_at: 1700000000,
        status: "incomplete",
        incomplete_details: { reason: "custom_nope" },
        model: "gpt-4o",
        output: [{ type: "message", id: "msg_unk", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }],
      };
    }
    return {
      id: "msg_unk",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "custom_nope",
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  };
  const unknownRow = manifestById.get("finish-other-unknown");
  assert.ok(unknownRow !== undefined);
  for (const dir of ALL_DIRECTIONS) {
    if (unknownRow.tiers[dir] !== "T3") continue;
    const [source, target] = dir.split("->") as [Protocol, Protocol];
    const res = coord.translateCompleteOutcome({
      sourceProtocol: source,
      targetProtocol: target,
      status: 200,
      headers: { "content-type": "application/json" },
      body: unknownFinishBody(target),
      logicalModel: "m",
    });
    assert.equal(res.ok, false, `finish-other-unknown ${dir} should reject`);
    if (!res.ok) {
      assert.equal(res.error.capability, "finish-other-unknown", `finish-other-unknown ${dir} capability`);
    }
  }

  // Unknown content items reject from Responses and Messages providers.
  const unknownItemRow = manifestById.get("unknown-content-item");
  assert.ok(unknownItemRow !== undefined);
  const unknownItemBody = (provider: Protocol): JsonObject | undefined => {
    if (provider === "openai-responses") {
      return {
        id: "resp_unkitem",
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "gpt-4o",
        output: [
          {
            type: "message",
            id: "msg_unkitem",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi" }, { type: "mystery_part" }],
          },
        ],
      };
    }
    if (provider === "anthropic-messages") {
      return {
        id: "msg_unkitem",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "Hi" }, { type: "mystery_block" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    }
    return undefined;
  };
  for (const dir of ALL_DIRECTIONS) {
    if (unknownItemRow.tiers[dir] !== "T3") continue;
    const [source, target] = dir.split("->") as [Protocol, Protocol];
    const body = unknownItemBody(target);
    if (body === undefined) continue;
    const res = coord.translateCompleteOutcome({
      sourceProtocol: source,
      targetProtocol: target,
      status: 200,
      headers: { "content-type": "application/json" },
      body,
      logicalModel: "m",
    });
    assert.equal(res.ok, false, `unknown-content-item ${dir} should reject`);
    if (!res.ok) {
      assert.equal(res.error.capability, "unknown-content-item", `unknown-content-item ${dir} capability`);
    }
  }
});

test("conformance runner: unknown stream events reject in every provider decoder", () => {
  const manifestById = new Map(CONFORMANCE_MANIFEST.map((row) => [row.id, row]));
  const row = manifestById.get("unknown-stream-event");
  assert.ok(row !== undefined);

  // Messages provider decoder rejects unknown SSE event names.
  const messages = new MessagesProviderStreamDecoder({
    responseId: "unk-stream-m",
    model: "m",
    createPartId: () => "p1",
  });
  const messagesRes = messages.push({ event: "mystery_event", data: JSON.stringify({ type: "mystery_event" }) });
  assert.equal(messagesRes.ok, false);
  if (!messagesRes.ok) {
    assert.equal(messagesRes.error.capability, "unknown-stream-event");
  }

  // Responses provider decoder rejects unknown SSE event names fail-closed.
  const responses = new ResponsesProviderStreamDecoder({
    responseId: "unk-stream-r",
    model: "m",
    createPartId: () => "p1",
  });
  const responsesRes = responses.push({ event: "mystery_event", data: JSON.stringify({ type: "mystery_event" }) });
  assert.equal(responsesRes.ok, false);
  if (!responsesRes.ok) {
    assert.equal(responsesRes.error.capability, "unknown-stream-event");
  }

  // All three client encoders reject unknown IR stream events.
  const encoders = [
    new ChatClientStreamEncoder({ responseId: "unk-enc-c", model: "m", createPartId: () => "p1" }),
    new ResponsesClientStreamEncoder({ responseId: "unk-enc-r", model: "m", createPartId: () => "p1" }),
    new MessagesClientStreamEncoder({ responseId: "unk-enc-m", model: "m", createPartId: () => "p1" }),
  ];
  for (const encoder of encoders) {
    const res = encoder.encode({ type: "mystery_event", responseId: "unk", partId: "p1" } as never);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.capability, "unknown-stream-event");
    }
  }
});
