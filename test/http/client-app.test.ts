import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "vitest";
import type { AptusConfig, SecretString } from "../../src/config/types.ts";
import type { Gateway, GatewayRequest, GatewayResult } from "../../src/domain/contracts.ts";
import { createClientApp } from "../../src/http/client-app.ts";
import { createErrorEncoder } from "../../src/http/error-encoder.ts";
import { createOperationsApp } from "../../src/http/operations-app.ts";
import { createMetricsRegistry } from "../../src/observability/metrics.ts";
import { createProtocolAdapters } from "../../src/providers/adapters.ts";

const config = configuration();

test("all create aliases share the injected gateway and request identity", async () => {
  const calls: GatewayRequest[] = [];
  const gateway: Gateway = {
    async execute(request) {
      calls.push(request);
      return complete();
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      for (const path of [
        "/chat/completions",
        "/v1/chat/completions",
        "/responses",
        "/v1/responses",
        "/messages",
        "/v1/messages",
      ]) {
        const response = await request(
          port,
          path,
          path.includes("messages") ? { "x-api-key": "client-secret" } : { authorization: "Bearer client-secret" },
          '{"model":"primary"}',
        );
        assert.equal(response.status, 200, path);
        assert.match(
          firstHeader(response.headers, "x-aptus-request-id"),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    },
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ["/chat/completions", "/chat/completions", "/responses", "/responses", "/messages", "/messages"],
  );
});

test("catalogs are local sorted alias-free and never dispatch", async () => {
  let calls = 0;
  const gateway: Gateway = {
    async execute() {
      calls++;
      return complete();
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const openAi = await request(port, "/v1/models", { authorization: "Bearer client-secret" });
      assert.equal(openAi.status, 200);
      assert.deepEqual(
        JSON.parse(openAi.body).data.map((entry: { id: string }) => entry.id),
        ["primary", "route"],
      );
      const anthropic = await request(port, "/models?after_id=nope&after_id=again&limit=bad", {
        "x-api-key": "client-secret",
      });
      assert.equal(anthropic.status, 200);
      const body = JSON.parse(anthropic.body);
      assert.equal(body.has_more, false);
      assert.equal(body.first_id, "primary");
      assert.match(
        firstHeader(openAi.headers, "x-aptus-request-id"),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      assert.equal(body.last_id, "route");
    },
  );
  assert.equal(calls, 0);
});

test("unknown and disallowed names are byte-identical native not-found failures", async () => {
  const restricted = configuration({ allow: ["primary"] });
  let calls = 0;
  const gateway: Gateway = {
    async execute() {
      calls++;
      return complete();
    },
  };
  await withApp(
    createClientApp({
      config: restricted,
      gateway,
      adapters: createProtocolAdapters(),
      errorEncoder: createErrorEncoder(),
    }),
    async (port) => {
      const unknown = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"missing"}',
      );
      const disallowed = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"route"}',
      );
      assert.equal(unknown.status, 404);
      assert.equal(disallowed.status, 404);
      assert.equal(unknown.body, disallowed.body);
      assert.match(
        firstHeader(unknown.headers, "x-aptus-request-id"),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    },
  );
  assert.equal(calls, 0);
});

test("in-flight exhaustion follows body admission and does not dispatch", async () => {
  const limited = { ...config, server: { ...config.server, maxInFlight: 1 } };
  let resolveFirst: (() => void) | undefined;
  let calls = 0;
  const gateway: Gateway = {
    async execute() {
      calls++;
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return complete();
    },
  };
  await withApp(
    createClientApp({
      config: limited,
      gateway,
      adapters: createProtocolAdapters(),
      errorEncoder: createErrorEncoder(),
    }),
    async (port) => {
      const first = request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"primary"}',
      );
      await waitFor(() => calls === 1);
      const second = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"primary"}',
      );
      assert.equal(second.status, 429);
      assert.equal(second.headers["x-aptus-request-id"], undefined);
      resolveFirst?.();
      assert.equal((await first).status, 200);
    },
  );
  assert.equal(calls, 1);
});

test("oversized ingress returns an unidentified native failure without dispatch", async () => {
  const limited = { ...config, server: { ...config.server, bodyLimitBytes: 4 } };
  let calls = 0;
  const gateway: Gateway = {
    async execute() {
      calls++;
      return complete();
    },
  };
  await withApp(
    createClientApp({
      config: limited,
      gateway,
      adapters: createProtocolAdapters(),
      errorEncoder: createErrorEncoder(),
    }),
    async (port) => {
      const response = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"primary"}',
      );
      assert.equal(response.status, 413);
      assert.equal(response.headers["x-aptus-request-id"], undefined);
    },
  );
  assert.equal(calls, 0);
});

