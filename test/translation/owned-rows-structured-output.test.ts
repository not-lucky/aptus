/**
 * Owned structured output capability rows:
 * - structured-json-schema
 * - structured-strict-guarantee
 * - structured-name-description
 * - legacy-json-object
 *
 * Covers all six directed translation paths, egress fidelity, RFC 6901 schema
 * walker contracts, streaming parity, and malformed input negatives.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { ChatIngressDecoder } from "../../src/translation/codecs/chat/ingress.ts";
import { MessagesIngressDecoder } from "../../src/translation/codecs/messages/ingress.ts";
import { ResponsesEgressEncoder } from "../../src/translation/codecs/responses/egress.ts";
import { ResponsesIngressDecoder } from "../../src/translation/codecs/responses/ingress.ts";
import { ResponsesStreamRequestEncoder } from "../../src/translation/codecs/responses/stream.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrRequest } from "../../src/translation/ir.ts";
import { validateMessagesOutputSchema, validateOpenAiStrictSchema } from "../../src/translation/schema-dialect.ts";
import { validateIrRequest } from "../../src/translation/validate.ts";
import { ALL_DIRECTIONS, irBase, sourceBodyFor, translateRequest } from "./owned-rows-helpers.ts";

function coordinator() {
  return createDefaultTranslationCoordinator();
}

const CONFORMING_OBJECT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
  },
  required: ["name", "age"],
  additionalProperties: false,
};

const MESSAGES_SUBSET_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    city: { type: "string" },
  },
  required: ["city"],
};

// =====================================================================
// 1. Matrix Coverage & Round Trips (24 cells)
// =====================================================================

test.concurrent("row structured-json-schema: 6-direction matrix coverage", () => {
  const coord = coordinator();

  // C->R (T1 direct)
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const text = cToR.value.body.text as { format: { type: string; name: string; schema: JsonObject } };
    assert.equal(text?.format?.type, "json_schema");
    assert.equal(text?.format?.name, "person_schema");
    assert.deepEqual(text?.format?.schema, CONFORMING_OBJECT_SCHEMA);
  }

  // C->M (T2 into M subset)
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person_schema",
        schema: MESSAGES_SUBSET_SCHEMA,
      },
    },
  });
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const outputConfig = cToM.value.body.output_config as { format: { type: string; schema: JsonObject } };
    assert.equal(outputConfig?.format?.type, "json_schema");
    assert.deepEqual(outputConfig?.format?.schema, MESSAGES_SUBSET_SCHEMA);
  }

  // R->C (T1 direct)
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "person_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const rf = rToC.value.body.response_format as {
      type: string;
      json_schema: { name: string; schema: JsonObject };
    };
    assert.equal(rf?.type, "json_schema");
    assert.equal(rf?.json_schema?.name, "person_schema");
    assert.deepEqual(rf?.json_schema?.schema, CONFORMING_OBJECT_SCHEMA);
  }

  // R->M (T2 into M subset)
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "person_schema",
        schema: MESSAGES_SUBSET_SCHEMA,
      },
    },
  });
  assert.equal(rToM.ok, true);
  if (rToM.ok) {
    const outputConfig = rToM.value.body.output_config as { format: { type: string; schema: JsonObject } };
    assert.equal(outputConfig?.format?.type, "json_schema");
    assert.deepEqual(outputConfig?.format?.schema, MESSAGES_SUBSET_SCHEMA);
  }

  // M->C (T2 with synthesized name)
  const mToC = translateRequest(coord, "anthropic-messages", "openai-chat", {
    ...sourceBodyFor("anthropic-messages"),
    max_tokens: 1024,
    output_config: {
      format: {
        type: "json_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    assert.equal(mToC.value.irRequest.output?.type, "json_schema");
    if (mToC.value.irRequest.output?.type === "json_schema") {
      assert.equal(mToC.value.irRequest.output.name, undefined); // never in IR
    }
    const rf = mToC.value.body.response_format as {
      type: string;
      json_schema: { name: string; schema: JsonObject };
    };
    assert.equal(rf?.type, "json_schema");
    assert.equal(rf?.json_schema?.name, "response"); // synthesized on wire
    assert.deepEqual(rf?.json_schema?.schema, CONFORMING_OBJECT_SCHEMA);
  }

  // M->R (T2 with synthesized name)
  const mToR = translateRequest(coord, "anthropic-messages", "openai-responses", {
    ...sourceBodyFor("anthropic-messages"),
    max_tokens: 1024,
    output_config: {
      format: {
        type: "json_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(mToR.ok, true);
  if (mToR.ok) {
    assert.equal(mToR.value.irRequest.output?.type, "json_schema");
    if (mToR.value.irRequest.output?.type === "json_schema") {
      assert.equal(mToR.value.irRequest.output.name, undefined);
    }
    const text = mToR.value.body.text as { format: { type: string; name: string; schema: JsonObject } };
    assert.equal(text?.format?.type, "json_schema");
    assert.equal(text?.format?.name, "response");
    assert.deepEqual(text?.format?.schema, CONFORMING_OBJECT_SCHEMA);
  }
});

test.concurrent("row structured-strict-guarantee: C↔R passes, into M rejects, strict violation into C/R rejects", () => {
  const coord = coordinator();

  // Strict C->R conforming passes
  const cToRStrict = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: true,
      },
    },
  });
  assert.equal(cToRStrict.ok, true);
  if (cToRStrict.ok) {
    const format = (cToRStrict.value.body.text as { format: { strict?: boolean } })?.format;
    assert.equal(format?.strict, true);
  }

  // Strict R->C conforming passes
  const rToCStrict = translateRequest(coord, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "test_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: true,
      },
    },
  });
  assert.equal(rToCStrict.ok, true);
  if (rToCStrict.ok) {
    const js = (rToCStrict.value.body.response_format as { json_schema: { strict?: boolean } })?.json_schema;
    assert.equal(js?.strict, true);
  }

  // Strict into M rejects structured-strict-guarantee (T3)
  const cToMStrict = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: true,
      },
    },
  });
  assert.equal(cToMStrict.ok, false);
  if (!cToMStrict.ok) {
    assert.equal(cToMStrict.error.capability, "structured-strict-guarantee");
  }

  const rToMStrict = translateRequest(coord, "openai-responses", "anthropic-messages", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "test_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: true,
      },
    },
  });
  assert.equal(rToMStrict.ok, false);
  if (!rToMStrict.ok) {
    assert.equal(rToMStrict.error.capability, "structured-strict-guarantee");
  }

  // OpenAI strict violation into C/R rejects structured-strict-guarantee
  const nonStrictSchema: JsonObject = {
    type: "object",
    properties: {
      item: { anyOf: [{ type: "string" }] },
    },
    required: ["item"],
    additionalProperties: false,
  };
  const cToRNonStrict = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "bad_strict",
        schema: nonStrictSchema,
        strict: true,
      },
    },
  });
  assert.equal(cToRNonStrict.ok, false);
  if (!cToRNonStrict.ok) {
    assert.equal(cToRNonStrict.error.capability, "structured-strict-guarantee");
    assert.match(cToRNonStrict.error.message, /\/properties\/item\/anyOf: anyOf/);
  }
});

test.concurrent("row structured-name-description: C↔R direct, into M name omitted and description rejected", () => {
  const coord = coordinator();

  // C->R with description passes
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "my_schema",
        description: "A detailed description",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const format = (cToR.value.body.text as { format: { description?: string } })?.format;
    assert.equal(format?.description, "A detailed description");
  }

  // C->M with non-empty description rejects structured-name-description
  const cToMDesc = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "my_schema",
        description: "A description",
        schema: MESSAGES_SUBSET_SCHEMA,
      },
    },
  });
  assert.equal(cToMDesc.ok, false);
  if (!cToMDesc.ok) {
    assert.equal(cToMDesc.error.capability, "structured-name-description");
  }

  // C->M with empty description passes (and name is omitted on wire)
  const cToMEmptyDesc = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "my_schema",
        description: "",
        schema: MESSAGES_SUBSET_SCHEMA,
      },
    },
  });
  assert.equal(cToMEmptyDesc.ok, true);
  if (cToMEmptyDesc.ok) {
    const outputConfig = cToMEmptyDesc.value.body.output_config as Record<string, unknown>;
    assert.equal("name" in (outputConfig.format as Record<string, unknown>), false);
    assert.equal("description" in (outputConfig.format as Record<string, unknown>), false);
  }
});

test.concurrent("row legacy-json-object: C↔R round-trips via sidecar; M directions reject", () => {
  const coord = coordinator();

  // C->R legacy json_object
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: { type: "json_object" },
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    assert.equal(cToR.value.irRequest.output, undefined);
    const text = cToR.value.body.text as { format: { type: string } };
    assert.equal(text?.format?.type, "json_object");
  }

  // R->C legacy json_object
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    text: { format: { type: "json_object" } },
  });
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    assert.equal(rToC.value.irRequest.output, undefined);
    const rf = rToC.value.body.response_format as { type: string };
    assert.equal(rf?.type, "json_object");
  }

  // C->M rejects legacy-json-object
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: { type: "json_object" },
  });
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "legacy-json-object");
  }

  // R->M rejects legacy-json-object
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", {
    model: "wire-model",
    input: "Hello!",
    text: { format: { type: "json_object" } },
  });
  assert.equal(rToM.ok, false);
  if (!rToM.ok) {
    assert.equal(rToM.error.capability, "legacy-json-object");
  }
});

// =====================================================================
// 2. Schema Walker Contracts (RFC 6901 pointers and determinism)
// =====================================================================

test.concurrent("walker contracts: OpenAI strict 14 forbidden keywords and pointer formatting", () => {
  const forbiddenKeywords = [
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "patternProperties",
    "dependentSchemas",
    "dependentRequired",
    "unevaluatedProperties",
    "unevaluatedItems",
    "const",
  ];

  for (const kw of forbiddenKeywords) {
    const schema: JsonObject = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            field: { type: "string", [kw]: kw === "const" ? 1 : {} },
          },
          required: ["field"],
          additionalProperties: false,
        },
      },
      required: ["user"],
      additionalProperties: false,
    };
    const res = validateOpenAiStrictSchema(schema, "structured-strict-guarantee");
    assert.equal(res.ok, false, `forbidden keyword ${kw}`);
    if (!res.ok) {
      assert.equal(res.error.capability, "structured-strict-guarantee");
      assert.equal(res.error.message, `/properties/user/properties/field/${kw}: ${kw}`);
    }
  }

  // Escaping in RFC 6901: ~ -> ~0, / -> ~1
  const escapingSchema: JsonObject = {
    type: "object",
    properties: {
      "user/name": {
        type: "object",
        properties: {
          "a~b": { type: "string", anyOf: [{ type: "string" }] },
        },
        required: ["a~b"],
        additionalProperties: false,
      },
    },
    required: ["user/name"],
    additionalProperties: false,
  };
  const escapeRes = validateOpenAiStrictSchema(escapingSchema, "structured-strict-guarantee");
  assert.equal(escapeRes.ok, false);
  if (!escapeRes.ok) {
    assert.equal(escapeRes.error.message, "/properties/user~1name/properties/a~0b/anyOf: anyOf");
  }

  // Non-object root
  const nonObjectRes = validateOpenAiStrictSchema({ type: "string" }, "structured-strict-guarantee");
  assert.equal(nonObjectRes.ok, false);
  if (!nonObjectRes.ok) {
    assert.equal(nonObjectRes.error.message, "/: root type must be object");
  }

  // Missing additionalProperties: false
  const missingAddProp: JsonObject = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  const addPropRes = validateOpenAiStrictSchema(missingAddProp, "structured-strict-guarantee");
  assert.equal(addPropRes.ok, false);
  if (!addPropRes.ok) {
    assert.equal(addPropRes.error.message, "/additionalProperties: additionalProperties must be false");
  }

  // Required mismatch
  const badRequired: JsonObject = {
    type: "object",
    properties: { x: { type: "string" } },
    required: [],
    additionalProperties: false,
  };
  const reqRes = validateOpenAiStrictSchema(badRequired, "structured-strict-guarantee");
  assert.equal(reqRes.ok, false);
  if (!reqRes.ok) {
    assert.equal(reqRes.error.message, "/required: required must list all property names");
  }

  // Depth limit > 10
  let deepSchema: JsonObject = { type: "string" };
  for (let i = 0; i < 11; i++) {
    deepSchema = {
      type: "object",
      properties: { nested: deepSchema },
      required: ["nested"],
      additionalProperties: false,
    };
  }
  const depthRes = validateOpenAiStrictSchema(deepSchema, "structured-strict-guarantee");
  assert.equal(depthRes.ok, false);
  if (!depthRes.ok) {
    assert.match(depthRes.error.message, /nesting depth limit exceeded/);
  }

  // Tool path regression: default capability is function-schema-strictness
  const toolRes = validateOpenAiStrictSchema({ type: "string" });
  assert.equal(toolRes.ok, false);
  if (!toolRes.ok) {
    assert.equal(toolRes.error.capability, "function-schema-strictness");
  }
});

test.concurrent("walker contracts: Messages output schema subset and determinism", () => {
  // Only {type, properties, required} allowed
  const conformingM: JsonObject = {
    type: "object",
    properties: {
      a: { type: "string" },
      b: {
        type: "object",
        properties: { c: { type: "number" } },
      },
    },
    required: ["a", "b"],
  };
  const okRes = validateMessagesOutputSchema(conformingM);
  assert.equal(okRes.ok, true);

  // $defs rejected
  const withDefs: JsonObject = {
    type: "object",
    $defs: { helper: { type: "string" } },
  };
  const defsRes = validateMessagesOutputSchema(withDefs);
  assert.equal(defsRes.ok, false);
  if (!defsRes.ok) {
    assert.equal(defsRes.error.capability, "structured-json-schema");
    assert.equal(defsRes.error.message, "/$defs: $defs");
  }

  // items rejected
  const withItems: JsonObject = {
    type: "object",
    properties: {
      list: { type: "array", items: { type: "string" } },
    },
  };
  const itemsRes = validateMessagesOutputSchema(withItems);
  assert.equal(itemsRes.ok, false);
  if (!itemsRes.ok) {
    assert.equal(itemsRes.error.message, "/properties/list/items: items");
  }

  // Determinism on multiple violations: sorted property key order
  const multiViolation: JsonObject = {
    type: "object",
    properties: {
      z_prop: { type: "string", $defs: {} },
      a_prop: { type: "string", $defs: {} },
    },
  };
  const multiRes = validateMessagesOutputSchema(multiViolation);
  assert.equal(multiRes.ok, false);
  if (!multiRes.ok) {
    assert.equal(multiRes.error.message, "/properties/a_prop/$defs: $defs");
  }
});

// =====================================================================
// 3. Streaming Parity
// =====================================================================

test.concurrent("streaming parity: translateStreamRequest across all 6 directions", () => {
  const coord = coordinator();

  for (const [source, target] of ALL_DIRECTIONS) {
    let sourceBody: JsonObject;
    if (source === "openai-chat") {
      sourceBody = {
        ...sourceBodyFor(source),
        stream: true,
        response_format: {
          type: "json_schema",
          json_schema: { name: "test_stream", schema: MESSAGES_SUBSET_SCHEMA },
        },
      };
    } else if (source === "openai-responses") {
      sourceBody = {
        model: "wire-model",
        input: "Hello!",
        stream: true,
        text: {
          format: {
            type: "json_schema",
            name: "test_stream",
            schema: MESSAGES_SUBSET_SCHEMA,
          },
        },
      };
    } else {
      sourceBody = {
        ...sourceBodyFor(source),
        max_tokens: 1024,
        stream: true,
        output_config: {
          format: {
            type: "json_schema",
            schema: MESSAGES_SUBSET_SCHEMA,
          },
        },
      };
    }

    const res = coord.translateStreamRequest({
      sourceProtocol: source,
      targetProtocol: target,
      logicalModel: "logical-model",
      targetModel: "target-model",
      targetDefaultMaxTokens: 4096,
      sourceBody,
    });
    assert.equal(res.ok, true, `stream ${source}->${target}`);
    if (res.ok) {
      assert.equal(res.value.body.stream, true);
    }
  }

  // Legacy json_object in stream
  const cToRStream = coord.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    logicalModel: "logical-model",
    targetModel: "target-model",
    sourceBody: {
      ...sourceBodyFor("openai-chat"),
      stream: true,
      response_format: { type: "json_object" },
    },
  });
  assert.equal(cToRStream.ok, true);
  if (cToRStream.ok) {
    const text = cToRStream.value.body.text as { format: { type: string } };
    assert.equal(text?.format?.type, "json_object");
  }

  // Legacy json_object into M rejects in stream
  const cToMStream = coord.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    logicalModel: "logical-model",
    targetModel: "target-model",
    sourceBody: {
      ...sourceBodyFor("openai-chat"),
      stream: true,
      response_format: { type: "json_object" },
    },
  });
  assert.equal(cToMStream.ok, false);
  if (!cToMStream.ok) {
    assert.equal(cToMStream.error.capability, "legacy-json-object");
  }
});

// =====================================================================
// 4. Malformed Negatives & Invariant Validation
// =====================================================================

test.concurrent("negatives: malformed response_format, text.format, and output_config fail invalid_request", () => {
  const chatDecoder = new ChatIngressDecoder();
  const respDecoder = new ResponsesIngressDecoder();
  const msgDecoder = new MessagesIngressDecoder();

  // Chat null response_format
  const chatNull = chatDecoder.decodeRequest({
    ...sourceBodyFor("openai-chat"),
    response_format: null as never,
  });
  assert.equal(chatNull.ok, false);
  if (!chatNull.ok) assert.equal(chatNull.error.category, "invalid_request");

  // Chat unknown key in response_format
  const chatExtra = chatDecoder.decodeRequest({
    ...sourceBodyFor("openai-chat"),
    response_format: { type: "json_schema", extra: 123 },
  });
  assert.equal(chatExtra.ok, false);
  if (!chatExtra.ok) assert.equal(chatExtra.error.category, "invalid_request");

  // Chat invalid name
  const chatBadName = chatDecoder.decodeRequest({
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: { name: "invalid name with spaces!", schema: {} },
    },
  });
  assert.equal(chatBadName.ok, false);
  if (!chatBadName.ok) assert.equal(chatBadName.error.category, "invalid_request");

  // Chat missing schema
  const chatNoSchema = chatDecoder.decodeRequest({
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: { name: "valid_name" },
    },
  });
  assert.equal(chatNoSchema.ok, false);
  if (!chatNoSchema.ok) assert.equal(chatNoSchema.error.category, "invalid_request");

  // Responses null text.format
  const respNull = respDecoder.decodeRequest({
    model: "wire-model",
    input: "Hi",
    text: { format: null as never },
  });
  assert.equal(respNull.ok, false);
  if (!respNull.ok) assert.equal(respNull.error.category, "invalid_request");

  // Messages output_config with both effort and format: effort takes precedence
  const msgEffortAndFormat = msgDecoder.decodeRequest({
    ...sourceBodyFor("anthropic-messages"),
    max_tokens: 1024,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: {} },
    },
  });
  assert.equal(msgEffortAndFormat.ok, false);
  if (!msgEffortAndFormat.ok) {
    assert.equal(msgEffortAndFormat.error.capability, "reasoning-effort-common");
  }

  // IR validation: contradictory legacyJsonObject sidecar + output
  const badIr: IrRequest = {
    ...irBase(),
    output: { type: "text" },
  };
  const validateContradictory = validateIrRequest(badIr, { legacyJsonObject: true });
  assert.equal(validateContradictory.ok, false);
  if (!validateContradictory.ok) {
    assert.equal(validateContradictory.error.category, "invalid_request");
    assert.match(validateContradictory.error.message, /must be unset when the legacyJsonObject sidecar is set/);
  }
});

// =====================================================================
// 5. Composition Regressions
// =====================================================================

test.concurrent("composition regressions: Responses text config owner merges verbosity and format", () => {
  const encoder = new ResponsesEgressEncoder();
  const streamEncoder = new ResponsesStreamRequestEncoder();

  // 1. Verbosity only
  const verbosityIr: IrRequest = {
    ...irBase(),
    generation: { verbosity: "high" },
  };
  const vEnc = encoder.encodeRequest(verbosityIr, "target");
  assert.deepEqual(vEnc.text, { verbosity: "high" });
  const vStreamEnc = streamEncoder.encodeRequest(verbosityIr, "target", {});
  assert.deepEqual(vStreamEnc.text, { verbosity: "high" });

  // 2. Format only
  const formatIr: IrRequest = {
    ...irBase(),
    output: {
      type: "json_schema",
      name: "schema_1",
      schema: { type: "object" },
    },
  };
  const fEnc = encoder.encodeRequest(formatIr, "target");
  assert.deepEqual(fEnc.text, {
    format: {
      type: "json_schema",
      name: "schema_1",
      schema: { type: "object" },
    },
  });

  // 3. Combined verbosity + format
  const combinedIr: IrRequest = {
    ...irBase(),
    generation: { verbosity: "low" },
    output: {
      type: "json_schema",
      name: "schema_2",
      schema: { type: "object" },
      strict: true,
    },
  };
  const cEnc = encoder.encodeRequest(combinedIr, "target");
  assert.deepEqual(cEnc.text, {
    verbosity: "low",
    format: {
      type: "json_schema",
      name: "schema_2",
      schema: { type: "object" },
      strict: true,
    },
  });
  const cStreamEnc = streamEncoder.encodeRequest(combinedIr, "target", {});
  assert.deepEqual(cStreamEnc.text, cEnc.text);

  // 4. Combined verbosity + legacy json_object
  const legEnc = encoder.encodeRequest(verbosityIr, "target", { legacyJsonObject: true });
  assert.deepEqual(legEnc.text, {
    verbosity: "high",
    format: { type: "json_object" },
  });
});

test.concurrent("composition regressions: C->M structured output resolves targetDefaultMaxTokens", () => {
  const coord = coordinator();
  const res = coord.translateCompleteRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    logicalModel: "logical-key",
    targetModel: "claude-model",
    targetDefaultMaxTokens: 4096,
    sourceBody: {
      ...sourceBodyFor("openai-chat"),
      response_format: {
        type: "json_schema",
        json_schema: { name: "test", schema: MESSAGES_SUBSET_SCHEMA },
      },
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.body.max_tokens, 4096);
    const outputConfig = res.value.body.output_config as { format: { type: string } };
    assert.equal(outputConfig?.format?.type, "json_schema");
  }
});

// =====================================================================
// 6. Worked Example: structured-output (protocol-ir.md:474-480)
// =====================================================================

test.concurrent("worked example: structured-output object schema strict:true C↔R direct, into M rejects", () => {
  const coord = coordinator();

  const chatRequest = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Extract user info" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "user_info",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: true,
      },
    },
  };

  // C->R translates preserving strict: true
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", chatRequest);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const text = cToR.value.body.text as {
      format: { type: string; name: string; schema: JsonObject; strict: boolean };
    };
    assert.equal(text?.format?.type, "json_schema");
    assert.equal(text?.format?.name, "user_info");
    assert.equal(text?.format?.strict, true);
    assert.deepEqual(text?.format?.schema, CONFORMING_OBJECT_SCHEMA);
  }

  // C->M rejects strict: true before dispatch
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", chatRequest);
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "structured-strict-guarantee");
  }

  // M source without name synthesizes 'response' into OpenAI targets
  const messagesRequest = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "Extract user info" }] }],
    output_config: {
      format: {
        type: "json_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  };
  const mToC = translateRequest(coord, "anthropic-messages", "openai-chat", messagesRequest);
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    assert.equal(mToC.value.irRequest.output?.type, "json_schema");
    if (mToC.value.irRequest.output?.type === "json_schema") {
      assert.equal(mToC.value.irRequest.output.name, undefined);
    }
    const rf = mToC.value.body.response_format as {
      type: string;
      json_schema: { name: string; schema: JsonObject };
    };
    assert.equal(rf?.json_schema?.name, "response");
  }
});

test.concurrent("non-strict non-object root schema fails preflight into C/R", () => {
  const coord = coordinator();
  const nonObjectSchema = { type: "string" } as unknown as JsonObject;

  const cToR = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "string_output",
        schema: nonObjectSchema,
      },
    },
  });
  assert.equal(cToR.ok, false);
  if (!cToR.ok) {
    assert.equal(cToR.error.capability, "structured-json-schema");
    assert.equal(cToR.error.message, "/: root type must be object");
  }

  const rToC = translateRequest(coord, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "string_output",
        schema: nonObjectSchema,
      },
    },
  });
  assert.equal(rToC.ok, false);
  if (!rToC.ok) {
    assert.equal(rToC.error.capability, "structured-json-schema");
    assert.equal(rToC.error.message, "/: root type must be object");
  }
});

test.concurrent("strict: false passes through C↔R preserving strictness flag", () => {
  const coord = coordinator();
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: false,
      },
    },
  });
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const text = cToR.value.body.text as {
      format: { type: string; name: string; schema: JsonObject; strict?: boolean };
    };
    assert.equal(text?.format?.strict, false);
  }

  const rToC = translateRequest(coord, "openai-responses", "openai-chat", {
    model: "wire-model",
    input: "Hello!",
    text: {
      format: {
        type: "json_schema",
        name: "person_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
        strict: false,
      },
    },
  });
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const rf = rToC.value.body.response_format as {
      type: string;
      json_schema: { name: string; schema: JsonObject; strict?: boolean };
    };
    assert.equal(rf?.json_schema?.strict, false);
  }
});

test.concurrent("explicit response_format text into M omits output_config", () => {
  const coord = coordinator();
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: { type: "text" },
  });
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    assert.equal(cToM.value.body.output_config, undefined);
  }
});

test.concurrent("Chat non-strict schema with additionalProperties: false into Messages rejects as structured-json-schema", () => {
  const coord = coordinator();
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", {
    ...sourceBodyFor("openai-chat"),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person_schema",
        schema: CONFORMING_OBJECT_SCHEMA,
      },
    },
  });
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "structured-json-schema");
    assert.equal(cToM.error.message, "/additionalProperties: additionalProperties");
  }
});

test.concurrent("validateMessagesOutputSchema depth limit boundary", () => {
  let depth10: JsonObject = { type: "string" };
  for (let i = 9; i >= 1; i--) {
    depth10 = {
      type: "object",
      properties: {
        nested: depth10,
      },
    };
  }
  const validAt10 = validateMessagesOutputSchema(depth10);
  assert.equal(validAt10.ok, true);

  let depth11: JsonObject = { type: "string" };
  for (let i = 10; i >= 1; i--) {
    depth11 = {
      type: "object",
      properties: {
        nested: depth11,
      },
    };
  }
  const invalidAt11 = validateMessagesOutputSchema(depth11);
  assert.equal(invalidAt11.ok, false);
  if (!invalidAt11.ok) {
    assert.match(invalidAt11.error.message, /nesting depth limit exceeded/);
  }
});
