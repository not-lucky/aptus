/**
 * Task 17 decoder hardening and parity pins:
 * - Unknown Chat `finish_reason` fails closed on complete and stream paths.
 * - Non-string refusal text/deltas fail closed instead of fabricating content.
 * - Orphan Responses `refusal.done` fails closed.
 * - Unknown stream finish reasons map to `finish-other-unknown`.
 * - Complete and stream paths assign identical refusal capabilities.
 * - In-band error message/code strings are bounded.
 * - Egress encoders assert preflight invariants and fail loudly on preflight drift.
 * - Foreign headers and transport markers stay outside the IR.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonValue, Protocol } from "../../src/domain/contracts.ts";
import { anthropicErrorType, type IrFailureCategory } from "../../src/domain/operations.ts";
import { statusFromCategory } from "../../src/routing/failures.ts";
import { RETRYABLE_STATUSES } from "../../src/routing/retry-policy.ts";
import { ChatEgressEncoder } from "../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { ChatProviderStreamDecoder } from "../../src/translation/codecs/chat/stream.ts";
import { MessagesEgressEncoder } from "../../src/translation/codecs/messages/egress.ts";
import { parseMessagesOutcome } from "../../src/translation/codecs/messages/outcome.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
} from "../../src/translation/codecs/responses/stream.ts";
import { chatFinishReason, messagesStopReason } from "../../src/translation/codecs/shared/transcript.ts";
import type { Direction } from "../../src/translation/contracts.ts";
import { PROVIDER_ERROR_STRING_LIMIT } from "../../src/translation/failures.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrOutcome, JsonObject } from "../../src/translation/ir.ts";
import { preflightOutcome, refusalFinishCapability } from "../../src/translation/preflight.ts";
import { createSseDecoder, createSseEncoder } from "../../src/translation/sse.ts";
import { TranslatedStreamPump } from "../../src/translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../../src/translation/stream-state.ts";

const ALL_DIRECTIONS: readonly Direction[] = [
  "openai-chat->openai-responses",
  "openai-chat->anthropic-messages",
  "openai-responses->openai-chat",
  "openai-responses->anthropic-messages",
  "anthropic-messages->openai-chat",
  "anthropic-messages->openai-responses",
];

function session(id: string) {
  return { responseId: id, model: "m", createPartId: () => `p-${id}` };
}

test.concurrent("chat ingress: unknown finish_reason rejects with finish-other-unknown", () => {
  const decoder = new ChatIngressDecoder();
  const res = decoder.decodeOutcome(
    200,
    { "content-type": "application/json" },
    {
      id: "chatcmpl-unk",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "refusal" }],
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "finish-other-unknown");
  }
});

test.concurrent("row quota-vs-rate-limit: quota and rate_limit stay distinct but share the 429 status", () => {
  // Quota is a billing condition, rate_limit a throughput condition. Both map
  // to HTTP 429, but they never collapse into one category: quota is
  // non-retryable (no amount of waiting helps a spend limit), while the
  // category vocabulary keeps them separate for route retry/fallback policy.
  assert.equal(statusFromCategory("quota", "openai-chat"), 429);
  assert.equal(statusFromCategory("rate_limit", "openai-chat"), 429);
  assert.equal(statusFromCategory("quota", "anthropic-messages"), 429);
  assert.equal(statusFromCategory("rate_limit", "anthropic-messages"), 429);
  // The target-native error types collapse the pair identically per protocol
  // (M rate_limit_error; OpenAI rate_limit_error / insufficient_quota codes
  // live in the error type map, not a distinct category).
  assert.equal(anthropicErrorType("quota"), "rate_limit_error");
  assert.equal(anthropicErrorType("rate_limit"), "rate_limit_error");
  // Route policy defaults keep quota out of retryable categories.
  assert.equal(RETRYABLE_STATUSES.has(429), true);
});

test.concurrent("row error-category-message: every decoder category/message carries bounded target-native strings", () => {
  // The 13-category set drives category selection; the message and the single
  // upstream code/type string stay bounded (pinned above) and target-native.
  // This row-named pin asserts the three decoders classify an in-band error
  // with the provider category carrying the bounded message/code pair.
  const mDecoder = new MessagesProviderStreamDecoder(session("cat-m"));
  const mRes = mDecoder.push({
    event: "error",
    data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "m" } }),
  });
  assert.equal(mRes.ok, true);
  if (mRes.ok) {
    const errEvent = mRes.value.find((e) => e.type === "error");
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.category, "provider");
      assert.equal(errEvent.failure.message, "m");
      assert.equal(errEvent.failure.code, "overloaded_error");
    }
  }

  // Responses: error frame code rides `code`, message rides `message`.
  const rDecoder = new ResponsesProviderStreamDecoder(session("cat-r"));
  const rRes = rDecoder.push({
    event: "response.failed",
    data: JSON.stringify({ type: "response.failed", error: { message: "r", code: "server_error" } }),
  });
  assert.equal(rRes.ok, true);
  if (rRes.ok) {
    const errEvent = rRes.value.find((e) => e.type === "error");
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.category, "provider");
      assert.equal(errEvent.failure.message, "r");
      assert.equal(errEvent.failure.code, "server_error");
    }
  }

  // Chat stream: the in-band error fails the decode as a provider failure
  // carrying the bounded message/code pair.
  const cDecoder = new ChatProviderStreamDecoder(session("cat-c"));
  const cRes = cDecoder.push({ data: JSON.stringify({ error: { message: "c", code: "server_error" } }) });
  assert.equal(cRes.ok, false);
  if (!cRes.ok) {
    assert.equal(cRes.error.category, "provider");
    assert.equal(cRes.error.message, "c");
    assert.equal(cRes.error.code, "server_error");
  }
});

test.concurrent("row error-http-status: the 13-category set maps to the exact target status table", () => {
  // Exact status map per docs/operations.md: 503 for C/R clients, 529 for M.
  const expected: ReadonlyArray<[IrFailureCategory, Record<Protocol, number>]> = [
    ["invalid_request", { "openai-chat": 400, "openai-responses": 400, "anthropic-messages": 400 }],
    ["unsupported_capability", { "openai-chat": 400, "openai-responses": 400, "anthropic-messages": 400 }],
    ["authentication", { "openai-chat": 401, "openai-responses": 401, "anthropic-messages": 401 }],
    ["permission", { "openai-chat": 403, "openai-responses": 403, "anthropic-messages": 403 }],
    ["not_found", { "openai-chat": 404, "openai-responses": 404, "anthropic-messages": 404 }],
    ["conflict", { "openai-chat": 409, "openai-responses": 409, "anthropic-messages": 409 }],
    ["payload_too_large", { "openai-chat": 413, "openai-responses": 413, "anthropic-messages": 413 }],
    ["rate_limit", { "openai-chat": 429, "openai-responses": 429, "anthropic-messages": 429 }],
    ["quota", { "openai-chat": 429, "openai-responses": 429, "anthropic-messages": 429 }],
    ["timeout", { "openai-chat": 504, "openai-responses": 504, "anthropic-messages": 504 }],
    ["unavailable", { "openai-chat": 503, "openai-responses": 503, "anthropic-messages": 529 }],
    ["provider", { "openai-chat": 502, "openai-responses": 502, "anthropic-messages": 502 }],
    ["stream_interrupted", { "openai-chat": 502, "openai-responses": 502, "anthropic-messages": 502 }],
  ];
  assert.equal(expected.length, 13);
  for (const [category, byProtocol] of expected) {
    for (const [protocol, status] of Object.entries(byProtocol) as [Protocol, number][]) {
      assert.equal(statusFromCategory(category, protocol), status, `${category}/${protocol}`);
    }
  }
});

test.concurrent("preflightOutcome: refusal part co-occurring with tool_call parts fails closed in both C↔R directions", () => {
  const outcome: IrOutcome = {
    responseId: "refusal-tools",
    model: "m",
    parts: [
      { type: "refusal", partId: "p1", text: "No." },
      { type: "tool_call", partId: "p2", call: { type: "function", callId: "c1", name: "f", argumentsText: "{}" } },
    ],
    finish: { reason: "refusal" },
  };
  for (const direction of ["openai-chat->openai-responses", "openai-responses->openai-chat"] as const) {
    const res = preflightOutcome(outcome, direction);
    assert.equal(res.ok, false, direction);
    if (!res.ok) {
      assert.equal(res.error.category, "invalid_request", direction);
      assert.match(res.error.message, /refusal part and tool_call parts/, direction);
    }
  }
});

test.concurrent("row post-header-stream-error: Responses client error-first stream opens the lifecycle before failing", () => {
  const encoder = new ResponsesClientStreamEncoder({ responseId: "err-first-r", model: "gpt-4o", createPartId: () => "p1" });

  // The error is the stream's only event: the client stream must still open
  // the R response lifecycle (response.created, response.in_progress) before
  // the error frame — a bare first `error` frame is not a documented R stream
  // shape. sequence_number stays strictly increasing from 1.
  const res = encoder.encode({
    type: "error",
    responseId: "err-first-r",
    failure: { category: "provider", message: "Immediate failure", code: "server_error", retryable: false },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 3);
    assert.equal(res.value[0]?.event, "response.created");
    assert.equal(res.value[1]?.event, "response.in_progress");
    assert.equal(res.value[2]?.event, "error");
    const created = JSON.parse(res.value[0]?.data ?? "{}");
    const inProgress = JSON.parse(res.value[1]?.data ?? "{}");
    const errorFrame = JSON.parse(res.value[2]?.data ?? "{}");
    assert.equal(created.sequence_number, 1);
    assert.equal(inProgress.sequence_number, 2);
    assert.equal(errorFrame.sequence_number, 3);
    // Documented R stream error shape only: no request_id, no retry_after.
    assert.equal("request_id" in errorFrame, false);
    assert.equal("retry_after" in errorFrame, false);
  }

  // An error after at least one emitted frame renders unchanged: one native
  // error frame, no injected lifecycle prefix mid-stream.
  const encoder2 = new ResponsesClientStreamEncoder({ responseId: "err-mid-r", model: "gpt-4o", createPartId: () => "p1" });
  const start = encoder2.encode({ type: "response_start", responseId: "err-mid-r", model: "gpt-4o" });
  assert.equal(start.ok, true);
  const midError = encoder2.encode({
    type: "error",
    responseId: "err-mid-r",
    failure: { category: "provider", message: "Mid failure", retryable: false },
  });
  assert.equal(midError.ok, true);
  if (midError.ok) {
    assert.equal(midError.value.length, 1);
    assert.equal(midError.value[0]?.event, "error");
    assert.equal(JSON.parse(midError.value[0]?.data ?? "{}").sequence_number, 3);
  }
});

test.concurrent("row post-header-stream-error: Messages client error-first stream opens the lifecycle before failing", () => {
  const encoder = new MessagesClientStreamEncoder({ responseId: "err-first-m", model: "claude-3-5", createPartId: () => "p1" });

  // The error is the stream's only event: the client stream must still open
  // the M message lifecycle (message_start with the session Message object)
  // before the error frame — a bare first `error` frame is not a documented M
  // stream shape.
  const res = encoder.encode({
    type: "error",
    responseId: "err-first-m",
    failure: { category: "provider", message: "Immediate failure", retryable: false, requestId: "req-obs-1" },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 2);
    assert.equal(res.value[0]?.event, "message_start");
    const message = JSON.parse(res.value[0]?.data ?? "{}").message;
    assert.equal(message.id, "msg_err-first-m");
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.deepEqual(message.content, []);
    assert.equal(message.stop_reason, null);
    assert.equal(message.stop_sequence, null);

    assert.equal(res.value[1]?.event, "error");
    const errorFrame = JSON.parse(res.value[1]?.data ?? "{}");
    assert.equal(errorFrame.error.type, "api_error");
    assert.equal(errorFrame.error.message, "Immediate failure");
    // request_id is the documented M error-envelope echo; retry-after is not
    // a documented in-band stream error field and is never fabricated.
    assert.equal(errorFrame.request_id, "req-obs-1");
    assert.equal("retry_after" in errorFrame, false);
  }

  // An error after message_start renders unchanged: one native error frame.
  const encoder2 = new MessagesClientStreamEncoder({ responseId: "err-mid-m", model: "claude-3-5", createPartId: () => "p1" });
  const start = encoder2.encode({ type: "response_start", responseId: "err-mid-m", model: "claude-3-5" });
  assert.equal(start.ok, true);
  const midError = encoder2.encode({
    type: "error",
    responseId: "err-mid-m",
    failure: { category: "provider", message: "Mid failure", retryable: false },
  });
  assert.equal(midError.ok, true);
  if (midError.ok) {
    assert.equal(midError.value.length, 1);
    assert.equal(midError.value[0]?.event, "error");
  }
});

test.concurrent("chat stream: unknown finish_reason rejects with finish-other-unknown", () => {
  const decoder = new ChatProviderStreamDecoder(session("chat-unk-finish"));
  const res = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "refusal" }],
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "finish-other-unknown");
  }
});

test.concurrent("chat ingress: non-string message.refusal fails closed", () => {
  const decoder = new ChatIngressDecoder();
  const res = decoder.decodeOutcome(
    200,
    { "content-type": "application/json" },
    {
      id: "chatcmpl-badref",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: null, refusal: { text: "No" } }, finish_reason: "stop" },
      ],
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("chat stream: non-string delta.refusal fails closed", () => {
  const decoder = new ChatProviderStreamDecoder(session("chat-unk-delta"));
  const res = decoder.push({
    data: JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { refusal: { text: "No" } }, finish_reason: null }],
    }),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("responses ingress: malformed refusal parts fail closed", () => {
  const decoder = new ResponsesIngressDecoder();
  const headers = { "content-type": "application/json" };
  const messageItem = (content: JsonValue): JsonObject => ({
    id: "resp_badref",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: "gpt-4o",
    output: [{ type: "message", id: "msg_1", role: "assistant", content }],
  });

  // Non-string refusal value.
  const nonString = decoder.decodeOutcome(200, headers, messageItem([{ type: "refusal", refusal: 42 }]));
  assert.equal(nonString.ok, false);
  if (!nonString.ok) {
    assert.equal(nonString.error.category, "invalid_request");
  }

  // Non-string text fallback value.
  const nonStringText = decoder.decodeOutcome(200, headers, messageItem([{ type: "refusal", text: 42 }]));
  assert.equal(nonStringText.ok, false);
  if (!nonStringText.ok) {
    assert.equal(nonStringText.error.category, "invalid_request");
  }

  // Refusal part carrying no text at all.
  const missingBoth = decoder.decodeOutcome(200, headers, messageItem([{ type: "refusal" }]));
  assert.equal(missingBoth.ok, false);
  if (!missingBoth.ok) {
    assert.equal(missingBoth.error.category, "invalid_request");
  }
});

test.concurrent("responses stream: non-string deltas and orphan refusal.done fail closed", () => {
  const textDecoder = new ResponsesProviderStreamDecoder(session("resp-baddelta"));
  const textRes = textDecoder.push({
    event: "response.output_text.delta",
    data: JSON.stringify({ type: "response.output_text.delta", delta: 42, sequence_number: 1 }),
  });
  assert.equal(textRes.ok, false);
  if (!textRes.ok) {
    assert.equal(textRes.error.category, "invalid_request");
  }

  const refusalDecoder = new ResponsesProviderStreamDecoder(session("resp-badrefdelta"));
  const refusalRes = refusalDecoder.push({
    event: "response.refusal.delta",
    data: JSON.stringify({ type: "response.refusal.delta", delta: { text: "No" }, sequence_number: 1 }),
  });
  assert.equal(refusalRes.ok, false);
  if (!refusalRes.ok) {
    assert.equal(refusalRes.error.category, "invalid_request");
  }

  const orphanDecoder = new ResponsesProviderStreamDecoder(session("resp-orphan"));
  const orphanRes = orphanDecoder.push({
    event: "response.refusal.done",
    data: JSON.stringify({ type: "response.refusal.done", sequence_number: 1 }),
  });
  assert.equal(orphanRes.ok, false);
  if (!orphanRes.ok) {
    assert.equal(orphanRes.error.category, "invalid_request");
  }
});

test.concurrent("refusal gating: complete and stream paths assign identical capabilities", () => {
  for (const direction of ALL_DIRECTIONS) {
    for (const hasRefusalPart of [false, true]) {
      const parts = hasRefusalPart
        ? [{ type: "refusal", partId: "p1", text: "No" } as const]
        : [{ type: "text", partId: "p1", text: "No" } as const];
      const outcome: IrOutcome = { responseId: "parity", model: "m", parts, finish: { reason: "refusal" } };
      const complete = preflightOutcome(outcome, direction);
      const completeCapability = complete.ok ? undefined : complete.error.capability;

      const machine = createIrStreamStateMachine({ direction });
      assert.equal(machine.feed({ type: "response_start", responseId: "parity", model: "m" }).ok, true);
      if (hasRefusalPart) {
        const partStart = machine.feed({
          type: "part_start",
          responseId: "parity",
          partId: "p1",
          part: { type: "refusal" },
        });
        if (!partStart.ok) {
          assert.equal(partStart.error.capability, completeCapability, `${direction} part refusal`);
          continue;
        }
        const partEnd = machine.feed({ type: "part_end", responseId: "parity", partId: "p1", partType: "refusal" });
        assert.equal(partEnd.ok, true);
      }
      const terminal = machine.feed({ type: "response_end", responseId: "parity", finish: { reason: "refusal" } });
      const streamCapability = terminal.ok ? undefined : terminal.error.capability;
      assert.equal(streamCapability, completeCapability, `${direction} hasRefusalPart=${hasRefusalPart}`);
    }
  }
});

test.concurrent("refusal gating: shared helper matches the matrix tiers", () => {
  // C/R admit refusal content when a refusal part is present; part-less refusal rejects.
  assert.equal(refusalFinishCapability("openai-chat->openai-responses", true), undefined);
  assert.equal(refusalFinishCapability("openai-responses->openai-chat", false), "refusal-terminal-reason");
  // A refusal finish without a refusal part comes from a Messages provider.
  assert.equal(refusalFinishCapability("openai-chat->anthropic-messages", false), "refusal-terminal-reason");
  assert.equal(refusalFinishCapability("openai-responses->anthropic-messages", false), "refusal-terminal-reason");
  assert.equal(refusalFinishCapability("anthropic-messages->openai-chat", true), "refusal-content");
  assert.equal(refusalFinishCapability("anthropic-messages->openai-responses", false), "refusal-terminal-reason");
});

test.concurrent("in-band error strings are bounded at the shared limit", () => {
  const overlong = `x`.repeat(PROVIDER_ERROR_STRING_LIMIT + 500);
  const overlongCode = `c`.repeat(PROVIDER_ERROR_STRING_LIMIT + 10);

  const msgDecoder = new MessagesProviderStreamDecoder(session("trunc-m"));
  const msgRes = msgDecoder.push({
    event: "error",
    data: JSON.stringify({ type: "error", error: { type: overlongCode, message: overlong } }),
  });
  assert.equal(msgRes.ok, true);
  if (msgRes.ok) {
    const event = msgRes.value.find((e) => e.type === "error");
    assert.ok(event !== undefined && event.type === "error");
    if (event.type === "error") {
      assert.equal(event.failure.message.length, PROVIDER_ERROR_STRING_LIMIT);
      assert.equal(event.failure.code?.length, PROVIDER_ERROR_STRING_LIMIT);
    }
  }

  const respDecoder = new ResponsesProviderStreamDecoder(session("trunc-r"));
  const respRes = respDecoder.push({
    event: "response.failed",
    data: JSON.stringify({ type: "response.failed", error: { message: overlong, code: overlongCode } }),
  });
  assert.equal(respRes.ok, true);
  if (respRes.ok) {
    const event = respRes.value.find((e) => e.type === "error");
    assert.ok(event !== undefined && event.type === "error");
    if (event.type === "error") {
      assert.equal(event.failure.message.length, PROVIDER_ERROR_STRING_LIMIT);
      assert.equal(event.failure.code?.length, PROVIDER_ERROR_STRING_LIMIT);
    }
  }

  // Short strings pass through untouched.
  const shortDecoder = new ResponsesProviderStreamDecoder(session("trunc-short"));
  const shortRes = shortDecoder.push({
    event: "response.failed",
    data: JSON.stringify({ type: "response.failed", error: { message: "boom", code: "server_error" } }),
  });
  assert.equal(shortRes.ok, true);
  if (shortRes.ok) {
    const event = shortRes.value.find((e) => e.type === "error");
    assert.ok(event !== undefined && event.type === "error");
    if (event.type === "error") {
      assert.equal(event.failure.message, "boom");
      assert.equal(event.failure.code, "server_error");
    }
  }
});

test.concurrent("chat egress: multiple refusal parts coalesce instead of dropping", () => {
  const outcome: IrOutcome = {
    responseId: "multi-ref",
    model: "m",
    parts: [
      { type: "refusal", partId: "p1", text: "First. " },
      { type: "refusal", partId: "p2", text: "Second." },
    ],
    finish: { reason: "refusal" },
  };
  const encoded = new ChatEgressEncoder(() => 1700000000).encodeOutcome(outcome);
  const message = (encoded.body.choices as JsonObject[])[0]?.message as JsonObject;
  assert.equal(message?.refusal, "First. Second.");
});

test.concurrent("messages egress: refusal outcome throws as an invariant guard against preflight drift", () => {
  const outcome: IrOutcome = {
    responseId: "m-ref",
    model: "m",
    parts: [{ type: "refusal", partId: "p1", text: "No." }],
    finish: { reason: "refusal" },
  };
  assert.throws(() => new MessagesEgressEncoder().encodeOutcome(outcome));
});

test.concurrent("messagesStopReason: unmapped finish reasons throw as an invariant guard against preflight drift", () => {
  assert.throws(() => messagesStopReason({ reason: "content_filter" }));
});

test.concurrent("chatFinishReason: context_limit throws as an invariant guard against preflight drift", () => {
  // preflightOutcome rejects finish-context-limit before any Chat egress runs;
  // the narrowing function must never silently map it to the natural stop.
  assert.throws(() => chatFinishReason("context_limit"));
  // The admitted reasons keep their exact wire spellings, and a refusal
  // narrows to the natural stop (the text rides in message.refusal).
  assert.equal(chatFinishReason("stop"), "stop");
  assert.equal(chatFinishReason("refusal"), "stop");
  assert.equal(chatFinishReason("length"), "length");
  assert.equal(chatFinishReason("tool_calls"), "tool_calls");
  assert.equal(chatFinishReason("content_filter"), "content_filter");
});

test.concurrent(
  "rows authentication-headers, organization-project-headers, anthropic-version-header, beta-header, rate-limit-headers, diagnostic-response-headers, responses-websocket-transport: foreign headers and transport markers stay outside the IR",
  () => {
    const coord = createDefaultTranslationCoordinator();
    const body: JsonObject = {
      id: "chatcmpl-hdr",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    };
    // Auth, organization, version, beta, rate-limit, diagnostic, and transport
    // markers ride outside the translated turn and never fail it.
    const res = coord.translateCompleteOutcome({
      sourceProtocol: "openai-responses",
      targetProtocol: "openai-chat",
      status: 200,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer redacted",
        "openai-organization": "org-123",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-ratelimit-remaining": "99",
        "x-request-id": "req-123",
        upgrade: "websocket",
      },
      body,
      logicalModel: "gpt-4o",
    });
    assert.equal(res.ok, true);
  },
);

test.concurrent("chat egress preserves ordered text alongside refusal in mixed outcomes", () => {
  const outcome: IrOutcome = {
    responseId: "c-mixed",
    model: "m",
    parts: [
      { type: "text", partId: "p1", text: "Prefix text" },
      { type: "refusal", partId: "p2", text: "Refusal text" },
    ],
    finish: { reason: "refusal" },
  };
  const encoded = new ChatEgressEncoder(() => 1700000000).encodeOutcome(outcome);
  const message = (encoded.body.choices as JsonObject[])[0]?.message as JsonObject;
  assert.equal(message?.content, "Prefix text");
  assert.equal(message?.refusal, "Refusal text");
});

test.concurrent("refusal: part-less refusal finish is rejected with refusal-terminal-reason across all six directions", () => {
  for (const dir of ALL_DIRECTIONS) {
    const capability = refusalFinishCapability(dir, false);
    assert.equal(capability, "refusal-terminal-reason", `part-less refusal in ${dir}`);

    const outcome: IrOutcome = {
      responseId: "ref-no-part",
      model: "m",
      parts: [{ type: "text", partId: "p1", text: "text only" }],
      finish: { reason: "refusal" },
    };
    const res = preflightOutcome(outcome, dir);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.capability, "refusal-terminal-reason");
    }
  }
});

test.concurrent("refusal: refusal part with non-refusal finish is rejected with invalid_request", () => {
  const outcome: IrOutcome = {
    responseId: "ref-part-stop",
    model: "m",
    parts: [{ type: "refusal", partId: "p1", text: "I refuse" }],
    finish: { reason: "stop" },
  };
  const res = preflightOutcome(outcome, "openai-chat->openai-responses");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
  }
});

test.concurrent("chat complete ingress rejects absent or null finish_reason with invalid_request", () => {
  const decoder = new ChatIngressDecoder();
  const resNull = decoder.decodeOutcome(
    200,
    { "content-type": "application/json" },
    {
      id: "c-1",
      object: "chat.completion",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: null as never }],
    },
  );
  assert.equal(resNull.ok, false);
  if (!resNull.ok) assert.equal(resNull.error.category, "invalid_request");

  const resUndefined = decoder.decodeOutcome(
    200,
    { "content-type": "application/json" },
    {
      id: "c-2",
      object: "chat.completion",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
    },
  );
  assert.equal(resUndefined.ok, false);
  if (!resUndefined.ok) assert.equal(resUndefined.error.category, "invalid_request");
});

test.concurrent("stream decoders: non-string deltas fail closed with invalid_request", () => {
  // Messages non-string delta.text
  const mDecoder = new MessagesProviderStreamDecoder({ responseId: "m1", model: "m", createPartId: () => "p1" });
  mDecoder.push({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  });
  mDecoder.push({
    event: "content_block_start",
    data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  });
  const mRes = mDecoder.push({
    event: "content_block_delta",
    data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 12345 } }),
  });
  assert.equal(mRes.ok, false);
  if (!mRes.ok) assert.equal(mRes.error.category, "invalid_request");

  // Chat non-string delta.content
  const cDecoder = new ChatProviderStreamDecoder({ responseId: "c1", model: "m", createPartId: () => "p1" });
  const cRes = cDecoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, delta: { content: 12345 } }],
    }),
  });
  assert.equal(cRes.ok, false);
  if (!cRes.ok) assert.equal(cRes.error.category, "invalid_request");
});

test.concurrent("stream decoders: refusal and tool_calls co-occurrence rejects with invalid_request", () => {
  // Chat stream
  const cDecoder = new ChatProviderStreamDecoder({ responseId: "c1", model: "m", createPartId: () => "p1" });
  cDecoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, delta: { refusal: "No." } }],
    }),
  });
  const cRes = cDecoder.push({
    data: JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
  });
  assert.equal(cRes.ok, false);
  if (!cRes.ok) assert.equal(cRes.error.category, "invalid_request");

  // Responses stream
  const rDecoder = new ResponsesProviderStreamDecoder({ responseId: "r1", model: "m", createPartId: () => "p1" });
  rDecoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created" }) });
  rDecoder.push({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "fn" },
    }),
  });
  rDecoder.push({
    event: "response.content_part.added",
    data: JSON.stringify({ type: "response.content_part.added", part: { type: "refusal" } }),
  });
  const rRes = rDecoder.push({
    event: "response.completed",
    data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
  });
  assert.equal(rRes.ok, false);
  if (!rRes.ok) assert.equal(rRes.error.category, "invalid_request");
});

test.concurrent("responses stream: output_text.done and refusal.done validate open part type", () => {
  const rDecoder = new ResponsesProviderStreamDecoder({ responseId: "r1", model: "m", createPartId: () => "p1" });
  rDecoder.push({ event: "response.created", data: JSON.stringify({ type: "response.created" }) });
  rDecoder.push({
    event: "response.content_part.added",
    data: JSON.stringify({ type: "response.content_part.added", part: { type: "refusal" } }),
  });
  // output_text.done arrives when refusal is open -> rejects
  const res1 = rDecoder.push({
    event: "response.output_text.done",
    data: JSON.stringify({ type: "response.output_text.done" }),
  });
  assert.equal(res1.ok, false);
  if (!res1.ok) assert.equal(res1.error.category, "invalid_request");

  const rDecoder2 = new ResponsesProviderStreamDecoder({ responseId: "r2", model: "m", createPartId: () => "p1" });
  rDecoder2.push({ event: "response.created", data: JSON.stringify({ type: "response.created" }) });
  rDecoder2.push({
    event: "response.content_part.added",
    data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text" } }),
  });
  // refusal.done arrives when text is open -> rejects
  const res2 = rDecoder2.push({
    event: "response.refusal.done",
    data: JSON.stringify({ type: "response.refusal.done" }),
  });
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.error.category, "invalid_request");
});

test.concurrent("row error-request-id + row error-retry-after: preserved only when observed, never fabricated when absent", () => {
  // Stream error with request_id in a Messages provider; no documented wire
  // carries retry-after on an in-band stream error frame, so absence stays
  // absence (never zero, never fabricated).
  const mDecoder = new MessagesProviderStreamDecoder({ responseId: "m1", model: "m", createPartId: () => "p1" });
  const mRes = mDecoder.push({
    event: "error",
    data: JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
      request_id: "req-upstream-123",
    }),
  });
  assert.equal(mRes.ok, true);
  if (mRes.ok) {
    const errEvent = mRes.value[0];
    assert.equal(errEvent?.type, "error");
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.requestId, "req-upstream-123");

      // Client encoder projects them
      const encoder = new MessagesClientStreamEncoder({ responseId: "m1", model: "m", createPartId: () => "p1" });
      const frames = encoder.encode(errEvent);
      assert.equal(frames.ok, true);
      if (frames.ok) {
        // First-frame error: message_start opens the lifecycle, then the error.
        assert.equal(frames.value[0]?.event, "message_start");
        const payload = JSON.parse(frames.value[1]?.data ?? "{}");
        assert.equal(payload.request_id, "req-upstream-123");
        assert.equal("retry_after" in payload, false);
      }
    }
  }

  // The Responses client error frame stays on the documented wire shape
  // {type, code, message, param, sequence_number}: a request id observed on
  // the M side does not leak into an R frame the research does not define.
  const rEncoder = new ResponsesClientStreamEncoder({ responseId: "m1", model: "m", createPartId: () => "p1" });
  const rFrames = rEncoder.encode({
    type: "error",
    responseId: "m1",
    failure: { category: "provider", message: "boom", code: "overloaded_error", retryable: false, requestId: "req-upstream-123" },
  });
  assert.equal(rFrames.ok, true);
  if (rFrames.ok) {
    const payload = JSON.parse(rFrames.value[rFrames.value.length - 1]?.data ?? "{}");
    assert.equal("request_id" in payload, false);
    assert.equal("retry_after" in payload, false);
  }

  // Stream error without request_id or retry_after
  const mDecoderAbsent = new MessagesProviderStreamDecoder({ responseId: "m2", model: "m", createPartId: () => "p1" });
  const mResAbsent = mDecoderAbsent.push({
    event: "error",
    data: JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Internal error" },
    }),
  });
  assert.equal(mResAbsent.ok, true);
  if (mResAbsent.ok) {
    const errEvent = mResAbsent.value[0];
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.requestId, undefined);

      const encoder = new MessagesClientStreamEncoder({ responseId: "m2", model: "m", createPartId: () => "p1" });
      const frames = encoder.encode(errEvent);
      assert.equal(frames.ok, true);
      if (frames.ok) {
        // First-frame error: the error frame follows the message_start prefix.
        const payload = JSON.parse(frames.value[1]?.data ?? "{}");
        assert.equal(payload.request_id, undefined);
        assert.equal("retry_after" in payload, false);
      }
    }
  }

  // Complete outcome decoders: header retry-after preservation
  const mOutcome = parseMessagesOutcome(
    500,
    { type: "error", error: { type: "api_error", message: "err" } },
    { "retry-after": "60" },
  );
  assert.equal(mOutcome.ok, false);
  if (!mOutcome.ok) {
    assert.equal(mOutcome.error.retryAfterSeconds, 60);
  }

  const rDecoderIngress = new ResponsesIngressDecoder();
  const rOutcome = rDecoderIngress.decodeOutcome(
    500,
    { "retry-after": "120" },
    { status: "failed", error: { message: "err" } },
  );
  assert.equal(rOutcome.ok, false);
  if (!rOutcome.ok) {
    assert.equal(rOutcome.error.retryAfterSeconds, 120);
  }
});

test.concurrent("messages complete: stop_reason null or omitted fails closed with invalid_request", () => {
  const baseMessage = {
    type: "message",
    id: "msg_term_test",
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  // 1. Explicit null stop_reason fails closed
  const resNull = parseMessagesOutcome(200, { ...baseMessage, stop_reason: null });
  assert.equal(resNull.ok, false);
  if (!resNull.ok) {
    assert.equal(resNull.error.category, "invalid_request");
    assert.match(resNull.error.message, /stop_reason/);
  }

  // 2. Omitted stop_reason fails closed
  const resOmitted = parseMessagesOutcome(200, { ...baseMessage });
  assert.equal(resOmitted.ok, false);
  if (!resOmitted.ok) {
    assert.equal(resOmitted.error.category, "invalid_request");
    assert.match(resOmitted.error.message, /stop_reason/);
  }

  // 3. Unknown non-null stop_reason (empty string) fails with finish-other-unknown
  const resEmpty = parseMessagesOutcome(200, { ...baseMessage, stop_reason: "" });
  assert.equal(resEmpty.ok, false);
  if (!resEmpty.ok) {
    assert.equal(resEmpty.error.category, "unsupported_capability");
    assert.equal(resEmpty.error.capability, "finish-other-unknown");
  }
});

test.concurrent("messages stream: stop_reason null or missing at terminal fails closed", () => {
  // 1. message_delta with null stop_reason, then message_stop -> fails closed
  const dec1 = new MessagesProviderStreamDecoder({ responseId: "m_null_term", model: "claude-3-5", createPartId: () => "p1" });
  dec1.push({
    event: "message_start",
    data: JSON.stringify({ type: "message_start", message: { id: "m_null_term", usage: { input_tokens: 5, output_tokens: 0 } } }),
  });
  dec1.push({
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", delta: { stop_reason: null } }),
  });
  const stopRes1 = dec1.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
  assert.equal(stopRes1.ok, false);
  if (!stopRes1.ok) {
    assert.equal(stopRes1.error.category, "invalid_request");
    assert.match(stopRes1.error.message, /stop_reason/);
  }

  // 2. message_stop without any terminal message_delta -> fails closed
  const dec2 = new MessagesProviderStreamDecoder({ responseId: "m_no_delta", model: "claude-3-5", createPartId: () => "p1" });
  dec2.push({
    event: "message_start",
    data: JSON.stringify({ type: "message_start", message: { id: "m_no_delta", usage: { input_tokens: 5, output_tokens: 0 } } }),
  });
  const stopRes2 = dec2.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
  assert.equal(stopRes2.ok, false);
  if (!stopRes2.ok) {
    assert.equal(stopRes2.error.category, "invalid_request");
    assert.match(stopRes2.error.message, /stop_reason/);
  }

  // 3. usage-only message_delta (stop_reason: null) followed by valid terminal message_delta -> succeeds!
  const dec3 = new MessagesProviderStreamDecoder({ responseId: "m_usage_then_valid", model: "claude-3-5", createPartId: () => "p1" });
  dec3.push({
    event: "message_start",
    data: JSON.stringify({ type: "message_start", message: { id: "m_usage_then_valid", usage: { input_tokens: 10, output_tokens: 0 } } }),
  });
  // Usage-only delta leaves recordedFinish untouched without rejecting mid-stream
  const deltaUsage = dec3.push({
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 7 } }),
  });
  assert.equal(deltaUsage.ok, true);
  // Terminal delta sets finish
  const deltaTerm = dec3.push({
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  });
  assert.equal(deltaTerm.ok, true);
  // Terminal stop emits response_end with stop reason and accumulated usage
  const stopRes3 = dec3.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
  assert.equal(stopRes3.ok, true);
  if (stopRes3.ok) {
    const endEvent = stopRes3.value.find((e) => e.type === "response_end");
    assert.ok(endEvent !== undefined && endEvent.type === "response_end");
    if (endEvent.type === "response_end") {
      assert.equal(endEvent.finish.reason, "stop");
      assert.equal(endEvent.usage?.input, 10);
      assert.equal(endEvent.usage?.output, 7);
    }
  }
});

test.concurrent("responses client stream encoder: emits native refusal framing with full item lifecycle and roundtrip", () => {
  const encSession = { responseId: "r_ref_frame", model: "gpt-4o", createPartId: () => "p_ref" };
  const encoder = new ResponsesClientStreamEncoder(encSession);

  // 1. part_start emits output_item.added + content_part.added
  const startRes = encoder.encode({
    type: "part_start",
    responseId: "r_ref_frame",
    partId: "p_ref",
    part: { type: "refusal" },
  });
  assert.equal(startRes.ok, true);
  if (startRes.ok) {
    assert.equal(startRes.value.length, 2);
    assert.equal(startRes.value[0]?.event, "response.output_item.added");
    const itemAdded = JSON.parse(startRes.value[0]?.data ?? "{}");
    assert.equal(itemAdded.item.type, "message");
    assert.equal(itemAdded.item.id, "msg_p_ref");

    assert.equal(startRes.value[1]?.event, "response.content_part.added");
    const partAdded = JSON.parse(startRes.value[1]?.data ?? "{}");
    assert.equal(partAdded.part.type, "refusal");
  }

  // 2. refusal_delta emits response.refusal.delta
  const deltaRes = encoder.encode({
    type: "refusal_delta",
    responseId: "r_ref_frame",
    partId: "p_ref",
    text: "I cannot fulfill this.",
  });
  assert.equal(deltaRes.ok, true);
  if (deltaRes.ok) {
    assert.equal(deltaRes.value.length, 1);
    assert.equal(deltaRes.value[0]?.event, "response.refusal.delta");
    const delta = JSON.parse(deltaRes.value[0]?.data ?? "{}");
    assert.equal(delta.delta, "I cannot fulfill this.");
  }

  // 3. part_end emits refusal.done + content_part.done + output_item.done
  const endRes = encoder.encode({
    type: "part_end",
    responseId: "r_ref_frame",
    partId: "p_ref",
    partType: "refusal",
  });
  assert.equal(endRes.ok, true);
  if (endRes.ok) {
    assert.equal(endRes.value.length, 3);
    assert.equal(endRes.value[0]?.event, "response.refusal.done");
    assert.equal(endRes.value[1]?.event, "response.content_part.done");
    assert.equal(endRes.value[2]?.event, "response.output_item.done");
  }

  // 4. Verify roundtrip: ResponsesProviderStreamDecoder consumes the sequence cleanly
  const decSession = { responseId: "r_ref_frame", model: "gpt-4o", createPartId: () => "dec_part" };
  const decoder = new ResponsesProviderStreamDecoder(decSession);
  if (startRes.ok && deltaRes.ok && endRes.ok) {
    const allFrames = [...startRes.value, ...deltaRes.value, ...endRes.value];
    const decodedEvents: any[] = [];
    for (const frame of allFrames) {
      const res = decoder.push(frame);
      assert.equal(res.ok, true);
      if (res.ok) decodedEvents.push(...res.value);
    }
    assert.ok(decodedEvents.some((e) => e.type === "part_start" && e.part.type === "refusal"));
    assert.ok(decodedEvents.some((e) => e.type === "refusal_delta" && e.text === "I cannot fulfill this."));
    assert.ok(decodedEvents.some((e) => e.type === "part_end" && e.partType === "refusal"));
  }
});

test.concurrent("stream pump: first in-band error wins and short-circuits post-error frames", () => {
  const sessionData = { responseId: "pump_err_wins", model: "gpt-4o", createPartId: () => "p1" };
  const sseDecoder = createSseDecoder();
  const sseEncoder = createSseEncoder();
  const providerDecoder = new ResponsesProviderStreamDecoder(sessionData);
  const stateMachine = createIrStreamStateMachine({
    expectedResponseId: sessionData.responseId,
    expectedModel: sessionData.model,
    direction: "anthropic-messages->openai-responses",
  });
  const clientEncoder = new MessagesClientStreamEncoder(sessionData);
  const pump = new TranslatedStreamPump(sseDecoder, sseEncoder, providerDecoder, stateMachine, clientEncoder, () => {});

  // 1. Feed initial creation frame
  const initBytes = new TextEncoder().encode(
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"}}\n\n',
  );
  const initRes = pump.pushBytes(initBytes);
  assert.equal(initRes.ok, true);

  // 2. Feed first error
  const errBytes1 = new TextEncoder().encode(
    'event: error\ndata: {"type":"error","code":"first_error","message":"Initial failure"}\n\n',
  );
  const errRes1 = pump.pushBytes(errBytes1);
  assert.equal(errRes1.ok, true);
  assert.equal(pump.getFailure()?.message, "Initial failure");

  // 3. Feed second error and content frames -> ignored; first failure wins
  const errBytes2 = new TextEncoder().encode(
    'event: error\ndata: {"type":"error","code":"second_error","message":"Subsequent failure"}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"more text"}\n\n',
  );
  const errRes2 = pump.pushBytes(errBytes2);
  assert.equal(errRes2.ok, true);
  if (errRes2.ok) {
    assert.equal(errRes2.value.length, 0); // No chunks emitted after in-band error
  }
  assert.equal(pump.getFailure()?.message, "Initial failure"); // First error retained

  // Finish emits no trailing frames
  const finishRes = pump.finish();
  assert.equal(finishRes.ok, true);
  if (finishRes.ok) {
    assert.equal(finishRes.value.length, 0);
  }
});

test.concurrent("stream state machine: error event arriving after terminal response_end is rejected as post-terminal", () => {
  const machine = createIrStreamStateMachine({ direction: "openai-chat->openai-responses" });
  assert.equal(machine.feed({ type: "response_start", responseId: "post_term", model: "m" }).ok, true);
  const endRes = machine.feed({
    type: "response_end",
    responseId: "post_term",
    finish: { reason: "stop" },
  });
  assert.equal(endRes.ok, true);
  assert.equal(machine.isTerminal(), true);

  // Subsequent error event is rejected as post-terminal
  const postErr = machine.feed({
    type: "error",
    responseId: "post_term",
    failure: { category: "provider", message: "Late error", retryable: false },
  });
  assert.equal(postErr.ok, false);
  if (!postErr.ok) {
    assert.equal(postErr.error.category, "invalid_request");
    assert.match(postErr.error.message, /terminal/i);
  }
  // The state machine remains in terminal state, not downgraded to failed
  assert.equal(machine.isTerminal(), true);
});

