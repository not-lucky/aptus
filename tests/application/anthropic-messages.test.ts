import { describe, expect, it } from "vitest";
import {
  CanonicalStreamEngine,
  SseProviderStreamParser,
  createAnthropicMessagesTranslatorFamily,
  decodeCanonicalEvent,
  type ProviderAdapterLimits,
} from "../../src/adapters/index.js";
import {
  DefaultGatewayApplication,
  type AdapterRegistry,
  type HookTimeoutConfiguration,
  type ProviderFactory,
} from "../../src/application/index.js";
import type {
  CanonicalChunk,
  CanonicalResponse,
} from "../../src/domain/index.js";
import { createGatewayError } from "../../src/domain/index.js";
import {
  ConfiguredDispatchPolicyPort,
  ConfiguredRouteResolver,
  GatewayConfigSchema,
} from "../../src/config/index.js";
import {
  AuthenticationPlugin,
  CostAuditPlugin,
  PluginRegistry,
  RouteValidationPlugin,
} from "../../src/plugins/index.js";
import {
  CredentialStateMachine,
  createStreamTranslationState,
  type ProviderTransportPort,
  type TranslationContext,
} from "../../src/ports/index.js";

const NOW = "2026-07-22T00:00:00.000Z";
const REQUEST_ID = "req_anthropic_application";
const RESPONSE_ID = "resp_anthropic_application";
const family = createAnthropicMessagesTranslatorFamily({ now: () => NOW });

interface Calls {
  request: number;
  stream: number;
  finalized: number;
  aborted: number;
  create: number;
}

const limits: ProviderAdapterLimits = {
  maxBodyBytes: 64 * 1024,
  maxFrameBytes: 16 * 1024,
  maxToolArgumentsBytes: 16 * 1024,
  queueCapacity: 16,
  highWaterMark: 12,
  lowWaterMark: 4,
};

const response: CanonicalResponse = {
  requestId: REQUEST_ID,
  responseId: RESPONSE_ID,
  createdAt: NOW,
  model: "logical-model",
  status: "completed",
  choices: [
    {
      index: 0,
      output: [{ type: "text", text: "done" }],
      finishReason: "stop",
    },
  ],
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  cost: {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    totalUsd: 0,
    currency: "USD",
  },
  provider: {
    providerId: "provider-one",
    credentialId: "credential-one",
    physicalModel: "anthropic-model",
    responseHeaders: {},
    upstreamStatus: 200,
  },
};

const config = GatewayConfigSchema.parse({
  server: {
    port: 11248,
    cors: { origins: ["https://example.test"] },
    bodyTimeoutMs: 100,
    requestTimeoutMs: 1000,
    streamIdleTimeoutMs: 200,
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
      allowedModelAliases: ["logical-model"],
      limits: { rpm: 10, tpm: 1000, dailyTokens: 1000, dailyCostUsd: 10 },
    },
  ],
  providers: [
    {
      id: "provider-one",
      protocol: "anthropic-messages",
      baseUrl: "https://example.test",
      timeoutMs: 300,
      customHeaders: {},
      credentials: [
        { id: "credential-one", secretRef: "env:ANTHROPIC_KEY", weight: 1 },
      ],
      credentialSelection: "fill-first",
    },
  ],
  models: [
    {
      alias: "logical-model",
      targets: [
        {
          providerId: "provider-one",
          physicalModel: "anthropic-model",
          pricesPerMillionUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          capabilities: [],
          contextTokens: 4096,
        },
      ],
    },
  ],
  routes: [
    {
      id: "route-one",
      modelAliases: ["logical-model"],
      orderedCandidates: [
        { providerId: "provider-one", modelAlias: "logical-model", weight: 1 },
      ],
      requiredCapabilities: [],
      conditions: [],
      fallbackGroups: [],
      attemptBudget: { maxAttempts: 1, maxLatencyMs: 900, maxCostUsd: 1 },
      statusPolicy: { retryable: [500], nonRetryable: [503] },
    },
  ],
  plugins: [
    {
      id: "authentication",
      version: "1.0.0",
      enabled: true,
      hooks: ["onIngressReceived"],
      priority: -100,
    },
    {
      id: "route-validation",
      version: "1.0.0",
      enabled: true,
      hooks: ["onRouteResolve"],
      priority: 0,
    },
    {
      id: "cost-audit",
      version: "1.0.0",
      enabled: true,
      hooks: ["beforeUpstreamDispatch", "onUpstreamResponse", "onStreamChunk"],
      priority: 10,
    },
  ],
});
const timeouts = Object.fromEntries(
  [
    "onIngressReceived",
    "onCanonicalTranslate",
    "onRouteResolve",
    "beforeUpstreamDispatch",
    "onUpstreamResponse",
    "onStreamChunk",
    "onEgressTranslate",
    "onError",
  ].map((hook) => [hook, { timeoutMs: 1000, retryable: false }]),
) as unknown as HookTimeoutConfiguration;

