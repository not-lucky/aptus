import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "../../src/config/index.js";
import type { GatewayConfig } from "../../src/config/index.js";

function validConfig() {
  return {
    server: {
      port: 11248,
      cors: { origins: ["https://console.example.com"] },
      bodyTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      streamIdleTimeoutMs: 1000,
      logLevel: "info",
      trace: { enabled: false, destination: "stdout" },
      metrics: { enabled: true, path: "/metrics" },
      health: { path: "/health", upstreamCheck: true },
      defaultDryRun: false,
    },
    clients: [
      {
        id: "client-one",
        tokenHashRef: "env:CLIENT_HASH",
        limits: { rpm: 1, tpm: 1, dailyTokens: 1, dailyCostUsd: 0 },
        allowedModelAliases: ["fast-chat"],
      },
    ],
    providers: [
      {
        id: "provider-one",
        protocol: "openai-chat",
        baseUrl: "https://provider.example",
        timeoutMs: 1,
        customHeaders: { Region: "us" },
        credentials: [
          { id: "credential-one", secretRef: "env:PROVIDER_KEY", weight: 1 },
        ],
        credentialSelection: "fill-first",
      },
    ],
    models: [
      {
        alias: "fast-chat",
        targets: [
          {
            providerId: "provider-one",
            physicalModel: "physical",
            pricesPerMillionUsd: {
              input: 0,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
            },
            capabilities: ["tools"],
            contextTokens: 1,
          },
        ],
      },
    ],
    routes: [
      {
        id: "route-one",
        modelAliases: ["fast-chat"],
        orderedCandidates: [
          { providerId: "provider-one", modelAlias: "fast-chat", weight: 1 },
        ],
        requiredCapabilities: [],
        conditions: [],
        fallbackGroups: [],
        attemptBudget: { maxAttempts: 1, maxLatencyMs: 1, maxCostUsd: 0 },
        statusPolicy: { retryable: [500], nonRetryable: [400] },
      },
    ],
    plugins: [
      {
        id: "authentication",
        version: "1.0.0",
        enabled: true,
        hooks: ["onIngressReceived"],
        priority: 1,
      },
    ],
  };
}

