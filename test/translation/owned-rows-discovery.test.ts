/**
 * Native-only request rejections and output/stream discovery rows: recognized
 * provider-owned state fails closed with its exact matrix capability ID and
 * never vanishes behind a success terminator.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { ChatStreamRequestDecoder } from "../../src/translation/codecs/chat/stream.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import {
  MessagesProviderStreamDecoder,
  MessagesStreamRequestDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import {
  ResponsesProviderStreamDecoder,
  ResponsesStreamRequestDecoder,
} from "../../src/translation/codecs/responses/stream.ts";
import type { Direction } from "../../src/translation/contracts.ts";
import type { IrOutcome } from "../../src/translation/ir.ts";
import { preflightOutcome } from "../../src/translation/preflight.ts";
import { sourceBodyFor } from "./owned-rows-helpers.ts";

test.concurrent("row multiple-candidates: Chat n>1 rejects before dispatch", () => {
  const decoder = new ChatIngressDecoder();
  const res = decoder.decodeRequest({
    model: "m",
    messages: [{ role: "user", content: "Hi" }],
    n: 2,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "multiple-candidates");
  }
});

test.concurrent("preflight outcome: non-plain-text outcome discoveries terminate fail-closed with matrix capability IDs", () => {
  const base = {
    responseId: "resp_1",
    model: "logical-key",
    parts: [{ type: "text" as const, partId: "p1", text: "Hi" }],
  };
  const cases: ReadonlyArray<readonly [IrOutcome, string, Direction]> = [
    [{ ...base, finish: { reason: "refusal" } }, "refusal-content", "openai-chat->openai-responses"],
    [{ ...base, finish: { reason: "content_filter" } }, "finish-content-filter", "openai-chat->openai-responses"],
    [{ ...base, finish: { reason: "context_limit" } }, "finish-context-limit", "anthropic-messages->openai-chat"],
    [{ ...base, finish: { reason: "other" } }, "finish-other-unknown", "openai-chat->openai-responses"],
  ];
  for (const [outcome, capability, direction] of cases) {
    const res = preflightOutcome(outcome, direction);
    assert.equal(res.ok, false, capability);
    if (!res.ok) {
      assert.equal(res.error.capability, capability);
    }
  }
});

// =====================================================================
// Native-only rejections (fail closed before dispatch)
// =====================================================================

test.concurrent("native-only rejections: Responses state/ops fields fail with their exact capability IDs", () => {
  const decoder = new ResponsesIngressDecoder();
  const cases: ReadonlyArray<readonly [JsonObject, string]> = [
    [{ previous_response_id: "resp_x" }, "responses-previous-id"],
    [{ conversation: "conv_x" }, "responses-conversation"],
    [{ background: true }, "responses-background"],
    [{ context_management: {} }, "responses-compaction"],
    [{ prompt: { id: "p1" } }, "responses-reusable-prompt"],
    [{ top_logprobs: 5 }, "token-logprobs"],
    [{ truncation: "auto" }, "truncation-policy"],
    [{ max_tool_calls: 3 }, "responses-max-tool-calls"],
    [{ include: ["reasoning.encrypted_content"] }, "responses-include"],
    [{ reasoning: { summary: "auto" } }, "responses-reasoning-summary"],
    [{ reasoning: { generate_summary: "auto" } }, "responses-reasoning-summary"],
    [{ reasoning: { context: "main" } }, "reasoning-style-context-mode"],
    [{ reasoning: { mode: "auto" } }, "reasoning-style-context-mode"],
  ];
  for (const [extra, capability] of cases) {
    const res = decoder.decodeRequest({ model: "wire-model", input: "Hello!", ...extra });
    assert.equal(res.ok, false, capability);
    if (!res.ok) assert.equal(res.error.capability, capability);
  }

  // Input item rejections.
  const itemRef = decoder.decodeRequest({ model: "wire-model", input: [{ type: "item_reference", id: "x" }] });
  assert.equal(itemRef.ok, false);
  if (!itemRef.ok) assert.equal(itemRef.error.capability, "responses-item-reference");

  const readableInput = decoder.decodeRequest({
    model: "wire-model",
    input: [{ type: "reasoning", id: "r1", summary: [] }],
  });
  assert.equal(readableInput.ok, false);
  if (!readableInput.ok) assert.equal(readableInput.error.capability, "readable-reasoning");

  const encryptedInput = decoder.decodeRequest({
    model: "wire-model",
    input: [{ type: "reasoning", id: "r2", encrypted_content: "abc" }],
  });
  assert.equal(encryptedInput.ok, false);
  if (!encryptedInput.ok) assert.equal(encryptedInput.error.capability, "encrypted-reasoning");
});

test.concurrent("rows encrypted-reasoning / readable-reasoning: the reasoning type check precedes the phase/status check", () => {
  const decoder = new ResponsesIngressDecoder();

  // A completed reasoning item carrying encrypted_content re-IDs to
  // encrypted-reasoning, never to responses-message-phase.
  const encrypted = decoder.decodeRequest({
    model: "wire-model",
    input: [{ type: "reasoning", status: "completed", encrypted_content: "x" }],
  });
  assert.equal(encrypted.ok, false);
  if (!encrypted.ok) assert.equal(encrypted.error.capability, "encrypted-reasoning");

  // The same item without encrypted_content keeps the readable-reasoning ID.
  const readable = decoder.decodeRequest({
    model: "wire-model",
    input: [{ type: "reasoning", status: "completed" }],
  });
  assert.equal(readable.ok, false);
  if (!readable.ok) assert.equal(readable.error.capability, "readable-reasoning");
});

test.concurrent("native-only rejections: Chat diagnostics/penalties keep their exact IDs (stream decoders included)", () => {
  for (const Decoder of [ChatIngressDecoder, ChatStreamRequestDecoder]) {
    const decoder = new Decoder();
    const base = { ...sourceBodyFor("openai-chat"), ...(Decoder === ChatStreamRequestDecoder ? { stream: true } : {}) };
    const cases: ReadonlyArray<readonly [JsonObject, string]> = [
      [{ seed: 42 }, "seed-determinism"],
      [{ logit_bias: { x: 1 } }, "token-logit-bias"],
      [{ logprobs: true }, "token-logprobs"],
      [{ top_logprobs: 3 }, "token-logprobs"],
      [{ frequency_penalty: 0.5 }, "frequency-penalty"],
      [{ presence_penalty: 0.5 }, "presence-penalty"],
      [{ prediction: { content: "guess" } }, "chat-predicted-outputs"],
    ];
    for (const [extra, capability] of cases) {
      const res = decoder.decodeRequest({ ...base, ...extra } as JsonObject);
      assert.equal(res.ok, false, `${capability} via ${Decoder.name}`);
      if (!res.ok) assert.equal(res.error.capability, capability);
    }
  }
});

test.concurrent("native-only rejections: Messages stream request decoder splits state/thinking/output_config into their exact rows", () => {
  const decoder = new MessagesStreamRequestDecoder();
  const base = { ...sourceBodyFor("anthropic-messages"), max_tokens: 1024, stream: true };
  const cases: ReadonlyArray<readonly [JsonObject, string]> = [
    [{ container: "cnt_1" }, "anthropic-container-reuse"],
    [{ inference_geo: "eu" }, "inference-geography"],
    [{ top_k: 5 }, "top-k"],
    [{ thinking: { type: "enabled", budget_tokens: 2048 } }, "reasoning-budget"],
    [{ thinking: { type: "enabled", display: "summarized" } }, "anthropic-thinking-display"],
    [{ thinking: { type: "disabled" } }, "anthropic-thinking-display"],
    [{ output_config: { effort: "high" } }, "reasoning-effort-common"],
    [{ output_config: { format: { type: "unsupported_format", schema: {} } } }, "structured-json-schema"],
  ];
  for (const [extra, capability] of cases) {
    const res = decoder.decodeRequest({ ...base, ...extra });
    assert.equal(res.ok, false, `${capability} via MessagesStreamRequestDecoder`);
    if (!res.ok) assert.equal(res.error.capability, capability);
  }
});

test.concurrent("native-only rejections: Responses stream request decoder keeps reasoning/state/diagnostic IDs (shared parser parity)", () => {
  const decoder = new ResponsesStreamRequestDecoder();
  const base = { model: "wire-model", input: "Hello!", stream: true };
  const cases: ReadonlyArray<readonly [JsonObject, string]> = [
    [{ reasoning: { summary: "auto" } }, "responses-reasoning-summary"],
    [{ reasoning: { generate_summary: "auto" } }, "responses-reasoning-summary"],
    [{ reasoning: { context: "main" } }, "reasoning-style-context-mode"],
    [{ reasoning: { mode: "auto" } }, "reasoning-style-context-mode"],
    [{ context_management: {} }, "responses-compaction"],
    [{ prompt: { id: "p1" } }, "responses-reusable-prompt"],
    [{ top_logprobs: 3 }, "token-logprobs"],
    [{ truncation: "auto" }, "truncation-policy"],
  ];
  for (const [extra, capability] of cases) {
    const res = decoder.decodeRequest({ ...base, ...extra });
    assert.equal(res.ok, false, `${capability} via ResponsesStreamRequestDecoder`);
    if (!res.ok) assert.equal(res.error.capability, capability);
  }

  const itemRef = decoder.decodeRequest({ ...base, input: [{ type: "item_reference", id: "x" }] });
  assert.equal(itemRef.ok, false);
  if (!itemRef.ok) assert.equal(itemRef.error.capability, "responses-item-reference");
});

test.concurrent("native-only rejections: Messages state/thinking/output_config split into their exact rows", () => {
  const decoder = new MessagesIngressDecoder();
  const cases: ReadonlyArray<readonly [JsonObject, string]> = [
    [{ container: "cnt_1" }, "anthropic-container-reuse"],
    [{ inference_geo: "eu" }, "inference-geography"],
    [{ top_k: 5 }, "top-k"],
    [{ thinking: { type: "enabled", budget_tokens: 2048 } }, "reasoning-budget"],
    [{ thinking: { type: "enabled", display: "summarized" } }, "anthropic-thinking-display"],
    [{ thinking: { type: "disabled" } }, "anthropic-thinking-display"],
    [{ thinking: { type: "adaptive" } }, "anthropic-thinking-display"],
    [{ output_config: { effort: "high" } }, "reasoning-effort-common"],
    [{ output_config: { format: { type: "unsupported_format", schema: {} } } }, "structured-json-schema"],
  ];
  for (const [extra, capability] of cases) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), max_tokens: 1024, ...extra });
    assert.equal(res.ok, false, capability);
    if (!res.ok) assert.equal(res.error.capability, capability);
  }

  // A metadata key other than user_id is malformed M wire (the row itself is
  // T2-admitted), so it fails invalid_request — never a capability rejection.
  {
    const res = decoder.decodeRequest({
      ...sourceBodyFor("anthropic-messages"),
      max_tokens: 1024,
      metadata: { session: "s" },
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.capability, undefined);
      assert.match(res.error.message, /user_id/);
    }
  }
  // An empty stop_sequences array is invalid M wire (the IR admits only a
  // non-empty set), not silent absence.
  {
    const res = decoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), max_tokens: 1024, stop_sequences: [] });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.capability, undefined);
      assert.match(res.error.message, /stop_sequences/);
    }
  }

  // Assistant transcript reasoning blocks re-ID to their payload rows.
  const thinkingBlock = decoder.decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    ],
  });
  assert.equal(thinkingBlock.ok, false);
  if (!thinkingBlock.ok) assert.equal(thinkingBlock.error.capability, "readable-reasoning");

  const redactedBlock = decoder.decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "zzz" }] },
    ],
  });
  assert.equal(redactedBlock.ok, false);
  if (!redactedBlock.ok) assert.equal(redactedBlock.error.capability, "redacted-reasoning");
});

// =====================================================================
// Output/stream discovery terminates without a success terminator
// =====================================================================

test.concurrent("output discovery: provider-owned reasoning payloads and inference geography fail closed with exact IDs", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const mBase = {
    id: "msg_d",
    type: "message",
    role: "assistant",
    model: "upstream-target",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const thinkingOutcome = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      ...mBase,
      content: [{ type: "thinking", thinking: "secret", signature: "sig" }],
    },
  );
  assert.equal(thinkingOutcome.ok, false);
  if (!thinkingOutcome.ok) assert.equal(thinkingOutcome.error.capability, "readable-reasoning");

  const redactedOutcome = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      ...mBase,
      content: [{ type: "redacted_thinking", data: "opaque" }],
    },
  );
  assert.equal(redactedOutcome.ok, false);
  if (!redactedOutcome.ok) assert.equal(redactedOutcome.error.capability, "redacted-reasoning");

  const geoOutcome = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      ...mBase,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1, inference_geo: "global" },
    },
  );
  assert.equal(geoOutcome.ok, false);
  if (!geoOutcome.ok) assert.equal(geoOutcome.error.capability, "inference-geography");

  const responsesDecoder = new ResponsesIngressDecoder();
  const rReasoning = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_d",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "s" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
      ],
    },
  );
  assert.equal(rReasoning.ok, false);
  if (!rReasoning.ok) assert.equal(rReasoning.error.capability, "readable-reasoning");

  const rEncrypted = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_e",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [{ type: "reasoning", id: "rs_2", encrypted_content: "vault" }],
    },
  );
  assert.equal(rEncrypted.ok, false);
  if (!rEncrypted.ok) assert.equal(rEncrypted.error.capability, "encrypted-reasoning");
});

test.concurrent("stream discovery: reasoning blocks/items reject at block start; no success terminator is produced", () => {
  const session = { responseId: "resp_disc", model: "logical-key", createPartId: () => "p1" };

  const mDecoder = new MessagesProviderStreamDecoder(session);
  const mThinking = mDecoder.push({
    event: "content_block_start",
    data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}',
  });
  assert.equal(mThinking.ok, false);
  if (!mThinking.ok) assert.equal(mThinking.error.capability, "readable-reasoning");

  const mRedacted = new MessagesProviderStreamDecoder(session).push({
    event: "content_block_start",
    data: '{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"x"}}',
  });
  assert.equal(mRedacted.ok, false);
  if (!mRedacted.ok) assert.equal(mRedacted.error.capability, "redacted-reasoning");

  const rDecoder = new ResponsesProviderStreamDecoder(session);
  const rReadable = rDecoder.push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"},"sequence_number":1}',
  });
  assert.equal(rReadable.ok, false);
  if (!rReadable.ok) assert.equal(rReadable.error.capability, "readable-reasoning");

  const rEncrypted = new ResponsesProviderStreamDecoder(session).push({
    event: "response.output_item.added",
    data: '{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_2","encrypted_content":"v"},"sequence_number":1}',
  });
  assert.equal(rEncrypted.ok, false);
  if (!rEncrypted.ok) assert.equal(rEncrypted.error.capability, "encrypted-reasoning");
});

test.concurrent("stream discovery: M usage.inference_geo echo fail-closes at message_start and message_delta accumulation", () => {
  const session = { responseId: "resp_geo_s", model: "logical-key", createPartId: () => "p1" };

  const onStart = new MessagesProviderStreamDecoder(session).push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"m","usage":{"input_tokens":5,"inference_geo":"global"}}}',
  });
  assert.equal(onStart.ok, false);
  if (!onStart.ok) assert.equal(onStart.error.capability, "inference-geography");

  const deltaDecoder = new MessagesProviderStreamDecoder(session);
  const started = deltaDecoder.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}',
  });
  assert.equal(started.ok, true);
  const onDelta = deltaDecoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4,"inference_geo":"global"}}',
  });
  assert.equal(onDelta.ok, false);
  if (!onDelta.ok) assert.equal(onDelta.error.capability, "inference-geography");
});

// =====================================================================
// reasoning-signature: a signature OUTSIDE a thinking block fails closed;
// INSIDE a thinking block it re-IDs under readable-reasoning
// =====================================================================

test.concurrent("row reasoning-signature: detached signature on an assistant text block rejects request decode", () => {
  const decoder = new MessagesIngressDecoder();
  const res = decoder.decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    max_tokens: 1024,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "prior answer", signature: "sigABC" }] },
    ],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.capability, "reasoning-signature");
});

test.concurrent("row reasoning-signature: detached signature on an outcome text block rejects outcome decode", () => {
  const res = new MessagesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "msg_sig",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text", text: "hi", signature: "sigABC" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.capability, "reasoning-signature");
});

test.concurrent("row reasoning-signature: signature on a stream text content_block_start rejects before capture", () => {
  const decoder = new MessagesProviderStreamDecoder({
    responseId: "resp_sig",
    model: "logical-key",
    createPartId: () => "p1",
  });
  const res = decoder.push({
    event: "content_block_start",
    data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","signature":"sigABC"}}',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.capability, "reasoning-signature");
});

test.concurrent("row reasoning-signature contrast: a signature inside a thinking block re-IDs to readable-reasoning on every entry point", () => {
  const requestRes = new MessagesIngressDecoder().decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    max_tokens: 1024,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sigABC" }] },
    ],
  });
  assert.equal(requestRes.ok, false);
  if (!requestRes.ok) assert.equal(requestRes.error.capability, "readable-reasoning");

  const outcomeRes = new MessagesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "msg_sig_t",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "thinking", thinking: "hmm", signature: "sigABC" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(outcomeRes.ok, false);
  if (!outcomeRes.ok) assert.equal(outcomeRes.error.capability, "readable-reasoning");

  const streamRes = new MessagesProviderStreamDecoder({
    responseId: "resp_sig_t",
    model: "logical-key",
    createPartId: () => "p1",
  }).push({
    event: "content_block_start",
    data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sigABC"}}',
  });
  assert.equal(streamRes.ok, false);
  if (!streamRes.ok) assert.equal(streamRes.error.capability, "readable-reasoning");
});

test.concurrent("row anthropic-pause-turn: outcome stop_reason and stream delta fail closed with the exact ID", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const outcome = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_pause",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text", text: "partial" }],
      stop_reason: "pause_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.capability, "anthropic-pause-turn");

  const session = { responseId: "resp_pause", model: "logical-key", createPartId: () => "p1" };
  const decoder = new MessagesProviderStreamDecoder(session);
  const delta = decoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":1}}',
  });
  assert.equal(delta.ok, false);
  if (!delta.ok) assert.equal(delta.error.capability, "anthropic-pause-turn");
});

test.concurrent("stream terminal scan: a reasoning item announced only in response.completed fails closed without terminator", () => {
  const session = { responseId: "resp_term", model: "logical-key", createPartId: () => "p1" };

  const readable = new ResponsesProviderStreamDecoder(session);
  const startedReadable = readable.push({
    event: "response.created",
    data: '{"type":"response.created","response":{}}',
  });
  assert.equal(startedReadable.ok, true);
  const completedReadable = readable.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_term",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] },
          { type: "reasoning", id: "rs_9", summary: [] },
        ],
      },
    }),
  });
  assert.equal(completedReadable.ok, false);
  if (!completedReadable.ok) assert.equal(completedReadable.error.capability, "readable-reasoning");

  const encrypted = new ResponsesProviderStreamDecoder(session);
  const startedEncrypted = encrypted.push({
    event: "response.created",
    data: '{"type":"response.created","response":{}}',
  });
  assert.equal(startedEncrypted.ok, true);
  const completedEncrypted = encrypted.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: { id: "resp_term", output: [{ type: "reasoning", id: "rs_10", encrypted_content: "vault" }] },
    }),
  });
  assert.equal(completedEncrypted.ok, false);
  if (!completedEncrypted.ok) assert.equal(completedEncrypted.error.capability, "encrypted-reasoning");
});

test.concurrent("complete-path outcome decoders reject unrecognized block/item types instead of dropping them", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const mRes = messagesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "msg_unknown",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "server_tool_use", id: "stu_1", input: {} }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(mRes.ok, false);
  if (!mRes.ok) assert.equal(mRes.error.capability, "unknown-content-item");

  const responsesDecoder = new ResponsesIngressDecoder();
  const rRes = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_unknown",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [{ type: "totally_unknown_item", id: "unk_1" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(rRes.ok, false);
  if (!rRes.ok) assert.equal(rRes.error.capability, "unknown-content-item");
});

test.concurrent("complete-path request decode: hosted blocks in assistant content reject with their exact rows", () => {
  // A hosted/provider block carries the same row regardless of which role's
  // content it appears in — user and assistant branches must agree.
  for (const [blockType, capability] of [
    ["web_search_tool_result", "hosted-web-search"],
    ["container_upload", "provider-container"],
    ["search_result", "hosted-web-search"],
  ] as const) {
    const body = {
      model: "wire-model",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: blockType } as unknown as Record<string, unknown>] },
      ],
    };
    const res = new MessagesIngressDecoder().decodeRequest(body as never);
    assert.equal(res.ok, false, `assistant ${blockType} should reject`);
    if (!res.ok) assert.equal(res.error.capability, capability);
  }
  // The documented nesting: encrypted payloads ride inside web_search_result
  // elements of a tool_result; the recursive scan catches them in user content.
  const encrypted = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "w", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "web_search_result", encrypted_content: "zzz", title: "t", url: "https://example.com" }],
          },
        ],
      },
    ],
  };
  const encRes = new MessagesIngressDecoder().decodeRequest(encrypted as never);
  assert.equal(encRes.ok, false, "encrypted web_search_result should reject");
  if (!encRes.ok) assert.equal(encRes.error.capability, "hosted-tool-result-encryption");
});

test.concurrent("complete-path outcome decode: a text block with a missing or non-string text field fails closed", () => {
  const mRes = new MessagesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "msg_no_text",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(mRes.ok, false, "M text block without text should reject");
  if (!mRes.ok) assert.equal(mRes.error.category, "invalid_request");

  const rRes = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "resp_no_text",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(rRes.ok, false, "R output_text without text should reject");
  if (!rRes.ok) assert.equal(rRes.error.category, "invalid_request");
});
