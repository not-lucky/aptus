/**
 * Owned wire-only sidecar rows: storage, prompt-cache key/mode/ttl/breakpoints,
 * metadata, safety identifier, moderation param and result, service tier, and
 * their stream-path sidecar behavior.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject, Protocol } from "../../src/domain/contracts.ts";
import { ChatEgressEncoder } from "../../src/translation/codecs/chat/egress.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { ChatStreamRequestDecoder, ChatStreamRequestEncoder } from "../../src/translation/codecs/chat/stream.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import { ResponsesEgressEncoder } from "../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import {
  ResponsesStreamRequestDecoder,
  ResponsesStreamRequestEncoder,
} from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrOutcome } from "../../src/translation/ir.ts";
import { preflightOutcome } from "../../src/translation/preflight.ts";
import { createSseDecoder, createSseEncoder } from "../../src/translation/sse.ts";
import { TranslatedStreamPump } from "../../src/translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../../src/translation/stream-state.ts";
import { createSessionBundle, irBase, sourceBodyFor, translateRequest } from "./owned-rows-helpers.ts";

// =====================================================================
// Admitted wire-only mappings (sidecar translate, never reject)
// =====================================================================

test.concurrent("row responses-storage: C↔R explicit-value mapping; absent stays absent; M directions reject", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // Explicit false maps verbatim; no fabricated default either way.
  const cToRFalse = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    store: false,
  });
  assert.equal(cToRFalse.ok, true);
  if (cToRFalse.ok) assert.equal(cToRFalse.value.body.store, false);

  const rToCTrue = translateRequest(coordinator, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    store: true,
  });
  assert.equal(rToCTrue.ok, true);
  if (rToCTrue.ok) assert.equal(rToCTrue.value.body.store, true);

  const absent = translateRequest(coordinator, "openai-chat", "openai-responses", sourceBodyFor("openai-chat"));
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal("store" in absent.value.body, false);

  // Every M direction rejects the row.
  const intoM = translateRequest(coordinator, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    store: false,
  });
  assert.equal(intoM.ok, false);
  if (!intoM.ok) assert.equal(intoM.error.capability, "responses-storage");

  // The R-source variant exercises the same preflight row from the other endpoint.
  const rIntoM = translateRequest(coordinator, "openai-responses", "anthropic-messages", {
    model: "wire-model",
    input: "Hello!",
    store: true,
  });
  assert.equal(rIntoM.ok, false);
  if (!rIntoM.ok) assert.equal(rIntoM.error.capability, "responses-storage");

  // Explicit null is malformed C/R wire (store is documented non-nullable):
  // invalid_request, never silently coerced to absence.
  for (const [source, target] of [
    ["openai-chat", "openai-responses"],
    ["openai-responses", "openai-chat"],
  ] as const) {
    const res = translateRequest(coordinator, source, target, {
      ...sourceBodyFor(source),
      store: null,
    });
    assert.equal(res.ok, false, `${source} store:null`);
    if (!res.ok) assert.equal(res.error.capability, undefined);
  }
});

test.concurrent("rows prompt-cache-key/mode/ttl: C↔R direct passthrough; M directions reject each row", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    ...sourceBodyFor("openai-chat"),
    prompt_cache_key: "ck-123",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  };
  const responsesBody = {
    model: "wire-model",
    input: "Hello!",
    prompt_cache_key: "ck-123",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    assert.equal(cToR.value.body.prompt_cache_key, "ck-123");
    assert.deepEqual(cToR.value.body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  }

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", responsesBody);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    assert.equal(rToC.value.body.prompt_cache_key, "ck-123");
    assert.deepEqual(rToC.value.body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  }

  for (const source of ["openai-chat", "openai-responses"] as const) {
    for (const [extra, capability] of [
      [{ prompt_cache_key: "ck" }, "prompt-cache-key"],
      [{ prompt_cache_options: { mode: "explicit" } }, "prompt-cache-mode"],
      [{ prompt_cache_options: { ttl: "30m" } }, "prompt-cache-ttl"],
    ] as const) {
      const res = translateRequest(coordinator, source, "anthropic-messages", {
        ...sourceBodyFor(source),
        ...extra,
      });
      assert.equal(res.ok, false, `${capability} from ${source}`);
      if (!res.ok) assert.equal(res.error.capability, capability);
    }
  }
});

test.concurrent("row prompt-cache-breakpoint: C↔R per-part markers re-anchor; into/out of M marker-only with declared TTL loss", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // C part marker → R input part marker at the same semantic position.
  const cBody = {
    model: "wire-model",
    messages: [
      { role: "system", content: [{ type: "text", text: "rules", prompt_cache_breakpoint: { mode: "explicit" } }] },
      { role: "user", content: "Hello!" },
    ],
  };
  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ prompt_cache_breakpoint?: unknown }> }>;
    assert.deepEqual(input[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(input[1]?.content[0]?.prompt_cache_breakpoint, undefined);
  }

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: "rules", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
      "Hello!",
    ],
  });
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const messages = rToC.value.body.messages as Array<{ content: Array<{ prompt_cache_breakpoint?: unknown }> }>;
    assert.deepEqual(messages[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  }

  // C part marker → M block marker (TTL dropped).
  const cToM = translateRequest(coordinator, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const system = cToM.value.body.system as Array<{ cache_control?: unknown }>;
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  }

  // M block marker (with TTL) → C part marker; TTL is declared loss.
  const mDecoder = new MessagesIngressDecoder();
  const mDecoded = mDecoder.decodeRequest({
    model: "wire-model",
    max_tokens: 64,
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(mDecoded.ok, true);
  if (!mDecoded.ok) return;
  assert.equal(mDecoded.value.requestWireOptions.promptCacheBreakpoints?.length, 1);

  // M top-level auto-marker anchors a sentinel breakpoint to the final block.
  const sentinel = mDecoder.decodeRequest({
    model: "wire-model",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ],
    cache_control: { type: "ephemeral" },
  });
  assert.equal(sentinel.ok, true);
  if (sentinel.ok) {
    assert.deepEqual(sentinel.value.requestWireOptions.promptCacheBreakpoints?.[0], {
      itemIndex: 0,
      partIndex: 1,
    });

    // Out of M, the sentinel re-anchors onto the item's reconstructed C part
    // (the two source text blocks merge into one Chat content part).
    const coordinator2 = createDefaultTranslationCoordinator();
    const mToC = coordinator2.translateRequest({ stream: false,
      sourceProtocol: "anthropic-messages",
      targetProtocol: "openai-chat",
      sourceBody: {
        model: "wire-model",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
        cache_control: { type: "ephemeral" },
      },
      logicalModel: "logical-key",
      targetModel: "upstream-target",
    });
    assert.equal(mToC.ok, true);
    if (mToC.ok) {
      // The marker forces array content form on the reconstructed part.
      const messages = mToC.value.body.messages as Array<{
        content: Array<{ prompt_cache_breakpoint?: unknown; text?: string }>;
      }>;
      const content = messages[0]?.content;
      assert.ok(Array.isArray(content));
      assert.equal(content.length, 1);
      assert.equal(content[0]?.text, "ab");
      assert.deepEqual(content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    }
  }
});

test.concurrent("row prompt-cache-breakpoint: assistant-anchored markers reject into R; C→M and M→C still re-anchor", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // C→R: a breakpoint anchored to an assistant message part cannot land on
  // the R wire (assistant items admit no marker-bearing part) — preflight
  // rejects with the row ID before dispatch.
  const cBody = {
    model: "wire-model",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "prev", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ],
  };
  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, false);
  if (!cToR.ok) assert.equal(cToR.error.capability, "prompt-cache-breakpoint");

  // M→R: a cache_control marker on an assistant block rejects identically.
  const mBody = {
    model: "wire-model",
    max_tokens: 64,
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "prev", cache_control: { type: "ephemeral" } }] },
    ],
  };
  const mToR = translateRequest(coordinator, "anthropic-messages", "openai-responses", mBody);
  assert.equal(mToR.ok, false);
  if (!mToR.ok) assert.equal(mToR.error.capability, "prompt-cache-breakpoint");

  // Positive controls: the same assistant-anchored requests still translate
  // fine when the target admits the marker (C→M block, M→C part).
  const cToM = translateRequest(coordinator, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const messages = cToM.value.body.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
    assert.deepEqual(messages[1]?.content[0]?.cache_control, { type: "ephemeral" });
  }

  const mToC = translateRequest(coordinator, "anthropic-messages", "openai-chat", mBody);
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    const messages = mToC.value.body.messages as Array<{
      content: string | Array<{ text?: string; prompt_cache_breakpoint?: unknown }>;
    }>;
    const content = messages[1]?.content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  }
});

test.concurrent("row request-metadata: C↔R direct kv; into-M subsets to user_id; out-of-M reconstructs the kv entry; legacy user is C/R-only", () => {
  const coordinator = createDefaultTranslationCoordinator();

  const cBody = {
    ...sourceBodyFor("openai-chat"),
    metadata: { user_id: "u1", session: "s1" },
    user: "legacy-user",
  };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    assert.deepEqual(cToR.value.body.metadata, { user_id: "u1", session: "s1" });
    assert.equal(cToR.value.body.user, "legacy-user");
  }

  // Into M only user_id survives; every other key and the legacy user are declared loss.
  const cToM = translateRequest(coordinator, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    assert.deepEqual(cToM.value.body.metadata, { user_id: "u1" });
    assert.equal("user" in cToM.value.body, false);
  }

  // Out of M, user_id becomes one kv entry.
  const mToC = translateRequest(coordinator, "anthropic-messages", "openai-chat", {
    ...sourceBodyFor("anthropic-messages"),
    metadata: { user_id: "u9" },
  });
  assert.equal(mToC.ok, true);
  if (mToC.ok) assert.deepEqual(mToC.value.body.metadata, { user_id: "u9" });

  // The C/R size/count subset rejects before dispatch.
  const tooMany = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.error.capability, undefined);

  // Non-string values fail structurally at decode.
  const decoder = new ChatIngressDecoder();
  const badValue = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), metadata: { a: 42 } });
  assert.equal(badValue.ok, false);

  // Explicit null is treated as absent: decode succeeds, the sidecar carries
  // no metadata, and nothing is emitted on the target wire.
  const nullDecoded = decoder.decodeRequest({ ...sourceBodyFor("openai-chat"), metadata: null });
  assert.equal(nullDecoded.ok, true);
  if (nullDecoded.ok) assert.equal(nullDecoded.value.requestWireOptions.metadata, undefined);

  for (const [source, target] of [
    ["openai-chat", "openai-responses"],
    ["openai-responses", "openai-chat"],
  ] as const) {
    const res = translateRequest(coordinator, source, target, {
      ...sourceBodyFor(source),
      metadata: null,
    });
    assert.equal(res.ok, true, `${source} metadata:null`);
    if (res.ok) assert.equal("metadata" in res.value.body, false);
  }
});

test.concurrent("rows safety-identifier / moderation param: C↔R direct; M directions reject", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const chatBody = {
    ...sourceBodyFor("openai-chat"),
    safety_identifier: "sid-1",
    moderation: { model: "omni-moderation-latest" },
  };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", chatBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    assert.equal(cToR.value.body.safety_identifier, "sid-1");
    assert.deepEqual(cToR.value.body.moderation, { model: "omni-moderation-latest" });
  }

  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    safety_identifier: "sid-2",
    moderation: null,
  });
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    assert.equal(rToC.value.body.safety_identifier, "sid-2");
    assert.equal(rToC.value.body.moderation, null);
  }

  for (const source of ["openai-chat", "openai-responses"] as const) {
    for (const [extra, capability] of [
      [{ safety_identifier: "sid" }, "safety-identifier"],
      [{ moderation: { model: "m" } }, "moderation-policy-result"],
    ] as const) {
      const res = translateRequest(coordinator, source, "anthropic-messages", {
        ...sourceBodyFor(source),
        ...extra,
      });
      assert.equal(res.ok, false, `${capability} from ${source}`);
      if (!res.ok) assert.equal(res.error.capability, capability);
    }
  }
});

test.concurrent("row service-tier: C↔R six-value passthrough; into/out of M only auto maps; response echo declared loss out of M", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // C↔R direct for every enum value, both ways.
  for (const tier of ["default", "flex", "scale", "priority", "fast", "auto"] as const) {
    const cToRTier = translateRequest(coordinator, "openai-chat", "openai-responses", {
      ...sourceBodyFor("openai-chat"),
      service_tier: tier,
    });
    assert.equal(cToRTier.ok, true, tier);
    if (cToRTier.ok) assert.equal(cToRTier.value.body.service_tier, tier);

    const rToCTier = translateRequest(coordinator, "openai-responses", "openai-chat", {
      ...sourceBodyFor("openai-responses"),
      service_tier: tier,
    });
    assert.equal(rToCTier.ok, true, tier);
    if (rToCTier.ok) assert.equal(rToCTier.value.body.service_tier, tier);
  }

  // Into M: auto maps, everything else rejects.
  const autoIntoM = translateRequest(coordinator, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    service_tier: "auto",
  });
  assert.equal(autoIntoM.ok, true);
  if (autoIntoM.ok) assert.equal((autoIntoM.value.body as { service_tier?: string }).service_tier, "auto");

  const flexIntoM = translateRequest(coordinator, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    service_tier: "flex",
  });
  assert.equal(flexIntoM.ok, false);
  if (!flexIntoM.ok) assert.equal(flexIntoM.error.capability, "service-tier");

  // standard_only is M-only wire vocabulary: it is not in the C/R six-value
  // enum, so a C/R source carrying it fails invalid_request at decode and
  // never reaches the service-tier preflight. (The plan's standard_only
  // rejection is the out-of-M direction, covered below.)
  const stdIntoM = translateRequest(coordinator, "openai-responses", "anthropic-messages", {
    ...sourceBodyFor("openai-responses"),
    service_tier: "standard_only",
  });
  assert.equal(stdIntoM.ok, false);
  if (!stdIntoM.ok) assert.equal(stdIntoM.error.capability, undefined);

  // Out of M: standard_only rejects.
  const stdOutOfM = translateRequest(coordinator, "anthropic-messages", "openai-chat", {
    ...sourceBodyFor("anthropic-messages"),
    service_tier: "standard_only",
  });
  assert.equal(stdOutOfM.ok, false);
  if (!stdOutOfM.ok) assert.equal(stdOutOfM.error.capability, "service-tier");

  // Out of M the rejection holds for every target protocol, not only Chat.
  const stdOutOfMToR = translateRequest(coordinator, "anthropic-messages", "openai-responses", {
    ...sourceBodyFor("anthropic-messages"),
    service_tier: "standard_only",
  });
  assert.equal(stdOutOfMToR.ok, false);
  if (!stdOutOfMToR.ok) assert.equal(stdOutOfMToR.error.capability, "service-tier");

  // Explicit null from a C/R client is absence into M (preflight passes and
  // the M target emits no service_tier) but round-trips verbatim on C↔R.
  for (const source of ["openai-chat", "openai-responses"] as const) {
    const intoM = translateRequest(coordinator, source, "anthropic-messages", {
      ...sourceBodyFor(source),
      service_tier: null,
    });
    assert.equal(intoM.ok, true, `${source} service_tier:null into M`);
    if (intoM.ok) assert.equal("service_tier" in intoM.value.body, false);
  }
  const cToRNull = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    service_tier: null,
  });
  assert.equal(cToRNull.ok, true);
  if (cToRNull.ok) assert.equal(cToRNull.value.body.service_tier, null);
  const rToCNull = translateRequest(coordinator, "openai-responses", "openai-chat", {
    ...sourceBodyFor("openai-responses"),
    service_tier: null,
  });
  assert.equal(rToCNull.ok, true);
  if (rToCNull.ok) assert.equal(rToCNull.value.body.service_tier, null);

  // Response echo: C→R passes through.
  const chatDecoder = new ChatIngressDecoder();
  const cOutcome = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl-t",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      service_tier: "scale",
    },
  );
  assert.equal(cOutcome.ok, true);
  if (cOutcome.ok) {
    assert.equal(cOutcome.value.outcomeWireOptions.serviceTier, "scale");
    const rEcho = new ResponsesEgressEncoder().encodeOutcome(
      cOutcome.value.irOutcome,
      cOutcome.value.outcomeWireOptions,
    ).body as { service_tier?: string };
    assert.equal(rEcho.service_tier, "scale");
  }

  // Out-of-M echo (standard|priority|batch) is declared loss: the
  // direction-aware coordinator strips the M echo before the client encoder
  // runs, so even the ambiguous `priority` literal never reaches C/R wire.
  const coordinator2 = createDefaultTranslationCoordinator();
  const mEcho = coordinator2.translateCompleteOutcome({
    // Outcome translation: source = client protocol, target = provider protocol.
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: {},
    body: {
      id: "msg_t",
      type: "message",
      role: "assistant",
      model: "upstream-target",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, service_tier: "priority" },
    },
    logicalModel: "logical-key",
  });
  assert.equal(mEcho.ok, true);
  if (mEcho.ok) {
    assert.equal((mEcho.value.body as { service_tier?: string }).service_tier, undefined);
  }
});

test.concurrent("row moderation-policy-result (response): deterministic wrapper re-wrap preserves the input/output split both ways", () => {
  const verdict = {
    categories: { hate: true },
    category_scores: { hate: 0.9 },
    category_applied_input_types: { hate: ["text"] },
    flagged: true,
    model: "omni-moderation-latest",
    type: "moderation_result",
  };

  // R provider (singular verdicts) → C client (wrapped verdicts).
  const responsesDecoder = new ResponsesIngressDecoder();
  const rOutcome = responsesDecoder.decodeOutcome(
    200,
    {},
    {
      id: "resp_m",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [],
      moderation: { input: verdict, output: verdict },
    },
  );
  assert.equal(rOutcome.ok, true);
  if (rOutcome.ok) {
    assert.deepEqual(rOutcome.value.outcomeWireOptions.moderation, { input: verdict, output: verdict });
    const cBody = new ChatEgressEncoder().encodeOutcome(rOutcome.value.irOutcome, rOutcome.value.outcomeWireOptions)
      .body as { moderation: { input: { type: string; results: unknown[] }; output: unknown } };
    assert.deepEqual(cBody.moderation.input.results, [verdict]);
    assert.notEqual(cBody.moderation.output, undefined);
  }

  // C provider (wrapped verdicts) → R client (singular verdicts).
  const chatDecoder = new ChatIngressDecoder();
  const cOutcome = chatDecoder.decodeOutcome(
    200,
    {},
    {
      id: "chatcmpl-m",
      object: "chat.completion",
      created: 1,
      model: "upstream-target",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      moderation: {
        input: { type: "moderation_results", model: "omni-moderation-latest", results: [verdict] },
        output: { type: "error", code: "x", message: "boom" },
      },
    },
  );
  assert.equal(cOutcome.ok, true);
  if (cOutcome.ok) {
    // Normal form unwraps the wrapper but keeps error variants untouched.
    assert.deepEqual((cOutcome.value.outcomeWireOptions.moderation as JsonObject).input, verdict);
    assert.deepEqual((cOutcome.value.outcomeWireOptions.moderation as JsonObject).output, {
      type: "error",
      code: "x",
      message: "boom",
    });
    const rBody = new ResponsesEgressEncoder().encodeOutcome(
      cOutcome.value.irOutcome,
      cOutcome.value.outcomeWireOptions,
    ).body as { moderation: { input: unknown; output: unknown } };
    assert.deepEqual(rBody.moderation.input, verdict);
    assert.deepEqual(rBody.moderation.output, { type: "error", code: "x", message: "boom" });
  }

  // A moderation result discovered for an M client fails closed in outcome preflight.
  const mPreflight = preflightOutcome(
    { ...irBase(), responseId: "r", finish: { reason: "stop" }, parts: [] } as unknown as IrOutcome,
    "anthropic-messages->openai-responses",
    { moderation: { input: verdict, output: verdict } },
  );
  assert.equal(mPreflight.ok, false);
  if (!mPreflight.ok) assert.equal(mPreflight.error.capability, "moderation-policy-result");
});

test.concurrent("row moderation-policy-result (response): non-admitted wrapper/result shapes fail closed", () => {
  const verdict = { flagged: true, model: "omni-moderation-latest", type: "moderation_result" };
  const chatBody = {
    id: "chatcmpl-mv",
    object: "chat.completion",
    created: 1,
    model: "upstream-target",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };

  // A multi-verdict wrapper is never silently truncated to its first entry.
  const multiVerdict = new ChatIngressDecoder().decodeOutcome(
    200,
    {},
    {
      ...chatBody,
      moderation: {
        input: { type: "moderation_results", model: "omni-moderation-latest", results: [verdict, verdict] },
        output: verdict,
      },
    },
  );
  assert.equal(multiVerdict.ok, false);
  if (!multiVerdict.ok)
    assert.match(multiVerdict.error.message, /moderation_results wrapper must carry exactly one verdict/);

  // An empty results wrapper never leaks through to a client.
  const emptyWrapper = new ChatIngressDecoder().decodeOutcome(
    200,
    {},
    {
      ...chatBody,
      moderation: {
        input: { type: "moderation_results", model: "omni-moderation-latest", results: [] },
        output: verdict,
      },
    },
  );
  assert.equal(emptyWrapper.ok, false);
  if (!emptyWrapper.ok)
    assert.match(emptyWrapper.error.message, /moderation_results wrapper must carry exactly one verdict/);

  // Unrecognized top-level keys on the result object fail closed instead of vanishing.
  const extraKey = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "resp_x",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [],
      moderation: { input: verdict, output: verdict, policy_version: "v2" },
    },
  );
  assert.equal(extraKey.ok, false);
  if (!extraKey.ok) assert.match(extraKey.error.message, /moderation result supports only 'input' and 'output' fields/);

  // A model-less verdict re-wraps for Chat preserving absence: no fabricated "" model.
  const modelLess = { flagged: true, type: "moderation_result" };
  const rOutcome = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    {
      id: "resp_ml",
      object: "response",
      status: "completed",
      model: "upstream-target",
      output: [],
      moderation: { input: modelLess, output: modelLess },
    },
  );
  assert.equal(rOutcome.ok, true);
  if (rOutcome.ok) {
    const cBody = new ChatEgressEncoder().encodeOutcome(rOutcome.value.irOutcome, rOutcome.value.outcomeWireOptions)
      .body as { moderation: { input: Record<string, unknown> } };
    assert.equal(Object.hasOwn(cBody.moderation.input, "model"), false);
    assert.deepEqual(cBody.moderation.input.results, [modelLess]);
  }
});

test.concurrent("M usage.service_tier echo capture: decodeOutcome surfaces OutcomeWireOptions.serviceTier verbatim", () => {
  const decoded = new MessagesIngressDecoder().decodeOutcome(200, {}, {
    id: "msg_tier",
    type: "message",
    role: "assistant",
    model: "upstream-target",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, service_tier: "standard" },
  } as JsonObject);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(decoded.value.outcomeWireOptions.serviceTier, "standard");
});

test.concurrent("row prompt-cache-breakpoint (multi-anchor): markers on non-leading messages re-anchor to the exact reconstructed entries", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // Three Chat messages with breakpoints on the first and third; the second
  // carries none. Regression: the emitted-index arithmetic must consume exactly
  // one slot per emitted message, so the third marker cannot drift or drop.
  const cBody = {
    model: "wire-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "one", prompt_cache_breakpoint: { mode: "explicit" } }] },
      { role: "assistant", content: "two" },
      { role: "user", content: [{ type: "text", text: "three", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ],
  };

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{
      content: Array<{ text?: string; prompt_cache_breakpoint?: unknown }>;
    }>;
    assert.deepEqual(input[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(input[0]?.content[0]?.text, "one");
    assert.equal(input[1]?.content[0]?.prompt_cache_breakpoint, undefined);
    assert.equal(input[1]?.content[0]?.text, "two");
    assert.deepEqual(input[2]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(input[2]?.content[0]?.text, "three");
  }

  // R source with markers on the first and third input items → C target.
  // (Assistant items admit no markers: output_text parts reject them at
  // decode, so the middle assistant item stays unmarked.)
  const rBody = {
    model: "wire-model",
    input: [
      { role: "user", content: [{ type: "input_text", text: "one", prompt_cache_breakpoint: { mode: "explicit" } }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "two" }],
      },
      { role: "user", content: [{ type: "input_text", text: "three", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ],
  };
  const rToC = translateRequest(coordinator, "openai-responses", "openai-chat", rBody);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const messages = rToC.value.body.messages as Array<{
      content: string | Array<{ text?: string; prompt_cache_breakpoint?: unknown }>;
    }>;
    const first = messages[0]?.content;
    assert.ok(Array.isArray(first));
    assert.deepEqual(first[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(first[0]?.text, "one");
    // The marker-less assistant message keeps the plain string content form.
    assert.equal(messages[1]?.content, "two");
    const third = messages[2]?.content;
    assert.ok(Array.isArray(third));
    assert.deepEqual(third[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(third[0]?.text, "three");
  }

  // Into M: the u/a/u transcript never merges turns, and each marker lands on
  // its own message's content block.
  const cToM = translateRequest(coordinator, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const messages = cToM.value.body.messages as Array<{ content: Array<{ text?: string; cache_control?: unknown }> }>;
    assert.deepEqual(messages[0]?.content[0]?.cache_control, { type: "ephemeral" });
    assert.equal(messages[1]?.content[0]?.cache_control, undefined);
    assert.deepEqual(messages[2]?.content[0]?.cache_control, { type: "ephemeral" });
  }

  // Stream encoders share the identical re-anchoring arithmetic.
  const streamDecoded = new ChatStreamRequestDecoder().decodeRequest({ ...cBody, stream: true });
  assert.equal(streamDecoded.ok, true);
  if (streamDecoded.ok) {
    const encoded = new ChatStreamRequestEncoder().encodeRequest(
      streamDecoded.value.irRequest,
      "t",
      {},
      streamDecoded.value.requestWireOptions,
    ) as { messages: Array<{ content: Array<{ text?: string; prompt_cache_breakpoint?: unknown }> }> };
    assert.deepEqual(encoded.messages[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(encoded.messages[1]?.content, "two");
    assert.deepEqual(encoded.messages[2]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  }

  const responsesStreamDecoded = new ResponsesStreamRequestDecoder().decodeRequest({ ...rBody, stream: true });
  assert.equal(responsesStreamDecoded.ok, true);
  if (responsesStreamDecoded.ok) {
    const encoded = new ResponsesStreamRequestEncoder().encodeRequest(
      responsesStreamDecoded.value.irRequest,
      "t",
      {},
      responsesStreamDecoded.value.requestWireOptions,
    ) as { input: Array<{ content: Array<{ text?: string; prompt_cache_breakpoint?: unknown }> }> };
    assert.deepEqual(encoded.input[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(encoded.input[1]?.content[0]?.prompt_cache_breakpoint, undefined);
    assert.deepEqual(encoded.input[2]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  }
});

// =====================================================================
// Stream sidecar fail-closed channel (TranslatedStreamPump.applyOutcomeWireOptions)
// =====================================================================

const UTF8_ENCODER = new TextEncoder();

/** Builds a pump over a coordinator stream session; records every client byte emitted before a failure. */
function createSidecarPump(source: Protocol, target: Protocol, responseId: string) {
  const bundle = createSessionBundle({
    sourceProtocol: source,
    targetProtocol: target,
    logicalModel: "logical-key",
    responseId,
  });
  const emitted: Uint8Array[] = [];
  const pump = new TranslatedStreamPump(
    createSseDecoder(),
    createSseEncoder(),
    bundle.providerDecoder,
    createIrStreamStateMachine({
      expectedResponseId: bundle.session.responseId,
      expectedModel: bundle.session.model,
    }),
    bundle.clientEncoder,
    () => {},
  );
  return { pump, emitted };
}

