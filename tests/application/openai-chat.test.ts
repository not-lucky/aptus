import { describe, expect, it } from "vitest";
import { createOpenAiChatTranslatorFamily } from "../../src/adapters/index.js";
import { DefaultGatewayApplication } from "../../src/application/index.js";
import type {
  AdapterRegistry,
  HookTimeoutConfiguration,
  ProviderFactory,
} from "../../src/application/index.js";
import type {
  CanonicalChunk,
  CanonicalResponse,
  RouteCandidate,
} from "../../src/domain/index.js";
import { createGatewayError } from "../../src/domain/index.js";
import { PluginRegistry, RouteValidationPlugin } from "../../src/plugins/index.js";
import type {
  CredentialStatePort,
  ProviderDispatchPort,
  TranslationContext,
} from "../../src/ports/index.js";

const NOW = "2026-07-21T12:00:00.000Z";
const family = createOpenAiChatTranslatorFamily({ now: () => NOW });
const candidates: RouteCandidate[] = [
  {
    routeId: "route",
    providerId: "provider",
    credentialId: "credential",
    physicalModel: "physical-model",
    capabilities: new Set(["tools", "multiple_choices"]),
    estimatedCostUsd: 0,
  },
];
const response: CanonicalResponse = {
  requestId: "req_openai_application",
  responseId: "chatcmpl_application",
  createdAt: NOW,
  model: "physical-model",
  status: "completed",
  choices: [
    {
      index: 0,
      output: [{ type: "text", text: "done" }],
      finishReason: "stop",
    },
  ],
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
    physicalModel: "physical-model",
    responseHeaders: {},
    upstreamStatus: 200,
  },
};
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
  ].map((name) => [name, { timeoutMs: 1000, retryable: false }]),
) as unknown as HookTimeoutConfiguration;
const credentials: CredentialStatePort = {
  state: () => "active",
  snapshot: () => ({ state: "active", penaltyCount: 0 }),
  eligible: () => true,
  hasEligible: () => true,
  counts: () => ({
    active: 1,
    cooldown: 0,
    critical_failure: 0,
    suspended: 0,
  }),
  failure: () => ({ state: "cooldown", delayMs: 1, retryable: true }),
  success: () => undefined,
  quarantine: () => undefined,
  reset: () => undefined,
  probe: () => undefined,
};

