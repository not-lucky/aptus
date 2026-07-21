import { describe, expect, it } from "vitest";

import type {
  CanonicalRequest,
  ValidationResult,
} from "../../src/domain/index.js";
import {
  validateBase64Media,
  validateCanonicalRequest,
  validateContentBlock,
  validateRequestId,
  validateRfc3339Timestamp,
  validateToolCallArgumentsJson,
  validateUrl,
} from "../../src/domain/index.js";

function issueText(result: ValidationResult): string {
  return result.valid ? "" : JSON.stringify(result.issues);
}

const completeRequest: CanonicalRequest = {
  requestId: "req_valid-1",
  receivedAt: "2026-07-19T12:34:56.123+02:30",
  source: {
    adapter: "fixture",
    protocol: "custom",
    path: "/v1/custom/messages",
  },
  model: "future-model",
  messages: [
    { role: "developer", content: [{ type: "text", text: "Be precise" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        {
          type: "reasoning",
          text: "thinking",
          signature: "sig",
          redactedData: "redacted",
          encryptedContent: "encrypted",
        },
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "lookup",
          argumentsJson: ' { "q" : "x" } ',
        },
        {
          type: "tool_result",
          toolCallId: "call-1",
          content: [
            {
              type: "server_tool_result",
              toolCallId: "server-1",
              toolKind: "future",
              content: [{ type: "text", text: "nested" }],
            },
          ],
        },
        { type: "text", text: "last" },
      ],
    },
  ],
  routing: { requiredCapabilities: ["future-capability"] },
  stream: true,
  extensions: {
    protocols: {
      "openai-chat": {
        protocol: "openai-chat",
        body: { unknown: null, nested: { enabled: true } },
        headers: { "X-Original-Case": "value" },
        sourceFields: ["body.unknown"],
      },
    },
    providers: {
      future: { provider: "future", body: { setting: null }, headers: {} },
    },
    custom: { explicitNull: null },
  },
};

describe("request identifiers", () => {
  it.each(["a", "A0_-", "req_123", "x".repeat(128)])("accepts %s", (value) => {
    expect(validateRequestId(value)).toEqual({ valid: true });
  });

  it.each(["", "_starts_wrong", "has space", "ümlaut", "x".repeat(129), 1])(
    "rejects unsafe identifiers",
    (value) => {
      expect(validateRequestId(value).valid).toBe(false);
    },
  );
});

describe("RFC 3339 timestamps", () => {
  it.each([
    "0000-02-29T00:00:00Z",
    "2026-07-19T12:34:56Z",
    "2024-02-29T23:59:59.123456Z",
    "2026-07-19T12:34:56+14:00",
    "2026-07-19T12:34:56-03:30",
  ])("accepts %s", (value) => {
    expect(validateRfc3339Timestamp(value)).toEqual({ valid: true });
  });

  it.each([
    "2023-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-07-19 12:34:56Z",
    "2026-07-19T12:34Z",
    "2026-07-19T12:34:60Z",
    "2026-07-19T12:34:56+24:00",
  ])("rejects %s", (value) => {
    expect(validateRfc3339Timestamp(value).valid).toBe(false);
  });
});