function joinEmitted(emitted: ReadonlyArray<Uint8Array>): string {
  return Buffer.concat(emitted.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

test.concurrent("stream sidecar: Chat provider terminal moderation frame fail-closes into an M client with no success terminator", () => {
  const { pump, emitted } = createSidecarPump("anthropic-messages", "openai-chat", "resp_mod_c");

  // Plain lifecycle frames; the terminal usage chunk carries the moderation result.
  const start = pump.pushBytes(
    UTF8_ENCODER.encode(
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    ),
  );
  assert.equal(start.ok, true);
  if (start.ok) emitted.push(...start.value);
  const finish = pump.pushBytes(
    UTF8_ENCODER.encode(
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    ),
  );
  assert.equal(finish.ok, true);
  if (finish.ok) emitted.push(...finish.value);
  const usage = pump.pushBytes(
    UTF8_ENCODER.encode(
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2},"moderation":{"input":{"flagged":true},"output":{"flagged":false}}}\n\n',
    ),
  );
  assert.equal(usage.ok, true);
  if (usage.ok) emitted.push(...usage.value);

  const done = pump.pushBytes(UTF8_ENCODER.encode("data: [DONE]\n\n"));
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.error.capability, "moderation-policy-result");

  // No success terminator was ever emitted to the M client.
  const wire = joinEmitted(emitted);
  assert.equal(wire.includes("message_delta"), false);
  assert.equal(wire.includes("message_stop"), false);
  assert.equal(wire.includes("[DONE]"), false);
});

