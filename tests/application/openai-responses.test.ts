import { describe, expect, it } from "vitest";
import { createOpenAiResponsesTranslatorFamily } from "../../src/adapters/index.js";
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
import {
  createStreamTranslationState,
  type CredentialStatePort,
  type ProviderDispatchPort,
  type StreamTranslationState,
  type TranslationContext,
} from "../../src/ports/index.js";

const NOW = "2026-07-21T12:00:00.000Z";
const REQUEST_ID = "req_responses_application";
const family = createOpenAiResponsesTranslatorFamily({ now: () => NOW });
const candidates: RouteCandidate[] = [
  {
    routeId: "route",
    providerId: "provider",
    credentialId: "credential",
    physicalModel: "physical-model",
    capabilities: new Set(["tools", "server_tools", "mcp", "reasoning"]),
    estimatedCostUsd: 0,
  },
];
const canonicalResponse: CanonicalResponse = {
  requestId: REQUEST_ID,
  responseId: "resp_application",
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
            usage: canonicalResponse.usage,
            cost: canonicalResponse.cost,
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
      routes: { resolve: async () => candidates },
      providers,
      clock: {
        now: () => 0,
        sleep: async (_delay, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
      requestIds: () => REQUEST_ID,
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
    ...canonicalResponse,
    requestId: request.requestId,
    model: request.model,
  }),
  stream: async function* (_candidate, request) {
    yield {
      type: "response_start",
      responseId: canonicalResponse.responseId,
      model: request.model,
      createdAt: NOW,
    };
    yield {
      type: "content_block_start",
      address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
      block: { type: "text", id: "message-1" },
    };
    yield {
      type: "text_delta",
      address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
      text: "done",
    };
    yield {
      type: "content_block_stop",
      address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
      block: { type: "text", id: "message-1", text: "done" },
    };
    yield { type: "choice_end", choiceIndex: 0, finishReason: "stop" };
    yield { type: "usage", usage: canonicalResponse.usage };
    yield { type: "response_end", status: "completed" };
  },
};

function raw(body: unknown, path = "/v1/responses") {
  return { path, headers: {}, body, requestId: REQUEST_ID };
}

function translationContext(
  options: {
    readonly streamState?: StreamTranslationState;
    readonly streamResponse?: TranslationContext["streamResponse"];
  } = {},
): TranslationContext {
  return {
    requestId: REQUEST_ID,
    signal: new AbortController().signal,
    trustedRoutingHeaders: {},
    ...(options.streamState === undefined
      ? {}
      : { streamState: options.streamState }),
    ...(options.streamResponse === undefined
      ? {}
      : { streamResponse: options.streamResponse }),
  };
}

async function collect(iterable: AsyncIterable<CanonicalChunk>): Promise<CanonicalChunk[]> {
  const chunks: CanonicalChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("DefaultGatewayApplication with OpenAI Responses translator", () => {
  it.each(["/responses", "/v1/responses"])(
    "dispatches valid %s input once and preserves source path/protocol",
    async (path) => {
      const fixture = application(successDispatch);
      const result = await fixture.app.handle(
        raw(
          {
            model: "logical-model",
            instructions: "separate",
            input: [
              { type: "message", role: "system", content: "system" },
              { type: "message", role: "developer", content: "developer" },
              { type: "message", role: "user", content: "hello" },
            ],
          },
          path,
        ),
      );
      expect(result).toMatchObject({
        responseId: canonicalResponse.responseId,
        model: "logical-model",
      });
      expect(fixture.calls).toEqual({ dispatch: 1, stream: 0, create: 1 });
      const encoded = family.egress.encodeResponse(
        result as CanonicalResponse,
        translationContext(),
      );
      expect(encoded).toMatchObject({
        id: canonicalResponse.responseId,
        object: "response",
        model: "logical-model",
        output: [{ type: "message", role: "assistant" }],
      });
    },
  );

  it.each([
    [{ model: "", input: "x" }, 400, "invalid_model"],
    [{ model: "m", input: [] }, 400, "invalid_messages"],
    [
      { model: "m", input: [{ type: "unknown" }] },
      422,
      "unsupported_openai_responses_semantics",
    ],
    [
      { model: "m", input: "x", stream_options: { resume_from: 1.5 } },
      400,
      "invalid_resume_metadata",
    ],
  ] as const)(
    "rejects invalid Responses input before provider creation/dispatch %#",
    async (body, status, code) => {
      const fixture = application(successDispatch);
      const result = await fixture.app.handle(raw(body));
      expect(result).toMatchObject({ status, code, retryable: false });
      expect(fixture.calls).toEqual({ dispatch: 0, stream: 0, create: 0 });
    },
  );

  it("streams canonical chunks and direct public egress emits named terminal records", async () => {
    const fixture = application(successDispatch);
    const chunks = await collect(
      fixture.app.stream(
        raw({ model: "logical-model", input: "hello", stream: true }),
      ),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response_start",
      "content_block_start",
      "text_delta",
      "content_block_stop",
      "choice_end",
      "usage",
      "response_end",
    ]);
    expect(fixture.calls).toEqual({ dispatch: 0, stream: 1, create: 1 });
    const streamState = createStreamTranslationState();
    const streamContext = translationContext({ streamState });
    const frames = chunks.map((chunk) =>
      family.egress.encodeChunk(chunk, streamContext),
    ) as string[];
    expect(frames.join("")).toContain("event: response.created");
    expect(frames.join("")).toContain("event: response.content_part.added");
    expect(frames.join("")).toContain("event: response.output_text.delta");
    expect(frames.join("")).toContain("event: response.content_part.done");
    expect(frames.at(-1)).toMatch(/event: response.completed/);
    expect(frames.at(-1)).toMatch(/data: \[DONE\]\n\n$/);
    expect(frames.at(-1)).toContain('"total_tokens":2');
  });

  it("encodes a direct public typed stream error with no successful terminal", async () => {
    const streamError = createGatewayError({
      category: "upstream",
      code: "provider_stream_failed",
      message: "Provider stream failed.",
      requestId: REQUEST_ID,
      providerId: "provider-private",
      credentialId: "credential-private",
      details: { authorization: "Bearer private" },
    });
    const failing: ProviderDispatchPort = {
      dispatch: successDispatch.dispatch,
      stream: async function* () {
        yield {
          type: "response_start",
          responseId: canonicalResponse.responseId,
          model: canonicalResponse.model,
          createdAt: NOW,
        } as const;
        yield {
          type: "text_delta",
          address: { choiceIndex: 0, outputIndex: 0 },
          text: "partial",
        } as const;
        yield { type: "error", error: streamError } as const;
      },
    };
    const fixture = application(failing);
    const chunks = await collect(
      fixture.app.stream(
        raw({ model: "logical-model", input: "hello", stream: true }),
      ),
    );
    const streamState = createStreamTranslationState();
    const streamContext = translationContext({ streamState });
    const frames = chunks.map((chunk) =>
      family.egress.encodeChunk(chunk, streamContext),
    ) as string[];
    const output = frames.join("");
    expect(output).toContain("event: error");
    expect(output).toMatch(/data: \[DONE\]\n\n$/);
    expect(output).not.toContain("response.completed");
    expect(output).not.toContain("provider-private");
    expect(output).not.toContain("credential-private");
    expect(output).not.toContain("Bearer private");
  });
});