function sse(chunks: ReadonlyArray<CanonicalChunk>): Uint8Array {
  return new TextEncoder().encode(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
  );
}

function transportFor(
  streamChunks: ReadonlyArray<CanonicalChunk>,
  calls: Calls,
): ProviderTransportPort<
  { requestId: string; stream: boolean },
  CanonicalResponse
> {
  return {
    request: async (_request, _signal) => {
      calls.request += 1;
      return response;
    },
    stream: (_request, signal) => {
      calls.stream += 1;
      signal.addEventListener(
        "abort",
        () => {
          calls.aborted += 1;
        },
        { once: true },
      );
      const bytes = sse(streamChunks);
      const cuts = [
        Math.floor(bytes.byteLength / 3),
        Math.floor((bytes.byteLength * 2) / 3),
      ];
      const fragments = [
        bytes.slice(0, cuts[0]),
        bytes.slice(cuts[0], cuts[1]),
        bytes.slice(cuts[1]),
      ];
      let index = 0;
      let finalized = false;
      const iterator: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (signal.aborted || index >= fragments.length) {
            return { done: true, value: undefined as never };
          }
          const value = fragments[index];
          index += 1;
          return value === undefined
            ? { done: true, value: undefined as never }
            : { done: false, value };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          if (!finalized) {
            finalized = true;
            calls.finalized += 1;
          }
          return { done: true, value: undefined as never };
        },
      };
      return iterator;
    },
  };
}

function engine(
  transport: ProviderTransportPort<
    { requestId: string; stream: boolean },
    CanonicalResponse
  >,
): CanonicalStreamEngine<
  { requestId: string; stream: boolean },
  CanonicalResponse
> {
  return new CanonicalStreamEngine({
    transport,
    buildRequest: (_selected, request) => ({
      requestId: request.requestId,
      stream: request.stream,
    }),
    decodeResponse: (value) => value,
    createParser: () => new SseProviderStreamParser(decodeCanonicalEvent, limits),
    limits,
    requestId: (request) => request.requestId,
  });
}

