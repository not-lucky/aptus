import { describe, expect, it } from "vitest";
import {
  BoundedAsyncQueue,
  CanonicalChunkCollator,
  CanonicalStreamEngine,
  ProviderAdapterConfigurationError,
  SseProviderStreamParser,
  decodeCanonicalEvent,
} from "../../src/adapters/index.js";
import type {
  ProviderAdapterLimits,
  ProviderStreamParser,
} from "../../src/adapters/index.js";
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
} from "../../src/domain/index.js";
import type { ProviderTransportPort } from "../../src/ports/index.js";

const limits: ProviderAdapterLimits = {
  maxBodyBytes: 8_192,
  maxFrameBytes: 2_048,
  maxToolArgumentsBytes: 64,
  queueCapacity: 4,
  highWaterMark: 3,
  lowWaterMark: 1,
};
const request: CanonicalRequest = {
  requestId: "req-provider",
  receivedAt: "2026-07-21T00:00:00Z",
  source: { adapter: "test", protocol: "custom", path: "/test" },
  model: "logical-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  routing: {},
  stream: true,
};
const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential-ref",
  physicalModel: "physical-model",
  capabilities: new Set(),
  estimatedCostUsd: 0,
};
const response: CanonicalResponse = {
  requestId: request.requestId,
  responseId: "response",
  createdAt: request.receivedAt,
  model: candidate.physicalModel,
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
    providerId: candidate.providerId,
    credentialId: candidate.credentialId,
    physicalModel: candidate.physicalModel,
    responseHeaders: {},
    upstreamStatus: 200,
  },
};

