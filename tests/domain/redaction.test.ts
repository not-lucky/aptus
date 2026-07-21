import { describe, expect, it } from "vitest";

import {
  CIRCULAR_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
  isSensitiveKey,
  redactDetails,
  redactValue,
} from "../../src/domain/index.js";

describe("sensitive key detection", () => {
  it.each([
    "authorization",
    "Authorization",
    "proxy-authorization",
    "token_hash",
    "tokenHash",
    "token-hash",
    "apiKey",
    "secretRef",
    "password",
    "credentials",
    "body",
    "requestBody",
    "prompt",
    "argumentsJson",
    "toolArguments",
    "providerResponse",
    "metadata",
    "headers",
  ])("treats %s as sensitive regardless of case or separators", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["model", "requestId", "status", "finishReason", "index"])(
    "keeps %s visible",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("recursive redaction", () => {
  it("replaces sensitive values at any depth while retaining benign siblings", () => {
    const input = {
      requestId: "req_1",
      authorization: "Bearer secret-token",
      nested: {
        apiKey: "sk-123",
        ok: 1,
        deeper: [{ prompt: "hidden", index: 0 }],
      },
      list: ["safe", { secret: "shh", keep: true }],
    };
    expect(redactValue(input)).toEqual({
      requestId: "req_1",
      authorization: REDACTION_PLACEHOLDER,
      nested: {
        apiKey: REDACTION_PLACEHOLDER,
        ok: 1,
        deeper: [{ prompt: REDACTION_PLACEHOLDER, index: 0 }],
      },
      list: ["safe", { secret: REDACTION_PLACEHOLDER, keep: true }],
    });
  });

  it("never mutates its input", () => {
    const input = { authorization: "Bearer x", nested: { keep: 1 } };
    const before = JSON.stringify(input);
    redactValue(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("passes primitives through unchanged", () => {
    expect(redactValue("plain")).toBe("plain");
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
  });

  it("marks cyclic references without throwing", () => {
    const cyclic: Record<string, unknown> = { keep: 1 };
    cyclic["self"] = cyclic;
    expect(redactValue(cyclic)).toEqual({
      keep: 1,
      self: CIRCULAR_PLACEHOLDER,
    });
  });

  it("masks non-plain objects wholesale", () => {
    expect(redactValue(new Map([["k", "v"]]))).toBe(REDACTION_PLACEHOLDER);
    expect(redactValue(new Set([1, 2]))).toBe(REDACTION_PLACEHOLDER);
    class Holder {
      secretField = "leak";
    }
    expect(redactValue({ holder: new Holder() })).toEqual({
      holder: REDACTION_PLACEHOLDER,
    });
  });
});

describe("redactDetails", () => {
  it("returns undefined for undefined details", () => {
    expect(redactDetails(undefined)).toBeUndefined();
  });

  it("redacts a details bag and leaves an empty object empty", () => {
    expect(redactDetails({})).toEqual({});
    expect(redactDetails({ body: { prompt: "hi" }, code: "x" })).toEqual({
      body: REDACTION_PLACEHOLDER,
      code: "x",
    });
  });
});
