/**
 * Owned generation-control rows: sampling bounds, output-token limits, stop
 * sequences, verbosity, common reasoning effort, and matched-stop echo
 * behavior, in every direction each row admits.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject, Protocol } from "../../src/domain/contracts.ts";
import { ChatEgressEncoder } from "../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import {
  ChatClientStreamEncoder,
  ChatStreamRequestDecoder,
  ChatStreamRequestEncoder,
} from "../../src/translation/codecs/chat/stream.ts";
import { MessagesEgressEncoder } from "../../src/translation/codecs/messages/egress.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import { ResponsesEgressEncoder } from "../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import {
  ResponsesStreamRequestDecoder,
  ResponsesStreamRequestEncoder,
} from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrStreamEvent } from "../../src/translation/ir.ts";
import { preflightRequest } from "../../src/translation/preflight.ts";
import { irBase, sourceBodyFor, translateRequest } from "./owned-rows-helpers.ts";

// =====================================================================
// Generation controls: direct translation across directions
// =====================================================================

const CHAT_CONTROLS_BODY = {
  model: "wire-model",
  messages: [{ role: "user", content: "Hello!" }],
  temperature: 0.7,
  top_p: 0.9,
  max_completion_tokens: 512,
  stop: ["END", "STOP"],
  verbosity: "low",
  reasoning_effort: "high",
};

const RESPONSES_CONTROLS_BODY = {
  model: "wire-model",
  input: "Hello!",
  temperature: 0.7,
  top_p: 0.9,
  max_output_tokens: 512,
  text: { verbosity: "low" },
  reasoning: { effort: "high" },
};

const MESSAGES_CONTROLS_BODY = {
  model: "wire-model",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
  temperature: 0.7,
  top_p: 0.9,
  stop_sequences: ["END", "STOP"],
};

test.concurrent("row temperature/top-p/output-token-limit/text-verbosity/reasoning-effort-common: C controls project onto R wire fields exactly (stops reject into R)", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatToR = {
    model: "wire-model",
    messages: [{ role: "user", content: "Hello!" }],
    temperature: 0.7,
    top_p: 0.9,
    max_completion_tokens: 512,
    verbosity: "low",
    reasoning_effort: "high",
  };
  const res = translateRequest(coordinator, "openai-chat", "openai-responses", chatToR);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value.body, {
      model: "upstream-target",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello!" }] }],
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 512,
      text: { verbosity: "low" },
      reasoning: { effort: "high" },
    });
  }

  // Stop sequences never target R even when everything else is admitted.
  const withStop = translateRequest(coordinator, "openai-chat", "openai-responses", CHAT_CONTROLS_BODY);
  assert.equal(withStop.ok, false);
  if (!withStop.ok) assert.equal(withStop.error.capability, "stop-sequence-request");
});

test.concurrent("generation controls: C→M projects sampling/stops; M target resolves user max value over default", () => {
  const coordinator = createDefaultTranslationCoordinator();
  // Verbosity and reasoning effort are T3 in every M-involved direction.
  const chatToMControls = {
    model: "wire-model",
    messages: [{ role: "user", content: "Hello!" }],
    temperature: 0.7,
    top_p: 0.9,
    max_completion_tokens: 512,
    stop: ["END", "STOP"],
  };
  const res = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatToMControls);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.body.temperature, 0.7);
    assert.equal(res.value.body.top_p, 0.9);
    // User's explicit output limit wins over the target model default.
    assert.equal(res.value.body.max_tokens, 512);
    assert.deepEqual(res.value.body.stop_sequences, ["END", "STOP"]);
    assert.equal("verbosity" in res.value.body, false);
  }
});

test.concurrent("generation controls: R→C and R→M preserve values; M→C maps max_tokens/stop_sequences back", () => {
  const coordinator = createDefaultTranslationCoordinator();

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", RESPONSES_CONTROLS_BODY);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    assert.equal(rToC.value.body.temperature, 0.7);
    assert.equal(rToC.value.body.top_p, 0.9);
    assert.equal(rToC.value.body.max_completion_tokens, 512);
    assert.equal(rToC.value.body.verbosity, "low");
    assert.equal(rToC.value.body.reasoning_effort, "high");
  }

  // Verbosity and common effort have no M equivalent: the first T3 row wins.
  const rToM = translateRequest(coordinator, "openai-responses", "anthropic-messages", RESPONSES_CONTROLS_BODY);
  assert.equal(rToM.ok, false);
  if (!rToM.ok) assert.equal(rToM.error.capability, "text-verbosity");

  const mToC = translateRequest(coordinator, "anthropic-messages", "openai-chat", MESSAGES_CONTROLS_BODY);
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    assert.equal(mToC.value.body.temperature, 0.7);
    assert.equal(mToC.value.body.top_p, 0.9);
    assert.equal(mToC.value.body.max_completion_tokens, 1024);
    assert.deepEqual(mToC.value.body.stop, ["END", "STOP"]);
  }

  // Stops never target R; sampling and the output limit still translate.
  const { stop_sequences: _s, ...messagesNoStops } = MESSAGES_CONTROLS_BODY;
  void _s;
  const mToR = translateRequest(coordinator, "anthropic-messages", "openai-responses", messagesNoStops);
  assert.equal(mToR.ok, true);
  if (mToR.ok) {
    assert.equal(mToR.value.body.temperature, 0.7);
    assert.equal(mToR.value.body.top_p, 0.9);
    assert.equal(mToR.value.body.max_output_tokens, 1024);
    assert.equal("stop" in mToR.value.body, false);
  }

  const mToRWithStops = translateRequest(coordinator, "anthropic-messages", "openai-responses", MESSAGES_CONTROLS_BODY);
  assert.equal(mToRWithStops.ok, false);
  if (!mToRWithStops.ok) assert.equal(mToRWithStops.error.capability, "stop-sequence-request");
});

test.concurrent("row temperature-0-1 / top-p-0-1: out-of-range or non-finite values fail closed, never clamped", () => {
  const decoder = new ChatIngressDecoder();
  for (const [field, capability] of [
    ["temperature", "temperature-0-1"],
    ["top_p", "top-p-0-1"],
  ] as const) {
    for (const value of [1.5, -0.1, 2]) {
      const res = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), [field]: value });
      assert.equal(res.ok, false, `${field}=${value}`);
      if (!res.ok) assert.equal(res.error.capability, capability);
    }
    for (const value of ["0.5", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), [field]: value });
      assert.equal(res.ok, false, `${field}=${String(value)} must be invalid_request`);
      if (!res.ok) assert.equal(res.error.capability, undefined);
    }
  }

  // M sources enforce the same bounds (never clamped).
  const messagesDecoder = new MessagesIngressDecoder();
  const hot = messagesDecoder.decodeRequest({ ...MESSAGES_CONTROLS_BODY, temperature: 1.25 });
  assert.equal(hot.ok, false);
  if (!hot.ok) assert.equal(hot.error.capability, "temperature-0-1");
});

test.concurrent("row text-verbosity: C↔R direct; every M-involved direction rejects with text-verbosity", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = { ...sourceBodyFor("openai-chat"), verbosity: "medium" };
  const responsesBody = { model: "wire-model", input: "Hello!", text: { verbosity: "low" } };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) assert.deepEqual((cToR.value.body as { text: { verbosity: string } }).text, { verbosity: "medium" });

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", responsesBody);
  assert.equal(rToC.ok, true);
  if (rToC.ok) assert.equal((rToC.value.body as { verbosity: string }).verbosity, "low");

  for (const target of ["anthropic-messages"] as Protocol[]) {
    const res = translateRequest(coordinator, "openai-chat", target, chatBody);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.capability, "text-verbosity");
  }
  // R→M rejects with the row ID as well.
  const rToM = translateRequest(coordinator, "openai-responses", "anthropic-messages", responsesBody);
  assert.equal(rToM.ok, false);
  if (!rToM.ok) assert.equal(rToM.error.capability, "text-verbosity");

  const fromM = preflightRequest(
    { ...irBase(), generation: { verbosity: "low" } },
    "anthropic-messages->openai-responses",
  );
  assert.equal(fromM.ok, false);
  if (!fromM.ok) assert.equal(fromM.error.capability, "text-verbosity");
  // M→C: an M-origin IR claiming verbosity rejects at preflight too.
  const fromMToC = preflightRequest(
    { ...irBase(), generation: { verbosity: "low" } },
    "anthropic-messages->openai-chat",
  );
  assert.equal(fromMToC.ok, false);
  if (!fromMToC.ok) assert.equal(fromMToC.error.capability, "text-verbosity");
});

test.concurrent("row reasoning-effort-common: C↔R five-literal set; none|minimal fail with the capability ID; M directions blocked", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = { ...sourceBodyFor("openai-chat"), reasoning_effort: "xhigh" };
  const responsesBody = { model: "wire-model", input: "Hello!", reasoning: { effort: "max" } };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) assert.deepEqual((cToR.value.body as { reasoning: { effort: string } }).reasoning, { effort: "xhigh" });

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", responsesBody);
  assert.equal(rToC.ok, true);
  if (rToC.ok) assert.equal((rToC.value.body as { reasoning_effort: string }).reasoning_effort, "max");

  // Valid-but-native-only literals fail closed with the row's ID, not invalid_request.
  const chatDecoder = new ChatIngressDecoder();
  for (const literal of ["none", "minimal"]) {
    const res = chatDecoder.decodeRequest({ ...sourceBodyFor("openai-chat"), reasoning_effort: literal });
    assert.equal(res.ok, false, literal);
    if (!res.ok) assert.equal(res.error.capability, "reasoning-effort-common");
  }
  const responsesDecoder = new ResponsesIngressDecoder();
  const minimalR = responsesDecoder.decodeRequest({
    model: "wire-model",
    input: "Hello!",
    reasoning: { effort: "minimal" },
  });
  assert.equal(minimalR.ok, false);
  if (!minimalR.ok) assert.equal(minimalR.error.capability, "reasoning-effort-common");

  // Non-admitted garbage is structurally invalid.
  const absurd = chatDecoder.decodeRequest({ ...sourceBodyFor("openai-chat"), reasoning_effort: "absurd" });
  assert.equal(absurd.ok, false);
  if (!absurd.ok) assert.equal(absurd.error.capability, undefined);

  // Every M-involved direction rejects before dispatch.
  const intoM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatBody);
  assert.equal(intoM.ok, false);
  if (!intoM.ok) assert.equal(intoM.error.capability, "reasoning-effort-common");
  const rIntoM = translateRequest(coordinator, "openai-responses", "anthropic-messages", responsesBody);
  assert.equal(rIntoM.ok, false);
  if (!rIntoM.ok) assert.equal(rIntoM.error.capability, "reasoning-effort-common");

  const outOfM = preflightRequest(
    { ...irBase(), generation: { reasoning: { effort: "high" } } },
    "anthropic-messages->openai-chat",
  );
  assert.equal(outOfM.ok, false);
  if (!outOfM.ok) assert.equal(outOfM.error.capability, "reasoning-effort-common");
  const outOfMToR = preflightRequest(
    { ...irBase(), generation: { reasoning: { effort: "high" } } },
    "anthropic-messages->openai-responses",
  );
  assert.equal(outOfMToR.ok, false);
  if (!outOfMToR.ok) assert.equal(outOfMToR.error.capability, "reasoning-effort-common");

  // M's own effort surface (output_config.effort) triggers the same row.
  const messagesDecoder = new MessagesIngressDecoder();
  const mEffort = messagesDecoder.decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    output_config: { effort: "high" },
  });
  assert.equal(mEffort.ok, false);
  if (!mEffort.ok) assert.equal(mEffort.error.capability, "reasoning-effort-common");
});

test.concurrent("row stop-sequence-request: C→M direct; M→C ≤4 passes and >4 rejects; every R-targeting direction rejects", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // C→M maps directly.
  const { verbosity: _v, reasoning_effort: _r, ...chatToMBody } = CHAT_CONTROLS_BODY;
  void _v;
  void _r;
  const cToM = translateRequest(coordinator, "openai-chat", "anthropic-messages", chatToMBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) assert.deepEqual(cToM.value.body.stop_sequences, ["END", "STOP"]);

  // M→C with exactly 4 entries passes; 5 entries reject with the row ID.
  const fourStopsM = { ...MESSAGES_CONTROLS_BODY, stop_sequences: ["a", "b", "c", "d"] };
  const mToCFour = translateRequest(coordinator, "anthropic-messages", "openai-chat", fourStopsM);
  assert.equal(mToCFour.ok, true);
  if (mToCFour.ok) assert.deepEqual(mToCFour.value.body.stop, ["a", "b", "c", "d"]);

  const fiveStopsM = { ...MESSAGES_CONTROLS_BODY, stop_sequences: ["a", "b", "c", "d", "e"] };
  const mToCFive = translateRequest(coordinator, "anthropic-messages", "openai-chat", fiveStopsM);
  assert.equal(mToCFive.ok, false);
  if (!mToCFive.ok) assert.equal(mToCFive.error.capability, "stop-sequence-request");

  // Every direction targeting Responses rejects. R sources have no stop
  // field, so only C and M sources exercise the rejection.
  for (const source of ["openai-chat", "anthropic-messages"] as Protocol[]) {
    const res = translateRequest(coordinator, source, "openai-responses", {
      ...sourceBodyFor(source),
      ...(source === "openai-chat" ? { stop: "END" } : { stop_sequences: ["END"] }),
    });
    assert.equal(res.ok, false, `${source}->openai-responses`);
    if (!res.ok) assert.equal(res.error.capability, "stop-sequence-request");
  }

  // Chat decode enforces its documented 1–4 entry schema.
  const chatDecoder = new ChatIngressDecoder();
  for (const badStop of [[], ["a", "b", "c", "d", "e"], [""], [42]]) {
    const res = chatDecoder.decodeRequest({ ...sourceBodyFor("openai-chat"), stop: badStop });
    assert.equal(res.ok, false, JSON.stringify(badStop));
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("row output-token-limit: M target resolves user value first, default second, and fails closed when unresolved", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // User value wins over the model default (512 vs 2048).
  const withUser = translateRequest(coordinator, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    max_completion_tokens: 512,
  });
  assert.equal(withUser.ok, true);
  if (withUser.ok) assert.equal(withUser.value.body.max_tokens, 512);

  // Default fills in when the caller sends none.
  const withDefault = translateRequest(coordinator, "openai-chat", "anthropic-messages", sourceBodyFor("openai-chat"));
  assert.equal(withDefault.ok, true);
  if (withDefault.ok) assert.equal(withDefault.value.body.max_tokens, 2048);

  // No user value and no resolvable default fails closed before dispatch.
  const unresolved = coordinator.translateRequest({ stream: false,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: sourceBodyFor("openai-chat"),
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: undefined,
  });
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.error.capability, "output-token-limit");

  // Invalid limits never reach the coordinator.
  const decoder = new ChatIngressDecoder();
  for (const bad of [0, -5, 1.5]) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), max_completion_tokens: bad });
    assert.equal(res.ok, false, `max_completion_tokens=${bad}`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

// =====================================================================
// Matched stop sequence echo
// =====================================================================

const M_OUTCOME_WITH_STOP: JsonObject = {
  id: "msg_stop",
  type: "message",
  role: "assistant",
  model: "upstream-target",
  content: [{ type: "text", text: "partial" }],
  stop_reason: "stop_sequence",
  stop_sequence: "END",
  usage: { input_tokens: 3, output_tokens: 2 },
};

test.concurrent("row matched-stop-sequence: M-origin stop maps to natural stop on C/R clients; only the M client echoes the string", () => {
  const messagesDecoder = new MessagesIngressDecoder();
  const decoded = messagesDecoder.decodeOutcome(200, {}, M_OUTCOME_WITH_STOP);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const outcome = decoded.value.irOutcome;
  assert.equal(outcome.finish.reason, "stop");
  assert.equal(outcome.finish.stopSequence, "END");

  // C client: natural stop, matched string omitted (T2 declared loss).
  const chatBody = new ChatEgressEncoder().encodeOutcome(outcome).body as {
    choices: Array<{ finish_reason: string }>;
  };
  assert.equal(chatBody.choices[0]?.finish_reason, "stop");
  assert.equal(JSON.stringify(chatBody).includes("END"), false);

  // R client: completed status, string omitted.
  const responsesBody = new ResponsesEgressEncoder().encodeOutcome(outcome).body as { status: string };
  assert.equal(responsesBody.status, "completed");
  assert.equal(JSON.stringify(responsesBody).includes('"END"'), false);

  // M client: valid stop_sequence framing echoed verbatim.
  const messagesBody = new MessagesEgressEncoder().encodeOutcome(outcome).body as {
    stop_reason: string;
    stop_sequence: string | null;
  };
  assert.equal(messagesBody.stop_reason, "stop_sequence");
  assert.equal(messagesBody.stop_sequence, "END");
});

test.concurrent("row matched-stop-sequence (stream): provider capture replaces rejection; client echo per protocol", () => {
  const session = {
    responseId: "resp_stop",
    model: "logical-key",
    createPartId: () => "p1",
  };

  const decoder = new MessagesProviderStreamDecoder(session);
  decoder.push({
    event: "message_start",
    data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}',
  });
  const deltaRes = decoder.push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"stop_sequence","stop_sequence":"END"},"usage":{"output_tokens":2}}',
  });
  assert.equal(deltaRes.ok, true);
  const endRes = decoder.push({ event: "message_stop", data: '{"type":"message_stop"}' });
  assert.equal(endRes.ok, true);
  if (endRes.ok) {
    const end = endRes.value[0];
    assert.equal(end?.type, "response_end");
    if (end?.type === "response_end") {
      assert.equal(end.finish.reason, "stop");
      assert.equal(end.finish.stopSequence, "END");
    }
  }

  // C client encoder maps to the plain stop reason without the string.
  const terminalEvent = endRes.ok ? (endRes.value[0] as IrStreamEvent) : ({ type: "error" } as IrStreamEvent);
  const chatEncoder = new ChatClientStreamEncoder(session, {});
  const chatFrames = chatEncoder.encode(terminalEvent);
  assert.equal(chatFrames.ok, true);
  if (chatFrames.ok) {
    const terminal = JSON.parse(chatFrames.value[0]?.data ?? "{}") as { choices: Array<{ finish_reason: string }> };
    assert.equal(terminal.choices[0]?.finish_reason, "stop");
  }

  // M client encoder echoes stop_sequence with its own stop reason.
  const messagesEncoder = new MessagesClientStreamEncoder(session);
  const mFrames = messagesEncoder.encode(terminalEvent);
  assert.equal(mFrames.ok, true);
  if (mFrames.ok) {
    const deltaFrame = mFrames.value.find((f) => f.data.includes("message_delta"));
    assert.ok(deltaFrame !== undefined);
    const parsed = JSON.parse(deltaFrame.data) as { delta: { stop_reason: string; stop_sequence: string | null } };
    assert.equal(parsed.delta.stop_reason, "stop_sequence");
    assert.equal(parsed.delta.stop_sequence, "END");
  }
});

test.concurrent("stream request codecs: generation controls and sidecar project onto provider stream bodies", () => {
  const chatDecoded = new ChatStreamRequestDecoder().decodeRequest({
    ...CHAT_CONTROLS_BODY,
    stream: true,
  });
  assert.equal(chatDecoded.ok, true);
  if (chatDecoded.ok) {
    const encoded = new ChatStreamRequestEncoder().encodeRequest(
      chatDecoded.value.irRequest,
      "t",
      chatDecoded.value.sourceWireOptions,
      chatDecoded.value.requestWireOptions,
    ) as Record<string, unknown>;
    assert.equal(encoded.temperature, 0.7);
    assert.deepEqual(encoded.stop, ["END", "STOP"]);
    assert.deepEqual((encoded.stream_options as Record<string, unknown>).include_usage, false);
  }

  const responsesDecoded = new ResponsesStreamRequestDecoder().decodeRequest({
    ...RESPONSES_CONTROLS_BODY,
    stream: true,
  });
  assert.equal(responsesDecoded.ok, true);
  if (responsesDecoded.ok) {
    const encoded = new ResponsesStreamRequestEncoder().encodeRequest(
      responsesDecoded.value.irRequest,
      "t",
      {},
      responsesDecoded.value.requestWireOptions,
    ) as Record<string, unknown>;
    assert.equal(encoded.max_output_tokens, 512);
    assert.deepEqual(encoded.text, { verbosity: "low" });
  }
});

// =====================================================================
// matched-stop-sequence T2 label (into-M): natural stop emits stop_sequence: null
// =====================================================================

test.concurrent("row matched-stop-sequence (into-M complete): natural-stop outcome emits stop_sequence null present, never omitted", () => {
  const decoded = new ChatIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl_stopnull",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  // C-origin finish carries no matched stop sequence.
  assert.equal(decoded.value.irOutcome.finish.stopSequence, undefined);

  const body = new MessagesEgressEncoder().encodeOutcome(decoded.value.irOutcome).body as Record<string, unknown> & {
    stop_reason: unknown;
    stop_sequence: unknown;
  };
  assert.equal("stop_sequence" in body, true);
  assert.deepEqual(
    { stop_reason: body.stop_reason, stop_sequence: body.stop_sequence },
    { stop_reason: "end_turn", stop_sequence: null },
  );
});

test.concurrent("row matched-stop-sequence (into-M complete, R origin): R-origin natural-stop outcome emits stop_sequence null present, never omitted", () => {
  const decoded = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "resp_stopnull",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  // R-origin finish carries no matched stop sequence.
  assert.equal(decoded.value.irOutcome.finish.stopSequence, undefined);

  const body = new MessagesEgressEncoder().encodeOutcome(decoded.value.irOutcome).body as Record<string, unknown> & {
    stop_reason: unknown;
    stop_sequence: unknown;
  };
  assert.equal("stop_sequence" in body, true);
  assert.deepEqual(
    { stop_reason: body.stop_reason, stop_sequence: body.stop_sequence },
    { stop_reason: "end_turn", stop_sequence: null },
  );
});

test.concurrent("row matched-stop-sequence (R→C source-absence): R-origin natural stop carries no stop sequence into C egress", () => {
  const decoded = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "resp_stopabsent",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  // R wire has no matched-stop field, so the symbol never enters the IR
  // (source-absence T3): nothing can leak toward the C client.
  assert.equal(decoded.value.irOutcome.finish.stopSequence, undefined);

  const body = new ChatEgressEncoder().encodeOutcome(decoded.value.irOutcome).body as {
    choices: Array<{ finish_reason: string }>;
  };
  assert.equal(body.choices[0]?.finish_reason, "stop");
  assert.equal(JSON.stringify(body).includes("stop_sequence"), false);
});

test.concurrent("row matched-stop-sequence (into-M stream): closing message_delta carries delta.stop_sequence === null", () => {
  const encoder = new MessagesClientStreamEncoder({
    responseId: "msg_stopnull",
    model: "logical-key",
    createPartId: () => "p1",
  });
  const frames = encoder.encode({
    type: "response_end",
    responseId: "msg_stopnull",
    finish: { reason: "stop" },
  });
  assert.equal(frames.ok, true);
  if (frames.ok) {
    const deltaFrame = frames.value.find((f) => f.data.includes("message_delta"));
    assert.ok(deltaFrame !== undefined);
    const parsed = JSON.parse(deltaFrame.data) as { delta: { stop_reason: string; stop_sequence: string | null } };
    assert.deepEqual(
      { stop_reason: parsed.delta.stop_reason, stop_sequence: parsed.delta.stop_sequence },
      { stop_reason: "end_turn", stop_sequence: null },
    );
  }
});

// =====================================================================
// temperature-0-1 / top-p-0-1 bounds gaps: Responses ingress both controls,
// Messages ingress top_p (M temperature is covered by the earlier row test)
// =====================================================================

test.concurrent("rows temperature-0-1 / top-p-0-1 bounds: Responses ingress enforces range and non-finite classes; Messages top_p matches", () => {
  const responsesDecoder = new ResponsesIngressDecoder();
  for (const [field, capability] of [
    ["temperature", "temperature-0-1"],
    ["top_p", "top-p-0-1"],
  ] as const) {
    for (const value of [1.5, -0.25, 2]) {
      const res = responsesDecoder.decodeRequest({ model: "wire-model", input: "Hello!", [field]: value });
      assert.equal(res.ok, false, `responses ${field}=${value}`);
      if (!res.ok) assert.equal(res.error.capability, capability);
    }
    for (const value of ["0.5", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = responsesDecoder.decodeRequest({ model: "wire-model", input: "Hello!", [field]: value });
      assert.equal(res.ok, false, `responses ${field}=${String(value)} must be invalid_request`);
      if (!res.ok) assert.equal(res.error.capability, undefined);
    }
  }

  const messagesDecoder = new MessagesIngressDecoder();
  for (const value of [1.5, -0.25, 2]) {
    const res = messagesDecoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), top_p: value });
    assert.equal(res.ok, false, `messages top_p=${value}`);
    if (!res.ok) assert.equal(res.error.capability, "top-p-0-1");
  }
  for (const value of ["0.5", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = messagesDecoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), top_p: value });
    assert.equal(res.ok, false, `messages top_p=${String(value)} must be invalid_request`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("verbosity invalid literals fail closed as invalid_request on both C/R ingresses", () => {
  const chatDecoder = new ChatIngressDecoder();
  for (const value of ["tall", 2]) {
    const res = chatDecoder.decodeRequest({ ...sourceBodyFor("openai-chat"), verbosity: value });
    assert.equal(res.ok, false, `chat verbosity=${String(value)} must be invalid_request`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }

  const responsesDecoder = new ResponsesIngressDecoder();
  for (const value of ["tall", 2]) {
    const res = responsesDecoder.decodeRequest({
      ...sourceBodyFor("openai-responses"),
      text: { verbosity: value },
    });
    assert.equal(res.ok, false, `responses text.verbosity=${String(value)} must be invalid_request`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("Messages generation controls: non-finite temperature and malformed stop entries fail closed", () => {
  const decoder = new MessagesIngressDecoder();
  for (const value of ["0.5", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), temperature: value });
    assert.equal(res.ok, false, `messages temperature=${String(value)} must be invalid_request`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }

  for (const entries of [["ok", ""], [42], ["ok", null]]) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("anthropic-messages"), stop_sequences: entries });
    assert.equal(res.ok, false, `messages stop_sequences=${JSON.stringify(entries)} must be invalid_request`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("strict stop_sequence coupling: a matched string with a non-stop_sequence reason fails closed everywhere", () => {
  const outcomeRes = new MessagesIngressDecoder().decodeOutcome(200, {}, {
    id: "msg_stray",
    type: "message",
    role: "assistant",
    model: "upstream-target",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: "STRAY",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as JsonObject);
  assert.equal(outcomeRes.ok, false);
  if (!outcomeRes.ok) assert.equal(outcomeRes.error.capability, undefined);

  const streamRes = new MessagesProviderStreamDecoder({
    responseId: "resp_stray",
    model: "logical-key",
    createPartId: () => "p1",
  }).push({
    event: "message_delta",
    data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":"STRAY"},"usage":{"output_tokens":1}}',
  });
  assert.equal(streamRes.ok, false);
  if (!streamRes.ok) assert.equal(streamRes.error.capability, undefined);
});

test.concurrent("chat scalar stop forms: empty string and non-string scalars fail invalid_request", () => {
  const decoder = new ChatIngressDecoder();
  for (const badStop of ["", 42]) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), stop: badStop });
    assert.equal(res.ok, false, `stop=${JSON.stringify(badStop)}`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("maxOutputTokens non-finite class: NaN and Infinity fail invalid_request at decode", () => {
  const decoder = new ChatIngressDecoder();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), max_completion_tokens: bad });
    assert.equal(res.ok, false, `max_completion_tokens=${String(bad)}`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});
