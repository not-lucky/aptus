import { describe, expect, it } from "vitest";
import { DefaultGatewayApplication } from "../../src/application/index.js";
import type {
  GatewayPlugin,
  HookManager,
  HookTimeoutConfiguration,
} from "../../src/application/index.js";
import {
  PluginRegistry,
  type PluginRegistration,
} from "../../src/plugins/index.js";
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
} from "../../src/domain/index.js";
import type {
  AdapterRegistry,
  ProviderFactory,
  RouteResolver,
} from "../../src/application/index.js";
import type {
  ClockPort,
  ProviderDispatchPort,
  RawIngressInput,
} from "../../src/ports/index.js";

const requestId = "req-lifecycle";
const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential",
  physicalModel: "model",
  capabilities: new Set(),
  estimatedCostUsd: 0,
};
const request: CanonicalRequest = {
  requestId,
  receivedAt: "2026-07-19T00:00:00Z",
  source: { adapter: "custom", protocol: "custom", path: "/v1/custom" },
  model: "test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  routing: {},
  stream: false,
};
const streamRequest = { ...request, stream: true };
const response: CanonicalResponse = {
  requestId,
  responseId: "response",
  createdAt: "2026-07-19T00:00:00Z",
  model: "test",
  status: "completed",
  choices: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  cost: {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    totalUsd: 0,
    currency: "USD",
  },
  provider: {
    providerId: "provider",
    credentialId: "credential",
    physicalModel: "model",
    responseHeaders: {},
    upstreamStatus: 200,
  },
};
const chunks: CanonicalChunk[] = [
  {
    type: "response_start",
    responseId: "response",
    model: "test",
    createdAt: "2026-07-19T00:00:00Z",
  },
  {
    type: "text_delta",
    address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
    text: "hello",
  },
  { type: "response_end", status: "completed" },
];

const hookTimeouts: HookTimeoutConfiguration = {
  onIngressReceived: { timeoutMs: 1000, retryable: false },
  onCanonicalTranslate: { timeoutMs: 1000, retryable: false },
  onRouteResolve: { timeoutMs: 1000, retryable: true },
  beforeUpstreamDispatch: { timeoutMs: 1000, retryable: true },
  onUpstreamResponse: { timeoutMs: 1000, retryable: true },
  onStreamChunk: { timeoutMs: 1000, retryable: true },
  onEgressTranslate: { timeoutMs: 1000, retryable: false },
  onError: { timeoutMs: 1000, retryable: false },
};