describe("URLs", () => {
  it("accepts HTTP(S) and rejects unsafe schemes without network I/O", () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error("network access is forbidden");
    }) as typeof fetch;
    try {
      expect(validateUrl("https://example.test/path")).toEqual({ valid: true });
      expect(validateUrl("http://example.test")).toEqual({ valid: true });
      expect(validateUrl("file:///tmp/secret").valid).toBe(false);
      expect(validateUrl("https://user:password@example.test").valid).toBe(
        false,
      );
      expect(validateUrl("not a URL").valid).toBe(false);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("base64 media", () => {
  it.each([
    ["aGVsbG8=", "text/plain"],
    ["TQ==", "application/octet-stream; charset=utf-8"],
    ["YWJj", "image/png"],
  ])("accepts standard base64", (data, mediaType) => {
    expect(validateBase64Media(data, mediaType)).toEqual({ valid: true });
  });

  it.each([
    ["", "text/plain"],
    ["a GVs", "text/plain"],
    ["aGVsbG8_", "text/plain"],
    ["a===", "text/plain"],
    ["aGVsbG8=", ""],
    ["aGVsbG8=", "plain"],
  ])("rejects invalid media", (data, mediaType) => {
    expect(validateBase64Media(data, mediaType).valid).toBe(false);
  });
});

describe("tool argument JSON", () => {
  it.each(["{}", ' { \n "q" : 1 \n } '])(
    "accepts object JSON without normalization",
    (value) => {
      expect(validateToolCallArgumentsJson(value)).toEqual({ valid: true });
    },
  );

  it.each(["{secret-token", "[]", "null", "true", "1", '"text"'])(
    "rejects malformed or non-object JSON safely",
    (value) => {
      const result = validateToolCallArgumentsJson(value);
      expect(result.valid).toBe(false);
      expect(issueText(result)).not.toContain(value);
    },
  );
});

describe("recursive content", () => {
  it("accepts nested/interleaved blocks while retaining unknown fields", () => {
    const value = {
      type: "tool_result",
      toolCallId: "call",
      unknown: null,
      content: [
        {
          type: "image_url",
          url: "https://example.test/image",
          unknownProviderField: { value: null },
        },
        {
          type: "server_tool_call",
          toolCallId: "server",
          toolKind: "future",
          argumentsJson: "{}",
        },
        {
          type: "server_tool_result",
          toolCallId: "server",
          toolKind: "future",
          content: [
            {
              type: "document_base64",
              mediaType: "text/plain",
              data: "aGVsbG8=",
            },
          ],
        },
      ],
    };
    const before = JSON.stringify(value);
    expect(validateContentBlock(value)).toEqual({ valid: true });
    expect(JSON.stringify(value)).toBe(before);
  });

  it("reports stable nested paths", () => {
    const result = validateContentBlock(
      {
        type: "tool_result",
        toolCallId: "call",
        content: [{ type: "image_url", url: "file:///secret" }],
      },
      "messages[0].content[0]",
    );
    expect(result).toEqual({
      valid: false,
      issues: [
        {
          code: "invalid_url",
          path: "messages[0].content[0].content[0].url",
          message: "Expected an HTTP or HTTPS URL without credentials.",
        },
      ],
    });
  });

  it.each([
    [
      { type: "tool_result", toolCallId: "x", content: [], isError: "yes" },
      "contentBlock.isError",
    ],
    [{ type: "text", text: "x", citations: "bad" }, "contentBlock.citations"],
    [
      {
        type: "text",
        text: "x",
        citations: [{ kind: "url", url: "file:///secret" }],
      },
      "contentBlock.citations[0].url",
    ],
    [
      { type: "image_url", url: "https://example.test", detail: "ultra" },
      "contentBlock.detail",
    ],
    [
      {
        type: "server_tool_call",
        toolCallId: "x",
        toolKind: "future",
        input: undefined,
      },
      "contentBlock.input",
    ],
  ])("validates present optional field shapes", (value, path) => {
    const result = validateContentBlock(value);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.issues.some((issue) => issue.path === path)).toBe(true);
  });
});

describe("canonical request", () => {
  it("validates complete requests and round-trips explicit null extensions losslessly", () => {
    const before = JSON.stringify(completeRequest);
    expect(validateCanonicalRequest(completeRequest)).toEqual({ valid: true });
    expect(JSON.stringify(completeRequest)).toBe(before);
    const roundTrip = JSON.parse(before) as CanonicalRequest;
    expect(
      roundTrip.extensions?.protocols?.["openai-chat"]?.body["unknown"],
    ).toBeNull();
  });

  it.each([
    [{ ...completeRequest, messages: [] }, "messages"],
    [
      { ...completeRequest, messages: [{ role: "user", content: [] }] },
      "messages[0].content",
    ],
    [{ ...completeRequest, requestId: "bad id" }, "requestId"],
    [{ ...completeRequest, model: "" }, "model"],
    [{ ...completeRequest, stream: "true" }, "stream"],
    [
      {
        ...completeRequest,
        routing: { maxCostUsd: "1", requiredCapabilities: [1] },
      },
      "routing.maxCostUsd",
    ],
  ])("rejects invalid required request shape at %s", (value, path) => {
    const result = validateCanonicalRequest(value);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.issues.some((issue) => issue.path === path)).toBe(true);
  });

  it("rejects invalid recursive extensions at stable paths", () => {
    const value = structuredClone(completeRequest) as unknown as Record<
      string,
      unknown
    >;
    value["extensions"] = {
      protocols: {
        custom: {
          protocol: "custom",
          body: { bad: undefined },
          headers: {},
          sourceFields: [],
        },
      },
    };
    const result = validateCanonicalRequest(value);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.issues[0]?.path).toBe("extensions.protocols.custom.body");
  });
});
