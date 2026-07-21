import { describe, expect, it } from "vitest";
import {
  ConfigurationCoordinator,
  ConfigurationUnavailableError,
  GatewayConfigSchema,
  createConfiguredPluginRegistry,
  loadConfiguration,
} from "../../src/config/index.js";
import type {
  ConfigurationLoadOptions,
  GatewayConfig,
} from "../../src/config/index.js";
import {
  PluginRegistrationError,
  type PluginResource,
} from "../../src/plugins/index.js";
import type { ClockPort } from "../../src/ports/index.js";

const clock: ClockPort = {
  now: () => 1_700_000_000_000,
  sleep: async () => undefined,
};
const baseConfig = {
  server: {
    port: 11248,
    cors: { origins: ["https://console.example.com"] },
    bodyTimeoutMs: 1,
    requestTimeoutMs: 2,
    streamIdleTimeoutMs: 1,
    logLevel: "info",
    trace: { enabled: false, destination: "stdout" },
    metrics: { enabled: true, path: "/metrics" },
    health: { path: "/health", upstreamCheck: false },
    defaultDryRun: false,
  },
  clients: [
    {
      id: "client-one",
      tokenHashRef: "env:HASH",
      limits: { rpm: 1, tpm: 1, dailyTokens: 1, dailyCostUsd: 0 },
      allowedModelAliases: ["model-one"],
    },
  ],
  providers: [
    {
      id: "provider-one",
      protocol: "custom",
      baseUrl: "https://provider.example",
      timeoutMs: 1,
      customHeaders: {},
      credentials: [{ id: "credential-one", secretRef: "env:KEY", weight: 1 }],
      credentialSelection: "fill-first",
    },
  ],
  models: [
    {
      alias: "model-one",
      targets: [
        {
          providerId: "provider-one",
          physicalModel: "physical",
          pricesPerMillionUsd: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          capabilities: [],
          contextTokens: 1,
        },
      ],
    },
  ],
  routes: [
    {
      id: "route-one",
      modelAliases: ["model-one"],
      orderedCandidates: [
        { providerId: "provider-one", modelAlias: "model-one", weight: 1 },
      ],
      requiredCapabilities: [],
      conditions: [],
      fallbackGroups: [],
      attemptBudget: { maxAttempts: 1, maxLatencyMs: 1, maxCostUsd: 0 },
      statusPolicy: { retryable: [], nonRetryable: [] },
    },
  ],
  plugins: [
    {
      id: "authentication",
      version: "1.0.0",
      enabled: true,
      hooks: [],
      priority: 1,
    },
  ],
};
const config = GatewayConfigSchema.parse(baseConfig);
function freshConfig(): GatewayConfig {
  return structuredClone(config);
}
const operational = {
  pluginsRegistered: true,
  credentials: { active: 1, cooldown: 0, critical_failure: 0, suspended: 0 },
  eligibleCredential: true,
  upstreamChecks: {
    "provider-one": "ok" as const,
    optional: "failed" as const,
  },
  requiredUpstreamProviders: new Set(["provider-one"]),
};