function application(
  dispatch: ProviderDispatchPort,
  resolved = candidates,
  calls = { dispatch: 0, stream: 0, create: 0 },
): { app: DefaultGatewayApplication; calls: typeof calls } {
  const adapters: AdapterRegistry = {
    ingress: () => family.ingress,
    egress: () => family.egress,
  };
  const providers: ProviderFactory = {
    create: () => {
      calls.create += 1;
      return {
        dispatch: async (...args) => {
          calls.dispatch += 1;
          return dispatch.dispatch(...args);
        },
        stream: (...args) => {
          calls.stream += 1;
          return dispatch.stream(...args);
        },
      };
    },
  };
  const hooks = new PluginRegistry([
    {
      plugin: {
        id: "authentication",
        version: "1.0.0",
        hooks: [],
        priority: -1,
      },
      enabled: true,
    },
    { plugin: new RouteValidationPlugin(), enabled: true },
    {
      plugin: {
        id: "estimate",
        version: "1.0.0",
        hooks: ["beforeUpstreamDispatch"],
        priority: 10,
        beforeUpstreamDispatch: (context, value) => {
          context.setState("dispatch:cost-estimate", {
            usage: response.usage,
            cost: response.cost,
          });
          return { kind: "continue" as const, value };
        },
      },
      enabled: true,
    },
  ]);
  return {
    calls,
    app: new DefaultGatewayApplication({
      adapters,
      hooks,
      routes: { resolve: async () => resolved },
      providers,
      clock: {
        now: () => 0,
        sleep: async (_delay, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
      requestIds: () => response.requestId,
      hookTimeouts: timeouts,
      auth: { authenticate: async () => undefined },
      dispatchPolicies: {
        snapshot: () => ({
          defaultDryRun: false,
          resolve: () => ({
            attemptBudget: {
              maxAttempts: 1,
              maxLatencyMs: 1000,
              maxCostUsd: 1,
            },
            statusPolicy: { retryable: [], nonRetryable: [] },
            providerTimeoutMs: 100,
            streamIdleTimeoutMs: 100,
            contextTokens: 100,
          }),
        }),
      },
      credentials,
      trace: { record: async () => undefined },
    }),
  };
}

const successDispatch: ProviderDispatchPort = {
  dispatch: async (_candidate, request) => ({
    ...response,
    requestId: request.requestId,
  }),
  stream: async function* (_candidate, request) {
    yield {
      type: "response_start",
      responseId: response.responseId,
      model: response.model,
      createdAt: response.createdAt,
    };
    yield {
      type: "text_delta",
      address: { choiceIndex: 0, outputIndex: 0 },
      text: "done",
    };
    yield { type: "choice_end", choiceIndex: 0, finishReason: "stop" };
    yield { type: "usage", usage: response.usage };
    if (request.model.length > 0) yield { type: "response_end", status: "completed" };
  },
};

function raw(body: unknown, path = "/v1/chat/completions") {
  return { path, headers: {}, body, requestId: response.requestId };
}

function translationContext(streamResponse?: TranslationContext["streamResponse"]): TranslationContext {
  return {
    requestId: response.requestId,
    signal: new AbortController().signal,
    trustedRoutingHeaders: {},
    ...(streamResponse === undefined ? {} : { streamResponse }),
  };
}

async function collect(iterable: AsyncIterable<CanonicalChunk>): Promise<CanonicalChunk[]> {
  const chunks: CanonicalChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("DefaultGatewayApplication with OpenAI Chat translator", () => {
  it.each(["/chat/completions", "/v1/chat/completions"])(
    "handles %s and encodes observable Chat JSON",
    async (path) => {
      const fixture = application(successDispatch);
      const result = await fixture.app.handle(
        raw({ model: "logical-model", messages: [{ role: "user", content: "hello" }] }, path),
      );
      expect(result).toMatchObject({ responseId: response.responseId });
      expect(fixture.calls).toMatchObject({ create: 1, dispatch: 1, stream: 0 });
      const encoded = family.egress.encodeResponse(
        result as CanonicalResponse,
        translationContext(),
      );
      expect(encoded).toMatchObject({
        id: response.responseId,
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "done" } }],
      });
    },
  );

  it.each([
    [{ model: "", messages: [{ role: "user", content: "x" }] }, 400, "invalid_model"],
    [{ model: "m", messages: [{ role: "user", content: [{ type: "unknown" }] }] }, 422, "unsupported_openai_chat_semantics"],
  ] as const)("rejects invalid input before provider dispatch %#", async (body, status, code) => {
    const fixture = application(successDispatch);
    const result = await fixture.app.handle(raw(body));
    expect(result).toMatchObject({ status, code, retryable: false });
    expect(fixture.calls).toEqual({ dispatch: 0, stream: 0, create: 0 });
  });

  it("infers multiple_choices and route validation blocks incompatible candidates", async () => {
    const incompatible: RouteCandidate = {
      ...candidates[0]!,
      capabilities: new Set(["tools"]),
    };
    const fixture = application(successDispatch, [incompatible]);
    const result = await fixture.app.handle(
      raw({
        model: "logical-model",
        messages: [{ role: "user", content: "hello" }],
        n: 2,
      }),
    );
    expect(result).toMatchObject({
      category: "authorization",
      status: 403,
      code: "model_not_authorized",
    });
    expect(fixture.calls).toEqual({ dispatch: 0, stream: 0, create: 0 });
  });

  it("streams canonical output and encodes exact SSE termination", async () => {
    const fixture = application(successDispatch);
    const chunks = await collect(
      fixture.app.stream(
        raw({
          model: "logical-model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      ),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response_start",
      "text_delta",
      "choice_end",
      "usage",
      "response_end",
    ]);
    expect(fixture.calls).toMatchObject({ create: 1, dispatch: 0, stream: 1 });
    const metadata = chunks[0];
    expect(metadata?.type).toBe("response_start");
    const streamContext = translationContext(
      metadata?.type === "response_start"
        ? Object.freeze({
            responseId: metadata.responseId,
            model: metadata.model,
            createdAt: metadata.createdAt,
          })
        : undefined,
    );
    const frames = chunks.map((chunk, index) =>
      family.egress.encodeChunk(
        chunk,
        index === 0 ? translationContext() : streamContext,
      ),
    );
    expect(frames.at(-1)).toEqual(
      expect.stringMatching(/data: \[DONE\]\n\n$/),
    );
  });

  it("encodes typed mid-stream errors followed by the exact terminator", async () => {
    const streamError = createGatewayError({
      category: "upstream",
      code: "provider_stream_failed",
      message: "Provider stream failed.",
      requestId: response.requestId,
      providerId: "provider-secret",
      credentialId: "credential-secret",
    });
    const failing: ProviderDispatchPort = {
      dispatch: successDispatch.dispatch,
      stream: async function* () {
        yield {
          type: "response_start",
          responseId: response.responseId,
          model: response.model,
          createdAt: response.createdAt,
        } as const;
        yield { type: "error", error: streamError } as const;
      },
    };
    const fixture = application(failing);
    const chunks = await collect(
      fixture.app.stream(
        raw({ model: "logical-model", messages: [{ role: "user", content: "hello" }], stream: true }),
      ),
    );
    const error = chunks.find((chunk) => chunk.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected stream error.");
    const encoded = family.egress.encodeChunk(error, translationContext());
    expect(encoded).toBe(
      `data: ${JSON.stringify(family.egress.encodeError(error.error, translationContext()))}\n\ndata: [DONE]\n\n`,
    );
    expect(JSON.stringify(encoded)).not.toContain("provider-secret");
    expect(JSON.stringify(encoded)).not.toContain("credential-secret");
  });
});
