import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const FORBIDDEN = [
  /from\s+["']express["']/,
  /from\s+["'](?:node:)?http(?:s)?["']/,
  /from\s+["'][^"']*(?:adapter|transport)[^"']*["']/i,
  /from\s+["'][^"']*(?:openai|anthropic|google|azure|aws)[^"']*["']/i,
  /require\s*\(/,
];

async function sourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourcePaths(path) : extname(entry.name) === ".ts" ? [path] : [];
  }));
  return paths.flat();
}

describe("Domain public boundary", () => {
  it("contains no transport, adapter, provider SDK, or runtime dependency imports", async () => {
    const directory = join(process.cwd(), "src", "domain");
    const paths = await sourcePaths(directory);
    const sources = await Promise.all(
      paths.map(async (path) => ({ name: relative(directory, path), source: await readFile(path, "utf8") })),
    );
    for (const { name, source } of sources) {
      for (const forbidden of FORBIDDEN) {
        expect(source, `${name} matched ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
  });

  it("loads the public barrel without network activity", async () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error("network access is forbidden");
    }) as typeof fetch;
    try {
      const domain = await import("../../src/domain/index.js");
      expect(domain.validateUrl("https://example.test/path")).toEqual({ valid: true });
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