describe("ConfigurationCoordinator", () => {
  it("is live but not ready without configuration", async () => {
    const coordinator = new ConfigurationCoordinator(clock);
    expect(() => coordinator.snapshot()).toThrow(ConfigurationUnavailableError);
    const snapshot = await coordinator.check(new AbortController().signal);
    expect(snapshot).toMatchObject({
      live: true,
      ready: false,
      status: "not_ready",
      port: 11248,
      configValid: false,
      credentials: {
        active: 0,
        cooldown: 0,
        critical_failure: 0,
        suspended: 0,
      },
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      "checkedAt",
      "configValid",
      "credentials",
      "live",
      "pluginsRegistered",
      "port",
      "ready",
      "status",
      "upstreamChecks",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /HASH|KEY|token|secret|provider-body/i,
    );
  });

  it("requires registration and required upstreams, while ignoring optional failures", async () => {
    const coordinator = new ConfigurationCoordinator(clock);
    coordinator.publishValidated(freshConfig());
    coordinator.setOperationalState({
      ...operational,
      pluginsRegistered: false,
    });
    expect((await coordinator.check(new AbortController().signal)).ready).toBe(
      false,
    );
    coordinator.setOperationalState(operational);
    expect(await coordinator.check(new AbortController().signal)).toMatchObject(
      { ready: true, status: "healthy", live: true },
    );
    coordinator.setOperationalState({
      ...operational,
      upstreamChecks: { "provider-one": "failed", optional: "ok" },
    });
    expect((await coordinator.check(new AbortController().signal)).ready).toBe(
      false,
    );
  });

  it("propagates cancellation and preserves atomic A then B snapshots", async () => {
    const coordinator = new ConfigurationCoordinator(clock);
    coordinator.publishValidated(freshConfig());
    const first = coordinator.snapshot();
    const invalidLoadOptions: ConfigurationLoadOptions = {
      resolver: { resolve: async () => "never" },
      signal: new AbortController().signal,
      consumeSecret: () => undefined,
    };
    await expect(
      loadConfiguration("not: [valid", invalidLoadOptions),
    ).rejects.toBeInstanceOf(Error);
    expect(coordinator.snapshot()).toBe(first);
    const replacement = freshConfig();
    replacement.server.defaultDryRun = true;
    coordinator.publishValidated(replacement);
    expect(first.server.defaultDryRun).toBe(false);
    expect(coordinator.snapshot()).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(coordinator.snapshot())).toBe(true);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(coordinator.check(controller.signal)).rejects.toBe(reason);
  });

  it("rejects invalid aggregate state and serializes only safe fields", async () => {
    const coordinator = new ConfigurationCoordinator(clock);
    expect(() =>
      coordinator.setOperationalState({
        ...operational,
        credentials: { ...operational.credentials, active: -1 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      coordinator.setOperationalState({
        ...operational,
        upstreamChecks: { "provider-one": "token" } as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      coordinator.setOperationalState({
        ...operational,
        pluginsRegistered: "token",
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      coordinator.setOperationalState({
        ...operational,
        eligibleCredential: "token",
      } as never),
    ).toThrow(TypeError);
    coordinator.setOperationalState({
      ...operational,
      credentials: { ...operational.credentials, secret: "token" } as never,
    });
    const snapshot = await coordinator.check(new AbortController().signal);
    expect(Object.keys(snapshot.credentials).sort()).toEqual([
      "active",
      "cooldown",
      "critical_failure",
      "suspended",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|secret|provider-body/i);
    expect(Object.isFrozen(snapshot.credentials)).toBe(true);
    expect(Object.isFrozen(snapshot.upstreamChecks)).toBe(true);
  });
  it("keeps readiness closed until configured plugin registration succeeds", async () => {
    const coordinator = new ConfigurationCoordinator(clock);
    coordinator.publishValidated(freshConfig());
    coordinator.setOperationalState({
      ...operational,
      pluginsRegistered: false,
    });
    const mismatched: PluginResource[] = [
      {
        plugin: {
          id: "authentication",
          version: "2.0.0",
          hooks: [],
          priority: 1,
        },
      },
    ];

    expect(() =>
      createConfiguredPluginRegistry(coordinator, mismatched),
    ).toThrow(PluginRegistrationError);
    expect(await coordinator.check(new AbortController().signal)).toMatchObject(
      {
        ready: false,
        status: "not_ready",
        pluginsRegistered: false,
      },
    );

    const registry = createConfiguredPluginRegistry(coordinator, [
      {
        plugin: {
          id: "authentication",
          version: "1.0.0",
          hooks: [],
          priority: 1,
        },
      },
    ]);
    coordinator.setOperationalState({
      ...operational,
      pluginsRegistered: true,
    });
    expect(await coordinator.check(new AbortController().signal)).toMatchObject(
      {
        ready: true,
        status: "healthy",
        pluginsRegistered: true,
      },
    );
    await registry.close();
  });

  it("rejects duplicate, unconfigured, missing, and mismatched implementations", () => {
    const coordinator = new ConfigurationCoordinator(clock);
    coordinator.publishValidated(freshConfig());
    const authentication: PluginResource = {
      plugin: {
        id: "authentication",
        version: "1.0.0",
        hooks: [],
        priority: 1,
      },
    };

    const issues = (resources: ReadonlyArray<PluginResource>) => {
      try {
        createConfiguredPluginRegistry(coordinator, resources);
        throw new Error("expected plugin registration failure");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(PluginRegistrationError);
        return (error as PluginRegistrationError).issues.map(
          (issue) => issue.message,
        );
      }
    };

    expect(issues([authentication, authentication])).toContain(
      "duplicate plugin implementation authentication",
    );
    expect(
      issues([
        {
          plugin: {
            id: "extra-plugin",
            version: "1.0.0",
            hooks: [],
            priority: 1,
          },
        },
      ]),
    ).toEqual([
      "unconfigured plugin implementation extra-plugin",
      "missing plugin implementation authentication",
    ]);
    expect(issues([])).toEqual([
      "missing plugin implementation authentication",
    ]);
    expect(
      issues([
        {
          plugin: {
            id: "authentication",
            version: "1.0.0",
            hooks: [],
            priority: 2,
          },
        },
      ]),
    ).toEqual(["plugin metadata does not match configuration authentication"]);
  });
});