test("unauthenticated request returns 401 before consuming concurrency limiter", async () => {
  const limited = { ...config, server: { ...config.server, maxInFlight: 0 } };
  let calls = 0;
  const gateway: Gateway = {
    async execute() {
      calls++;
      return complete();
    },
  };
  await withApp(
    createClientApp({
      config: limited,
      gateway,
      adapters: createProtocolAdapters(),
      errorEncoder: createErrorEncoder(),
    }),
    async (port) => {
      const response = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer invalid-token" },
        '{"model":"primary"}',
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers["x-aptus-request-id"], undefined);
    },
  );
  assert.equal(calls, 0);
});

test("error encoder maps every category with request IDs", async () => {
  const categories = [
    "invalid_request",
    "authentication",
    "permission",
    "not_found",
    "conflict",
    "payload_too_large",
    "rate_limit",
    "quota",
    "timeout",
    "unavailable",
    "provider",
    "unsupported_capability",
    "stream_interrupted",
  ] as const;
  const expected: Record<(typeof categories)[number], number> = {
    invalid_request: 400,
    authentication: 401,
    permission: 403,
    not_found: 404,
    conflict: 409,
    payload_too_large: 413,
    rate_limit: 429,
    quota: 429,
    timeout: 504,
    unavailable: 503,
    provider: 502,
    unsupported_capability: 400,
    stream_interrupted: 502,
  };
  for (const category of categories) {
    const gateway: Gateway = {
      async execute() {
        return { kind: "failure", failure: { category, message: "safe", retryable: false } };
      },
    };
    await withApp(
      createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
      async (port) => {
        const response = await request(
          port,
          "/responses",
          { authorization: "Bearer client-secret" },
          '{"model":"primary"}',
        );
        assert.equal(response.status, expected[category], category);
        assert.ok(response.headers["x-aptus-request-id"]);
      },
    );
  }
  const gateway: Gateway = {
    async execute() {
      return { kind: "failure", failure: { category: "unavailable", message: "safe", retryable: false } };
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const response = await request(port, "/messages", { "x-api-key": "client-secret" }, '{"model":"primary"}');
      assert.equal(response.status, 529);
      assert.equal(JSON.parse(response.body).error.type, "overloaded_error");
    },
  );
});

test("gateway failures use complete protocol-native error envelopes", async () => {
  const gateway: Gateway = {
    async execute() {
      return { kind: "failure", failure: { category: "not_found", message: "safe", retryable: false } };
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const openAi = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"primary"}',
      );
      assert.deepEqual(JSON.parse(openAi.body).error, {
        message: "safe",
        type: "not_found_error",
        param: null,
        code: null,
      });
      const messages = await request(port, "/messages", { "x-api-key": "client-secret" }, '{"model":"primary"}');
      const messageBody = JSON.parse(messages.body);
      assert.equal(messageBody.type, "error");
      assert.equal(messageBody.error.type, "not_found_error");
      assert.equal(messageBody.request_id, firstHeader(messages.headers, "x-aptus-request-id"));
    },
  );
});

test("client disconnect aborts the gateway signal without a second response", async () => {
  const completion = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const gateway: Gateway = {
    async execute(request) {
      signal = request.signal;
      await completion.promise;
      return complete();
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const disconnected = Promise.withResolvers<void>();
      const request = http.request({
        host: "127.0.0.1",
        port,
        path: "/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer client-secret", "content-type": "application/json" },
      });
      request.on("error", () => disconnected.resolve());
      request.end('{"model":"primary"}');
      await waitFor(() => signal !== undefined);
      request.destroy();
      await disconnected.promise;
      assert.equal(signal?.aborted, true);
      completion.resolve();
    },
  );
});

test("request deadline aborts the gateway once and returns a native timeout failure", async () => {
  const timed = { ...config, server: { ...config.server, requestDeadlineMs: 25 } };
  let calls = 0;
  let aborts = 0;
  const gateway: Gateway = {
    execute(gatewayRequest) {
      calls++;
      return new Promise<GatewayResult>((_resolve) => {
        gatewayRequest.signal.addEventListener("abort", () => {
          aborts++;
        });
      });
    },
  };
  await withApp(
    createClientApp({ config: timed, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const response = await request(
        port,
        "/chat/completions",
        { authorization: "Bearer client-secret" },
        '{"model":"primary"}',
      );
      assert.equal(response.status, 504);
      assert.deepEqual(JSON.parse(response.body).error, {
        message: "request deadline exceeded",
        type: "api_error",
        param: null,
        code: null,
      });
      assert.match(
        firstHeader(response.headers, "x-aptus-request-id"),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    },
  );
  assert.equal(calls, 1);
  assert.equal(aborts, 1);
});

test("stream deadline closes after headers and cancels the owned stream", async () => {
  const timed = { ...config, server: { ...config.server, requestDeadlineMs: 25 } };
  const cancellation = Promise.withResolvers<unknown>();
  const gateway: Gateway = {
    async execute() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel(reason) {
          cancellation.resolve(reason);
        },
      });
      return { kind: "stream", status: 200, headers: { "content-type": "text/event-stream" }, body };
    },
  };
  await withApp(
    createClientApp({ config: timed, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      await new Promise<void>((resolve, reject) => {
        const client = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/chat/completions",
            method: "POST",
            headers: { authorization: "Bearer client-secret", "content-type": "application/json" },
          },
          (response) => {
            assert.equal(response.statusCode, 200);
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              body += chunk;
            });
            response.on("aborted", () => {
              assert.equal(body, "chunk");
              resolve();
            });
            response.on("end", () => reject(new Error("deadline stream ended instead of closing")));
          },
        );
        client.on("error", reject);
        client.end('{"model":"primary"}');
      });
    },
  );
  await cancellation.promise;
});

