import type { IncomingHttpHeaders } from "node:http";
import { Agent, type Dispatcher, request } from "undici";
import type { HeaderMap, ProviderDispatcher } from "../../domain/contracts.js";
import { filterInboundHeaders } from "./headers.js";

/**
 * Stable reason codes attached to errors thrown during dispatch (before any
 * response body is exposed). The Gateway classifies these without importing
 * this module: it inspects `dispatchErrorKind` structurally.
 */
export type DispatchErrorKind = "transport" | "timeout" | "abort" | "redirect";

/**
 * Typed dispatch failure. Thrown only for transport, timeout, abort, and
 * redirect-policy failures; body timeout/idle failures surface as stream
 * errors instead (see {@link StreamError}).
 */
export class DispatchError extends Error {
  readonly dispatchErrorKind: DispatchErrorKind;

  constructor(kind: DispatchErrorKind, message: string) {
    super(message);
    this.name = "DispatchError";
    this.dispatchErrorKind = kind;
  }
}

/**
 * Stable reason codes attached to body-stream errors. The Gateway reads
 * `streamErrorKind` structurally to pick the terminal failure category.
 */
export type StreamErrorKind = "idle_timeout" | "deadline" | "abort" | "transport";

/**
 * Typed body-stream failure surfaced as a rejected `reader.read()`.
 */
export class StreamError extends Error {
  readonly streamErrorKind: StreamErrorKind;

  constructor(kind: StreamErrorKind, message: string) {
    super(message);
    this.name = "StreamError";
    this.streamErrorKind = kind;
  }
}

/** Redirect statuses the dispatcher follows manually (path-only hops). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Maximum number of redirect hops (so at most 4 requests are issued). */
const MAX_REDIRECT_HOPS = 3;

/**
 * Creates the production Undici-backed {@link ProviderDispatcher}.
 *
 * Dispatch policies enforced here:
 * - Redirects may change only the URL path; scheme, host, and effective port
 *   must equal the first URL. Loops are detected via a seen-set and hops are
 *   capped at three.
 * - The total request deadline covers redirects and body consumption.
 * - The stream-idle timer resets on every received byte (including SSE pings).
 * - Backpressure is preserved end-to-end and every provider body is consumed
 *   or cancelled exactly once.
 *
 * @returns A production dispatcher using `undici.request`.
 */