function application(
  transport: ProviderTransportPort<
    { requestId: string; stream: boolean },
    CanonicalResponse
  >,
  calls: Calls,
): DefaultGatewayApplication {
  const credentials = new CredentialStateMachine(["credential-one"], {
    clock: {
      now: () => 0,
      sleep: async (_delay, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    },
    random: () => 0,
    audit: { record: () => undefined },
  });
  const configuration = { snapshot: () => config };
  const routes = new ConfiguredRouteResolver({
    configuration,
    credentials,
    estimate: () => ({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
    estimateLatencyMs: () => 1,
  });
  const policy = new ConfiguredDispatchPolicyPort({ configuration });
  const auth = {
    authenticate: async () => ({
      clientId: "client-one",
      allowedModelAliases: new Set(["logical-model"]),
      limits: {
        rpm: 10,
        tpm: 1000,
        dailyTokens: 1000,
        dailyCostUsd: 10,
      },
      dryRun: false,
    }),
  };
  const hooks = new PluginRegistry([
    {
      plugin: new AuthenticationPlugin({ auth, tokenHashAlgorithm: "sha256" }),
      enabled: true,
    },
    { plugin: new RouteValidationPlugin(), enabled: true },
    {
      plugin: new CostAuditPlugin({
        estimate: () => ({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
        prices: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      }),
      enabled: true,
    },
  ]);
  const provider = engine(transport);
  const providers: ProviderFactory = {
    create: () => {
      calls.create += 1;
      return provider;
    },
  };
  const adapters: AdapterRegistry = {
    ingress: () => family.ingress,
    egress: () => family.egress,
  };
  return new DefaultGatewayApplication({
    adapters,
    hooks,
    routes,
    providers,
    clock: {
      now: () => 0,
      sleep: async (_delay, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    },
    requestIds: () => REQUEST_ID,
    hookTimeouts: timeouts,
    auth,
    dispatchPolicies: policy,
    credentials,
    trace: { record: async () => undefined },
  });
}

function input(path: string, body: unknown, signal?: AbortSignal) {
  return {
    path,
    headers: {},
    body,
    requestId: REQUEST_ID,
    ...(signal === undefined ? {} : { signal }),
  };
}

function context(state = createStreamTranslationState()): TranslationContext {
  return {
    requestId: REQUEST_ID,
    signal: new AbortController().signal,
    trustedRoutingHeaders: {},
    streamState: state,
  };
}

const basicBody = {
  model: "logical-model",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
};

describe("Anthropic Messages application boundary", () => {
  it.each(["/messages", "/v1/messages"])(
    "selects configured route and handles non-stream %s",
    async (path) => {
      const calls: Calls = {
        request: 0,
        stream: 0,
        finalized: 0,
        aborted: 0,
        create: 0,
      };
      const app = application(transportFor([], calls), calls);
      const result = await app.handle(input(path, basicBody));
      expect(result).toMatchObject({
        responseId: RESPONSE_ID,
        model: "logical-model",
        status: "completed",
      });
      expect(calls).toEqual({
        request: 1,
        stream: 0,
        finalized: 0,
        aborted: 0,
        create: 1,
      });
    },
  );

  it("streams six canonical events through the application and Anthropic closure", async () => {
    const calls: Calls = {
      request: 0,
      stream: 0,
      finalized: 0,
      aborted: 0,
      create: 0,
    };
    const chunks: CanonicalChunk[] = [
      {
        type: "response_start",
        responseId: RESPONSE_ID,
        model: "logical-model",
        createdAt: NOW,
      },
      {
        type: "content_block_start",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
        block: { type: "text", id: "text-1" },
      },
      {
        type: "text_delta",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
        text: "done",
      },
      {
        type: "content_block_stop",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
      },
      { type: "choice_end", choiceIndex: 0, finishReason: "stop" },
      { type: "response_end", status: "completed" },
    ];
    const app = application(transportFor(chunks, calls), calls);
    const exchange = app.open(
      input("/v1/messages", { ...basicBody, stream: true }),
    );
    const iterator = exchange.stream()[Symbol.asyncIterator]();
    const frames: string[] = [];
    const streamContext = context();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const encoded = await exchange.runEgress(
        family.egress.encodeChunk(next.value, streamContext),
      );
      if (typeof encoded !== "string") throw new Error("Unexpected egress value.");
      frames.push(encoded);
      exchange.commitEgress();
    }
    await exchange.close();
    const output = frames.join("");
    expect(calls).toEqual({
      request: 0,
      stream: 1,
      finalized: 1,
      aborted: 0,
      create: 1,
    });
    expect(output).toContain("event: message_start");
    expect(output).toContain("event: content_block_start");
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain("event: content_block_stop");
    expect(output).toContain("event: message_delta");
    expect(output).toContain("event: message_stop");
    expect(output).not.toContain("[DONE]");
  });

  it("rejects malformed ingress before provider creation", async () => {
    const calls: Calls = {
      request: 0,
      stream: 0,
      finalized: 0,
      aborted: 0,
      create: 0,
    };
    const app = application(transportFor([], calls), calls);
    const result = await app.handle(
      input("/messages", {
        model: "logical-model",
        max_tokens: 0,
        messages: [],
      }),
    );
    expect(result).toMatchObject({ status: 400, retryable: false });
    expect(calls).toEqual({
      request: 0,
      stream: 0,
      finalized: 0,
      aborted: 0,
      create: 0,
    });
  });

  it("emits typed canonical error closure without success reason", () => {
    const state = createStreamTranslationState();
    const ctx = context(state);
    family.egress.encodeChunk(
      {
        type: "response_start",
        responseId: RESPONSE_ID,
        model: "logical-model",
        createdAt: NOW,
      },
      ctx,
    );
    family.egress.encodeChunk(
      {
        type: "content_block_start",
        address: { choiceIndex: 0, outputIndex: 0 },
        block: { type: "text" },
      },
      ctx,
    );
    const error = createGatewayError({
      category: "upstream",
      code: "provider_stream_failed",
      message: "Provider stream failed.",
      requestId: REQUEST_ID,
      status: 502,
      retryable: false,
    });
    const closure = family.egress.encodeChunk({ type: "error", error }, ctx);
    expect(closure).toMatch(
      /event: error[\s\S]*event: content_block_stop[\s\S]*event: message_delta[\s\S]*event: message_stop/,
    );
    expect(closure).toContain('"stop_reason":null');
    expect(closure).not.toContain("provider_stream_failed");
    expect(state.terminal).toBe(true);
  });

  it("propagates consumer abort and finalizes transport iterator once", async () => {
    const calls: Calls = {
      request: 0,
      stream: 0,
      finalized: 0,
      aborted: 0,
      create: 0,
    };
    const chunks: CanonicalChunk[] = [
      {
        type: "response_start",
        responseId: RESPONSE_ID,
        model: "logical-model",
        createdAt: NOW,
      },
    ];
    const controller = new AbortController();
    const app = application(transportFor(chunks, calls), calls);
    const exchange = app.open(
      input(
        "/messages",
        { ...basicBody, stream: true },
        controller.signal,
      ),
    );
    const iterator = exchange.stream()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done) {
      const encoded = await exchange.runEgress(
        family.egress.encodeChunk(first.value, context()),
      );
      expect(typeof encoded).toBe("string");
      exchange.commitEgress();
    }
    expect(first.done).toBe(false);
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await exchange.close();
    expect((await iterator.next()).done).toBe(true);
    await iterator.return?.();
    expect(calls.stream).toBe(1);
    expect(calls.finalized).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.request).toBe(0);
  });
});
