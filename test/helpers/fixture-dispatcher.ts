import type { PreparedProviderRequest, ProviderDispatcher, ProviderResponse } from "../../src/domain/contracts.js";

/**
 * One scripted fixture response served (FIFO) by the fixture dispatcher.
 */
export interface FixtureResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** Single-chunk complete body. */
  readonly body?: Uint8Array | string;
  /** Multi-chunk streamed body (closes after the final chunk). */
  readonly segments?: readonly { readonly bytes: Uint8Array | string; readonly delayMs?: number }[];
  /** Throw a dispatch failure instead of returning a response. */
  readonly throwDispatch?: { readonly kind: "transport" | "timeout" | "abort" | "redirect"; readonly message: string };
  /** Error the body stream (after any segments) with a typed stream error. */
  readonly streamError?: {
    readonly kind: "idle_timeout" | "deadline" | "abort" | "transport";
    readonly afterChunks?: number;
  };
  /** Hold the body stream open forever (until canceled). */
  readonly heldOpen?: boolean;
}

/**
 * A record of one dispatched request for assertion purposes.
 */
export interface DispatchedRequest {
  readonly prepared: PreparedProviderRequest;
  readonly cancelledAtMs: number | undefined;
}

/**
 * In-process {@link ProviderDispatcher} backed by a FIFO queue.
 */
export interface FixtureDispatcher extends ProviderDispatcher {
  enqueue(response: FixtureResponse): void;
  dispatchCount(): number;
  requests(): readonly DispatchedRequest[];
  lastRequest(): DispatchedRequest | undefined;
}

/**
 * Creates an in-process fixture dispatcher (no network I/O).
 */
export function createFixtureDispatcher(): FixtureDispatcher {
  const queue: FixtureResponse[] = [];
  const requests: DispatchedRequest[] = [];

  return {
    enqueue(response) {
      queue.push(response);
    },
    dispatchCount: () => requests.length,
    requests: () => requests,
    lastRequest: () => requests.at(-1),

    async dispatch(prepared: PreparedProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
      const record: DispatchedRequest = { prepared, cancelledAtMs: undefined };
      requests.push(record);
      if (!signal.aborted) {
        signal.addEventListener(
          "abort",
          () => {
            (record as { cancelledAtMs: number | undefined }).cancelledAtMs = Date.now();
          },
          { once: true },
        );
      }

      const item = queue.shift();
      if (item === undefined) {
        throw taggedError("transport", "no queued fixture response");
      }
      if (item.throwDispatch !== undefined) {
        throw taggedError(item.throwDispatch.kind, item.throwDispatch.message);
      }

      const headers: Record<string, string> = { "content-type": "application/json", ...(item.headers ?? {}) };
      return {
        status: item.status,
        headers,
        body: buildStream(item, signal),
        finalUrl: prepared.url,
      };
    },
  };
}

/**
 * Builds a backpressured web stream from the scripted fixture item.
 */
function buildStream(item: FixtureResponse, signal: AbortSignal): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] =
    item.segments !== undefined
      ? item.segments.map((segment) => toBuffer(segment.bytes))
      : item.body !== undefined
        ? [toBuffer(item.body)]
        : [];
  const delays: number[] = (item.segments ?? []).map((segment) => segment.delayMs ?? 0);
  let index = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.error(taggedStreamError("abort", "aborted"));
        return;
      }
      // Emit scripted chunks first, then close, hold open, or error.
      if (index < chunks.length) {
        const delayMs = delays[index] ?? 0;
        const chunk = chunks[index];
        index++;
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(chunk as Uint8Array);
        return;
      }
      if (item.heldOpen === true) {
        // Hold the stream open until the outer signal aborts, then error with
        // an abort so the consumer observes a cancellation (not a clean EOF).
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        controller.error(taggedStreamError("abort", "aborted"));
        return;
      }
      if (item.streamError !== undefined && index >= (item.streamError.afterChunks ?? 0)) {
        controller.error(taggedStreamError(item.streamError.kind, "stream error"));
      } else {
        controller.close();
      }
    },
  });
}

function toBuffer(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function taggedError(kind: string, message: string): Error {
  const error = new Error(message) as Error & { dispatchErrorKind: string };
  error.dispatchErrorKind = kind;
  return error;
}

function taggedStreamError(kind: string, message: string): Error {
  const error = new Error(message) as Error & { streamErrorKind: string };
  error.streamErrorKind = kind;
  return error;
}