function plugin(
  id: string,
  hooks: GatewayPlugin["hooks"] = [],
  overrides: Partial<GatewayPlugin> = {},
): GatewayPlugin {
  return { id, version: "1.0.0", hooks, priority: 0, ...overrides };
}
function registry(plugins: ReadonlyArray<GatewayPlugin>): HookManager {
  const registrations: PluginRegistration[] = [
    { plugin: plugin("authentication"), enabled: true },
    ...plugins.map((value) => ({ plugin: value, enabled: true })),
  ];
  return new PluginRegistry(registrations);
}
function clock(): ClockPort {
  return {
    now: () => 0,
    sleep: (_delay, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  };
}
function setup(
  dispatch: ProviderDispatchPort,
  hooks: HookManager,
  ingressRequest = request,
): { app: DefaultGatewayApplication; input: RawIngressInput } {
  const ingress = {
    protocol: "custom" as const,
    paths: new Set(["/v1/custom"]),
    canTranslate: () => true,
    translate: () => ingressRequest,
  };
  const egress = {
    protocol: "custom" as const,
    encodeResponse: () => "encoded-response",
    encodeChunk: () => "encoded-chunk",
    encodeError: () => "encoded-error",
  };
  const adapters: AdapterRegistry = {
    ingress: () => ingress,
    egress: () => egress,
  };
  const routes: RouteResolver = { resolve: async () => [candidate] };
  const providers: ProviderFactory = { create: () => dispatch };
  const app = new DefaultGatewayApplication({
    adapters,
    hooks,
    routes,
    providers,
    clock: clock(),
    requestIds: () => requestId,
    hookTimeouts,
  });
  return {
    app,
    input: {
      path: "/v1/custom",
      headers: {},
      body: { model: "test" },
      requestId,
    },
  };
}

describe("DefaultGatewayApplication lifecycle", () => {
  it("runs canonical stages in order and exposes egress only on an exchange", async () => {
    const events: string[] = [];
    let undone = 0;
    const hooks = registry([
      plugin(
        "order",
        [
          "onIngressReceived",
          "onCanonicalTranslate",
          "onRouteResolve",
          "beforeUpstreamDispatch",
          "onUpstreamResponse",
          "onEgressTranslate",
        ],
        {
          onIngressReceived: async (context, value) => {
            events.push("onIngressReceived");
            await context.execute({
              execute: async () => undefined,
              undo: async () => {
                undone += 1;
              },
            });
            return { kind: "continue", value };
          },
          onCanonicalTranslate: (_context, value) => {
            events.push("onCanonicalTranslate");
            return { kind: "continue", value };
          },
          onRouteResolve: (_context, value) => {
            events.push("onRouteResolve");
            return { kind: "continue", value };
          },
          beforeUpstreamDispatch: (_context, value) => {
            events.push("beforeUpstreamDispatch");
            return { kind: "continue", value };
          },
          onUpstreamResponse: (_context, value) => {
            events.push("onUpstreamResponse");
            return { kind: "continue", value };
          },
          onEgressTranslate: (_context, value) => {
            events.push("onEgressTranslate");
            return { kind: "continue", value };
          },
        },
      ),
    ]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => {
        events.push("dispatch");
        return response;
      },
      stream: async function* () {
        yield chunks[0]!;
      },
    };
    const { app, input } = setup(dispatch, hooks);
    expect(await app.handle(input)).toBe(response);
    expect(events).toEqual([
      "onIngressReceived",
      "onCanonicalTranslate",
      "onRouteResolve",
      "beforeUpstreamDispatch",
      "dispatch",
      "onUpstreamResponse",
    ]);
    const exchange = app.open(input);
    const canonical = await exchange.handle();
    expect(canonical).toBe(response);
    const encoded = await exchange.runEgress("encoded-response");
    expect(encoded).toBe("encoded-response");
    expect(events.at(-1)).toBe("onEgressTranslate");
    await exchange.close();
    expect(undone).toBe(2);
  });

  it("gates exchange stream reads on egress and closes the provider iterator", async () => {
    let reads = 0;
    let returned = 0;
    const iterator: AsyncIterator<CanonicalChunk> = {
      next: async () => {
        reads += 1;
        const chunk = chunks[reads - 1];
        return chunk === undefined
          ? { done: true, value: undefined }
          : { done: false, value: chunk };
      },
      return: async () => {
        returned += 1;
        return { done: true, value: undefined };
      },
    };
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    };
    const { app, input } = setup(dispatch, registry([]), streamRequest);
    const exchange = app.open(input);
    const stream = exchange.stream()[Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe("response_start");
    expect(reads).toBe(1);
    expect(await exchange.runEgress("encoded-chunk")).toBe("encoded-chunk");
    expect((await stream.next()).value?.type).toBe("text_delta");
    expect(reads).toBe(2);
    await stream.return?.();
    await exchange.close();
    expect(returned).toBe(1);
  });

  it("returns fixed safe errors for invalid request IDs without adapter access", async () => {
    let lookedUp = false;
    const hooks = registry([]);
    const dispatch: ProviderDispatchPort = {
      dispatch: async () => response,
      stream: async function* () {
        yield chunks[0]!;
      },
    };
    const { input } = setup(dispatch, hooks);
    const bad: RawIngressInput = {
      ...input,
      requestId: "bad id",
      body: { secret: "fixture-secret" },
    };
    const invalidApp = new DefaultGatewayApplication({
      adapters: {
        ingress: () => {
          lookedUp = true;
          throw new Error("secret");
        },
        egress: () => {
          throw new Error("secret");
        },
      },
      hooks,
      routes: { resolve: async () => [] },
      providers: { create: () => dispatch },
      clock: clock(),
      requestIds: () => requestId,
      hookTimeouts,
    });
    const result = await invalidApp.handle(bad);
    expect(result).toMatchObject({
      code: "invalid_request_id",
      message: "invalid request ID",
      status: 400,
      requestId: "bad id",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(lookedUp).toBe(false);
  });
});
