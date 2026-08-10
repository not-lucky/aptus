import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../src/domain/contracts.ts";
import { applyNativeMutations } from "../../src/providers/shared/mutation.ts";

test.concurrent("applyNativeMutations preserves unknown fields and array order and reports ordered pointers", () => {
  const clientBody: JsonObject = {
    model: "public-name",
    temperature: 1.5,
    messages: [
      { role: "system", content: "a" },
      { role: "user", content: "b" },
    ],
    unknown: { keep: true },
  };
  const result = applyNativeMutations(
    clientBody,
    {
      defaults: { max_tokens: 100, nested: { a: 1 } },
      extraBody: { temperature: 0.5, extra: { deep: { x: 1 } } },
      overrides: { temperature: 0.2, store: false },
    },
    "upstream-model",
  );

  assert.deepEqual(result.mutations, [
    "/max_tokens",
    "/nested/a",
    "/temperature",
    "/extra/deep/x",
    "/temperature",
    "/store",
    "/model",
  ]);

  const body = result.body as JsonObject;
  assert.equal(body.model, "upstream-model");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.nested, { a: 1 });
  assert.deepEqual(body.extra, { deep: { x: 1 } });
  assert.equal(body.store, false);
  assert.deepEqual(body.messages, [
    { role: "system", content: "a" },
    { role: "user", content: "b" },
  ]);
  assert.deepEqual(body.unknown, { keep: true });

  // The configured maps and the client body are never mutated.
  assert.equal(clientBody.model, "public-name");
  assert.equal(clientBody.temperature, 1.5);
});

test.concurrent("applyNativeMutations skips defaults when intermediate segment is a client scalar", () => {
  const clientBody: JsonObject = {
    model: "public-name",
    a: 1,
  };
  const result = applyNativeMutations(
    clientBody,
    {
      defaults: { a: { b: 2 }, c: { d: 3 } },
      extraBody: {},
      overrides: {},
    },
    "upstream-model",
  );

  const body = result.body as JsonObject;
  assert.equal(body.a, 1);
  assert.deepEqual(body.c, { d: 3 });
  assert.deepEqual(result.mutations, ["/c/d", "/model"]);
});
