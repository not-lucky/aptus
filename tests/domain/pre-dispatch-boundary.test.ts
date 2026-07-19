import { describe, expect, it } from "vitest";

import {
  checkRequiredCapabilities,
  createGatewayError,
  validateContentBlock,
  validateToolCallArgumentsJson,
} from "../../src/domain/index.js";

/**
 * Task 2 helpers are pure, so the "fail before any dispatch port is called"
 * guarantee is proven at the validation-to-error boundary with the network
 * forbidden: a malformed request never reaches an upstream, and the resulting
 * typed error never echoes the offending body, secret, or raw tool argument.
 */
describe("pre-dispatch boundary", () => {
  it("turns malformed content and invalid tool JSON into safe validation errors without network I/O", () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error("network access is forbidden");
    }) as typeof fetch;
    try {
      const badMedia = validateContentBlock({ type: "image_url", url: "file:///secret-path" });
      expect(badMedia.valid).toBe(false);

      const secretArguments = "{\"apiKey\":\"sk-super-secret\"";
      const badArguments = validateToolCallArgumentsJson(secretArguments);
      expect(badArguments.valid).toBe(false);

      const error = createGatewayError({
        category: "validation",
        code: "invalid_request",
        message: "Request failed validation.",
        requestId: "req_1",
        details: { issues: badMedia.valid ? [] : badMedia.issues, argumentsJson: secretArguments },
      });

      expect(error.status).toBe(400);
      expect(error.category).toBe("validation");
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain("sk-super-secret");
      expect(serialized).not.toContain("secret-path");
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets unknown-but-valid capabilities pass without producing an error", () => {
    const result = checkRequiredCapabilities(["future-capability"], ["future-capability", "tools"]);
    expect(result.satisfied).toBe(true);
  });
});