test.concurrent("stream sidecar: Responses response.completed moderation fail-closes into an M client (R→M re-wrap rejection)", () => {
  const { pump, emitted } = createSidecarPump("anthropic-messages", "openai-responses", "resp_mod_r");

  const created = pump.pushBytes(
    UTF8_ENCODER.encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_mod_r"},"sequence_number":1}\n\n',
    ),
  );
  assert.equal(created.ok, true);
  if (created.ok) emitted.push(...created.value);

  const completed = pump.pushBytes(
    UTF8_ENCODER.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_mod_r",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
          moderation: { input: { flagged: true }, output: { flagged: false } },
        },
        sequence_number: 2,
      })}\n\n`,
    ),
  );
  assert.equal(completed.ok, false);
  if (!completed.ok) assert.equal(completed.error.capability, "moderation-policy-result");

  // No success terminator was ever emitted to the M client.
  const wire = joinEmitted(emitted);
  assert.equal(wire.includes("message_delta"), false);
  assert.equal(wire.includes("message_stop"), false);
});

test.concurrent("stream sidecar: Responses terminal moderation re-wraps into Chat client verdict wrappers with tier passthrough", () => {
  const { pump, emitted } = createSidecarPump("openai-chat", "openai-responses", "resp_mod_pos");
  const verdict = {
    categories: { hate: true },
    category_scores: { hate: 0.9 },
    category_applied_input_types: { hate: ["text"] },
    flagged: true,
    model: "omni-moderation-latest",
    type: "moderation_result",
  };

  const created = pump.pushBytes(
    UTF8_ENCODER.encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_mod_pos"},"sequence_number":1}\n\n',
    ),
  );
  assert.equal(created.ok, true);
  if (created.ok) emitted.push(...created.value);

  const completed = pump.pushBytes(
    UTF8_ENCODER.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_mod_pos",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
          moderation: { input: verdict, output: verdict },
          service_tier: "scale",
        },
        sequence_number: 2,
      })}\n\n`,
    ),
  );
  assert.equal(completed.ok, true);
  if (completed.ok) emitted.push(...completed.value);

  // The success terminator went out, carrying the re-wrapped verdicts.
  const wire = joinEmitted(emitted);
  assert.equal(wire.includes("[DONE]"), true);
  const terminalFrame = wire
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes("moderation"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
    .at(-1);
  assert.ok(terminalFrame !== undefined);
  const moderation = terminalFrame.moderation as {
    input: { type: string; model: string; results: unknown[] };
    output: { type: string; results: unknown[] };
  };
  assert.equal(moderation.input.type, "moderation_results");
  assert.equal(moderation.input.model, "omni-moderation-latest");
  assert.deepEqual(moderation.input.results, [verdict]);
  assert.equal(moderation.output.type, "moderation_results");
  assert.deepEqual(moderation.output.results, [verdict]);
  assert.equal(terminalFrame.service_tier, "scale");
});

