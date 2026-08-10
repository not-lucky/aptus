import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    pool: "threads",
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
