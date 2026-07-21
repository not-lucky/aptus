import { describe, expect, it } from "vitest";
import {
  ConfigurationLoadError,
  loadConfiguration,
} from "../../src/config/index.js";
import type { SecretResolverPort } from "../../src/ports/index.js";

const yamlText = `
server:
  port: 11248
  cors: { origins: [https://console.example.com] }
  bodyTimeoutMs: 1000
  requestTimeoutMs: 2000
  streamIdleTimeoutMs: 1000
  logLevel: info
  trace: { enabled: false, destination: stdout }
  metrics: { enabled: true, path: /metrics }
  health: { path: /health, upstreamCheck: true }
  defaultDryRun: false
clients:
  - id: client-one
    tokenHashRef: env:CLIENT_HASH
    limits: { rpm: 1, tpm: 1, dailyTokens: 1, dailyCostUsd: 0 }
    allowedModelAliases: [fast-chat]
providers:
  - id: provider-one
    protocol: openai-chat
    baseUrl: https://provider.example
    timeoutMs: 1
    customHeaders: {}
    credentials: [{ id: credential-one, secretRef: env:PROVIDER_KEY, weight: 1 }]
    credentialSelection: fill-first
models:
  - alias: fast-chat
    targets: [{ providerId: provider-one, physicalModel: physical, pricesPerMillionUsd: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, capabilities: [tools], contextTokens: 1 }]
routes:
  - id: route-one
    modelAliases: [fast-chat]
    orderedCandidates: [{ providerId: provider-one, modelAlias: fast-chat, weight: 1 }]
    requiredCapabilities: []
    conditions: []
    fallbackGroups: []
    attemptBudget: { maxAttempts: 1, maxLatencyMs: 1, maxCostUsd: 0 }
    statusPolicy: { retryable: [500], nonRetryable: [400] }
plugins: [{ id: authentication, version: 1.0.0, enabled: true, hooks: [onIngressReceived], priority: 1 }]
`;

function resolver(
  calls: string[],
  expectedSignal?: AbortSignal,
): SecretResolverPort {
  return {
    resolve: async (reference, signal) => {
      calls.push(reference);
      if (expectedSignal) expect(signal).toBe(expectedSignal);
      return `resolved-${reference}`;
    },
  };
}
type ConsumedSecret = {
  readonly scope: "client-token-hash" | "provider-credential";
  readonly ownerId: string;
  readonly reference: string;
  readonly value: string;
};

describe("loadConfiguration", () => {
  it("rejects malformed and non-object roots before resolution", async () => {
    const calls: string[] = [];
    const options = {
      resolver: resolver(calls),
      signal: new AbortController().signal,
      consumeSecret: () => undefined,
    };
    await expect(
      loadConfiguration("server: [", options),
    ).rejects.toBeInstanceOf(ConfigurationLoadError);
    await expect(loadConfiguration("[]", options)).rejects.toBeInstanceOf(
      ConfigurationLoadError,
    );
    expect(calls).toEqual([]);
  });

  it("validates before resolving, forwards signal, and preserves source order without retention", async () => {
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const consumed: Array<{ readonly reference: string }> = [];
    const config = await loadConfiguration(yamlText, {
      resolver: resolver(calls, signal),
      signal,
      consumeSecret: (secret: ConsumedSecret) => {
        expect(secret.value).toBe(`resolved-${secret.reference}`);
        consumed.push({ reference: secret.reference });
      },
    });
    expect(calls).toEqual(["env:CLIENT_HASH", "env:PROVIDER_KEY"]);
    expect(consumed.map(({ reference }) => reference)).toEqual(calls);
    expect(JSON.stringify(config)).not.toContain("resolved-");
    expect(JSON.stringify(consumed)).not.toContain("resolved-");
    const consumerFailure = new Error("consumer failed");
    await expect(
      loadConfiguration(yamlText, {
        resolver: resolver([], signal),
        signal,
        consumeSecret: () => {
          throw consumerFailure;
        },
      }),
    ).rejects.toMatchObject({
      issues: [{ message: "secret consumption failed" }],
    });
  });

  it("does not resolve on structural failure and wraps resolver failures safely", async () => {
    const calls: string[] = [];
    const bad = {
      resolve: async (reference: string) => {
        calls.push(reference);
        throw new Error("fixture resolved secret");
      },
    };
    await expect(
      loadConfiguration(
        yamlText.replace("id: authentication", "id: not-auth"),
        {
          resolver: bad,
          signal: new AbortController().signal,
          consumeSecret: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      issues: [{ message: "authentication plugin must be enabled" }],
    });
    expect(calls).toEqual([]);
    await expect(
      loadConfiguration(yamlText, {
        resolver: bad,
        signal: new AbortController().signal,
        consumeSecret: () => undefined,
      }),
    ).rejects.toMatchObject({
      issues: [{ message: "secret resolution failed" }],
    });
    expect(JSON.stringify(await Promise.resolve(calls))).not.toContain(
      "fixture resolved secret",
    );
  });
  it("keeps resolver and YAML dependencies at the config boundary", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const paths = await readdir("src/config");
    for (const path of paths.filter((entry) => entry.endsWith(".ts"))) {
      const source = await readFile(`src/config/${path}`, "utf8");
      expect(
        source.includes('from "zod"') || source.includes('from "js-yaml"'),
      ).toBe(path === "schema.ts" || path === "loader.ts");
      expect(
        source.includes("../domain/") || source.includes("../application/"),
      ).toBe(false);
    }
  });
});