describe("GatewayConfigSchema", () => {
  it("accepts the complete shape and strips unknown object keys", () => {
    const result = GatewayConfigSchema.safeParse({
      ...validConfig(),
      extra: "removed",
      server: { ...validConfig().server, extra: "removed" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validConfig());
      expect("extra" in result.data).toBe(false);
      expect("extra" in result.data.server).toBe(false);
    }
  });

  it("reports primitive boundaries and timeout ordering exactly", () => {
    const result = GatewayConfigSchema.safeParse({
      ...validConfig(),
      server: {
        ...validConfig().server,
        bodyTimeoutMs: 3000,
        requestTimeoutMs: 2,
        streamIdleTimeoutMs: 3000,
      },
      clients: [{ ...validConfig().clients[0], tokenHashRef: "bad" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["server", "bodyTimeoutMs"],
            message: "body timeout cannot exceed request timeout",
          }),
          expect.objectContaining({
            path: ["server", "streamIdleTimeoutMs"],
            message: "stream idle timeout cannot exceed request timeout",
          }),
          expect.objectContaining({
            path: ["clients", 0, "tokenHashRef"],
            message: "secretRef must name a resolver and reference",
          }),
        ]),
      );
    }
  });

  it("rejects duplicate and cross-reference errors", () => {
    const config = validConfig();
    config.routes[0]!.orderedCandidates[0]!.providerId = "missing";
    config.clients[0]!.allowedModelAliases = ["missing"];
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "unknown model alias missing",
          "unknown provider missing",
        ]),
      );
  });

  it("reports deterministic plugin cycles and requires enabled authentication", () => {
    const config = validConfig();
    config.plugins = [
      {
        id: "alpha",
        version: "1.0.0",
        enabled: true,
        hooks: [],
        priority: 1,
        before: ["beta"],
      } as (typeof config.plugins)[number],
      {
        id: "beta",
        version: "1.0.0",
        enabled: true,
        hooks: [],
        priority: 2,
        before: ["alpha"],
      } as (typeof config.plugins)[number],
    ];
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "plugin dependency cycle: alpha -> beta -> alpha",
          "authentication plugin must be enabled",
        ]),
      );
  });
  it("rejects duplicate credential, model target, and root IDs with exact diagnostics", () => {
    const config: GatewayConfig = structuredClone(
      GatewayConfigSchema.parse(validConfig()),
    );
    config.providers[0]!.credentials.push({
      id: "credential-one",
      secretRef: "env:SECOND",
      weight: 1,
    });
    config.models[0]!.targets.push(
      structuredClone(config.models[0]!.targets[0]!),
    );
    config.clients.push(structuredClone(config.clients[0]!));
    config.providers.push({
      ...structuredClone(config.providers[0]!),
      id: "provider-one",
    });
    config.models.push({
      ...structuredClone(config.models[0]!),
      alias: "fast-chat",
    });
    config.routes.push({
      ...structuredClone(config.routes[0]!),
      id: "route-one",
    });
    config.plugins.push({
      ...structuredClone(config.plugins[0]!),
      id: "authentication",
    });
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["providers", 0, "credentials"],
            message: "duplicate credential ID",
          }),
          expect.objectContaining({
            path: ["models", 0, "targets"],
            message: "duplicate model target",
          }),
          expect.objectContaining({
            path: ["clients"],
            message: "duplicate clients ID",
          }),
          expect.objectContaining({
            path: ["providers"],
            message: "duplicate providers ID",
          }),
          expect.objectContaining({
            path: ["models"],
            message: "duplicate models ID",
          }),
          expect.objectContaining({
            path: ["routes"],
            message: "duplicate routes ID",
          }),
          expect.objectContaining({
            path: ["plugins"],
            message: "duplicate plugins ID",
          }),
        ]),
      );
    }
  });

  it("rejects status overlap and candidate, fallback, and target mismatches", () => {
    const config: GatewayConfig = structuredClone(
      GatewayConfigSchema.parse(validConfig()),
    );
    config.routes[0]!.statusPolicy = { retryable: [500], nonRetryable: [500] };
    config.routes[0]!.modelAliases = ["other-model"];
    config.routes[0]!.orderedCandidates = [
      {
        providerId: "missing-provider",
        modelAlias: "missing-model",
        weight: 1,
      },
      { providerId: "provider-one", modelAlias: "fast-chat", weight: 1 },
    ];
    config.routes[0]!.fallbackGroups = ["missing-route"];
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["routes", 0, "statusPolicy"],
            message: "status cannot be both retryable and nonRetryable",
          }),
          expect.objectContaining({
            path: ["routes", 0],
            message: "unknown model alias other-model",
          }),
          expect.objectContaining({
            path: ["routes", 0, "orderedCandidates", 0, "providerId"],
            message: "unknown provider missing-provider",
          }),
          expect.objectContaining({
            path: ["routes", 0, "orderedCandidates", 0, "modelAlias"],
            message: "unknown candidate model missing-model",
          }),
          expect.objectContaining({
            path: ["routes", 0, "orderedCandidates", 1, "modelAlias"],
            message: "candidate model fast-chat is not enabled by route",
          }),
          expect.objectContaining({
            path: ["routes", 0, "fallbackGroups"],
            message: "unknown fallback route missing-route",
          }),
        ]),
      );

    const targetMismatch: GatewayConfig = structuredClone(
      GatewayConfigSchema.parse(validConfig()),
    );
    targetMismatch.routes[0]!.orderedCandidates[0]!.providerId =
      "provider-not-target";
    const mismatchResult = GatewayConfigSchema.safeParse(targetMismatch);
    expect(mismatchResult.success).toBe(false);
    if (!mismatchResult.success)
      expect(mismatchResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["routes", 0, "orderedCandidates", 0],
            message:
              "candidate provider-not-target/fast-chat must match an actual model target",
          }),
        ]),
      );
  });

  it("rejects unknown and self plugin dependencies", () => {
    const config: GatewayConfig = structuredClone(
      GatewayConfigSchema.parse(validConfig()),
    );
    config.plugins[0] = {
      ...config.plugins[0]!,
      before: ["missing-plugin", "authentication"],
    };
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["plugins", 0],
            message: "unknown plugin dependency missing-plugin",
          }),
          expect.objectContaining({
            path: ["plugins", 0],
            message: "plugin cannot depend on itself",
          }),
        ]),
      );
  });

  it("rejects invalid version, hook, URL, header, and numeric values", () => {
    const config: GatewayConfig = structuredClone(
      GatewayConfigSchema.parse(validConfig()),
    );
    config.plugins[0] = {
      ...config.plugins[0]!,
      version: "1.0",
      hooks: ["invalid-hook"],
    } as unknown as GatewayConfig["plugins"][number];
    config.server.cors.origins = ["not-a-url"];
    config.server.metrics.path = "/wrong" as "/metrics";
    config.providers[0]!.customHeaders = { "bad header": "" };
    config.providers[0]!.timeoutMs = 0;
    config.models[0]!.targets[0]!.contextTokens = Number.POSITIVE_INFINITY;
    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["plugins", 0, "version"] }),
          expect.objectContaining({ path: ["plugins", 0, "hooks", 0] }),
          expect.objectContaining({ path: ["server", "cors", "origins", 0] }),
          expect.objectContaining({ path: ["server", "metrics", "path"] }),
          expect.objectContaining({
            path: ["providers", 0, "customHeaders", "bad header"],
          }),
          expect.objectContaining({ path: ["providers", 0, "timeoutMs"] }),
          expect.objectContaining({
            path: ["models", 0, "targets", 0, "contextTokens"],
          }),
        ]),
      );
  });
});
