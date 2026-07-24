import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Response delivery modes supported by the fixture origin.
 */
export type ResponseMode = "complete" | "sse" | "disconnect" | "held-open";

/**
 * A queued response the origin serves (FIFO) to the next request.
 */
export interface QueuedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  /** Streamed as distinct chunks (used with `sse`, `disconnect`, `held-open`). */
  readonly segments?: readonly { readonly bytes: string | Uint8Array; readonly delayMs?: number }[];
  readonly mode?: ResponseMode;
  /** Serves `count` same-path redirects before falling through to the final response. */
  readonly redirect?: { readonly location: string; readonly count: number };
}

/**
 * One recorded origin request (ordered raw headers and exact body bytes).
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly closedAtMs: number | undefined;
}

/**
 * A loopback Chat origin used to exercise the dispatcher and process paths
 * deterministically without external network access.
 */
export interface ChatOrigin {
  /** API root (no trailing slash) — appending `/chat/completions` yields `/v1/chat/completions`. */
  readonly baseUrl: string;
  /** Bound port. */
  readonly port: number;
  /** Queues the next response to serve. */
  enqueue(response: QueuedResponse): void;
  /** Number of requests received so far. */
  dispatchCount(): number;
  /** All recorded requests in arrival order. */
  requests(): readonly RecordedRequest[];
  /** The most recent recorded request, if any. */
  lastRequest(): RecordedRequest | undefined;
  /** Closes the listener. */
  close(): Promise<void>;
}

/**
 * Starts a loopback Chat origin on `127.0.0.1:0`.
 */
export async function createChatOrigin(): Promise<ChatOrigin> {
  const queue: QueuedResponse[] = [];
  const recorded: RecordedRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    await handleRequest(req, res, queue, recorded);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    enqueue(response) {
      queue.push(response);
    },
    dispatchCount: () => recorded.length,
    requests: () => recorded,
    lastRequest: () => recorded.at(-1),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  queue: QueuedResponse[],
  recorded: RecordedRequest[],
): Promise<void> {
  const record: RecordedRequest = {
    method: req.method ?? "",
    url: req.url ?? "",
    headers: orderedHeaders(req),
    body: await readBody(req),
    closedAtMs: undefined,
  };
  recorded.push(record);
  res.on("close", () => {
    (record as { closedAtMs: number | undefined }).closedAtMs = Date.now();
  });

  const item = queue.shift();
  if (item === undefined) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":{"message":"no queued response"}}');
    return;
  }
  await serveResponse(res, item, queue);
}

async function serveResponse(res: ServerResponse, item: QueuedResponse, queue: QueuedResponse[]): Promise<void> {
  // Redirect hops are re-queued so the same item serves the final response after `count` hops.
  if (item.redirect !== undefined && item.redirect.count > 0) {
    const next: QueuedResponse = { ...item, redirect: { ...item.redirect, count: item.redirect.count - 1 } };
    queue.unshift(next);
    res.writeHead(302, { location: item.redirect.location });
    res.end();
    return;
  }

  const mode = item.mode ?? "complete";
  const headers = {
    "content-type": mode === "sse" ? "text/event-stream" : "application/json",
    ...(item.headers ?? {}),
  };

  if (mode === "complete") {
    res.writeHead(item.status, headers);
    const body = item.segments?.map((s) => toBuffer(s.bytes)) ?? [toBuffer(item.body ?? "")];
    res.end(Buffer.concat(body));
    return;
  }

  res.writeHead(item.status, headers);
  const segments = item.segments ?? [];
  for (const segment of segments) {
    if (segment.delayMs !== undefined && segment.delayMs > 0) await delay(segment.delayMs);
    res.write(toBuffer(segment.bytes));
  }
  if (mode === "sse") {
    res.end();
  } else if (mode === "disconnect") {
    res.destroy();
  }
  // held-open: never end; the socket stays open until the client disconnects.
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function orderedHeaders(req: IncomingMessage): readonly (readonly [string, string])[] {
  const headers: [string, string][] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    headers.push([(req.rawHeaders[index] ?? "").toLowerCase(), req.rawHeaders[index + 1] ?? ""]);
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
