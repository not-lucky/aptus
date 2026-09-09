/**
 * @fileoverview Vitest execution settings for the Aptus test suite.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    pool: "threads",
    // Shared worker threads without per-file isolation to speed up test execution.
    isolate: false,
    // 30s timeouts accommodate provider dispatch, retry, and shutdown drain tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
