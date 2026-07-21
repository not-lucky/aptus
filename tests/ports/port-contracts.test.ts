import { describe, expect, it } from "vitest";
import { redactValue } from "../../src/domain/index.js";
import type {
  CachePort,
  ClockPort,
  CredentialStorePort,
  HealthPort,
  LoggerPort,
  MetricsPort,
  ProviderTransportPort,
  RateLimitPort,
  RouteConfigPort,
  SecretResolverPort,
  TracePort,
} from "../../src/ports/index.js";

describe("core capability ports", () => {
  it("preserves cancellation, bounded streams, cleanup, and redacted observations", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let sleptWith: AbortSignal | undefined;
    const clock: ClockPort = {
      now: () => 1_700_000_000_000,
      sleep: async (_delay, observed) => {
        sleptWith = observed;
      },
    };
    await clock.sleep(1, signal);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(sleptWith).toBe(signal);

    const transport: ProviderTransportPort<{ request: string }, { ok: true }> =
      {
        request: async (_request, observed) => {
          expect(observed).toBe(signal);
          return { ok: true };
        },
        stream: async function* (_request, observed) {
          expect(observed).toBe(signal);
          yield new Uint8Array([1, 2]);
        },
      };
    expect(await transport.request({ request: "x" }, signal)).toEqual({
      ok: true,
    });
    const chunks = [];
    for await (const chunk of transport.stream({ request: "x" }, signal))
      chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2])]);

    const secrets: SecretResolverPort = {
      resolve: async (reference, observed) => {
        expect(observed).toBe(signal);
        return `${reference}-resolved`;
      },
    };
    expect(await secrets.resolve("ref", signal)).toBe("ref-resolved");
    let storeSignal: AbortSignal | undefined;
    const store: CredentialStorePort<{ token: string }> = {
      get: async (id, observed) => {
        storeSignal = observed;
        return id === "credential" ? { token: "safe" } : undefined;
      },
      set: async (_id, _value, observed) => {
        storeSignal = observed;
      },
    };
    expect(await store.get("credential", signal)).toEqual({ token: "safe" });
    expect(await store.get("missing", signal)).toBeUndefined();
    expect(storeSignal).toBe(signal);

    const snapshot = { route: "route" };
    const config: RouteConfigPort<{ route: string }> = {
      snapshot: () => snapshot,
    };
    expect(config.snapshot()).toBe(snapshot);
    let cachedKey = "";
    let cachedValue = "";
    let cacheSignal: AbortSignal | undefined;
    const cache: CachePort<string> = {
      get: async (key, observed) => {
        cacheSignal = observed;
        return key === "hit" ? "value" : undefined;
      },
      set: async (key, value, observed) => {
        cachedKey = key;
        cachedValue = value;
        cacheSignal = observed;
      },
    };
    expect(await cache.get("hit", signal)).toBe("value");
    expect(await cache.get("miss", signal)).toBeUndefined();
    await cache.set("hit", "value", signal);
    expect([cachedKey, cachedValue, cacheSignal]).toEqual([
      "hit",
      "value",
      signal,
    ]);

    let reservedSignal: AbortSignal | undefined;
    let released = false;
    const limits: RateLimitPort<string, string> = {
      reserve: async (_request, observed) => {
        reservedSignal = observed;
        return "reservation";
      },
      release: async () => {
        released = true;
      },
    };
    const reservation = await limits.reserve("request", signal);
    expect(reservedSignal).toBe(signal);
    controller.abort();
    await limits.release(reservation);
    expect(released).toBe(true);

    const observations: string[] = [];
    const labels = { route: "test" };
    const metrics: MetricsPort = {
      incrementCounter: (name) => observations.push(name),
      observeHistogram: (name) => observations.push(name),
      setGauge: (name) => observations.push(name),
    };
    metrics.incrementCounter("counter", 1, labels);
    metrics.observeHistogram("histogram", 1, labels);
    metrics.setGauge("gauge", 1, labels);
    expect(observations).toEqual(["counter", "histogram", "gauge"]);
    let healthSignal: AbortSignal | undefined;
    const health: HealthPort<{ healthy: true }> = {
      check: async (observed) => {
        healthSignal = observed;
        return { healthy: true };
      },
    };
    expect(await health.check(signal)).toEqual({ healthy: true });
    expect(healthSignal).toBe(signal);

    const sensitive = "fixture-secret";
    const redacted = redactValue({
      token: sensitive,
      requestId: "req",
    }) as Record<string, unknown>;
    const traces: unknown[] = [];
    const logs: unknown[] = [];
    const trace: TracePort = {
      record: async (entry) => {
        traces.push(entry);
      },
    };
    const logger: LoggerPort = {
      log: async (entry) => {
        logs.push(entry);
      },
    };
    await trace.record(redacted as never);
    await logger.log(redacted as never);
    expect(JSON.stringify(traces)).not.toContain(sensitive);
    expect(JSON.stringify(logs)).not.toContain(sensitive);
  });
});