test.concurrent("request-metadata size subset: keys over 64 chars and values over 512 chars reject before dispatch", () => {
  const coordinator = createDefaultTranslationCoordinator();

  const longKey = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    metadata: { ["k".repeat(65)]: "v" },
  });
  assert.equal(longKey.ok, false);
  if (!longKey.ok) assert.equal(longKey.error.capability, undefined);

  const longValue = translateRequest(coordinator, "openai-responses", "openai-chat", {
    ...sourceBodyFor("openai-responses"),
    metadata: { user_id: "v".repeat(513) },
  });
  assert.equal(longValue.ok, false);
  if (!longValue.ok) assert.equal(longValue.error.capability, undefined);

  // The boundary values themselves are admitted.
  const boundary = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    metadata: { ["k".repeat(64)]: "v".repeat(512) },
  });
  assert.equal(boundary.ok, true);
});

test.concurrent("row prompt-cache-breakpoint R<->M: R part markers become M blocks; M blocks re-anchor onto R parts", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // R part marker -> M system block marker (TTL dropped).
  const rToM = translateRequest(coordinator, "openai-responses", "anthropic-messages", {
    model: "wire-model",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: "rules", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
      "Hello!",
    ],
  });
  assert.equal(rToM.ok, true);
  if (rToM.ok) {
    const system = rToM.value.body.system as Array<{ cache_control?: unknown }>;
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  }

  // M block marker (with TTL) -> R input part marker; TTL is declared loss.
  const mToR = translateRequest(coordinator, "anthropic-messages", "openai-responses", {
    model: "wire-model",
    max_tokens: 64,
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(mToR.ok, true);
  if (mToR.ok) {
    const input = mToR.value.body.input as Array<{ content: Array<{ prompt_cache_breakpoint?: unknown }> }>;
    assert.deepEqual(input[0]?.content[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  }
});

test.concurrent("request-metadata size subset boundary: exactly 16 entries passes before dispatch", () => {
  const coordinator = createDefaultTranslationCoordinator();
  const res = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    metadata: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])),
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(Object.keys(res.value.body.metadata as Record<string, unknown>).length, 16);
  }
});

