/**
 * Owned client tool loop rows: admitted function/custom loops,
 * T3 hosted/provider rejections, legacy/finish/usage, and prompt-cache
 * cross-row extensions.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { Protocol } from "../../src/domain/contracts.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import {
  MESSAGES_HOSTED_BLOCK_TYPES,
  MESSAGES_HOSTED_TOOL_TYPES,
  MESSAGES_SERVER_TOOL_USE_NAMES,
  RESPONSES_HOSTED_OUTPUT_ITEMS,
  RESPONSES_HOSTED_TOOL_TYPES,
} from "../../src/translation/codecs/shared/hosted-tools.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import { preflightOutcome, preflightRequest, preflightStreamRequest } from "../../src/translation/preflight.ts";
import { createSseDecoder, createSseEncoder } from "../../src/translation/sse.ts";
import { TranslatedStreamPump } from "../../src/translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../../src/translation/stream-state.ts";
import { validateIrRequest } from "../../src/translation/validate.ts";
import { ALL_DIRECTIONS, createSessionBundle, translateRequest } from "./owned-rows-helpers.ts";

// =====================================================================
// Helpers
// =====================================================================

function coordinator() {
  return createDefaultTranslationCoordinator();
}

const UTF8_ENCODER = new TextEncoder();

function createToolStreamPump(client: Protocol, provider: Protocol, responseId: string) {
  const bundle = createSessionBundle({
    sourceProtocol: client,
    targetProtocol: provider,
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

function joinStreamEmitted(emitted: ReadonlyArray<Uint8Array>): string {
  return Buffer.concat(emitted.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function assertOk(
  res: { ok: boolean; value?: unknown; error?: { capability?: string; category?: string; message?: string } },
  label: string,
) {
  assert.equal(res.ok, true, `${label}: expected ok, got ${JSON.stringify(res.error)}`);
}

function assertFailsWith(
  res: { ok: boolean; error?: { capability?: string; category?: string; message?: string } },
  capability: string | undefined,
  category: string,
  label: string,
) {
  assert.equal(res.ok, false, `${label}: expected failure`);
  if (res.ok === false) {
    const err = res.error as { capability?: string; category?: string } | undefined;
    assert.equal(err?.category, category, `${label}: category`);
    assert.equal(err?.capability, capability, `${label}: capability`);
  }
}

function assertUnsupported(
  res: { ok: boolean; error?: { capability?: string; category?: string } },
  capability: string,
  label: string,
) {
  assertFailsWith(res, capability, "unsupported_capability", label);
}

const FUNC_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
} as const;

const STRICT_CONFORMING = {
  type: "object",
  properties: {},
  additionalProperties: false,
  required: [],
} as unknown as Record<string, unknown>;

const M_EXACT_SHAPE = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as unknown as Record<string, unknown>;

function chatToolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "wire-model",
    messages: [{ role: "user", content: "What's the weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { ...FUNC_SCHEMA },
        },
      },
    ],
    ...overrides,
  };
}

function responsesToolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "wire-model",
    input: "What's the weather?",
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { ...FUNC_SCHEMA },
        strict: false,
      },
    ],
    ...overrides,
  };
}

function messagesToolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "What's the weather?" }] }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { ...FUNC_SCHEMA },
      },
    ],
    ...overrides,
  };
}

// =====================================================================
// Admitted function loop
// =====================================================================

test.concurrent("row function-tool-definition: six-direction round trip plus decode rejections", () => {
  const c = coordinator();
  // Six directions admit translation
  for (const [src, dst] of ALL_DIRECTIONS) {
    let body: Record<string, unknown>;
    if (src === "openai-chat") body = chatToolBody();
    else if (src === "openai-responses") body = responsesToolBody();
    else body = messagesToolBody();
    const res = translateRequest(c, src, dst, body as never);
    assertOk(res, `${src}->${dst} function-tool-definition`);
    if (res.ok) {
      // Target body carries tools in correct wire shape
      if (dst === "openai-chat") {
        const tools = (res.value.body as Record<string, unknown>).tools as unknown[];
        assert.ok(Array.isArray(tools) && tools.length === 1, `${src}->${dst} chat tools`);
        const entry = tools[0] as Record<string, unknown>;
        assert.equal(entry.type, "function");
        assert.ok((entry.function as Record<string, unknown>).name === "get_weather");
      } else if (dst === "openai-responses") {
        const tools = (res.value.body as Record<string, unknown>).tools as unknown[];
        const entry = tools[0] as Record<string, unknown>;
        assert.equal(entry.type, "function");
        assert.equal(entry.name, "get_weather");
        assert.equal(entry.strict, false);
      } else {
        const tools = (res.value.body as Record<string, unknown>).tools as unknown[];
        const entry = tools[0] as Record<string, unknown>;
        assert.equal(entry.name, "get_weather");
        const schema = entry.input_schema as Record<string, unknown>;
        assert.equal(schema.type, "object");
      }
    }
  }
  // C tool without parameters rejects function-tool-definition at decode
  const cNoParams = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "get_weather" } }],
  };
  const noParamsRes = translateRequest(coordinator(), "openai-chat", "openai-responses", cNoParams as never);
  assertUnsupported(noParamsRes as never, "function-tool-definition", "C tool without parameters");

  // Non-object root into M rejects at preflight via function-tool-definition
  const cArraySchema = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "array", items: { type: "string" } },
        },
      },
    ],
  };
  const arrayRes = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cArraySchema as never);
  assertUnsupported(arrayRes as never, "function-tool-definition", "non-object root into M");

  // R function tools are wire-required: missing/non-object parameters and
  // missing/non-boolean strict are malformed R wire, never fabricated.
  const rNoParams = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "function", name: "get_weather", strict: false }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-responses", "openai-chat", rNoParams as never) as never,
    undefined,
    "invalid_request",
    "R tool missing parameters",
  );
  const rNoStrict = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA } }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-responses", "openai-chat", rNoStrict as never) as never,
    undefined,
    "invalid_request",
    "R tool missing strict",
  );
});

test.concurrent("row function-schema-strictness: strict dialect subsets", () => {
  // Strict C->R pass with conforming schema
  const strictChat = chatToolBody({
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { ...STRICT_CONFORMING },
          strict: true,
        },
      },
    ],
  });
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", strictChat as never);
  assertOk(cToR, "strict C->R conforming");

  // Strict R->C pass
  const strictResp = responsesToolBody({
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { ...STRICT_CONFORMING },
        strict: true,
      },
    ],
  });
  const rToC = translateRequest(coordinator(), "openai-responses", "openai-chat", strictResp as never);
  assertOk(rToC, "strict R->C conforming");

  // Strict into M passes exact documented shape
  const strictForM = chatToolBody({
    tools: [
      {
        type: "function",
        function: { name: "get_weather", parameters: { ...M_EXACT_SHAPE }, strict: true },
      },
    ],
  });
  const cToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", strictForM as never);
  assertOk(cToM, "strict C->M exact shape");

  // Strict into M rejects extra root keyword
  const extraRoot = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { ...M_EXACT_SHAPE, additionalProperties: false },
          strict: true,
        },
      },
    ],
  };
  const extraRes = translateRequest(coordinator(), "openai-chat", "anthropic-messages", extraRoot as never);
  assertUnsupported(extraRes as never, "function-schema-strictness", "extra root keyword");

  // M-origin strict into C with non-subset (missing additionalProperties) rejects
  // Add strict flag via IR? M decoder parses strict field; send strict:true in tools
  const mStrictBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "get_weather", input_schema: { ...M_EXACT_SHAPE }, strict: true }],
  };
  const mToC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mStrictBody as never);
  assertUnsupported(mToC as never, "function-schema-strictness", "M strict non-subset into C");

  // The strict walk must reject constructs it cannot verify, never silently
  // pass them (strict: true is a guarantee and must not weaken at the
  // provider): nested combinators, tuple items, boolean schemas, malformed
  // bag values, and any non-false additionalProperties spelling.
  const escapeHatches: Record<string, Record<string, unknown>> = {
    "nested allOf": { ...STRICT_CONFORMING, properties: { x: { allOf: [{ type: "string" }] } } },
    "nested anyOf": { ...STRICT_CONFORMING, properties: { x: { anyOf: [{ type: "string" }] } } },
    "nested not": { ...STRICT_CONFORMING, properties: { x: { type: "string", not: { type: "number" } } } },
    const: { ...STRICT_CONFORMING, properties: { x: { const: 5 } } },
    "tuple items": { ...STRICT_CONFORMING, properties: { x: { type: "array", items: [{ type: "string" }] } } },
    "boolean schema in properties": { ...STRICT_CONFORMING, properties: { x: true } },
    "non-object properties": { type: "object", properties: 5, required: [], additionalProperties: false },
    "object additionalProperties": {
      ...STRICT_CONFORMING,
      properties: { x: { type: "string" } },
      additionalProperties: { type: "string" },
    },
    patternProperties: { ...STRICT_CONFORMING, patternProperties: {} },
  };
  for (const [label, schema] of Object.entries(escapeHatches)) {
    const body = chatToolBody({
      tools: [{ type: "function", function: { name: "get_weather", parameters: schema, strict: true } }],
    });
    const res = translateRequest(coordinator(), "openai-chat", "openai-responses", body as never);
    assertUnsupported(res as never, "function-schema-strictness", `strict escape hatch: ${label}`);
  }

  // M strict mode also rejects a malformed required value.
  const mBadRequired = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "get_weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: "city" },
        strict: true,
      },
    ],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", mBadRequired as never) as never,
    "function-schema-strictness",
    "M strict malformed required",
  );

  // M strict mode rejects a malformed required even when properties is absent
  // (the root keyword set stays within {type, properties, required}).
  const mBadRequiredNoProps = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "get_weather", input_schema: { type: "object", required: "city" }, strict: true }],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", mBadRequiredNoProps as never) as never,
    "function-schema-strictness",
    "M strict malformed required without properties",
  );

  // The OpenAI strict walk rejects a present-but-non-array enum instead of
  // silently passing it unvalidated (symmetric with its malformed-required
  // rejection).
  const badEnum = chatToolBody({
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { ...STRICT_CONFORMING, properties: { x: { type: "string", enum: "red" } } },
          strict: true,
        },
      },
    ],
  });
  assertUnsupported(
    translateRequest(coordinator(), "openai-chat", "openai-responses", badEnum as never) as never,
    "function-schema-strictness",
    "strict malformed enum",
  );
});

test.concurrent("row tool-choice-none-auto-required: none/auto/required mappings", () => {
  // M any -> C/R required (via coordinator)
  const mAny = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
    tool_choice: { type: "any" as const },
  };
  const mAnyToC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mAny as never);
  assertOk(mAnyToC, "M any -> C");
  if (mAnyToC.ok) {
    assert.equal((mAnyToC.value.body as Record<string, unknown>).tool_choice, "required");
  }
  const mAnyToR = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mAny as never);
  assertOk(mAnyToR, "M any -> R");
  if (mAnyToR.ok) {
    // M any maps to required in both C and R (shared OpenAI string)
    assert.equal((mAnyToR.value.body as Record<string, unknown>).tool_choice, "required");
  }

  // C required -> M any
  const cReq = chatToolBody({ tool_choice: "required" as const });
  const cReqToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cReq as never);
  assertOk(cReqToM, "C required -> M");
  if (cReqToM.ok) {
    const tc = (cReqToM.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "any");
  }

  // none and auto passthrough
  const cNone = chatToolBody({ tool_choice: "none" as const });
  const cNoneToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cNone as never);
  assertOk(cNoneToR, "C none -> R");
  if (cNoneToR.ok) assert.equal((cNoneToR.value.body as Record<string, unknown>).tool_choice, "none");

  const cAuto = chatToolBody({ tool_choice: "auto" as const });
  const cAutoToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cAuto as never);
  assertOk(cAutoToM, "C auto -> M");
  if (cAutoToM.ok) {
    const tc = (cAutoToM.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "auto");
  }
});

test.concurrent("row tool-choice-named: six directions named choice", () => {
  for (const [src, dst] of ALL_DIRECTIONS) {
    const body =
      src === "openai-chat"
        ? chatToolBody({ tool_choice: { type: "function", function: { name: "get_weather" } } })
        : src === "openai-responses"
          ? responsesToolBody({ tool_choice: { type: "function", name: "get_weather" } })
          : {
              model: "wire-model",
              max_tokens: 1024,
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
              tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
              tool_choice: { type: "tool", name: "get_weather" },
            };
    const res = translateRequest(coordinator(), src, dst, body as never);
    assertOk(res, `tool-choice-named ${src}->${dst}`);
  }

  // Named resolving to custom tool C<->R
  const customChat = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "custom", custom: { name: "my_custom", description: "c" } }],
    tool_choice: { type: "custom", custom: { name: "my_custom" } },
  };
  const customCToR = translateRequest(coordinator(), "openai-chat", "openai-responses", customChat as never);
  assertOk(customCToR, "custom named C->R");
  if (customCToR.ok) {
    const tc = (customCToR.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "custom");
    assert.equal(tc.name, "my_custom");
  }
  const customResp = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "custom", name: "my_custom", description: "c" }],
    tool_choice: { type: "custom", name: "my_custom" },
  };
  const customRToC = translateRequest(coordinator(), "openai-responses", "openai-chat", customResp as never);
  assertOk(customRToC, "custom named R->C");
  if (customRToC.ok) {
    const tc = (customRToC.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "custom");
    assert.deepEqual((tc.custom as Record<string, unknown>).name, "my_custom");
  }
});

test.concurrent("row allowed-tool-subset: C<->R admit, M rejects", () => {
  // C allowed_tools -> R flat
  const cWithSubset = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } },
      },
      {
        type: "function",
        function: { name: "other", parameters: { ...FUNC_SCHEMA } },
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      allowed_tools: {
        mode: "auto",
        tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
      },
    },
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cWithSubset as never);
  assertOk(cToR, "C allowed subset -> R");
  if (cToR.ok) {
    const tc = (cToR.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "allowed_tools");
    assert.equal(tc.mode, "auto");
    const tools = tc.tools as unknown[];
    assert.equal(tools.length, 1);
    const entry = tools[0] as Record<string, unknown>;
    assert.equal(entry.type, "function");
    assert.equal(entry.name, "get_weather");
  }

  // R allowed_tools -> C nested
  const rWithSubset = {
    model: "wire-model",
    input: "hi",
    tools: [
      { type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false },
      { type: "function", name: "other", parameters: { ...FUNC_SCHEMA }, strict: false },
    ],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
    },
  };
  const rToC = translateRequest(coordinator(), "openai-responses", "openai-chat", rWithSubset as never);
  assertOk(rToC, "R allowed subset -> C");
  if (rToC.ok) {
    const tc = (rToC.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.type, "allowed_tools");
    const allowed = tc.allowed_tools as Record<string, unknown>;
    assert.equal(allowed.mode, "required");
    const tools = allowed.tools as unknown[];
    const entry = tools[0] as Record<string, unknown>;
    assert.equal(entry.type, "function");
    assert.ok((entry.function as Record<string, unknown>).name === "get_weather");
  }

  // A subset entry must name a tool from the top-level declaration list.
  const cSubsetUndeclared = {
    ...cWithSubset,
    tool_choice: {
      type: "allowed_tools",
      allowed_tools: {
        mode: "auto",
        tools: [{ type: "function", function: { name: "missing_tool", parameters: { ...FUNC_SCHEMA } } }],
      },
    },
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-chat", "openai-responses", cSubsetUndeclared as never) as never,
    undefined,
    "invalid_request",
    "C subset references undeclared tool",
  );

  const rSubsetUndeclared = {
    ...rWithSubset,
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "missing_tool", parameters: { ...FUNC_SCHEMA }, strict: false }],
    },
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-responses", "openai-chat", rSubsetUndeclared as never) as never,
    undefined,
    "invalid_request",
    "R subset references undeclared tool",
  );

  const cSubsetWithoutTools = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: cWithSubset.tool_choice,
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-chat", "openai-responses", cSubsetWithoutTools as never) as never,
    undefined,
    "invalid_request",
    "C subset has no top-level tools",
  );

  // Every M direction rejects
  for (const [src, dst] of ALL_DIRECTIONS) {
    if (dst !== "anthropic-messages" && src !== "anthropic-messages") continue;
    // Only test M-involving directions
    const res =
      src === "openai-chat"
        ? translateRequest(coordinator(), src, dst, cWithSubset as never)
        : src === "openai-responses"
          ? translateRequest(coordinator(), src, dst, rWithSubset as never)
          : translateRequest(coordinator(), "openai-chat", "anthropic-messages", cWithSubset as never);
    if (dst === "anthropic-messages" || src === "anthropic-messages") {
      assertUnsupported(res as never, "allowed-tool-subset", `${src}->${dst} allowed subset into M`);
    }
  }

  // Subset elements re-emit in the target wire shape, so an invalid C
  // function name inside a subset targeting Chat fails closed at preflight
  // with the owning row instead of dispatching a body OpenAI rejects.
  const rSubsetBadName = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "function", name: "bad name with spaces!", parameters: { ...FUNC_SCHEMA }, strict: false }],
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "bad name with spaces!", parameters: { ...FUNC_SCHEMA }, strict: false }],
    },
  };
  assertUnsupported(
    translateRequest(coordinator(), "openai-responses", "openai-chat", rSubsetBadName as never) as never,
    "function-tool-definition",
    "R subset element with invalid C name -> C",
  );
});

test.concurrent("row parallel-tool-calls: booleans and disable flag", () => {
  // C/R bool direct
  const cFalse = chatToolBody({ parallel_tool_calls: false });
  const cFalseToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cFalse as never);
  assertOk(cFalseToR, "parallel false C->R");
  if (cFalseToR.ok) assert.equal((cFalseToR.value.body as Record<string, unknown>).parallel_tool_calls, false);

  const rFalse = responsesToolBody({ parallel_tool_calls: false });
  const rFalseToC = translateRequest(coordinator(), "openai-responses", "openai-chat", rFalse as never);
  assertOk(rFalseToC, "parallel false R->C");
  if (rFalseToC.ok) assert.equal((rFalseToC.value.body as Record<string, unknown>).parallel_tool_calls, false);

  // Into M disable_parallel_tool_use on auto
  const cFalseAuto = chatToolBody({ parallel_tool_calls: false, tool_choice: "auto" as const });
  const cFalseAutoToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cFalseAuto as never);
  assertOk(cFalseAutoToM, "parallel false into M auto");
  if (cFalseAutoToM.ok) {
    const tc = (cFalseAutoToM.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    assert.equal(tc.disable_parallel_tool_use, true);
  }

  // Conflict with none rejects
  const cFalseNone = chatToolBody({ parallel_tool_calls: false, tool_choice: "none" as const });
  const cFalseNoneToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cFalseNone as never);
  assertUnsupported(cFalseNoneToM as never, "parallel-tool-calls", "parallel false + none into M");

  // M disable maps to false (test via M->C with disable flag? Use IR via decode)
  // Instead test M with tool_choice disable flag via translation: M body with disable flag -> C gets false
  // M tool_choice {type:auto, disable_parallel_tool_use:true} -> C parallel_tool_calls false
  // We construct via IR: use translate path M->C not directly exposing disable, but we test via preflight/inspection:
  // Simpler: verify coordinator handles M disable by sending M with disable and checking C gets false via irRequest
  const mDisable = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
    tool_choice: { type: "auto" as const, disable_parallel_tool_use: true },
  };
  const mDisableToC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mDisable as never);
  assertOk(mDisableToC, "M disable -> C");
  if (mDisableToC.ok) assert.equal((mDisableToC.value.body as Record<string, unknown>).parallel_tool_calls, false);

  // Also into M without explicit choice but with tools and parallel false should synthesize auto with disable
  const cFalseNoChoice = chatToolBody({ parallel_tool_calls: false });
  const cFalseNoChoiceToM = translateRequest(
    coordinator(),
    "openai-chat",
    "anthropic-messages",
    cFalseNoChoice as never,
  );
  assertOk(cFalseNoChoiceToM, "parallel false no choice into M");
  if (cFalseNoChoiceToM.ok) {
    const tc = (cFalseNoChoiceToM.value.body as Record<string, unknown>).tool_choice as Record<string, unknown>;
    if (tc) assert.equal(tc.disable_parallel_tool_use, true);
  }
});

test.concurrent("row function-call-correlation: IDs and ordering plus invalid_request guards", () => {
  // Admitted: opaque IDs 1:1 order preserved via coordinator
  for (const [src, dst] of ALL_DIRECTIONS) {
    let body: Record<string, unknown>;
    const callId = `call_${src}_${dst}`.replace(/-/g, "_");
    if (src === "openai-chat") {
      body = {
        model: "wire-model",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [
              { id: callId, type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            ],
          },
          { role: "tool", tool_call_id: callId, content: "ok" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
      };
    } else if (src === "openai-responses") {
      body = {
        model: "wire-model",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", call_id: callId, name: "get_weather", arguments: '{"city":"SF"}' },
          { type: "function_call_output", call_id: callId, output: "ok" },
        ],
        tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
      };
    } else {
      body = {
        model: "wire-model",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "get_weather", input: { city: "SF" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }] },
        ],
        tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
      };
    }
    const res = translateRequest(coordinator(), src, dst, body as never);
    assertOk(res, `correlation ${src}->${dst}`);
    if (res.ok) {
      // Check IR preserved callId
      const ids = res.value.irRequest.items
        .filter((i) => i.type === "tool_call" || i.type === "tool_result")
        .map((i) => (i.type === "tool_call" ? i.call.callId : i.callId));
      assert.deepEqual(ids, [callId, callId], `${src}->${dst} correlation ids`);
    }
  }

  // Orphan result -> invalid_request
  const orphanChat = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "orphan", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const orphanRes = translateRequest(coordinator(), "openai-chat", "openai-responses", orphanChat as never);
  assertFailsWith(orphanRes as never, undefined, "invalid_request", "orphan tool_result");

  // Duplicate callId -> invalid_request (two calls same id)
  const dupChat = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [
          { id: "dup", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
          { id: "dup", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const dupRes = translateRequest(coordinator(), "openai-chat", "openai-responses", dupChat as never);
  assertFailsWith(dupRes as never, undefined, "invalid_request", "duplicate callId");

  // Duplicate result for the same call -> invalid_request (each result
  // references exactly one earlier call).
  const dupResultChat = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "first" },
      { role: "tool", tool_call_id: "call_1", content: "second" },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const dupResultRes = translateRequest(coordinator(), "openai-chat", "openai-responses", dupResultChat as never);
  assertFailsWith(dupResultRes as never, undefined, "invalid_request", "duplicate tool_result");
});

test.concurrent("row function-arguments-complete: compact JSON and verbatim text", () => {
  // M both-fields rule: input object compact-JSONs to argumentsText
  const mBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { b: 2, a: 1 } }] },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  const mToC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mBody as never);
  assertOk(mToC, "M compact JSON");
  if (mToC.ok) {
    const ir = mToC.value.irRequest;
    const callItem = ir.items.find((i) => i.type === "tool_call");
    assert.ok(callItem && callItem.type === "tool_call");
    const call = callItem.call;
    assert.equal(call.type, "function");
    if (call.type === "function") {
      assert.equal(call.argumentsText, JSON.stringify({ b: 2, a: 1 }));
      assert.deepEqual(call.arguments, { b: 2, a: 1 });
    }
  }

  // C/R exact text preserved
  const cArgs = '{"city":"SF","extra":  42}';
  const cBody = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: cArgs } }],
      },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cBody as never);
  assertOk(cToR, "C exact text preserved");
  if (cToR.ok) {
    const body = cToR.value.body as Record<string, unknown>;
    const input = body.input as unknown[];
    const fc = input.find((e) => (e as Record<string, unknown>).type === "function_call") as Record<string, unknown>;
    assert.equal(fc.arguments, cArgs);
  }

  // Every decoder builds `arguments` from `argumentsText`; direct validator
  // coverage also enforces that relationship for manually constructed IR.
  const badIr = {
    model: "logical-key",
    delivery: "complete" as const,
    items: [
      { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        type: "tool_call" as const,
        call: {
          type: "function" as const,
          callId: "call_1",
          name: "get_weather",
          argumentsText: 42 as unknown as string,
        },
      },
    ],
  };
  const v = validateIrRequest(badIr as never);
  assert.equal(v.ok, false, "non-string argumentsText");
  if (!v.ok) assert.equal(v.error.category, "invalid_request");
});

test.concurrent("row invalid-function-json: verbatim vs M rejection", () => {
  // Invalid text stays observable C<->R
  const invalidArgs = '{"city": "SF", }';
  const cInvalid = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: invalidArgs } }],
      },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cInvalid as never);
  assertOk(cToR, "invalid JSON C->R");
  if (cToR.ok) {
    const input = (cToR.value.body as Record<string, unknown>).input as unknown[];
    const fc = input.find((e) => (e as Record<string, unknown>).type === "function_call") as Record<string, unknown>;
    assert.equal(fc.arguments, invalidArgs);
    const hasArgs =
      fc.arguments !== undefined &&
      (() => {
        try {
          JSON.parse(fc.arguments as string);
          return true;
        } catch {
          return false;
        }
      })();
    assert.equal(hasArgs, false);
  }

  // Into M rejects with invalid-function-json
  const cToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cInvalid as never);
  assertUnsupported(cToM as never, "invalid-function-json", "invalid JSON into M");

  // M-client outcome with invalid provider text -> invalid_request (no tool_use)
  // Provider is Chat, client is Messages: decode Chat body, encode to Messages should fail preflight
  const chatOutcomeBad = {
    id: "chatcmpl-bad",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "not-json" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const outRes = coordinator().translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-chat",
    status: 200,
    headers: {},
    body: chatOutcomeBad as never,
    logicalModel: "logical-key",
  });
  assertFailsWith(outRes as never, undefined, "invalid_request", "M-client outcome invalid json");
  if (!outRes.ok) {
    // Should not have fabricated tool_use; error category invalid_request already checked
  }
});

test.concurrent("row invalid-function-json: streaming raw relay into C/R and fail-closed into M", () => {
  // Valid M input_json_delta fixture for T1 evidence
  const mValidFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5","stop_reason":null,"stop_sequence":null}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_m","name":"get_weather","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"SF\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const { pump: pumpMtoC, emitted: emittedMtoC } = createToolStreamPump(
    "openai-chat",
    "anthropic-messages",
    "resp_m_valid",
  );
  for (const f of mValidFrames) {
    const res = pumpMtoC.pushBytes(UTF8_ENCODER.encode(f));
    assert.equal(res.ok, true);
    if (res.ok) emittedMtoC.push(...res.value);
  }
  const finishMtoC = pumpMtoC.finish();
  assert.equal(finishMtoC.ok, true);
  if (finishMtoC.ok) emittedMtoC.push(...finishMtoC.value);
  assert.ok(joinStreamEmitted(emittedMtoC).includes("city") && joinStreamEmitted(emittedMtoC).includes("SF"));

  // Invalid JSON fragments into C -> relayed verbatim
  const cInvalidFrames = [
    'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{invalid-json"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];

  // Into Responses (C->R): invalid JSON text is relayed
  const { pump: pumpCtoR, emitted: emittedCtoR } = createToolStreamPump(
    "openai-responses",
    "openai-chat",
    "resp_bad_r",
  );
  for (const f of cInvalidFrames) {
    const res = pumpCtoR.pushBytes(UTF8_ENCODER.encode(f));
    if (res.ok) emittedCtoR.push(...res.value);
  }
  const finCtoR = pumpCtoR.finish();
  if (finCtoR.ok) emittedCtoR.push(...finCtoR.value);
  assert.ok(joinStreamEmitted(emittedCtoR).includes("{invalid-json"));

  // Into Messages (C->M): invalid JSON at part_end fails closed with invalid_request and zero tool_use blocks
  const { pump: pumpCtoM, emitted: emittedCtoM } = createToolStreamPump(
    "anthropic-messages",
    "openai-chat",
    "resp_bad_m",
  );
  let failed = false;
  for (const f of cInvalidFrames) {
    const res = pumpCtoM.pushBytes(UTF8_ENCODER.encode(f));
    if (!res.ok) {
      failed = true;
      assert.equal(res.error.category, "invalid_request");
      break;
    }
    emittedCtoM.push(...res.value);
  }
  assert.equal(failed, true, "invalid JSON into M stream must fail");
  const textEmitted = joinStreamEmitted(emittedCtoM);
  assert.equal(textEmitted.includes("tool_use"), false, "no tool_use frame emitted on invalid JSON");
  assert.equal(textEmitted.includes("message_stop"), false, "no success terminator emitted on invalid JSON");
});

test.concurrent("row tool-result-text: single text six directions", () => {
  for (const [src, dst] of ALL_DIRECTIONS) {
    let body: Record<string, unknown>;
    const cid = "call_1";
    if (src === "openai-chat") {
      body = {
        model: "wire-model",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [{ id: cid, type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
          },
          { role: "tool", tool_call_id: cid, content: "sunny" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
      };
    } else if (src === "openai-responses") {
      body = {
        model: "wire-model",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", call_id: cid, name: "get_weather", arguments: '{"city":"SF"}' },
          { type: "function_call_output", call_id: cid, output: "sunny" },
        ],
        tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
      };
    } else {
      body = {
        model: "wire-model",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_use", id: cid, name: "get_weather", input: { city: "SF" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: cid, content: "sunny" }] },
        ],
        tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
      };
    }
    const res = translateRequest(coordinator(), src, dst, body as never);
    assertOk(res, `tool-result-text ${src}->${dst}`);
    if (res.ok) {
      // The result must land in the target's exact wire field, in order.
      const target = res.value.body as Record<string, unknown>;
      if (dst === "openai-chat") {
        const toolMsg = (target.messages as unknown[]).find(
          (m) => (m as Record<string, unknown>).role === "tool",
        ) as Record<string, unknown>;
        assert.equal(toolMsg.content, "sunny", `${src}->C tool content`);
      } else if (dst === "openai-responses") {
        const output = (target.input as unknown[]).find(
          (it) => (it as Record<string, unknown>).type === "function_call_output",
        ) as Record<string, unknown>;
        assert.equal(output.call_id, cid, `${src}->R output call_id`);
        assert.equal(output.output, "sunny", `${src}->R output`);
      } else {
        const block = (target.messages as unknown[])
          .flatMap((m) => ((m as Record<string, unknown>).content as unknown[] | string | undefined) ?? [])
          .find((b) => (b as Record<string, unknown>)?.type === "tool_result") as Record<string, unknown>;
        assert.equal(block.tool_use_id, cid, `${src}->M tool_use_id`);
        assert.equal(block.content, "sunny", `${src}->M content`);
      }
    }
  }
});

test.concurrent("row tool-result-multipart: T3,T3,T3,T1,T3,T1 vector", () => {
  // C->R decode rejects multipart
  const cMulti = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cMulti as never);
  assertUnsupported(cToR as never, "tool-result-multipart", "C->R multipart");

  const cToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cMulti as never);
  assertUnsupported(cToM as never, "tool-result-multipart", "C->M multipart");

  // R->C preflight rejects multipart (via IR)
  const rMultiIr = {
    model: "logical-key",
    delivery: "complete" as const,
    tools: [{ type: "function" as const, name: "get_weather", inputSchema: { ...FUNC_SCHEMA } }],
    items: [
      { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        type: "tool_call" as const,
        call: {
          type: "function" as const,
          callId: "call_1",
          name: "get_weather",
          argumentsText: '{"city":"SF"}',
          arguments: { city: "SF" },
        },
      },
      {
        type: "tool_result" as const,
        callId: "call_1",
        isError: false,
        content: [
          { type: "text" as const, text: "part1" },
          { type: "text" as const, text: "part2" },
        ],
      },
    ],
  };
  const rMultiPre = preflightRequest(rMultiIr as never, "openai-responses->openai-chat", undefined);
  assertUnsupported(rMultiPre as never, "tool-result-multipart", "R->C multipart preflight");
  const mMultiPre = preflightRequest(rMultiIr as never, "anthropic-messages->openai-chat", undefined);
  assertUnsupported(mMultiPre as never, "tool-result-multipart", "M->C multipart preflight");

  // Empty into C also rejects
  const emptyIr = {
    ...rMultiIr,
    items: [
      rMultiIr.items[0],
      rMultiIr.items[1],
      { type: "tool_result" as const, callId: "call_1", isError: false, content: [] as never },
    ],
  };
  const emptyPre = preflightRequest(emptyIr as never, "openai-responses->openai-chat", undefined);
  assertUnsupported(emptyPre as never, "tool-result-multipart", "empty into C");

  // R->M and M->R admit multipart
  const rToM = preflightRequest(rMultiIr as never, "openai-responses->anthropic-messages", undefined);
  assert.equal(rToM.ok, true, "R->M multipart admits");
  const mToR = preflightRequest(rMultiIr as never, "anthropic-messages->openai-responses", undefined);
  assert.equal(mToR.ok, true, "M->R multipart admits");
  // Full translate for those directions
  const rMultiBody = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "a" },
          { type: "input_text", text: "b" },
        ],
      },
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  const rToMFull = translateRequest(coordinator(), "openai-responses", "anthropic-messages", rMultiBody as never);
  assertOk(rToMFull, "R->M multipart full");
  const mMultiBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  const mToRFull = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mMultiBody as never);
  assertOk(mToRFull, "M->R multipart full");
});

test.concurrent("row tool-result-error: is_error true rejects T3x6", () => {
  const mErrBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "err", is_error: true }] },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  for (const [src, dst] of ALL_DIRECTIONS) {
    if (src !== "anthropic-messages") continue;
    const res = translateRequest(coordinator(), src, dst, mErrBody as never);
    assertUnsupported(res as never, "tool-result-error", `error ${src}->${dst}`);
  }
  // false passes
  const mOkBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok", is_error: false }] },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  const okRes = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mOkBody as never);
  assertOk(okRes, "is_error false passes");
  if (okRes.ok) {
    const bodyStr = JSON.stringify(okRes.value.body);
    assert.ok(!bodyStr.includes("is_error"), "M egress omits is_error false");
  }
});

// =====================================================================
// Custom tools
// =====================================================================

test.concurrent("row custom-text-tool: C<->R admit, M rejects", () => {
  const cBody = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "custom", custom: { name: "my_tool", description: "d" } }],
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cBody as never);
  assertOk(cToR, "custom-text C->R");
  if (cToR.ok) {
    const tools = (cToR.value.body as Record<string, unknown>).tools as unknown[];
    assert.equal((tools[0] as Record<string, unknown>).type, "custom");
    assert.equal((tools[0] as Record<string, unknown>).name, "my_tool");
  }
  const rBody = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "custom", name: "my_tool", description: "d" }],
  };
  const rToC = translateRequest(coordinator(), "openai-responses", "openai-chat", rBody as never);
  assertOk(rToC, "custom-text R->C");
  if (rToC.ok) {
    const tools = (rToC.value.body as Record<string, unknown>).tools as unknown[];
    const e = tools[0] as Record<string, unknown>;
    assert.equal(e.type, "custom");
    assert.equal((e.custom as Record<string, unknown>).name, "my_tool");
  }
  // M has no custom tool surface, so M-source custom calls cannot arise at
  // decode; the reachable M rejections are the C/R definitions into M plus a
  // custom tool_call part destined for an M client (preflightOutcome).
  const cToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cBody as never);
  assertUnsupported(cToM as never, "custom-text-tool", "custom C->M");
  const rToM = translateRequest(coordinator(), "openai-responses", "anthropic-messages", rBody as never);
  assertUnsupported(rToM as never, "custom-text-tool", "custom R->M");
  const customCallOutcome = {
    responseId: "resp_custom",
    model: "wire-model",
    delivery: "complete",
    parts: [
      { type: "tool_call", partId: "p1", call: { type: "custom", callId: "call_1", name: "my_tool", inputText: "x" } },
    ],
    finish: { reason: "tool_calls" },
  };
  const customCallPre = preflightOutcome(customCallOutcome as never, "anthropic-messages->openai-chat");
  assertUnsupported(customCallPre as never, "custom-text-tool", "custom call part to M client");

  // The admitted C->R custom-call loop round-trips: a custom assistant call
  // and its text result become custom_tool_call/custom_tool_call_output input
  // items on the flat R wire.
  const cCustomLoop = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "custom", custom: { name: "my_tool", input: "raw" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result text" },
    ],
    tools: [{ type: "custom", custom: { name: "my_tool" } }],
  };
  const cLoopToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cCustomLoop as never);
  assertOk(cLoopToR, "custom call loop C->R");
  if (cLoopToR.ok) {
    const input = (cLoopToR.value.body as Record<string, unknown>).input as unknown[];
    const call = input.find((i) => (i as Record<string, unknown>).type === "custom_tool_call") as Record<
      string,
      unknown
    >;
    assert.equal(call.call_id, "call_1");
    assert.equal(call.name, "my_tool");
    assert.equal(call.input, "raw");
    const output = input.find((i) => (i as Record<string, unknown>).type === "custom_tool_call_output") as Record<
      string,
      unknown
    >;
    assert.equal(output.call_id, "call_1");
    assert.equal(output.output, "result text");
  }
});

test.concurrent("row custom-grammar-tool: grammar transform and M rejections", () => {
  const cGrammar = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "custom",
        custom: {
          name: "my_grammar",
          description: "d",
          format: { type: "grammar", grammar: { definition: "rule", syntax: "lark" } },
        },
      },
    ],
  };
  const cToR = translateRequest(coordinator(), "openai-chat", "openai-responses", cGrammar as never);
  assertOk(cToR, "custom-grammar C->R");
  if (cToR.ok) {
    const tools = (cToR.value.body as Record<string, unknown>).tools as unknown[];
    const e = tools[0] as Record<string, unknown>;
    assert.equal(e.type, "custom");
    const fmt = e.format as Record<string, unknown>;
    assert.equal(fmt.type, "grammar");
    assert.equal(fmt.definition, "rule");
    assert.equal(fmt.syntax, "lark");
  }
  const rGrammar = {
    model: "wire-model",
    input: "hi",
    tools: [
      {
        type: "custom",
        name: "my_grammar",
        description: "d",
        format: { type: "grammar", definition: "rule", syntax: "lark" },
      },
    ],
  };
  const rToC = translateRequest(coordinator(), "openai-responses", "openai-chat", rGrammar as never);
  assertOk(rToC, "custom-grammar R->C");
  if (rToC.ok) {
    const tools = (rToC.value.body as Record<string, unknown>).tools as unknown[];
    const e = tools[0] as Record<string, unknown>;
    assert.equal(e.type, "custom");
    const custom = e.custom as Record<string, unknown>;
    const fmt = custom.format as Record<string, unknown>;
    const grammar = fmt.grammar as Record<string, unknown>;
    assert.equal(grammar.definition, "rule");
    assert.equal(grammar.syntax, "lark");
  }
  const cToM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cGrammar as never);
  assertUnsupported(cToM as never, "custom-grammar-tool", "grammar C->M");
  const rToM = translateRequest(coordinator(), "openai-responses", "anthropic-messages", rGrammar as never);
  assertUnsupported(rToM as never, "custom-grammar-tool", "grammar R->M");
});

test.concurrent("row custom-tool-streaming: request and output gates", () => {
  const customIr = {
    model: "logical-key",
    delivery: "stream" as const,
    tools: [{ type: "custom" as const, name: "my_tool", format: { type: "text" as const } }],
    items: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };
  for (const [src, dst] of ALL_DIRECTIONS) {
    const dir = `${src}->${dst}` as never;
    const res = preflightStreamRequest(customIr as never, dir, undefined);
    assertUnsupported(res as never, "custom-tool-streaming", `stream request custom ${dir}`);
  }

  // Also with custom call item
  const customCallIr = {
    model: "logical-key",
    delivery: "stream" as const,
    tools: [{ type: "function" as const, name: "get_weather", inputSchema: { ...FUNC_SCHEMA } }],
    items: [
      { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        type: "tool_call" as const,
        call: { type: "custom" as const, callId: "call_1", name: "my_tool", inputText: "hello" },
      },
    ],
  };
  for (const [src, dst] of ALL_DIRECTIONS) {
    const dir = `${src}->${dst}` as never;
    const res = preflightStreamRequest(customCallIr as never, dir, undefined);
    assertUnsupported(res as never, "custom-tool-streaming", `stream custom call ${dir}`);
  }

  // Also with custom tool solely in allowedToolSubset sidecar
  const standardIr = {
    model: "logical-key",
    delivery: "stream" as const,
    tools: [{ type: "function" as const, name: "get_weather", inputSchema: { ...FUNC_SCHEMA } }],
    items: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };
  const customSubset = {
    allowedToolSubset: {
      mode: "auto" as const,
      tools: [{ type: "custom" as const, name: "my_tool", format: { type: "text" as const } }],
    },
  };
  for (const [src, dst] of ALL_DIRECTIONS) {
    const dir = `${src}->${dst}` as never;
    const res = preflightStreamRequest(standardIr as never, dir, customSubset as never);
    assertUnsupported(res as never, "custom-tool-streaming", `stream custom subset ${dir}`);
  }

  // Output side: part_start with custom_call descriptor
  const sm = createIrStreamStateMachine();
  const r1 = sm.feed({ type: "response_start", responseId: "r1", model: "m", wireOptions: {} } as never);
  assert.equal(r1.ok, true);
  const r2 = sm.feed({
    type: "part_start",
    responseId: "r1",
    partId: "p1",
    part: { type: "custom_call", callId: "c1", name: "n" },
  } as never);
  assert.equal(r2.ok, false, "custom_call part_start should fail");
  if (!r2.ok) {
    assert.equal((r2.error as { capability?: string }).capability, "custom-tool-streaming");
    assert.equal((r2.error as { category?: string }).category, "unsupported_capability");
  }
});

// =====================================================================
// Provisional stream function tools
// =====================================================================

test.concurrent("row function-arguments-streaming & tool-stream-delta: piecewise tool argument streaming across all six directions", () => {
  const chatStreamFrames = [
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_w","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];

  const responsesStreamFrames = [
    'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_stream","status":"in_progress"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"item":{"type":"function_call","id":"fc_w","call_id":"call_w","name":"get_weather","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_w","delta":"{\\"city\\":"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_w","delta":"\\"SF\\"}"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":5,"item":{"type":"function_call","id":"fc_w","call_id":"call_w","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":6,"response":{"id":"resp_stream","status":"completed","output":[{"type":"function_call","id":"fc_w","call_id":"call_w","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}]}}\n\n',
  ];

  const messagesStreamFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","content":[],"model":"claude-3-5","stop_reason":null,"stop_sequence":null}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_w","name":"get_weather","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  for (const [client, provider] of ALL_DIRECTIONS) {
    const { pump, emitted } = createToolStreamPump(client, provider, `resp_${client}_${provider}`);
    let frames: string[];
    if (provider === "openai-chat") frames = chatStreamFrames;
    else if (provider === "openai-responses") frames = responsesStreamFrames;
    else frames = messagesStreamFrames;

    for (const f of frames) {
      const res = pump.pushBytes(UTF8_ENCODER.encode(f));
      assert.equal(res.ok, true, `pushBytes failed for ${client}<-${provider}`);
      if (res.ok) emitted.push(...res.value);
    }
    const finishRes = pump.finish();
    assert.equal(finishRes.ok, true, `finish failed for ${client}<-${provider}`);
    if (finishRes.ok) emitted.push(...finishRes.value);

    const output = joinStreamEmitted(emitted);
    if (client === "openai-chat") {
      assert.ok(output.includes("tool_calls"), `chat client should contain tool_calls for ${client}<-${provider}`);
      assert.ok(output.includes("get_weather"), `chat client should contain get_weather for ${client}<-${provider}`);
      assert.ok(output.includes("[DONE]"), `chat client should contain [DONE] for ${client}<-${provider}`);
    } else if (client === "openai-responses") {
      assert.ok(
        output.includes("function_call"),
        `responses client should contain function_call for ${client}<-${provider}`,
      );
      assert.ok(
        output.includes("function_call_arguments.delta"),
        `responses client should contain delta for ${client}<-${provider}`,
      );
      assert.ok(
        output.includes("response.completed"),
        `responses client should contain response.completed for ${client}<-${provider}`,
      );
    } else {
      assert.ok(output.includes("tool_use"), `messages client should contain tool_use for ${client}<-${provider}`);
      assert.ok(
        output.includes("input_json_delta"),
        `messages client should contain input_json_delta for ${client}<-${provider}`,
      );
      assert.ok(
        output.includes("message_stop"),
        `messages client should contain message_stop for ${client}<-${provider}`,
      );
    }
  }
});

test.concurrent("row finish-tool-calls: stream-side finish reason mapping across all six directions", () => {
  for (const [client, provider] of ALL_DIRECTIONS) {
    const { pump, emitted } = createToolStreamPump(client, provider, `resp_finish_${client}_${provider}`);
    let frames: string[];
    if (provider === "openai-chat") {
      frames = [
        'data: {"id":"chatcmpl-f","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_f","type":"function","function":{"name":"fn","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-f","object":"chat.completion.chunk","created":1775606400,"model":"gpt-main","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];
    } else if (provider === "openai-responses") {
      frames = [
        'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_f","status":"in_progress"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"item":{"type":"function_call","id":"fc_f","call_id":"call_f","name":"fn","arguments":"{}"}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"item":{"type":"function_call","id":"fc_f","call_id":"call_f","name":"fn","arguments":"{}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_f","status":"completed","output":[{"type":"function_call","id":"fc_f","call_id":"call_f","name":"fn","arguments":"{}"}]}}\n\n',
      ];
    } else {
      frames = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_f","type":"message","role":"assistant","content":[],"model":"claude-3-5","stop_reason":null,"stop_sequence":null}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_f","name":"fn","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
    }

    for (const f of frames) {
      const res = pump.pushBytes(UTF8_ENCODER.encode(f));
      assert.equal(res.ok, true);
      if (res.ok) emitted.push(...res.value);
    }
    const fin = pump.finish();
    assert.equal(fin.ok, true);
    if (fin.ok) emitted.push(...fin.value);
    const out = joinStreamEmitted(emitted);
    if (client === "openai-chat") {
      assert.ok(
        out.includes('"finish_reason":"tool_calls"'),
        `finish_reason tool_calls expected for ${client}<-${provider}`,
      );
    } else if (client === "openai-responses") {
      assert.ok(out.includes("response.completed"), `response.completed expected for ${client}<-${provider}`);
    } else {
      assert.ok(out.includes('"stop_reason":"tool_use"'), `stop_reason tool_use expected for ${client}<-${provider}`);
    }
  }
});

// =====================================================================
// T3 request rejections
// =====================================================================

test.concurrent("row tool-output-schema: R tools with output_schema", () => {
  const body = {
    model: "wire-model",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { ...FUNC_SCHEMA },
        strict: false,
        output_schema: { type: "object" },
      },
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, body as never);
    assertUnsupported(res as never, "tool-output-schema", `output_schema ${dst}`);
  }
});

test.concurrent("row deferred-tools: R and M defer_loading", () => {
  const rBody = {
    model: "wire-model",
    input: "hi",
    tools: [
      { type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false, defer_loading: true },
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, rBody as never);
    assertUnsupported(res as never, "deferred-tools", `R deferred -> ${dst}`);
  }
  // M defer: tool_reference block + tool with defer?
  // Test via M tools with type that triggers deferred? Instead test tool_reference block decode:
  // The plan says deferred-tools covers R + M variants; for M we test request with tool_reference block?
  // Simplify: M tool with deferred shape via raw input that triggers shared table? We assert R already covers row T3x6.
  // Additional check: ensure R input item tool_reference also triggers?
  const mDeferBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "tool_reference", tool_name: "x" }] }],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "anthropic-messages", dst, mDeferBody as never);
    assertUnsupported(res as never, "deferred-tools", `M deferred -> ${dst}`);
  }
});

test.concurrent("row allowed-callers: normalized direct intersection and fail-closed validation", () => {
  // R->M records caller facts by tool name: only the declared direct tool is
  // re-emitted, while an adjacent tool without the field stays absent.
  const rDirect = {
    model: "wire-model",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { ...FUNC_SCHEMA },
        strict: false,
        allowed_callers: ["direct"],
      },
      { type: "function", name: "get_time", parameters: { ...FUNC_SCHEMA }, strict: false },
    ],
  };
  const rToM = translateRequest(coordinator(), "openai-responses", "anthropic-messages", rDirect as never);
  assertOk(rToM, "R direct -> M admits");
  if (rToM.ok) {
    const tools = (rToM.value.body as Record<string, unknown>).tools as unknown[];
    const weather = tools[0] as Record<string, unknown>;
    const time = tools[1] as Record<string, unknown>;
    assert.deepEqual(weather.allowed_callers, ["direct"]);
    assert.equal(time.allowed_callers, undefined);
  }

  // A documented non-intersecting caller rejects at decode, rather than
  // leaving a partial direct entry in the sidecar.
  const rProgrammatic = {
    model: "wire-model",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { ...FUNC_SCHEMA },
        strict: false,
        allowed_callers: ["programmatic"],
      },
    ],
  };
  assertUnsupported(
    translateRequest(coordinator(), "openai-responses", "anthropic-messages", rProgrammatic as never) as never,
    "allowed-callers",
    "programmatic R->M",
  );

  const rMixed = {
    ...rProgrammatic,
    tools: [{ ...rProgrammatic.tools[0], allowed_callers: ["direct", "programmatic"] }],
  };
  assertUnsupported(
    translateRequest(coordinator(), "openai-responses", "anthropic-messages", rMixed as never) as never,
    "allowed-callers",
    "mixed direct/programmatic R->M",
  );

  // Empty and undocumented arrays are malformed source wire, not capability
  // loss. Both must fail before directional preflight or egress.
  const rEmpty = {
    ...rProgrammatic,
    tools: [{ ...rProgrammatic.tools[0], allowed_callers: [] }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-responses", "anthropic-messages", rEmpty as never) as never,
    undefined,
    "invalid_request",
    "empty R allowed_callers",
  );
  const rUnknown = {
    ...rProgrammatic,
    tools: [{ ...rProgrammatic.tools[0], allowed_callers: ["not_documented"] }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "openai-responses", "anthropic-messages", rUnknown as never) as never,
    undefined,
    "invalid_request",
    "unknown R allowed_callers",
  );

  // Chat has no caller surface, so even the direct intersection rejects when
  // the target is Chat.
  assertUnsupported(
    translateRequest(coordinator(), "openai-responses", "openai-chat", rDirect as never) as never,
    "allowed-callers",
    "R direct -> C rejects",
  );

  // M's version of code_execution_20250825 is documented but has no R
  // intersection, so it must report the exact capability rather than the
  // invalid-wire category used for an unknown version.
  const mCodeExecution = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "get_weather",
        input_schema: { ...FUNC_SCHEMA },
        allowed_callers: ["code_execution_20250825"],
      },
    ],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-responses", mCodeExecution as never) as never,
    "allowed-callers",
    "documented M code_execution -> R",
  );

  const mMixed = {
    ...mCodeExecution,
    tools: [{ ...mCodeExecution.tools[0], allowed_callers: ["direct", "code_execution_20250825"] }],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-responses", mMixed as never) as never,
    "allowed-callers",
    "mixed direct/code_execution M->R",
  );

  const mEmpty = {
    ...mCodeExecution,
    tools: [{ ...mCodeExecution.tools[0], allowed_callers: [] }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "anthropic-messages", "openai-responses", mEmpty as never) as never,
    undefined,
    "invalid_request",
    "empty M allowed_callers",
  );
  const mUnknown = {
    ...mCodeExecution,
    tools: [{ ...mCodeExecution.tools[0], allowed_callers: ["code_execution_20250522"] }],
  };
  assertFailsWith(
    translateRequest(coordinator(), "anthropic-messages", "openai-responses", mUnknown as never) as never,
    undefined,
    "invalid_request",
    "unknown M allowed_callers",
  );

  // M->R preserves the same per-tool direct-only fact and leaves the adjacent
  // tool without a caller field untouched. Responses also supplies its
  // required strict=false spelling.
  const mDirect = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      { name: "get_weather", input_schema: { ...FUNC_SCHEMA }, allowed_callers: ["direct"] },
      { name: "get_time", input_schema: { ...FUNC_SCHEMA } },
    ],
  };
  const mDirectToR = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mDirect as never);
  assertOk(mDirectToR, "M direct -> R admits");
  if (mDirectToR.ok) {
    const tools = (mDirectToR.value.body as Record<string, unknown>).tools as unknown[];
    const weather = tools[0] as Record<string, unknown>;
    const time = tools[1] as Record<string, unknown>;
    assert.deepEqual(weather.allowed_callers, ["direct"]);
    assert.equal(weather.strict, false);
    assert.equal(time.allowed_callers, undefined);
    assert.equal(time.strict, false);
  }
});

test.concurrent("row tool-input-examples: examples in tool definition", () => {
  // M-only input_examples field
  const mWithExamples = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      { name: "get_weather", input_schema: { ...FUNC_SCHEMA }, input_examples: [{ city: "SF" }] } as unknown as Record<
        string,
        unknown
      >,
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "anthropic-messages", dst, mWithExamples as never);
    assertUnsupported(res as never, "tool-input-examples", `M examples -> ${dst}`);
  }
});

test.concurrent("row eager-tool-streaming: eager + null eager", () => {
  // M-only eager_input_streaming field
  const mEager = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      { name: "get_weather", input_schema: { ...FUNC_SCHEMA }, eager_input_streaming: true } as unknown as Record<
        string,
        unknown
      >,
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "anthropic-messages", dst, mEager as never);
    assertUnsupported(res as never, "eager-tool-streaming", `M eager -> ${dst}`);
  }
  const mEagerNull = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      { name: "get_weather", input_schema: { ...FUNC_SCHEMA }, eager_input_streaming: null } as unknown as Record<
        string,
        unknown
      >,
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "anthropic-messages", dst, mEagerNull as never);
    assertUnsupported(res as never, "eager-tool-streaming", `M eager null -> ${dst}`);
  }
});

test.concurrent("row tool-namespaces: namespace tool type + namespace on function_call", () => {
  const nsTool = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "namespace", name: "my_ns", description: "ns" }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, nsTool as never);
    assertUnsupported(res as never, "tool-namespaces", `namespace tool -> ${dst}`);
  }
  const nsCall = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}", namespace: "my_ns" },
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, nsCall as never);
    assertUnsupported(res as never, "tool-namespaces", `namespace call -> ${dst}`);
  }
});

test.concurrent("row programmatic-tools: programmatic surfaces", () => {
  const progTool = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "programmatic_tool_calling", name: "prog" } as unknown as Record<string, unknown>],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, progTool as never);
    assertUnsupported(res as never, "programmatic-tools", `prog tool -> ${dst}`);
  }
  const progCall = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: "{}",
        caller: { type: "programmatic" },
      },
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, progCall as never);
    assertUnsupported(res as never, "programmatic-tools", `programmatic caller -> ${dst}`);
  }
  const progOutput = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "program", call_id: "call_1", output: "hi" } as unknown as Record<string, unknown>,
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, progOutput as never);
    assertUnsupported(res as never, "programmatic-tools", `program output -> ${dst}`);
  }
});

// =====================================================================
// Hosted/provider rows
// =====================================================================

test.concurrent("row hosted types: R tools table maps to exact IDs", () => {
  for (const [type, expected] of Object.entries(RESPONSES_HOSTED_TOOL_TYPES)) {
    if (type === "file_search") continue; // bare hits hosted-file-search; vector variant separate
    if (type === "namespace" || type === "programmatic_tool_calling") continue; // owned elsewhere
    const body = {
      model: "wire-model",
      input: "hi",
      tools: [{ type }],
    };
    for (const [, dst] of ALL_DIRECTIONS) {
      const res = translateRequest(coordinator(), "openai-responses", dst, body as never);
      assertUnsupported(res as never, expected, `R tool ${type} -> ${dst}`);
    }
  }
  // The tool_search tools[]-type trigger (distinct from the replayed
  // tool_search_call/tool_search_output items covered by the next test).
  const toolSearchTool = { model: "wire-model", input: "hi", tools: [{ type: "tool_search" }] };
  for (const [, dst] of ALL_DIRECTIONS) {
    assertUnsupported(
      translateRequest(coordinator(), "openai-responses", dst, toolSearchTool as never) as never,
      "hosted-tool-search",
      `tool_search tool -> ${dst}`,
    );
  }
  // file_search bare -> hosted-file-search
  const bare = { model: "wire-model", input: "hi", tools: [{ type: "file_search" }] };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, bare as never);
    assertUnsupported(res as never, "hosted-file-search", `file_search bare -> ${dst}`);
  }
  // file_search with vector_store_ids -> provider-vector-store precedence
  const withVector = {
    model: "wire-model",
    input: "hi",
    tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, withVector as never);
    assertUnsupported(res as never, "provider-vector-store", `file_search vector -> ${dst}`);
  }
});

test.concurrent("row hosted types: M tools table maps to exact IDs", () => {
  for (const [type, expected] of Object.entries(MESSAGES_HOSTED_TOOL_TYPES)) {
    const body = {
      model: "wire-model",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "x", type, input_schema: { type: "object" } } as unknown as Record<string, unknown>],
    };
    for (const [, dst] of ALL_DIRECTIONS) {
      const res = translateRequest(coordinator(), "anthropic-messages", dst, body as never);
      assertUnsupported(res as never, expected, `M tool ${type} -> ${dst}`);
    }
  }
  // Also verify server_tool_use name table via block
  // server_tool_use is a response-side block (it never appears in request
  // content); the name table is exercised through decodeOutcome, where each
  // documented name must reject with its exact hosted row.
  for (const [name, expected] of Object.entries(MESSAGES_SERVER_TOOL_USE_NAMES)) {
    const outcome = {
      id: "msg_srv",
      type: "message",
      role: "assistant",
      model: "wire-model",
      content: [{ type: "server_tool_use", id: "srv_1", name, input: {} } as unknown as Record<string, unknown>],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const dec = new MessagesIngressDecoder().decodeOutcome(200, {}, outcome as never);
    assertUnsupported(dec as never, expected, `server_tool_use ${name}`);
  }
  // The same block type in request user content is malformed request wire.
  const reqBlock = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } as unknown as Record<string, unknown>,
        ],
      },
    ],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", reqBlock as never) as never,
    "unknown-content-item",
    "server_tool_use in request user content",
  );
});

test.concurrent("row hosted-web-search: C web_search_options", () => {
  const body = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    web_search_options: { search_context_size: "low" },
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, body as never);
    assertUnsupported(res as never, "hosted-web-search", `web_search_options -> ${dst}`);
  }
});

test.concurrent("row hosted-mcp and hosted-tool-search: replayed R input items", () => {
  for (const type of ["mcp_call", "mcp_list_tools", "mcp_approval_request", "mcp_approval_response"]) {
    const body = {
      model: "wire-model",
      input: [{ type, id: "x", name: "y" } as unknown as Record<string, unknown>],
    };
    for (const [, dst] of ALL_DIRECTIONS) {
      const res = translateRequest(coordinator(), "openai-responses", dst, body as never);
      assertUnsupported(res as never, "hosted-mcp", `replayed ${type} -> ${dst}`);
    }
  }
  for (const type of ["tool_search_call", "tool_search_output"]) {
    const body = {
      model: "wire-model",
      input: [{ type, id: "x" } as unknown as Record<string, unknown>],
    };
    for (const [, dst] of ALL_DIRECTIONS) {
      const res = translateRequest(coordinator(), "openai-responses", dst, body as never);
      assertUnsupported(res as never, "hosted-tool-search", `replayed ${type} -> ${dst}`);
    }
  }
  // The hosted output-item table maps every type to its exact row on BOTH the
  // replayed-input path and the outcome-decode path (asserting one arbitrary
  // target direction keeps the table-drive bounded; decode is direction-free).
  for (const [type, expected] of Object.entries(RESPONSES_HOSTED_OUTPUT_ITEMS)) {
    const replayBody = {
      model: "wire-model",
      input: [{ type, id: "x" } as unknown as Record<string, unknown>],
    };
    assertUnsupported(
      translateRequest(coordinator(), "openai-responses", "openai-chat", replayBody as never) as never,
      expected,
      `replayed ${type} input`,
    );
    const outcome = {
      id: "resp_hosted",
      object: "response",
      status: "completed",
      model: "wire-model",
      output: [{ type, id: "x" } as unknown as Record<string, unknown>],
      usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 },
    };
    const dec = new ResponsesIngressDecoder().decodeOutcome(200, {}, outcome as never);
    assertUnsupported(dec as never, expected, `outcome ${type}`);
  }

  // computer_call_output refines on acknowledged safety checks: the non-empty
  // array maps to hosted-tool-safety-checks, absent/empty stays computer-use.
  const computerCallOutput = (checks: unknown) => ({
    id: "resp_c",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [{ type: "computer_call_output", call_id: "c_1", acknowledged_safety_checks: checks }],
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 },
  });
  assertUnsupported(
    new ResponsesIngressDecoder().decodeOutcome(200, {}, computerCallOutput([{ id: "s_1" }]) as never) as never,
    "hosted-tool-safety-checks",
    "computer_call_output acknowledged checks",
  );
  assertUnsupported(
    new ResponsesIngressDecoder().decodeOutcome(200, {}, computerCallOutput([]) as never) as never,
    "hosted-computer-use",
    "computer_call_output empty checks",
  );
  assertUnsupported(
    new ResponsesIngressDecoder().decodeOutcome(200, {}, computerCallOutput(undefined) as never) as never,
    "hosted-computer-use",
    "computer_call_output absent checks",
  );
});

test.concurrent("row responses-message-phase: replayed function_call status completed passes", () => {
  const body = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
        status: "completed",
      },
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  const res = translateRequest(coordinator(), "openai-responses", "openai-chat", body as never);
  assertOk(res, "replayed function_call completed");
});

test.concurrent("row hosted output discovery: R and M output items", () => {
  // R open_page -> hosted-web-fetch
  const rOutcomeOpenPage = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [
      {
        type: "web_search_call",
        id: "ws_1",
        action: { type: "open_page", url: "https://example.com" },
        status: "completed",
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const dec = new ResponsesIngressDecoder().decodeOutcome(200, {}, rOutcomeOpenPage as never);
  if (dec.ok) {
    const pre = preflightOutcome(dec.value.irOutcome, "openai-responses->openai-chat", dec.value.outcomeWireOptions);
    assertUnsupported(pre as never, "hosted-web-fetch", "open_page outcome");
  } else {
    assertUnsupported(dec as never, "hosted-web-fetch", "open_page decode");
  }

  // R computer_call with pending_safety_checks -> hosted-tool-safety-checks
  const rCompPending = {
    id: "resp_2",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [
      {
        type: "computer_call",
        id: "cc_1",
        call_id: "call_1",
        action: { type: "click", x: 0, y: 0 },
        pending_safety_checks: [{ code: "x", message: "y" }],
        status: "completed",
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const dec2 = new ResponsesIngressDecoder().decodeOutcome(200, {}, rCompPending as never);
  if (dec2.ok) {
    const pre = preflightOutcome(dec2.value.irOutcome, "openai-responses->openai-chat", dec2.value.outcomeWireOptions);
    assertUnsupported(pre as never, "hosted-tool-safety-checks", "computer pending");
  } else {
    assertUnsupported(dec2 as never, "hosted-tool-safety-checks", "computer pending decode");
  }

  // Outcome function_call items carry the same re-ID rules as replayed input
  // items: namespace, caller, and a non-completed status each reject with
  // their owning row (or malformed-wire invalid_request).
  const outcomeCall = (extra: Record<string, unknown>) => ({
    id: "resp_fc",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
        ...extra,
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  const nsDec = new ResponsesIngressDecoder().decodeOutcome(200, {}, outcomeCall({ namespace: "my_ns" }) as never);
  assertUnsupported(nsDec as never, "tool-namespaces", "outcome function_call namespace");
  const callerDec = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    outcomeCall({ caller: { type: "programmatic" } }) as never,
  );
  assertUnsupported(callerDec as never, "programmatic-tools", "outcome function_call caller");
  const statusDec = new ResponsesIngressDecoder().decodeOutcome(
    200,
    {},
    outcomeCall({ status: "in_progress" }) as never,
  );
  assertFailsWith(statusDec as never, undefined, "invalid_request", "outcome function_call status in_progress");

  // M encrypted_content precedence - use tool_result block with encrypted_content nested
  const mEncrypted = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [
      {
        type: "web_search_tool_result",
        content: [{ type: "text", text: "hi" }],
        encrypted_content: "xxx",
      } as unknown as Record<string, unknown>,
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const mDec = new MessagesIngressDecoder().decodeOutcome(200, {}, mEncrypted as never);
  assertUnsupported(mDec as never, "hosted-tool-result-encryption", "encrypted decode");

  // The encryption scan reads only provider wire keys on block shapes: a text
  // block carrying the marker rejects, while a client tool argument literally
  // named encrypted_content inside tool_use input stays translatable.
  const mTextEncrypted = {
    id: "msg_te",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [{ type: "text", text: "hi", encrypted_content: "xxx" } as unknown as Record<string, unknown>],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  assertUnsupported(
    new MessagesIngressDecoder().decodeOutcome(200, {}, mTextEncrypted as never) as never,
    "hosted-tool-result-encryption",
    "text block with encrypted_content",
  );
  const mClientArgEncrypted = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "decrypt",
            input: { encrypted_content: "client-owned-ciphertext" },
          },
        ],
      },
    ],
    tools: [{ name: "decrypt", input_schema: { type: "object" } }],
  };
  assertOk(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", mClientArgEncrypted as never),
    "client tool arg named encrypted_content",
  );

  // M search_result block
  const mSearch = {
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [{ type: "search_result", content: [] } as unknown as Record<string, unknown>],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const mSearchDec = new MessagesIngressDecoder().decodeOutcome(200, {}, mSearch as never);
  assertUnsupported(mSearchDec as never, "hosted-web-search", "search_result");

  // M container_upload / container field
  const mContainer = {
    id: "msg_3",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [{ type: "container_upload", file_id: "file_1" } as unknown as Record<string, unknown>],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const mContainerDec = new MessagesIngressDecoder().decodeOutcome(200, {}, mContainer as never);
  assertUnsupported(mContainerDec as never, "provider-container", "container_upload");

  const mWithContainerField = {
    id: "msg_4",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    container: { id: "cont_1" },
  } as unknown as Record<string, unknown>;
  const mContFieldDec = new MessagesIngressDecoder().decodeOutcome(200, {}, mWithContainerField as never);
  assertUnsupported(mContFieldDec as never, "provider-container", "container field");

  // Also verify hosted block types table direct request blocks: each block
  // type rejects with its exact row, in user content and in tool_result
  // element position.
  for (const [blockType, expected] of Object.entries(MESSAGES_HOSTED_BLOCK_TYPES)) {
    const body = {
      model: "wire-model",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: blockType, content: "x" } as unknown as Record<string, unknown>] }],
    };
    const res = translateRequest(coordinator(), "anthropic-messages", "openai-chat", body as never);
    assertUnsupported(res as never, expected, `M user block ${blockType}`);
  }

  // A tool_result content array with an image block rejects with the media
  // row at decode (image parts never become IR parts).
  const mToolResultImage = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }],
          },
        ],
      },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", mToolResultImage as never) as never,
    "tool-result-multipart",
    "M tool_result image",
  );
});

test.concurrent("row provider-uploaded-file: file_id surfaces", () => {
  // R input_file with file_id: passes through C↔R via sidecar, rejects into M with provider-file-id
  const rFile = {
    model: "wire-model",
    input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, rFile as never);
    if (dst === "anthropic-messages") {
      assertUnsupported(res as never, "provider-file-id", `R input_file -> ${dst}`);
    } else {
      assert.equal(res.ok, true, `R input_file -> ${dst}`);
    }
  }
  // C user file part with file_id: passes through C↔R via sidecar, rejects into M with provider-file-id
  const cFile = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file_123" } }] }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, cFile as never);
    if (dst === "anthropic-messages") {
      assertUnsupported(res as never, "provider-file-id", `C file -> ${dst}`);
    } else {
      assert.equal(res.ok, true, `C file -> ${dst}`);
    }
  }
  // function_call_output with file_id - accept either unsupported or invalid_request depending on decode path
  const rOutputFile = {
    model: "wire-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_file", file_id: "file_123" }] },
    ],
    tools: [{ type: "function", name: "get_weather", parameters: { ...FUNC_SCHEMA }, strict: false }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-responses", dst, rOutputFile as never);
    assertUnsupported(res as never, "provider-uploaded-file", `R output file_id -> ${dst}`);
  }
});

// =====================================================================
// Legacy/finish/usage
// =====================================================================

test.concurrent("row chat-legacy-functions: functions param and function_call fields", () => {
  const withFunctions = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    functions: [{ name: "get_weather", parameters: { type: "object", properties: {} } }],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, withFunctions as never);
    assertUnsupported(res as never, "chat-legacy-functions", `functions param -> ${dst}`);
  }
  const withFuncCall = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    function_call: { name: "get_weather" },
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, withFuncCall as never);
    assertUnsupported(res as never, "chat-legacy-functions", `function_call param -> ${dst}`);
  }
  const assistantFunc = {
    model: "wire-model",
    messages: [
      {
        role: "assistant",
        content: null,
        function_call: { name: "get_weather", arguments: "{}" },
      } as unknown as Record<string, unknown>,
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, assistantFunc as never);
    assertUnsupported(res as never, "chat-legacy-functions", `assistant function_call -> ${dst}`);
  }
  // Outcome finish_reason function_call
  const outcomeFnCall = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "function_call" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const dec = new ChatIngressDecoder().decodeOutcome(200, {}, outcomeFnCall as never);
  assertUnsupported(dec as never, "chat-legacy-functions", "outcome function_call");
  const outcomeWithFunc = {
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hi",
          function_call: { name: "get_weather", arguments: "{}" },
        } as unknown as Record<string, unknown>,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const dec2 = new ChatIngressDecoder().decodeOutcome(200, {}, outcomeWithFunc as never);
  assertUnsupported(dec2 as never, "chat-legacy-functions", "outcome message.function_call");
});

test.concurrent("row chat-legacy-function-role: role function", () => {
  // Direct decode check: new ChatIngressDecoder should reject role:function
  const decDirect = new ChatIngressDecoder().decodeRequest({
    model: "wire-model",
    messages: [{ role: "function", content: "ok" } as unknown as Record<string, unknown>],
  } as never);
  assertUnsupported(decDirect as never, "chat-legacy-function-role", "direct decode function role");
  // Via coordinator for all targets, expect same (or message-name if shape invalid)
  const body = {
    model: "wire-model",
    messages: [{ role: "function", content: "ok" } as unknown as Record<string, unknown>],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "openai-chat", dst, body as never);
    assert.equal(res.ok, false, `function role -> ${dst} should fail`);
    if (!res.ok) {
      const cap = (res.error as { capability?: string }).capability;
      // Accept either legacy role or message-name (if name missing) but prefer legacy
      assert.ok(cap === "chat-legacy-function-role" || cap === "message-name", `function role cap ${cap}`);
    }
  }
});

test.concurrent("row finish-tool-calls: six-direction admission and well-formedness guard", () => {
  // Provider outcomes with tool finish
  const cOutcome = {
    id: "chatcmpl-tools",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":"PST"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const rOutcome = {
    id: "resp_tools",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [
      {
        type: "function_call",
        id: "fc_a",
        call_id: "call_a",
        name: "get_weather",
        arguments: '{"city":"SF"}',
        status: "completed",
      },
      {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "get_time",
        arguments: '{"tz":"PST"}',
        status: "completed",
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const mOutcome = {
    id: "msg_tools",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [
      { type: "tool_use", id: "call_a", name: "get_weather", input: { city: "SF" } },
      { type: "tool_use", id: "call_b", name: "get_time", input: { tz: "PST" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  for (const [client, provider] of ALL_DIRECTIONS) {
    let providerOutcome: Record<string, unknown>;
    if (provider === "openai-chat") providerOutcome = cOutcome;
    else if (provider === "openai-responses") providerOutcome = rOutcome as unknown as Record<string, unknown>;
    else providerOutcome = mOutcome as unknown as Record<string, unknown>;
    const res = coordinator().translateCompleteOutcome({
      sourceProtocol: client,
      targetProtocol: provider,
      status: 200,
      headers: {},
      body: providerOutcome as never,
      logicalModel: "logical-key",
    });
    assert.equal(
      res.ok,
      true,
      `finish-tool-calls ${client}->${provider} should admit (provider ${provider} -> client ${client})`,
    );
    if (res.ok) {
      const body = res.value.body as Record<string, unknown>;
      if (client === "openai-chat") {
        // Tool-only outcome: null content, both calls in order, no empty text.
        const choice = (body.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
        const msg = choice.message as Record<string, unknown>;
        assert.equal(msg.content, null, "chat tool-only content is null");
        const calls = msg.tool_calls as Array<Record<string, unknown>>;
        assert.deepEqual(
          calls.map((c) => c.id),
          ["call_a", "call_b"],
        );
        assert.equal(choice.finish_reason, "tool_calls");
      } else if (client === "openai-responses") {
        // Tool-only outcome: no spurious empty message item beside the calls.
        const output = body.output as Array<Record<string, unknown>>;
        assert.equal(output.length, 2, "responses emits exactly the two call items");
        assert.ok(output.every((i) => i.type === "function_call"));
        assert.deepEqual(
          output.map((i) => i.call_id),
          ["call_a", "call_b"],
        );
        assert.equal(output[0]?.status, "completed");
      } else {
        // Tool-only outcome: no spurious empty text block beside tool_use.
        const content = body.content as Array<Record<string, unknown>>;
        assert.equal(content.length, 2, "messages emits exactly the two tool_use blocks");
        assert.ok(content.every((b) => b.type === "tool_use"));
        assert.deepEqual(
          content.map((b) => b.id),
          ["call_a", "call_b"],
        );
        assert.equal(body.stop_reason, "tool_use");
      }
    }
  }

  // Well-formedness guard: tool finish with zero parts -> invalid_request
  const emptyOutcome = {
    id: "chatcmpl-empty",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const dec = new ChatIngressDecoder().decodeOutcome(200, {}, emptyOutcome as never);
  assert.ok(dec.ok, "empty tool_calls decode should succeed");
  if (dec.ok) {
    const pre = preflightOutcome(dec.value.irOutcome, "openai-chat->openai-responses", dec.value.outcomeWireOptions);
    assertFailsWith(pre as never, undefined, "invalid_request", "well-formedness guard empty tool finish");
  }
});

test.concurrent("row usage-server-tools: server_tool_use usage field", () => {
  const mOutcomeWithServerUse = {
    id: "msg_usage",
    type: "message",
    role: "assistant",
    model: "wire-model",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
  } as unknown as Record<string, unknown>;
  const dec = new MessagesIngressDecoder().decodeOutcome(200, {}, mOutcomeWithServerUse as never);
  assertUnsupported(dec as never, "usage-server-tools", "usage server_tool_use");
  // Also via coordinator: for each client->provider where provider is messages
  for (const [client, provider] of ALL_DIRECTIONS) {
    if (provider !== "anthropic-messages") continue;
    const res = coordinator().translateCompleteOutcome({
      sourceProtocol: client,
      targetProtocol: provider,
      status: 200,
      headers: {},
      body: mOutcomeWithServerUse as never,
      logicalModel: "logical-key",
    });
    assert.equal(res.ok, false, `usage-server-tools via outcome ${client}<-${provider}`);
    if (!res.ok) assert.equal((res.error as { capability?: string }).capability, "usage-server-tools");
  }
});

// =====================================================================
// Cross-row prompt-cache-breakpoint extensions (NOT ownership)
// =====================================================================

test.concurrent("cross-row prompt-cache-breakpoint: M tool definition cache_control", () => {
  const body = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "get_weather",
        input_schema: { ...FUNC_SCHEMA },
        cache_control: { type: "ephemeral" },
      } as unknown as Record<string, unknown>,
    ],
  };
  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coordinator(), "anthropic-messages", dst, body as never);
    assertUnsupported(res as never, "prompt-cache-breakpoint", `M tool cache_control -> ${dst}`);
  }
});

test.concurrent("cross-row prompt-cache-breakpoint: C tool-message marker -> M tool blocks", () => {
  const cMarkedTool = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "text", text: "ok", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { ...FUNC_SCHEMA } } }],
  };
  const toM = translateRequest(coordinator(), "openai-chat", "anthropic-messages", cMarkedTool as never);
  assertOk(toM, "C tool marker -> M should translate");
  if (toM.ok) {
    const body = toM.value.body as Record<string, unknown>;
    const msgs = body.messages as unknown[];
    const last = msgs[msgs.length - 1] as Record<string, unknown>;
    const content = last.content as unknown[];
    const block = content.find((b) => (b as Record<string, unknown>).type === "tool_result") as Record<string, unknown>;
    assert.ok(block.cache_control !== undefined, "tool_result cache_control present");
  }
});

test.concurrent("cross-row prompt-cache-breakpoint: M tool_result marker -> C array marker", () => {
  const mMarked = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "ok",
            cache_control: { type: "ephemeral" },
          } as unknown as Record<string, unknown>,
        ],
      },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  const toC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mMarked as never);
  assertOk(toC, "M tool_result marker -> C");
  if (toC.ok) {
    const msgs = (toC.value.body as Record<string, unknown>).messages as unknown[];
    const toolMsg = msgs.find((m) => (m as Record<string, unknown>).role === "tool") as Record<string, unknown>;
    assert.ok(toolMsg, "tool message exists");
    const content = toolMsg.content as unknown[];
    assert.ok(Array.isArray(content), "tool content is array for breakpoint");
    assert.equal((content[0] as Record<string, unknown>).prompt_cache_breakpoint !== undefined, true);
  }
});

test.concurrent("cross-row prompt-cache-breakpoint: tool_call-anchored markers reject into C/R", () => {
  const mToolCallMarked = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "get_weather",
            input: { city: "SF" },
            cache_control: { type: "ephemeral" },
          } as unknown as Record<string, unknown>,
        ],
      },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
  };
  const toC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mToolCallMarked as never);
  assertUnsupported(toC as never, "prompt-cache-breakpoint", "tool_use marker -> C rejects");
  const toR = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mToolCallMarked as never);
  assertUnsupported(toR as never, "prompt-cache-breakpoint", "tool_use marker -> R rejects");
});

test.concurrent("cross-row prompt-cache-breakpoint: top-level cache_control ending in tool_use re-attaches and rejects into C/R", () => {
  const mTopToolUse = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
    cache_control: { type: "ephemeral" } as unknown as Record<string, unknown>,
  };
  // This top-level marker should re-attach to the final tool_use block; into C/R it rejects
  const toC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mTopToolUse as never);
  assertUnsupported(toC as never, "prompt-cache-breakpoint", "top-level tool_use -> C");
  const toR = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mTopToolUse as never);
  assertUnsupported(toR as never, "prompt-cache-breakpoint", "top-level tool_use -> R");
});

test.concurrent("cross-row prompt-cache-breakpoint: top-level cache_control ending in tool_result admits into C", () => {
  const mTopToolResult = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ],
    tools: [{ name: "get_weather", input_schema: { ...FUNC_SCHEMA } }],
    cache_control: { type: "ephemeral" } as unknown as Record<string, unknown>,
  };
  const toC = translateRequest(coordinator(), "anthropic-messages", "openai-chat", mTopToolResult as never);
  assertOk(toC, "top-level tool_result -> C admits");
  if (toC.ok) {
    const msgs = (toC.value.body as Record<string, unknown>).messages as unknown[];
    const toolMsg = msgs.find((m) => (m as Record<string, unknown>).role === "tool") as Record<string, unknown>;
    const content = toolMsg.content as unknown[];
    assert.ok(Array.isArray(content), "tool array admits breakpoint");
  }
  const toR = translateRequest(coordinator(), "anthropic-messages", "openai-responses", mTopToolResult as never);
  assertUnsupported(toR as never, "prompt-cache-breakpoint", "top-level tool_result -> R rejects");
});

// =====================================================================
// Hardened wire-key surfaces (fail-closed parity across block positions)
// =====================================================================

test.concurrent("system-position blocks: encrypted markers and hosted block types keep their exact rows", () => {
  // A system text block is the same provider wire-key container as a message
  // text block: an encryption marker on one rejects, never silently drops.
  const mSystemEncrypted = {
    model: "wire-model",
    max_tokens: 1024,
    system: [{ type: "text", text: "hi", encrypted_content: "xxx" } as unknown as Record<string, unknown>],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  assertUnsupported(
    translateRequest(coordinator(), "anthropic-messages", "openai-chat", mSystemEncrypted as never) as never,
    "hosted-tool-result-encryption",
    "system text block with encrypted_content",
  );

  // Recognized hosted block types in the system position reject with their
  // owning row, exactly as they do in user content.
  for (const [blockType, capability] of [
    ["web_search_tool_result", "hosted-web-search"],
    ["container_upload", "provider-container"],
  ] as const) {
    const body = {
      model: "wire-model",
      max_tokens: 1024,
      system: [{ type: blockType } as unknown as Record<string, unknown>],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    assertUnsupported(
      translateRequest(coordinator(), "anthropic-messages", "openai-chat", body as never) as never,
      capability,
      `system ${blockType}`,
    );
  }
});

test.concurrent("provider-container: R container_file_citation annotation rejects at outcome decode", () => {
  const outcome = {
    id: "resp_cfc",
    object: "response",
    status: "completed",
    model: "wire-model",
    output: [
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "see file",
            annotations: [
              { type: "container_file_citation", container_id: "c_1", file_id: "f_1", start_index: 0, end_index: 3 },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  assertUnsupported(
    new ResponsesIngressDecoder().decodeOutcome(200, {}, outcome as never) as never,
    "provider-container",
    "container_file_citation annotation",
  );

  // Plain url_citation annotations are the citation rows' surface;
  // they stay admitted at decode and fail closed later if they ever surface.
  const urlOutcome = {
    ...outcome,
    output: [
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "see page",
            annotations: [
              { type: "url_citation", url: "https://example.com", title: "t", start_index: 0, end_index: 3 },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(new ResponsesIngressDecoder().decodeOutcome(200, {}, urlOutcome as never).ok, true);
});

test.concurrent("chat tool_choice allowed_tools wrapper rejects unrecognized keys", () => {
  for (const bad of [
    { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [] }, extra: true },
    { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [], filters: {} } },
  ] as const) {
    const res = new ChatIngressDecoder().decodeRequest({
      model: "wire-model",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: bad as unknown as Record<string, unknown>,
    } as never);
    assert.equal(res.ok, false, `tool_choice ${JSON.stringify(bad)} should reject`);
    if (!res.ok) {
      assert.equal(res.error.category, "invalid_request");
      assert.match(res.error.message, /is not recognized/);
    }
  }
});

test.concurrent("chat outcome with a missing choices[0].message fails closed instead of fabricating text", () => {
  const malformed = {
    id: "chatcmpl-nomsg",
    object: "chat.completion",
    created: 1775606400,
    model: "wire-model",
    choices: [{ index: 0, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const res = new ChatIngressDecoder().decodeOutcome(200, {}, malformed as never);
  assert.equal(res.ok, false, "missing message object should reject");
  if (!res.ok) {
    assert.equal(res.error.category, "invalid_request");
    assert.match(res.error.message, /message/);
  }
});
