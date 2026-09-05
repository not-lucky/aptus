/**
 * Terminal-behavior capability rows:
 * - refusal-content
 * - refusal-terminal-reason
 * - refusal-category-explanation
 * - refusal-stream-delta
 * - finish-content-filter
 * - finish-context-limit
 * - finish-other-unknown
 * - post-header-stream-error
 * - abrupt-stream-close
 * - responses-websocket-transport
 * - authentication-headers
 * - organization-project-headers
 * - anthropic-version-header
 * - beta-header
 * - rate-limit-headers
 * - diagnostic-response-headers
 * - chat-legacy-max-tokens
 * - openai-prompt-cache-retention
 * - openai-system-fingerprint
 * - responses-preview-multi-agent
 * - ignorable-wire-metadata
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatClientStreamEncoder, ChatProviderStreamDecoder } from "../../src/translation/codecs/chat/stream.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
} from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrStreamEvent, JsonObject } from "../../src/translation/ir.ts";

function coordinator() {
  return createDefaultTranslationCoordinator();
}

// =====================================================================
// 1. Refusal Outcomes (C↔R T1, M directions T3)
// =====================================================================

test.concurrent("row refusal-content: complete outcome translation C↔R preserves refusal text", () => {
  const coord = coordinator();

  // Chat provider returns refusal -> translates to Responses client
  const chatOutcomeBody: JsonObject = {
    id: "chatcmpl-test-refusal",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          refusal: "I cannot fulfill this request due to policy.",
        },
        finish_reason: "stop",
      },
    ],
  };

  const toResponses = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatOutcomeBody,
    logicalModel: "gpt-4o",
  });

  assert.equal(toResponses.ok, true);
  if (toResponses.ok) {
    assert.equal(toResponses.value.status, 200);
    const body = toResponses.value.body;
    assert.equal(body.status, "completed");
    assert.ok(Array.isArray(body.output));
    const msg = (body.output as JsonObject[])[0];
    assert.equal(msg?.type, "message");
    assert.ok(Array.isArray(msg?.content));
    const contentPart = (msg?.content as JsonObject[])[0];
    assert.equal(contentPart?.type, "refusal");
    assert.equal(contentPart?.refusal, "I cannot fulfill this request due to policy.");
  }

  // Responses provider returns refusal -> translates to Chat client
  const respOutcomeBody: JsonObject = {
    id: "resp_test_refusal",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: "gpt-4o",
    output: [
      {
        type: "message",
        id: "msg_refusal",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I cannot fulfill this request due to policy." }],
      },
    ],
  };

  const toChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respOutcomeBody,
    logicalModel: "gpt-4o",
  });

  assert.equal(toChat.ok, true);
  if (toChat.ok) {
    assert.equal(toChat.value.status, 200);
    const body = toChat.value.body;
    assert.ok(Array.isArray(body.choices));
    const choice = (body.choices as JsonObject[])[0];
    assert.equal(choice?.finish_reason, "stop");
    const msg = choice?.message as JsonObject;
    assert.equal(msg?.role, "assistant");
    assert.equal(msg?.content, null);
    assert.equal(msg?.refusal, "I cannot fulfill this request due to policy.");
  }
});

test.concurrent("row refusal-content: refusal part co-occurring with tool_call parts fails closed on the complete path", () => {
  const coord = coordinator();

  // A provider outcome that both refuses and calls tools is malformed: no
  // target wire can express it. The stream decoders already reject the
  // combination; the complete path must reject it in preflight instead of
  // encoding a self-inconsistent client message.
  const responsesBody: JsonObject = {
    id: "resp_refusal_tools",
    model: "gpt-4o",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    output: [
      { type: "message", id: "msg_refusal_tools", role: "assistant", content: [{ type: "refusal", refusal: "I cannot fulfill this." }] },
      {
        type: "function_call",
        id: "fc_refusal_tools",
        call_id: "call_1",
        name: "get_weather",
        arguments: "{}",
      },
    ],
    usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  };

  // R provider emits refusal + function_call -> Chat client rejects.
  const toChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: responsesBody,
    logicalModel: "gpt-4o",
  });
  assert.equal(toChat.ok, false);
  if (!toChat.ok) {
    assert.equal(toChat.error.category, "invalid_request");
    assert.match(toChat.error.message, /refusal part and tool_call parts/);
  }

  // The Chat ingress decoder structurally cannot produce this combination —
  // its refusal branch owns the whole message and never parses tool_calls —
  // so the guard's second observable surface is the direct preflight unit
  // contract (covering both C↔R directions), pinned in terminal-hardening.
});

test.concurrent("row refusal-content: directions involving Anthropic Messages reject refusal parts", () => {
  const coord = coordinator();

  const chatRefusalBody: JsonObject = {
    id: "chatcmpl-test-refusal",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal: "I cannot fulfill this." },
        finish_reason: "stop",
      },
    ],
  };

  // C provider -> M client rejects
  const toMessages = coord.translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatRefusalBody,
    logicalModel: "gpt-4o",
  });
  assert.equal(toMessages.ok, false);
  if (!toMessages.ok) {
    assert.equal(toMessages.error.capability, "refusal-content");
  }

  // R provider -> M client rejects
  const respRefusalBody: JsonObject = {
    id: "resp_test_refusal",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: "gpt-4o",
    output: [
      {
        type: "message",
        id: "msg_refusal",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I cannot fulfill this." }],
      },
    ],
  };

  const rToMessages = coord.translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respRefusalBody,
    logicalModel: "gpt-4o",
  });
  assert.equal(rToMessages.ok, false);
  if (!rToMessages.ok) {
    assert.equal(rToMessages.error.capability, "refusal-content");
  }
});

test.concurrent("row refusal-terminal-reason: Anthropic stop_reason refusal fails closed", () => {
  const coord = coordinator();

  const messagesRefusalBody: JsonObject = {
    id: "msg_test_refusal",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet-20241022",
    content: [{ type: "text", text: "I cannot fulfill this." }],
    stop_reason: "refusal",
    usage: { input_tokens: 10, output_tokens: 10 },
  };

  const mToChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: messagesRefusalBody,
    logicalModel: "claude-3-5-sonnet-20241022",
  });
  assert.equal(mToChat.ok, false);
  if (!mToChat.ok) {
    assert.equal(mToChat.error.capability, "refusal-terminal-reason");
  }

  const mToResponses = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: messagesRefusalBody,
    logicalModel: "claude-3-5-sonnet-20241022",
  });
  assert.equal(mToResponses.ok, false);
  if (!mToResponses.ok) {
    assert.equal(mToResponses.error.capability, "refusal-terminal-reason");
  }
});

// =====================================================================
// 2. Refusal Streaming Deltas (refusal-stream-delta)
// =====================================================================

test.concurrent("row refusal-stream-delta: streaming refusal deltas relay C↔R", () => {
  const session = {
    responseId: "refusal-stream-1",
    model: "gpt-4o",
    createPartId: () => "part-refusal-1",
  };

  // Chat decoder -> Responses encoder
  const chatDecoder = new ChatProviderStreamDecoder(session);
  const respEncoder = new ResponsesClientStreamEncoder(session);

  // Chunk with delta.refusal
  const chatFrame = {
    data: JSON.stringify({
      id: "chatcmpl-ref-stream",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { refusal: "I cannot " },
          finish_reason: null,
        },
      ],
    }),
  };

  const decoded = chatDecoder.push(chatFrame);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const events = decoded.value;
    assert.ok(events.some((e) => e.type === "part_start" && e.part.type === "refusal"));
    const refusalDelta = events.find((e) => e.type === "refusal_delta");
    assert.ok(refusalDelta !== undefined && refusalDelta.type === "refusal_delta");
    assert.equal(refusalDelta.text, "I cannot ");

    // Encode for Responses client
    const encoded = respEncoder.encode(refusalDelta);
    assert.equal(encoded.ok, true);
    if (encoded.ok) {
      assert.equal(encoded.value.length, 1);
      assert.equal(encoded.value[0]?.event, "response.refusal.delta");
      const data = JSON.parse(encoded.value[0]?.data ?? "{}");
      assert.equal(data.delta, "I cannot ");
    }
  }

  // Responses decoder -> Chat encoder
  const respDecoder = new ResponsesProviderStreamDecoder(session);
  const chatEncoder = new ChatClientStreamEncoder(session);

  const respFrame = {
    event: "response.refusal.delta",
    data: JSON.stringify({
      type: "response.refusal.delta",
      delta: "fulfill this.",
      sequence_number: 1,
    }),
  };

  const respDecoded = respDecoder.push(respFrame);
  assert.equal(respDecoded.ok, true);
  if (respDecoded.ok) {
    const refusalDelta = respDecoded.value.find((e) => e.type === "refusal_delta");
    assert.ok(refusalDelta !== undefined && refusalDelta.type === "refusal_delta");
    assert.equal(refusalDelta.text, "fulfill this.");

    const chatEncoded = chatEncoder.encode(refusalDelta);
    assert.equal(chatEncoded.ok, true);
    if (chatEncoded.ok) {
      assert.equal(chatEncoded.value.length, 1);
      const data = JSON.parse(chatEncoded.value[0]?.data ?? "{}");
      assert.equal(data.choices[0].delta.refusal, "fulfill this.");
    }
  }
});

test.concurrent("row refusal-stream-delta: Messages stream encoder rejects refusal deltas", () => {
  const session = {
    responseId: "refusal-stream-m",
    model: "claude-3-5-sonnet",
    createPartId: () => "p1",
  };
  const msgEncoder = new MessagesClientStreamEncoder(session);

  const event: IrStreamEvent = {
    type: "refusal_delta",
    responseId: session.responseId,
    partId: "p1",
    text: "Refusal text",
  };

  const res = msgEncoder.encode(event);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "refusal-stream-delta");
  }
});

// =====================================================================
// 3. Content Filter Finish Reason (finish-content-filter)
// =====================================================================

test.concurrent("row finish-content-filter: complete outcome C↔R preserves content_filter finish", () => {
  const coord = coordinator();

  // Chat provider returns finish_reason: "content_filter" -> Responses client
  const chatBody: JsonObject = {
    id: "chatcmpl-filter",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Filtered text" },
        finish_reason: "content_filter",
      },
    ],
  };

  const toResponses = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatBody,
    logicalModel: "gpt-4o",
  });

  assert.equal(toResponses.ok, true);
  if (toResponses.ok) {
    const body = toResponses.value.body;
    assert.equal(body.status, "incomplete");
    const details = body.incomplete_details as JsonObject;
    assert.equal(details?.reason, "content_filter");
  }

  // Responses provider returns incomplete with reason: "content_filter" -> Chat client
  const respBody: JsonObject = {
    id: "resp_filter",
    object: "response",
    created_at: 1700000000,
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    model: "gpt-4o",
    output: [
      {
        type: "message",
        id: "msg_filter",
        role: "assistant",
        content: [{ type: "output_text", text: "Filtered text", annotations: [] }],
      },
    ],
  };

  const toChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respBody,
    logicalModel: "gpt-4o",
  });

  assert.equal(toChat.ok, true);
  if (toChat.ok) {
    const body = toChat.value.body;
    const choice = (body.choices as JsonObject[])[0];
    assert.equal(choice?.finish_reason, "content_filter");
  }
});

test.concurrent("row finish-content-filter: directions involving Messages reject content_filter", () => {
  const coord = coordinator();

  const chatBody: JsonObject = {
    id: "chatcmpl-filter",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Filtered text" },
        finish_reason: "content_filter",
      },
    ],
  };

  const toMessages = coord.translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatBody,
    logicalModel: "gpt-4o",
  });

  assert.equal(toMessages.ok, false);
  if (!toMessages.ok) {
    assert.equal(toMessages.error.capability, "finish-content-filter");
  }
});

// =====================================================================
// 4. Context Limit & Unknown Finish Reasons
// =====================================================================

test.concurrent("row finish-context-limit: Anthropic context limit stop reason fails closed in all directions", () => {
  const coord = coordinator();

  const messagesBody: JsonObject = {
    id: "msg_ctx_limit",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "text", text: "Truncated" }],
    stop_reason: "model_context_window_exceeded",
    usage: { input_tokens: 100, output_tokens: 50 },
  };

  const toChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: messagesBody,
    logicalModel: "claude-3-5-sonnet",
  });

  assert.equal(toChat.ok, false);
  if (!toChat.ok) {
    assert.equal(toChat.error.capability, "finish-context-limit");
  }
});

test.concurrent("row finish-other-unknown: unrecognized finish reasons fail closed", () => {
  const coord = coordinator();

  // Chat with unknown finish_reason
  const chatUnknown: JsonObject = {
    id: "chatcmpl-unk",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "custom_unsupported_reason",
      },
    ],
  };

  const chatRes = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatUnknown,
    logicalModel: "gpt-4o",
  });
  assert.equal(chatRes.ok, false);
  if (!chatRes.ok) {
    assert.equal(chatRes.error.capability, "finish-other-unknown");
  }

  // Responses with unknown incomplete reason
  const respUnknown: JsonObject = {
    id: "resp_unk",
    object: "response",
    created_at: 1700000000,
    status: "incomplete",
    incomplete_details: { reason: "unsupported_incomplete_reason" },
    model: "gpt-4o",
    output: [
      {
        type: "message",
        id: "msg_unk",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi", annotations: [] }],
      },
    ],
  };

  const respRes = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: { "content-type": "application/json" },
    body: respUnknown,
    logicalModel: "gpt-4o",
  });
  assert.equal(respRes.ok, false);
  if (!respRes.ok) {
    assert.equal(respRes.error.capability, "finish-other-unknown");
  }

  // Messages with unknown stop_reason
  const msgUnknown: JsonObject = {
    id: "msg_unk",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "text", text: "Hi" }],
    stop_reason: "quantum_interference",
    usage: { input_tokens: 10, output_tokens: 10 },
  };

  const msgRes = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: { "content-type": "application/json" },
    body: msgUnknown,
    logicalModel: "claude-3-5-sonnet",
  });
  assert.equal(msgRes.ok, false);
  if (!msgRes.ok) {
    assert.equal(msgRes.error.capability, "finish-other-unknown");
  }
});

// =====================================================================
// 5. In-Band Stream Errors (post-header-stream-error)
// =====================================================================

test.concurrent("row post-header-stream-error: in-band stream error translates between Responses and Messages", () => {
  const session = {
    responseId: "stream-err-1",
    model: "gpt-4o",
    createPartId: () => "p1",
  };

  // 1. Messages provider sends in-band error -> Responses client encoder formats native error frame
  const msgDecoder = new MessagesProviderStreamDecoder(session);
  const respEncoder = new ResponsesClientStreamEncoder(session);

  const errorChunk = {
    type: "error",
    error: {
      type: "overloaded_error",
      message: "Anthropic engine overloaded",
    },
  };

  const decoded = msgDecoder.push({
    event: "error",
    data: JSON.stringify(errorChunk),
  });

  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.length, 1);
    const errEvent = decoded.value[0];
    assert.equal(errEvent?.type, "error");
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.message, "Anthropic engine overloaded");

      const encoded = respEncoder.encode(errEvent);
      assert.equal(encoded.ok, true);
      if (encoded.ok) {
        // The error is the stream's first event, so the encoder opens the
        // Responses lifecycle before failing it: created + in_progress + error.
        assert.equal(encoded.value.length, 3);
        assert.equal(encoded.value[0]?.event, "response.created");
        assert.equal(encoded.value[1]?.event, "response.in_progress");
        assert.equal(encoded.value[2]?.event, "error");
        const data = JSON.parse(encoded.value[2]?.data ?? "{}");
        assert.equal(data.type, "error");
        assert.equal(data.message, "Anthropic engine overloaded");
      }
    }
  }

  // 2. Responses provider sends in-band error -> Messages client encoder formats native error frame
  const respDecoder = new ResponsesProviderStreamDecoder(session);
  const msgEncoder = new MessagesClientStreamEncoder(session);

  const respErrorFrame = {
    event: "error",
    data: JSON.stringify({
      type: "error",
      code: "rate_limit_exceeded",
      message: "OpenAI rate limit reached",
      param: null,
    }),
  };

  const respDecoded = respDecoder.push(respErrorFrame);
  assert.equal(respDecoded.ok, true);
  if (respDecoded.ok) {
    assert.equal(respDecoded.value.length, 1);
    const errEvent = respDecoded.value[0];
    assert.equal(errEvent?.type, "error");
    if (errEvent?.type === "error") {
      assert.equal(errEvent.failure.message, "OpenAI rate limit reached");

      const encoded = msgEncoder.encode(errEvent);
      assert.equal(encoded.ok, true);
      if (encoded.ok) {
        // The error is the stream's first event, so the encoder opens the
        // Messages lifecycle before failing it: message_start + error.
        assert.equal(encoded.value.length, 2);
        assert.equal(encoded.value[0]?.event, "message_start");
        assert.equal(encoded.value[1]?.event, "error");
        const data = JSON.parse(encoded.value[1]?.data ?? "{}");
        assert.equal(data.type, "error");
        assert.equal(data.error?.message, "OpenAI rate limit reached");
      }
    }
  }

  // 3. For Chat client, error event yields empty frame list (connection closes cleanly)
  const chatEncoder = new ChatClientStreamEncoder(session);
  if (decoded.ok && decoded.value[0]?.type === "error") {
    const chatEncoded = chatEncoder.encode(decoded.value[0]);
    assert.equal(chatEncoded.ok, true);
    if (chatEncoded.ok) {
      assert.equal(chatEncoded.value.length, 0);
    }
  }
});

// =====================================================================
// 6. Deprecated Request Fields & Preview Surfaces
// =====================================================================

test.concurrent("row chat-legacy-max-tokens: max_tokens on Chat request fails closed in translation", () => {
  const coord = coordinator();

  const chatRequestWithMaxTokens: JsonObject = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
  };

  const res = coord.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatRequestWithMaxTokens,
    logicalModel: "logical-key",
    targetModel: "gpt-4o",
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "chat-legacy-max-tokens");
  }
});

test.concurrent("row openai-prompt-cache-retention: prompt_cache_retention fails closed in translation", () => {
  const coord = coordinator();

  // Chat request
  const chatReq: JsonObject = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    prompt_cache_retention: "in_memory",
  };

  const chatRes = coord.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: chatReq,
    logicalModel: "logical-key",
    targetModel: "gpt-4o",
  });
  assert.equal(chatRes.ok, false);
  if (!chatRes.ok) {
    assert.equal(chatRes.error.capability, "openai-prompt-cache-retention");
  }

  // Responses request
  const respReq: JsonObject = {
    model: "gpt-4o",
    input: "Hello",
    prompt_cache_retention: "in_memory",
  };

  const respRes = coord.translateCompleteRequest({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    sourceBody: respReq,
    logicalModel: "logical-key",
    targetModel: "gpt-4o",
  });
  assert.equal(respRes.ok, false);
  if (!respRes.ok) {
    assert.equal(respRes.error.capability, "openai-prompt-cache-retention");
  }
});

test.concurrent("row responses-preview-multi-agent: multi_agent fails closed in translation", () => {
  const coord = coordinator();

  const respReq: JsonObject = {
    model: "gpt-4o",
    input: "Hello",
    multi_agent: true,
  };

  const res = coord.translateCompleteRequest({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    sourceBody: respReq,
    logicalModel: "logical-key",
    targetModel: "gpt-4o",
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "responses-preview-multi-agent");
  }
});

test.concurrent("row ignorable-wire-metadata: envelope tags stay outside IR without failing T1 turns", () => {
  const coord = coordinator();

  // Chat response with standard envelope tags (object, created, system_fingerprint)
  const chatOutcome: JsonObject = {
    id: "chatcmpl-metadata-test",
    object: "chat.completion",
    created: 1700000000,
    system_fingerprint: "fp_44709d6fcb",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Clean text response." },
        finish_reason: "stop",
      },
    ],
  };

  const res = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "openai-chat",
    status: 200,
    headers: { "content-type": "application/json" },
    body: chatOutcome,
    logicalModel: "gpt-4o",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.status, 200);
    const body = res.value.body;
    assert.equal(body.status, "completed");
    // Wire metadata of Chat does not pollute Responses output items
    const output = body.output as JsonObject[];
    assert.equal(output.length, 1);
  }
});