export function createUndiciDispatcher(): ProviderDispatcher {
  const agent = new Agent();

  return {
    async dispatch(prepared, signal) {
      const firstUrl = new URL(prepared.url);
      const originScheme = firstUrl.protocol;
      const originHost = firstUrl.host;
      const originPort = effectivePort(firstUrl);
      const deadlineMs = prepared.deadlineMs;

      // Compose cancellation: outer abort signal + absolute monotonic deadline.
      const composed = new AbortController();
      const onOuterAbort = (): void => composed.abort(new DispatchError("abort", "request aborted"));
      if (signal.aborted) {
        onOuterAbort();
      } else {
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      const deadlineTimer = setTimeout(
        () => composed.abort(new DispatchError("timeout", "request deadline exceeded")),
        Math.max(0, deadlineMs - performance.now()),
      );

      const seen = new Set<string>();
      let currentUrl = firstUrl;
      let hops = 0;

      try {
        for (;;) {
          assertNotCancelled(signal, deadlineMs);

          let response: Dispatcher.ResponseData;
          try {
            response = await request(currentUrl, {
              method: "POST",
              headers: { ...prepared.headers },
              body: prepared.body,
              signal: composed.signal,
              dispatcher: agent,
            });
          } catch (error) {
            throw classifyDispatchFailure(signal, deadlineMs, error);
          }

          const status = response.statusCode;
          const location = headerValue(response.headers, "location");

          if (REDIRECT_STATUSES.has(status) && location !== undefined) {
            // Drain the 3xx body exactly once before following the redirect.
            try {
              await response.body.dump({ limit: 1024 * 1024, signal: composed.signal });
            } catch (error) {
              throw classifyDispatchFailure(signal, deadlineMs, error);
            }
            const next = new URL(location, currentUrl);
            if (next.protocol !== originScheme || next.host !== originHost || effectivePort(next) !== originPort) {
              throw new DispatchError("redirect", "redirect must stay on the same scheme, host, and effective port");
            }
            if (seen.has(next.href) || hops >= MAX_REDIRECT_HOPS) {
              throw new DispatchError(
                "redirect",
                hops >= MAX_REDIRECT_HOPS ? "redirect hop limit exceeded" : "redirect loop detected",
              );
            }
            seen.add(currentUrl.href);
            hops++;
            currentUrl = next;
            continue;
          }

          return {
            status,
            headers: filterInboundHeaders(convertHeaders(response.headers)),
            body: wrapStream(response.body, { streamIdleMs: prepared.streamIdleMs, deadlineMs, outerSignal: signal }),
            finalUrl: currentUrl.href,
          };
        }
      } finally {
        clearTimeout(deadlineTimer);
        signal.removeEventListener("abort", onOuterAbort);
      }
    },

    async close() {
      await agent.close();
    },

    async destroy() {
      await agent.destroy();
    },
  };
}

/**
 * Re-checks the outer abort signal and absolute deadline before each hop.
 */
function assertNotCancelled(signal: AbortSignal, deadlineMs: number): void {
  if (signal.aborted) throw new DispatchError("abort", "request aborted");
  if (performance.now() >= deadlineMs) throw new DispatchError("timeout", "request deadline exceeded");
}

/**
 * Maps a raw dispatch failure to a typed {@link DispatchError} based on which
 * cancellation source fired first.
 */
function classifyDispatchFailure(signal: AbortSignal, deadlineMs: number, error: unknown): DispatchError {
  if (signal.aborted) return new DispatchError("abort", "request aborted");
  if (performance.now() >= deadlineMs) return new DispatchError("timeout", "request deadline exceeded");
  return new DispatchError("transport", describeError(error));
}

/**
 * Wrap options passed from the dispatcher into the body stream.
 */
interface WrapOptions {
  readonly streamIdleMs: number;
  readonly deadlineMs: number;
  readonly outerSignal: AbortSignal;
}

/**
 * Wraps an Undici body in a backpressured web `ReadableStream` that enforces
 * stream-idle and total-deadline limits and cancels the body exactly once.
 *
 * Each `pull` re-arms a fresh idle timer, so every received byte (including
 * SSE comments and pings) resets the idle window. Timeouts surface as typed
 * {@link StreamError} rejections of `reader.read()`, never as a dispatch throw.
 */
function wrapStream(
  rawBody: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array>; destroy(): void },
  opts: WrapOptions,
): ReadableStream<Uint8Array> {
  const iterator = rawBody[Symbol.asyncIterator]();
  let closed = false;

  const destroyOnce = (): void => {
    if (closed) return;
    closed = true;
    rawBody.destroy();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;

      const idle = timerPromise(
        opts.streamIdleMs,
        () => new StreamError("idle_timeout", "stream idle timeout exceeded"),
      );
      const remaining = opts.deadlineMs - performance.now();
      const deadline =
        remaining <= 0
          ? {
              promise: Promise.reject(new StreamError("deadline", "request deadline exceeded")),
              cancel: (): void => undefined,
            }
          : timerPromise(remaining, () => new StreamError("deadline", "request deadline exceeded"));
      const aborted = abortPromise(opts.outerSignal, () => new StreamError("abort", "request aborted"));

      let result: IteratorResult<Uint8Array>;
      try {
        result = await Promise.race([iterator.next(), idle.promise, deadline.promise, aborted.promise]);
      } catch (error) {
        destroyOnce();
        controller.error(error);
        return;
      } finally {
        idle.cancel();
        deadline.cancel();
        aborted.cancel();
      }

      if (result.done === true) {
        destroyOnce();
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel() {
      destroyOnce();
    },
  });
}

/**
 * A promise that rejects with `factory()` after `ms` milliseconds, plus a
 * cancel handle used to disarm the underlying timer.
 */
function timerPromise(ms: number, factory: () => Error): { promise: Promise<never>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(factory()), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * A promise that rejects when the given signal aborts, plus a cancel handle.
 */
function abortPromise(signal: AbortSignal, factory: () => Error): { promise: Promise<never>; cancel(): void } {
  if (signal.aborted) return { promise: Promise.reject(factory()), cancel: (): void => undefined };
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(factory());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Converts Undici/Node `IncomingHttpHeaders` into a flat lower-case string map.
 */
function convertHeaders(headers: IncomingHttpHeaders): HeaderMap {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

/**
 * Reads a single header value from Undici headers (flattening arrays).
 */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value[0] ?? undefined) : value;
}

/**
 * Computes the effective port for a URL, defaulting to the scheme default.
 */
function effectivePort(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/**
 * Produces a safe, bounded description of an unknown transport error.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
