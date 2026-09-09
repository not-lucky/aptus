/**
 * @fileoverview Production Undici-backed dispatcher for upstream provider requests.
 *
 * Executes prepared HTTP requests against upstream providers with connection pooling,
 * redirect enforcement (same-origin, max 3 hops, loop detection), absolute request
 * deadlines, stream idle timeouts, and backpressured response streaming.
 *
 * Translates transport and network faults into typed {@link DispatchError} and
 * {@link StreamError} instances to allow structured error handling without string parsing.
 */

import type { IncomingHttpHeaders } from "node:http";
import { Agent, type Dispatcher, request } from "undici";
import type { HeaderMap, ProviderDispatcher } from "../../domain/contracts.ts";
import { filterInboundHeaders } from "./headers.ts";

/**
 * Stable reason codes for failures occurring prior to receiving the response body.
 *
 * - `transport`: Socket or network-level errors.
 * - `timeout`: Expiration of the overall request deadline.
 * - `abort`: Request aborted by client cancellation or gateway shutdown.
 * - `redirect`: Redirect violations (cross-origin, loop, or hop limit exceeded).
 */
export type DispatchErrorKind = "transport" | "timeout" | "abort" | "redirect";

/**
 * Error thrown when a request fails prior to receiving a response body.
 *
 * Carries a structured {@link DispatchErrorKind} distinguishing network failures,
 * timeouts, cancellations, and redirect policy violations.
 */
export class DispatchError extends Error {
  /** Structured reason category for the dispatch failure. */
  readonly dispatchErrorKind: DispatchErrorKind;

  /**
   * @param kind - Structured error category.
   * @param message - Descriptive failure message.
   */
  constructor(kind: DispatchErrorKind, message: string) {
    super(message);
    this.name = "DispatchError";
    this.dispatchErrorKind = kind;
  }
}

/**
 * Stable reason codes for failures occurring during response body streaming.
 *
 * - `idle_timeout`: No bytes received within the idle timeout threshold.
 * - `deadline`: Expiration of the overall request deadline during streaming.
 * - `abort`: Stream aborted by client cancellation or gateway shutdown.
 * - `transport`: Upstream socket or network failure during streaming.
 */
export type StreamErrorKind = "idle_timeout" | "deadline" | "abort" | "transport";

/**
 * Error emitted when response body streaming fails mid-flight.
 *
 * Carries a structured {@link StreamErrorKind} distinguishing idle gaps,
 * overall deadline expiry, aborts, and socket failures.
 */
export class StreamError extends Error {
  /** Structured reason category for the body stream failure. */
  readonly streamErrorKind: StreamErrorKind;

  /**
   * @param kind - Structured error category.
   * @param message - Descriptive failure message.
   */
  constructor(kind: StreamErrorKind, message: string) {
    super(message);
    this.name = "StreamError";
    this.streamErrorKind = kind;
  }
}

/** HTTP redirect status codes followed by the dispatcher. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Maximum number of redirect hops allowed per dispatch attempt. */
const MAX_REDIRECT_HOPS = 3;

/**
 * Instantiates a production {@link ProviderDispatcher} backed by an Undici Agent.
 *
 * Configures connection pooling and returns an implementation supporting same-origin
 * redirect loops/hop protection, overall deadlines, and idle stream monitoring.
 *
 * @returns Configured {@link ProviderDispatcher}.
 */