function sse(...chunks: CanonicalChunk[]): Uint8Array {
  return new TextEncoder().encode(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
}

function fragments(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const output: Uint8Array[] = [];
  let start = 0;
  for (const end of cuts) {
    output.push(bytes.slice(start, end));
    start = end;
  }
  output.push(bytes.slice(start));
  return output;
}

function engine(
  frames: Uint8Array[],
  overrides: Partial<ProviderTransportPort<{ id: string }, CanonicalResponse>> = {},
  parserFactory?: () => ProviderStreamParser,
): CanonicalStreamEngine<{ id: string }, CanonicalResponse> {
  const transport: ProviderTransportPort<{ id: string }, CanonicalResponse> = {
    request: async () => response,
    stream: async function* () {
      for (const frame of frames) yield frame;
    },
    ...overrides,
  };
  return new CanonicalStreamEngine({
    transport,
    buildRequest: () => ({ id: request.requestId }),
    decodeResponse: (value) => value,
    createParser:
      parserFactory ??
      (() => new SseProviderStreamParser(decodeCanonicalEvent, limits)),
    limits,
    requestId: (value) => value.requestId,
  });
}

async function collect(
  source: AsyncIterable<CanonicalChunk>,
): Promise<CanonicalChunk[]> {
  const output: CanonicalChunk[] = [];
  for await (const chunk of source) output.push(chunk);
  return output;
}

describe("public provider adapters", () => {
  it("frames fragmented UTF-8 SSE and preserves exact chunk order and addresses", async () => {
    const expected: CanonicalChunk[] = [
      {
        type: "response_start",
        responseId: "response",
        model: "physical-model",
        createdAt: request.receivedAt,
        sequenceNumber: 2,
      },
      {
        type: "content_block_start",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
        block: { type: "text", id: "provider-block" },
        sequenceNumber: 3,
      },
      {
        type: "text_delta",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
        text: "héllo",
        sequenceNumber: 7,
      },
      {
        type: "reasoning_delta",
        address: { outputIndex: 1 },
        text: "why",
        sequenceNumber: 8,
      },
      {
        type: "content_block_stop",
        address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
        sequenceNumber: 9,
      },
      { type: "response_end", status: "completed", sequenceNumber: 12 },
    ];
    const bytes = sse(...expected);
    const multibyte = bytes.indexOf(0xc3);
    const actual = await collect(
      engine(fragments(bytes, [1, 8, 73, multibyte + 1, multibyte + 2])).stream(
        candidate,
        request,
        new AbortController().signal,
      ),
    );
    expect(actual).toEqual(expected);
  });

  it("merges cumulative usage and cost once immediately before response end", async () => {
    const chunks = await collect(
      engine([
        sse(
          {
            type: "response_start",
            responseId: "r",
            model: "m",
            createdAt: request.receivedAt,
          },
          {
            type: "usage",
            usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
            cost: {
              inputUsd: 1,
              outputUsd: 1,
              cacheReadUsd: 0,
              cacheWriteUsd: 0,
              totalUsd: 2,
              currency: "USD",
            },
          },
          {
            type: "usage",
            usage: {
              inputTokens: 3,
              outputTokens: 7,
              totalTokens: 8,
              cacheWriteBreakdown: [{ ttlSeconds: 60, tokens: 2 }],
              serverToolUsage: { search: 2 },
            },
            cost: {
              inputUsd: 0.5,
              outputUsd: 2,
              cacheReadUsd: 0.25,
              cacheWriteUsd: 0.5,
              totalUsd: 2,
              currency: "USD",
            },
          },
          { type: "response_end", status: "completed" },
        ),
      ]).stream(candidate, request, new AbortController().signal),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response_start",
      "usage",
      "response_end",
    ]);
    expect(chunks[1]).toMatchObject({
      usage: {
        inputTokens: 4,
        outputTokens: 7,
        totalTokens: 11,
        cacheWriteBreakdown: [{ ttlSeconds: 60, tokens: 2 }],
        serverToolUsage: { search: 2 },
      },
      cost: { totalUsd: 3.75, currency: "USD" },
    });
  });

  it("assembles tool arguments by full address and rejects invalid or oversized JSON", async () => {
    const valid = await collect(
      engine([
        sse(
          {
            type: "response_start",
            responseId: "r",
            model: "m",
            createdAt: request.receivedAt,
          },
          {
            type: "tool_call_delta",
            address: { outputIndex: 0 },
            argumentsDelta: '{"a":',
          },
          {
            type: "tool_call_delta",
            address: { choiceIndex: 0, outputIndex: 0 },
            argumentsDelta: '{"b":2}',
          },
          {
            type: "tool_call_delta",
            address: { outputIndex: 0 },
            argumentsDelta: "1}",
          },
          { type: "content_block_stop", address: { outputIndex: 0 } },
          {
            type: "content_block_stop",
            address: { choiceIndex: 0, outputIndex: 0 },
          },
          { type: "response_end", status: "completed" },
        ),
      ]).stream(candidate, request, new AbortController().signal),
    );
    expect(valid.at(-1)?.type).toBe("response_end");

    for (const [delta, code] of [
      ["not-json", "upstream_tool_arguments_invalid"],
      ["x".repeat(65), "upstream_tool_arguments_too_large"],
    ] as const) {
      const result = await collect(
        engine([
          sse(
            {
              type: "response_start",
              responseId: "r",
              model: "m",
              createdAt: request.receivedAt,
            },
            {
              type: "tool_call_delta",
              address: { outputIndex: 0 },
              argumentsDelta: delta,
            },
            { type: "content_block_stop", address: { outputIndex: 0 } },
            { type: "response_end", status: "completed" },
          ),
        ]).stream(candidate, request, new AbortController().signal),
      );
      expect(result.at(-1)).toMatchObject({ type: "error", error: { code } });
      expect(result.some((chunk) => chunk.type === "response_end")).toBe(false);
    }
  });

  it("projects malformed, bounded, UTF-8, and lifecycle failures to one safe error", async () => {
    const cases: Array<[Uint8Array[], string]> = [
      [[new TextEncoder().encode("data: {secret-token}\n\n")], "upstream_event_malformed"],
      [[new Uint8Array([0xff, 0xfe])], "upstream_invalid_utf8"],
      [[new TextEncoder().encode("data: {}")], "upstream_incomplete_frame"],
      [[sse({ type: "mystery" } as unknown as CanonicalChunk)], "upstream_event_malformed"],
      [[sse({ type: "response_end", status: "completed" })], "upstream_stream_lifecycle_invalid"],
    ];
    for (const [frames, code] of cases) {
      const chunks = await collect(
        engine(frames).stream(candidate, request, new AbortController().signal),
      );
      expect(chunks.filter((chunk) => chunk.type === "error")).toHaveLength(1);
      expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code } });
      expect(JSON.stringify(chunks)).not.toContain("secret-token");
      expect(chunks.some((chunk) => chunk.type === "response_end")).toBe(false);
    }
  });

  it("preserves prior deltas and one upstream error when later data violates lifecycle", async () => {
    const upstreamError = {
      code: "provider_failed",
      message: "Provider failed.",
      category: "upstream" as const,
      retryable: false,
      status: 502,
      requestId: request.requestId,
    };
    const chunks = await collect(
      engine([
        sse(
          {
            type: "response_start",
            responseId: "r",
            model: "m",
            createdAt: request.receivedAt,
          },
          { type: "ping" },
          { type: "error", error: upstreamError },
          { type: "ping" },
        ),
      ]).stream(candidate, request, new AbortController().signal),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response_start",
      "ping",
      "error",
    ]);
  });

  it("applies high/low-water backpressure and never exceeds capacity", async () => {
    const controller = new AbortController();
    const queue = new BoundedAsyncQueue<number>(limits, controller.signal);
    await queue.push(1);
    await queue.push(2);
    await queue.push(3);
    let fourthResolved = false;
    const fourth = queue.push(4).then(() => {
      fourthResolved = true;
    });
    await Promise.resolve();
    expect(fourthResolved).toBe(false);
    expect(queue.size()).toBe(3);
    expect(await queue.next()).toEqual({ done: false, value: 1 });
    await Promise.resolve();
    expect(fourthResolved).toBe(false);
    expect(await queue.next()).toEqual({ done: false, value: 2 });
    await fourth;
    expect(queue.size()).toBe(2);
    expect(queue.size()).toBeLessThanOrEqual(limits.queueCapacity);
    queue.close();
  });

  it("isolates simultaneous streams and performs exactly-once cleanup", async () => {
    let returns = 0;
    let closes = 0;
    const frames = [
      sse(
        {
          type: "response_start",
          responseId: "r",
          model: "m",
          createdAt: request.receivedAt,
        },
        { type: "ping" },
        { type: "response_end", status: "completed" },
      ),
    ];
    const transport: ProviderTransportPort<{ id: string }, CanonicalResponse> = {
      request: async () => response,
      stream: () => {
        let index = 0;
        const iterator: AsyncIterableIterator<Uint8Array> = {
          [Symbol.asyncIterator]() { return this; },
          next: async () =>
            index < frames.length
              ? { done: false as const, value: frames[index++] as Uint8Array }
              : { done: true as const, value: undefined },
          return: async () => {
            returns += 1;
            return { done: true as const, value: undefined };
          },
        };
        return iterator;
      },
    };
    const adapter = engine(frames, transport, () => {
      const parser = new SseProviderStreamParser(decodeCanonicalEvent, limits);
      return {
        push: (frame, context) => parser.push(frame, context),
        finish: (context) => parser.finish(context),
        close: async () => {
          closes += 1;
          await parser.close();
        },
      };
    });
    const [left, right] = await Promise.all([
      collect(adapter.stream(candidate, request, new AbortController().signal)),
      collect(adapter.stream(candidate, request, new AbortController().signal)),
    ]);
    expect(left).toEqual(right);
    expect(returns).toBe(2);
    expect(closes).toBe(2);
  });

  it("aborts a blocked producer and early return closes every resource once", async () => {
    const controller = new AbortController();
    let reads = 0;
    let returns = 0;
    let closes = 0;
    const one = sse({
      type: "response_start",
      responseId: "r",
      model: "m",
      createdAt: request.receivedAt,
    });
    const transport: ProviderTransportPort<{ id: string }, CanonicalResponse> = {
      request: async () => response,
      stream: () => {
        const iterator: AsyncIterableIterator<Uint8Array> = {
          [Symbol.asyncIterator]() { return this; },
          next: async () => {
            reads += 1;
            return { done: false as const, value: one };
          },
          return: async () => {
            returns += 1;
            return { done: true as const, value: undefined };
          },
        };
        return iterator;
      },
    };
    const adapter = engine([one], transport, () => {
      const parser = new SseProviderStreamParser(decodeCanonicalEvent, limits);
      return {
        push: (frame, context) => parser.push(frame, context),
        finish: (context) => parser.finish(context),
        close: async () => {
          closes += 1;
          await parser.close();
        },
      };
    });
    const iterator = adapter.stream(candidate, request, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("response_start");
    await iterator.return?.();
    expect(reads).toBeLessThanOrEqual(limits.highWaterMark + 2);
    expect(returns).toBe(1);
    expect(closes).toBe(1);
  });

  it("bounds dispatch bodies, preserves the signal, and rejects invalid configuration", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const adapter = engine([], {
      request: async (_value, signal) => {
        observed = signal;
        return response;
      },
    });
    expect(await adapter.dispatch(candidate, request, controller.signal)).toBe(response);
    expect(observed).toBe(controller.signal);
    expect(
      () =>
        new CanonicalStreamEngine({
          transport: {
            request: async () => response,
            stream: async function* () {},
          },
          buildRequest: () => ({}),
          decodeResponse: () => response,
          createParser: () => new SseProviderStreamParser(decodeCanonicalEvent, limits),
          requestId: (value: CanonicalRequest) => value.requestId,
          limits: { ...limits, lowWaterMark: 3, highWaterMark: 3 },

        }),
    ).toThrow(ProviderAdapterConfigurationError);
  });

  it("does not build or open transport for an already-aborted stream", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    let builds = 0;
    let streams = 0;
    const adapter = new CanonicalStreamEngine({
      transport: {
        request: async () => response,
        stream: () => {
          streams += 1;
          return (async function* () {})();
        },
      },
      buildRequest: () => {
        builds += 1;
        return { id: request.requestId };
      },
      decodeResponse: (value) => value,
      createParser: () => new SseProviderStreamParser(decodeCanonicalEvent, limits),
      limits,
      requestId: (value: CanonicalRequest) => value.requestId,
    });
    const iterator = adapter.stream(candidate, request, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("cancelled");
    expect(builds).toBe(0);
    expect(streams).toBe(0);
  });

  it("collator emits no synthetic usage when none was observed", () => {
    const collator = new CanonicalChunkCollator(64, request.requestId);
    expect(
      collator.accept({
        type: "response_start",
        responseId: "r",
        model: "m",
        createdAt: request.receivedAt,
      }),
    ).toHaveLength(1);
    expect(collator.accept({ type: "response_end", status: "completed" })).toEqual([
      { type: "response_end", status: "completed" },
    ]);
  });
});