test("stream relay cancels the owned stream when the client disconnects", async () => {
  const cancellation = Promise.withResolvers<unknown>();
  const gateway: Gateway = {
    async execute() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel(reason) {
          cancellation.resolve(reason);
        },
      });
      return { kind: "stream", status: 200, headers: { "content-type": "text/event-stream" }, body };
    },
  };
  await withApp(
    createClientApp({ config, gateway, adapters: createProtocolAdapters(), errorEncoder: createErrorEncoder() }),
    async (port) => {
      const disconnected = Promise.withResolvers<void>();
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/chat/completions",
          method: "POST",
          headers: { authorization: "Bearer client-secret", "content-type": "application/json" },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            disconnected.resolve();
          });
        },
      );
      request.on("error", () => undefined);
      request.end('{"model":"primary"}');
      await disconnected.promise;
      await cancellation.promise;
    },
  );
});

test("operations metrics honor enablement and bounded endpoint labels", async () => {
  const state = { draining: false, traceReady: true };
  await withApp(
    createOperationsApp({ config, revision: "sha256:test", state, metrics: createMetricsRegistry() }),
    async (port) => {
      await request(port, "/health/live", {});
      await request(port, "/health/ready", {});
      await request(port, "/health", {});
      const metrics = await request(port, "/metrics", {});
      assert.equal(metrics.status, 200);
      assert.match(metrics.body, /endpoint="health_live"/);
      assert.match(metrics.body, /endpoint="health_ready"/);
      assert.match(metrics.body, /endpoint="health"/);
      assert.match(metrics.body, /endpoint="metrics"/);
    },
  );
  const disabled = { ...config, metrics: { enabled: false } };
  await withApp(
    createOperationsApp({ config: disabled, revision: "sha256:test", state, metrics: createMetricsRegistry() }),
    async (port) => {
      assert.equal((await request(port, "/metrics", {})).status, 404);
    },
  );
});

function complete(): GatewayResult {
  return {
    kind: "complete",
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode("{}"),
  };
}

async function withApp(app: ReturnType<typeof createClientApp>, run: (port: number) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener did not bind TCP");
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function request(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: responseBody }),
        );
      },
    );

    request.on("error", reject);
    request.end(body);
  });
}
function firstHeader(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function configuration(overrides: { allow?: readonly string[] } = {}): AptusConfig {
  const metadata = {
    openai: { created: 1, ownedBy: "aptus" },
    anthropic: {
      createdAt: "2026-01-01T00:00:00Z",
      displayName: "Aptus",
      capabilities: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1024,
      maxInFlight: 2,
      requestDeadlineMs: 1000,
      streamIdleMs: 1000,
      shutdownDrainMs: 1000,
      trustedProxyCidrs: [],
    },
    operations: { host: "127.0.0.1", port: 0 },
    auth: {
      clientKeys: [
        {
          name: "client",
          secret: "client-secret" as SecretString,
          ...(overrides.allow === undefined ? {} : { allow: overrides.allow }),
        },
      ],
    },
    providers: [
      {
        name: "provider",
        protocol: "openai-chat",
        baseUrl: "https://example.test",
        headers: {},
        keys: [{ name: "key", secret: "provider-secret" as SecretString, enabled: true }],
        keyStrategy: "fill-first",
      },
    ],
    models: [
      {
        name: "primary",
        aliases: ["alias"],
        provider: "provider",
        upstreamModel: "upstream",
        defaults: {},
        extraBody: {},
        overrides: {},
        catalog: metadata,
        pricing: null,
      },
    ],
    routes: [{ name: "route", aliases: [], candidates: ["primary"], retryOn: [], fallbackOn: [], catalog: metadata }],
    routing: { keyPool: { failureCooldownMs: [1, 2], rateLimitFallbackMs: 1, maxRetryAfterMs: 1, jitterRatio: 0 } },
    tracing: { enabled: false, root: "./traces", retention: { maxAgeMs: 1, maxBytes: 1, cleanupIntervalMs: 1 } },
    logging: { enabled: false, level: "info" },
    metrics: { enabled: true },
    dryRun: { enabled: false },
  };
}