export function createUndiciDispatcher(): ProviderDispatcher {
  const agent = new Agent();

  return {
    /**
     * Dispatches a prepared request upstream with timeout and redirect tracking.
     *
     * @param prepared - Outbound request parameters including URL, headers, body, and timeouts.
     * @param signal - AbortSignal triggering cancellation on timeout or client disconnect.
     * @returns Promise resolving to the upstream response and backpressured body stream.
     * @throws {@link DispatchError} On connection errors, timeouts, aborts, or invalid redirects.
     */
    async dispatch(prepared, signal) {
      const firstUrl = new URL(prepared.url);
      const originScheme = firstUrl.protocol;
      const originHost = firstUrl.host;
      const originPort = effectivePort(firstUrl);
      const deadlineMs = prepared.deadlineMs;

      // Combine the outer abort signal with the absolute monotonic deadline in one controller for the transport.
      const composed = new AbortController();
      const onOuterAbort = (): void => composed.abort(new DispatchError("abort", "request aborted"));
      if (signal.aborted) {
        onOuterAbort();
      } else {
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      // Clamp a past deadline to zero delay so that an already expired request aborts on the next tick.
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
            // Drain the redirect body exactly once so that the pooled connection is released before the hop.
            try {
              await response.body.dump({ limit: 1024 * 1024, signal: composed.signal });
            } catch (error) {
              throw classifyDispatchFailure(signal, deadlineMs, error);
            }
            const next = new URL(location, currentUrl);
            // Keep credentials on the original origin by rejecting hops that change scheme, host, or port.
            if (next.protocol !== originScheme || next.host !== originHost || effectivePort(next) !== originPort) {
              throw new DispatchError("redirect", "redirect must stay on the same scheme, host, and effective port");
            }
            // Detect cycles through the seen-set and cap total hops so that redirect chains always terminate.
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
            // Strip framing and cookies from the head so that the relay never forwards them to the client.
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

    /** Gracefully closes the underlying connection pool after existing requests complete. */
    async close() {
      await agent.close();
    },

    /** Immediately terminates the connection pool and active sockets. */
    async destroy() {
      await agent.destroy();
    },
  };
}

/**
 * Asserts that the request has not been aborted and the deadline has not expired.
 *
 * @param signal - Active cancellation signal.
 * @param deadlineMs - Monotonic deadline timestamp in milliseconds.
 * @throws {@link DispatchError} If cancelled or deadline exceeded.
 */
function assertNotCancelled(signal: AbortSignal, deadlineMs: number): void {
  if (signal.aborted) throw new DispatchError("abort", "request aborted");
  if (performance.now() >= deadlineMs) throw new DispatchError("timeout", "request deadline exceeded");
}

/**
 * Maps an upstream transport failure to a typed {@link DispatchError}.
 *
 * Checks whether the error was triggered by abort or deadline expiration before
 * falling back to a transport error.
 *
 * @param signal - Active cancellation signal.
 * @param deadlineMs - Monotonic deadline timestamp in milliseconds.
 * @param error - Caught error from the transport layer.
 * @returns Typed {@link DispatchError}.
 */
function classifyDispatchFailure(signal: AbortSignal, deadlineMs: number, error: unknown): DispatchError {
  if (signal.aborted) return new DispatchError("abort", "request aborted");
  if (performance.now() >= deadlineMs) return new DispatchError("timeout", "request deadline exceeded");
  return new DispatchError("transport", describeError(error));
}

/**
 * Stream timing and cancellation options for response wrapping.
 */
interface WrapOptions {
  /** Maximum idle interval in milliseconds allowed between received chunks. */
  readonly streamIdleMs: number;

  /** Absolute monotonic deadline in milliseconds for the entire response. */
  readonly deadlineMs: number;

  /** External abort signal for client cancellation and shutdown. */
  readonly outerSignal: AbortSignal;
}

/**
 * Wraps an Undici response body in a ReadableStream enforcing idle and deadline timeouts.
 *
 * Reads chunks on demand to maintain backpressure, racing each read against the stream
 * idle timeout, remaining request deadline, and outer abort signal.
 *
 * @param rawBody - Raw Undici response body.
 * @param opts - Stream timing and cancellation configuration.
 * @returns Wrapped `ReadableStream<Uint8Array>`.
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
        // Race upstream bytes against the three expiry sources so that the first event wins the read.
        result = await Promise.race([iterator.next(), idle.promise, deadline.promise, aborted.promise]);
      } catch (error) {
        destroyOnce();
        controller.error(error);
        return;
      } finally {
        // Disarm the losing timers and the abort listener so that settled pulls leave no residue behind.
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
 * Creates a promise that rejects with an error after a delay, along with a cancellation function.
 *
 * @param ms - Delay duration in milliseconds.
 * @param factory - Factory creating the rejection error.
 * @returns Object with the timeout promise and a `cancel` handle.
 */
function timerPromise(ms: number, factory: () => Error): { promise: Promise<never>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(factory()), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Creates a promise that rejects when the specified signal aborts, along with a cancellation function.
 *
 * @param signal - AbortSignal to monitor.
 * @param factory - Factory creating the rejection error.
 * @returns Object with the abort promise and a `cancel` handle.
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
 * Normalizes Node/Undici HTTP headers into a flat lowercase record.
 *
 * Joins array values with commas and discards undefined headers.
 *
 * @param headers - Incoming headers from the transport layer.
 * @returns Normalized {@link HeaderMap}.
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
 * Retrieves the first value of a specific header from transport headers.
 *
 * @param headers - Transport headers.
 * @param name - Case-sensitive header name.
 * @returns First header value or `undefined` if absent.
 */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value[0] ?? undefined) : value;
}

/**
 * Resolves the effective port of a URL, defaulting to scheme standards (443 for HTTPS, 80 for HTTP).
 *
 * @param url - Parsed URL instance.
 * @returns Effective port as a string.
 */
function effectivePort(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/**
 * Extracts a safe error description string from an unknown error value.
 *
 * @param error - Caught error of unknown type.
 * @returns String representation of the error.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