test.concurrent("request-metadata capture is prototype-safe: a client '__proto__' key survives capture and egress projection", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // A literal wire payload parses "__proto__" as an ordinary own key; build the
  // shape the same way so the pin reflects real wire input rather than
  // object-literal prototype-setter quirks.
  const wireMetadata = JSON.parse('{"__proto__":"x","user_id":"u"}') as JsonObject;

  const decoded = new ChatIngressDecoder().decodeRequest({ ...sourceBodyFor("openai-chat"), metadata: wireMetadata });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const captured = decoded.value.requestWireOptions.metadata;
    assert.ok(captured !== undefined);
    assert.equal(Object.entries(captured).length, 2);
  }

  const cToR = translateRequest(coordinator, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    metadata: wireMetadata,
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    // JSON round-trip: stringify serializes own keys, so the "__proto__" entry
    // must appear in the provider body instead of vanishing into the prototype.
    const projected = JSON.parse(JSON.stringify(cToR.value.body.metadata)) as JsonObject;
    assert.deepEqual(projected, { ["__proto__"]: "x", user_id: "u" });
    const metadataRecord = cToR.value.body.metadata as Record<string, unknown>;
    assert.equal(Object.hasOwn(metadataRecord, "__proto__"), true);
  }
});

test.concurrent("stream request sidecar: wire-only rows reject on M directions and project onto C→R stream bodies", () => {
  const coordinator = createDefaultTranslationCoordinator();

  // T3(a): responses-storage is C↔R-only — a C→M stream body carrying store rejects
  // in the coordinator's stream preflight before any dispatch.
  const storeToM = coordinator.translateRequest({ stream: true,
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    sourceBody: { ...sourceBodyFor("openai-chat"), stream: true, store: true },
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: 2048,
  });
  assert.equal(storeToM.ok, false);
  if (!storeToM.ok) assert.equal(storeToM.error.capability, "responses-storage");

  // T3(b): admitted sidecar rows project onto the encoded stream provider body.
  const cToRStream = coordinator.translateRequest({ stream: true,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: {
      ...sourceBodyFor("openai-chat"),
      stream: true,
      prompt_cache_key: "ck-stream",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      metadata: { user_id: "u-stream" },
      safety_identifier: "sid-stream",
    },
    logicalModel: "logical-key",
    targetModel: "upstream-target",
  });
  assert.equal(cToRStream.ok, true);
  if (cToRStream.ok) {
    assert.equal(cToRStream.value.body.prompt_cache_key, "ck-stream");
    assert.deepEqual(cToRStream.value.body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
    assert.deepEqual(cToRStream.value.body.metadata, { user_id: "u-stream" });
    assert.equal(cToRStream.value.body.safety_identifier, "sid-stream");
  }
});
