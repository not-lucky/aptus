import assert from "node:assert/strict";
import { test } from "vitest";
import type { PreparedProviderRequest } from "../../src/domain/contracts.js";
import { createUndiciDispatcher } from "../../src/providers/shared/dispatcher.js";
import { type ChatOrigin, createChatOrigin } from "../helpers/chat-origin.js";

const dispatcher = createUndiciDispatcher();

function prepare(url: string, overrides: Partial<PreparedProviderRequest> = {}): PreparedProviderRequest {
  return {
    provider: "test",
    protocol: "openai-chat",
    url,
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: new TextEncoder().encode('{"model":"gpt-5.4"}'),
    stream: false,
    deadlineMs: performance.now() + 60_000,
    streamIdleMs: 60_000,
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function streamErrorKind(error: unknown): string | undefined {
  return (error as { streamErrorKind?: string }).streamErrorKind;
}

function dispatchErrorKind(error: unknown): string | undefined {
  return (error as { dispatchErrorKind?: string }).dispatchErrorKind;
}

async function withOrigin(run: (origin: ChatOrigin) => Promise<void>): Promise<void> {
  const origin = await createChatOrigin();
  try {
    await run(origin);
  } finally {
    await origin.close();
  }
}

test("dispatcher relays a complete response with filtered headers", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({ status: 200, headers: { "x-request-id": "rid", "set-cookie": "secret=1" }, body: "hello" });
    const response = await dispatcher.dispatch(
      prepare(`${origin.baseUrl}/chat/completions`),
      new AbortController().signal,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-request-id"], "rid");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.finalUrl, `${origin.baseUrl}/chat/completions`);
    assert.equal(new TextDecoder().decode(await readAll(response.body)), "hello");
  });
});

test("dispatcher follows a same-origin path-only redirect", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({ status: 200, body: "final", redirect: { location: "/v1/chat/completions/final", count: 1 } });
    const response = await dispatcher.dispatch(
      prepare(`${origin.baseUrl}/chat/completions`),
      new AbortController().signal,
    );
    assert.equal(response.status, 200);
    assert.equal(response.finalUrl, `${origin.baseUrl}/chat/completions/final`);
    assert.equal(new TextDecoder().decode(await readAll(response.body)), "final");
    assert.equal(origin.dispatchCount(), 2);
  });
});

test("dispatcher rejects a cross-origin redirect", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({ status: 302, redirect: { location: `http://127.0.0.1:${origin.port + 1}/x`, count: 1 } });
    await assert.rejects(
      dispatcher.dispatch(prepare(`${origin.baseUrl}/chat/completions`), new AbortController().signal),
      (error: unknown) => dispatchErrorKind(error) === "redirect",
    );
  });
});

test("dispatcher detects a redirect loop", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({ status: 302, redirect: { location: "/v1/chat/completions", count: 5 } });
    await assert.rejects(
      dispatcher.dispatch(prepare(`${origin.baseUrl}/chat/completions`), new AbortController().signal),
      (error: unknown) => dispatchErrorKind(error) === "redirect",
    );
    assert.equal(origin.dispatchCount(), 2);
  });
});

test("dispatcher rejects an already-expired deadline before dispatch", async () => {
  await withOrigin(async (origin) => {
    const signal = new AbortController().signal;
    await assert.rejects(
      dispatcher.dispatch(prepare(`${origin.baseUrl}/chat/completions`, { deadlineMs: performance.now() - 1 }), signal),
      (error: unknown) => dispatchErrorKind(error) === "timeout",
    );
    assert.equal(origin.dispatchCount(), 0);
  });
});

test("stream-idle timer resets on each received chunk", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({
      status: 200,
      mode: "sse",
      segments: [
        { bytes: "data: a\n\n", delayMs: 0 },
        { bytes: "data: b\n\n", delayMs: 60 },
        { bytes: "data: [DONE]\n\n", delayMs: 60 },
      ],
    });
    const response = await dispatcher.dispatch(
      prepare(`${origin.baseUrl}/chat/completions`, { streamIdleMs: 200 }),
      new AbortController().signal,
    );
    assert.equal(new TextDecoder().decode(await readAll(response.body)), "data: a\n\ndata: b\n\ndata: [DONE]\n\n");
  });
});

test("stream-idle expiry errors the stream with idle_timeout", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({
      status: 200,
      mode: "sse",
      segments: [
        { bytes: "data: first\n\n", delayMs: 0 },
        { bytes: "data: late\n\n", delayMs: 400 },
      ],
    });
    const response = await dispatcher.dispatch(
      prepare(`${origin.baseUrl}/chat/completions`, { streamIdleMs: 100 }),
      new AbortController().signal,
    );
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await assert.rejects(reader.read(), (error: unknown) => streamErrorKind(error) === "idle_timeout");
  });
});

test("abort cancels the provider body and errors the stream", async () => {
  await withOrigin(async (origin) => {
    origin.enqueue({ status: 200, mode: "held-open", segments: [{ bytes: "data: start\n\n", delayMs: 0 }] });
    const controller = new AbortController();
    const response = await dispatcher.dispatch(prepare(`${origin.baseUrl}/chat/completions`), controller.signal);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(reader.read(), (error: unknown) => streamErrorKind(error) === "abort");
    const deadline = Date.now() + 1_000;
    while (origin.lastRequest()?.closedAtMs === undefined) {
      assert.ok(Date.now() < deadline, "origin socket did not close");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});
