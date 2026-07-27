import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
} from "../../domain/index.js";
import {
  createGatewayError,
  isSafeCanonicalResponse,
} from "../../domain/index.js";
import type { ProviderDispatchPort } from "../../ports/index.js";
import { BoundedAsyncQueue } from "./bounded-queue.js";
import { CanonicalChunkCollator } from "./canonical-collator.js";
import type {
  ProviderAdapterOptions,
  ProviderDecodeContext,
  ProviderStreamParser,
} from "./types.js";
import {
  toProviderError,
  validateProviderAdapterLimits,
} from "./types.js";

/** Bounded provider adapter implementing canonical request and stream dispatch. */
export class CanonicalStreamEngine<TRequest, TResponse>
  implements ProviderDispatchPort
{
  private readonly encoder = new TextEncoder();

  /** Validates all hard bounds before this adapter can invoke its transport. */
  public constructor(
    private readonly options: ProviderAdapterOptions<TRequest, TResponse>,
  ) {
    validateProviderAdapterLimits(options.limits);
  }

  /** Performs one bounded non-stream provider request and validates its result. */
  public async dispatch(
    candidate: RouteCandidate,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse> {
    const requestId = this.options.requestId(request);
    const context = this.context(candidate, request, requestId);
    try {
      const providerRequest = this.options.buildRequest(candidate, request);
      const response = await this.options.transport.request(providerRequest, signal);
      this.boundResponse(response, requestId);
      const canonical = this.options.decodeResponse(response, context);
      if (!isSafeCanonicalResponse(canonical, requestId)) {
        throw createGatewayError({
          category: "upstream",
          code: "upstream_response_malformed",
          message: "The upstream provider response is malformed.",
          requestId,
          retryable: false,
          status: 502,
        });
      }
      return canonical;
    } catch (error) {
      throw toProviderError(error, requestId, "upstream_request_failed");
    }
  }

  /** Streams bounded canonical chunks with request-local state and cleanup. */
  public stream(
    candidate: RouteCandidate,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalChunk> {
    const options = this.options;
    const requestId = options.requestId(request);
    const context = this.context(candidate, request, requestId);
    const local = new AbortController();
    const queue = new BoundedAsyncQueue<CanonicalChunk>(
      options.limits,
      local.signal,
    );
    const collator = new CanonicalChunkCollator(
      options.limits.maxToolArgumentsBytes,
      requestId,
    );
    let parser: ProviderStreamParser | undefined;
    let parserCreationError: unknown;
    try {
      parser = options.createParser(context);
    } catch (error) {
      parserCreationError = error;
    }
    let upstream: AsyncIterator<Uint8Array> | undefined;
    let upstreamReturned = false;
    let parserClosed = false;
    let finalized = false;
    let emittedError = false;

    const closeParser = async (): Promise<void> => {
      if (parserClosed || parser === undefined) return;
      parserClosed = true;
      await parser.close();
    };
    const returnUpstream = async (): Promise<void> => {
      if (upstreamReturned || upstream?.return === undefined) return;
      upstreamReturned = true;
      await upstream.return();
    };
    const finalize = async (abort: boolean): Promise<void> => {
      if (finalized) return;
      finalized = true;
      signal.removeEventListener("abort", forwardAbort);
      if (abort && !local.signal.aborted) {
        local.abort(new DOMException("Provider stream stopped", "AbortError"));
      }
      await returnUpstream().catch(() => undefined);
      await closeParser().catch(() => undefined);
      queue.close();
    };
    const forwardAbort = (): void => {
      local.abort(signal.reason);
      void finalize(true);
    };
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();

    const pushChunks = async (
      chunks: ReadonlyArray<CanonicalChunk>,
    ): Promise<void> => {
      for (const parsed of chunks) {
        const ready = collator.accept(parsed);
        for (const chunk of ready) {
          if (chunk.type === "error") emittedError = true;
          await queue.push(chunk);
        }
      }
    };
    const emitFailure = async (error: unknown): Promise<void> => {
      if (emittedError) {
        queue.close();
        return;
      }
      if (local.signal.aborted) {
        queue.fail(error);
        return;
      }
      const safe = toProviderError(error, requestId, "upstream_stream_failed");
      emittedError = true;
      try {
        await queue.push({ type: "error", error: safe });
        queue.close();
      } catch (pushError) {
        queue.fail(pushError);
      }
    };

    const producer = (async () => {
      try {
        if (local.signal.aborted) return;
        if (parserCreationError !== undefined) throw parserCreationError;
        if (parser === undefined) throw new Error("provider parser unavailable");
        if (local.signal.aborted) return;
        const providerRequest = options.buildRequest(candidate, request);
        if (local.signal.aborted) return;
        upstream = options.transport
          .stream(providerRequest, local.signal)
          [Symbol.asyncIterator]();
        let bodyBytes = 0;
        while (true) {
          if (local.signal.aborted) throw local.signal.reason;
          const result = await upstream.next();
          if (local.signal.aborted) throw local.signal.reason;
          if (result.done) break;
          const frame: unknown = result.value;
          if (!(frame instanceof Uint8Array)) {
            throw createGatewayError({
              category: "upstream",
              code: "upstream_event_malformed",
              message: "The upstream provider stream is invalid.",
              requestId,
              retryable: false,
              status: 502,
            });
          }
          bodyBytes += frame.byteLength;
          if (bodyBytes > options.limits.maxBodyBytes) {
            throw createGatewayError({
              category: "upstream",
              code: "upstream_body_too_large",
              message: "The upstream provider body is too large.",
              requestId,
              retryable: false,
              status: 502,
            });
          }
          await pushChunks(parser.push(frame, context));
        }
        await pushChunks(parser.finish(context));
        for (const chunk of collator.finish()) await queue.push(chunk);
        queue.close();
      } catch (error) {
        await emitFailure(error);
      } finally {
        await finalize(false);
      }
    })();

    const consumer: AsyncIterableIterator<CanonicalChunk> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<CanonicalChunk>> {
        return await queue.next();
      },
      async return(): Promise<IteratorResult<CanonicalChunk>> {
        await finalize(true);
        await producer.catch(() => undefined);
        return { done: true, value: undefined };
      },
      async throw(error?: unknown): Promise<IteratorResult<CanonicalChunk>> {
        queue.fail(error);
        await finalize(true);
        await producer.catch(() => undefined);
        throw error;
      },
    };
    return consumer;
  }

  private context(
    candidate: RouteCandidate,
    request: CanonicalRequest,
    requestId: string,
  ): ProviderDecodeContext {
    return Object.freeze({
      requestId,
      candidate,
      model: candidate.physicalModel || request.model,
    });
  }

  private boundResponse(response: TResponse, requestId: string): void {
    let bytes: number | undefined;
    if (response instanceof Uint8Array) bytes = response.byteLength;
    else if (typeof response === "string") bytes = this.encoder.encode(response).byteLength;
    if (bytes !== undefined && bytes > this.options.limits.maxBodyBytes) {
      throw createGatewayError({
        category: "upstream",
        code: "upstream_body_too_large",
        message: "The upstream provider body is too large.",
        requestId,
        retryable: false,
        status: 502,
      });
    }
  }
}
