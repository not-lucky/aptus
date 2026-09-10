/**
 * @fileoverview
 * Shared stream delivery engine for native and translated provider SSE streams.
 *
 * Implements the post-header stream relay spine exactly once: reads provider chunks from a
 * reader, hands them to a per-path {@link StreamTransform} adapter, applies client backpressure
 * through a {@link ReadableStream}, and owns close-once terminal handling — uniform trace sink
 * lifecycle, abort classification (timeout / shutdown / client), interrupted-EOF detection, and
 * deferred terminal fact finalization through the request {@link TerminalCoordinator}.
 *
 * Native and translated delivery previously each carried their own copy of this spine
 * (`relayStream` in `relay.ts` and `relayTranslatedStream` in `translated-stream-relay.ts`).
 * Both copies differed only in the middle: how provider bytes become client frames and what
 * verdict the end of stream produces. This module turns that difference into a seam — the
 * {@link StreamTransform} adapter — and keeps the transport-level outcome handling in one place.
 */

import type {
  AptusRequestId,
  GatewayResult,
  HeaderMap,
  JsonObject,
  Protocol,
  Result,
  TerminalCoordinator,
  TerminalFact,
  TraceByteSink,
  TraceSession,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { estimateCostUsd, type PricingConfig } from "../domain/pricing.ts";
import type { Usage } from "../domain/usage.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import { classifyAbortReason } from "./attempt.ts";
import { interruptedFailure, streamFailure, timeoutFailure } from "./failures.ts";
import { buildTerminalFact, type TerminalFactContext } from "./terminal-outcome.ts";
import type { Clock } from "./timing.ts";

/**
 * Verdict a stream transform adapter reports after provider end-of-stream has been finalized.
 *
 * `complete` means the stream ended with a valid terminal state; `inband_failure` means the
 * stream carried a polite in-band provider error (only produced by the translated path, where the
 * error is emitted as SSE error frames before closing); `no_terminal` means the stream ended
 * without reaching any terminal marker, which the engine treats as an interrupted stream.
 */
export type StreamEofVerdict =
  | {
      readonly kind: "complete";
      /** Provider or normalized usage record to attach to the trace terminal. */
      readonly usageRecord?: JsonObject;
      /** Normalized counters for cost estimation, when the stream reported usage. */
      readonly costUsage?: Usage;
    }
  | { readonly kind: "inband_failure"; readonly failure: NormalizedFailure }
  | { readonly kind: "no_terminal" };

/**
 * Per-path chunk transform seam between the relay engine and protocol delivery semantics.
 *
 * The adapter answers three questions the engine cannot: how provider bytes become client frames
 * (`feed`), whether any final client frames are produced at end of stream (`finish`), and what
 * the end of stream means (`eofVerdict`). The engine never inspects bytes or stream grammar; it
 * only relays the frames the adapter returns and classifies transport-level outcomes.
 *
 * Adapters also own per-chunk trace sink writes that depend on their internals (for example the
 * translated adapter writes the provider byte sink per chunk and lets its pump write IR events),
 * while the engine owns the uniform terminal lifecycle of every sink in the relay options.
 */
export interface StreamTransform {
  /**
   * Consumes one provider chunk, returning client frames to enqueue or a normalized failure.
   *
   * @param chunk - Raw byte segment from the upstream provider stream.
   * @returns Client frame bytes ready for downstream enqueue, or a normalized failure.
   */
  feed(chunk: Uint8Array): Result<readonly Uint8Array[], NormalizedFailure>;

  /**
   * Finalizes the adapter at provider end-of-stream, flushing any remaining client frames.
   *
   * @returns Final client frame bytes, or a normalized failure if the stream was truncated.
   */
  finish(): Result<readonly Uint8Array[], NormalizedFailure>;

  /**
   * Reports the terminal verdict once `finish` has succeeded (or once the upstream phase already
   * finalized the stream, as the translated bootstrap does before headers commit).
   *
   * @returns Terminal verdict describing how the stream ended.
   */
  eofVerdict(): StreamEofVerdict;
}

/**
 * Options for running the shared stream relay engine.
 */
export interface StreamRelayOptions {
  /** Unique request identifier recorded in cancellation telemetry. */
  readonly aptusRequestId: AptusRequestId;
  /** Terminal coordinator tracking request lifecycle finalization. */
  readonly coordinator: TerminalCoordinator;
  /** Monotonic and wall clock source. */
  readonly clock: Clock;
  /** Monotonic millisecond timestamp when request processing began. */
  readonly started: number;
  /** Cumulative attempt count executed for this request. */
  readonly attemptCount: number;
  /** Wire protocol spoken by the upstream provider. */
  readonly targetProtocol: Protocol;
  /** Client protocol owning the downstream response, used for failure status mapping. */
  readonly clientProtocol: Protocol;
  /** Provider identifier producing the stream. */
  readonly providerName: string;
  /** Canonical model or route name requested by client. */
  readonly canonicalName: string;
  /** Model pricing configuration for cost estimation. */
  readonly pricing: PricingConfig | null;
  /** Inbound request abort signal. */
  readonly requestSignal: AbortSignal;
  /** Trace session recording cancellation stages. */
  readonly trace: TraceSession;
  /** Telemetry observer receiving lifecycle and cancellation events. */
  readonly observer: LifecycleObserver;
  /** Provider stream reader transferring raw bytes into the engine. */
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Trace byte sinks whose terminal lifecycle the engine owns (complete all / discard all). */
  readonly sinks: readonly TraceByteSink[];
  /** Per-path chunk transform adapter. */
  readonly transform: StreamTransform;
  /** HTTP status committed on the downstream stream head. */
  readonly status: number;
  /** Downstream stream response headers. */
  readonly headers: HeaderMap;
  /** Client frames already produced before the engine started (translated bootstrap carry-over). */
  readonly initialClientChunks?: readonly Uint8Array[];
  /** Whether the provider stream already concluded before the engine started. */
  readonly isInitialComplete?: boolean;
}

/**
 * Runs the shared stream relay engine and returns a streaming gateway result.
 *
 * The engine owns the pull loop, client backpressure, close-once terminal ownership, the uniform
 * sink lifecycle rule (terminal outcomes complete every sink, aborts and errors discard every
 * sink), and transport-level outcome classification. Clean and in-band terminals defer their
 * terminal fact to {@link GatewayResult.onDelivered} so finalization reflects actual client
 * delivery; interrupted, timeout, cancelled, and stream-error terminals finalize inline.
 *
 * @param options - Reader, sinks, transform adapter, and lifecycle context.
 * @returns Streaming gateway result with downstream headers and deferred finalization.
 */
export function runStreamRelay(options: StreamRelayOptions): GatewayResult {
  const { coordinator, clock, started, transform, reader, requestSignal, observer, trace } = options;

  const clientQueue: Uint8Array[] = [...(options.initialClientChunks ?? [])];
  let streamDone = options.isInitialComplete ?? false;
  let eofVerdict: StreamEofVerdict | undefined = streamDone ? transform.eofVerdict() : undefined;
  let closed = false;
  let deliver: ((durationMs: number) => Promise<void>) | undefined;

  // Request-scoped terminal vocabulary context: every terminal the engine finalizes
  // merges these fields. The client protocol lets the vocabulary derive failure statuses.
  const terminalContext: TerminalFactContext = {
    attempts: options.attemptCount,
    stream: true,
    clientProtocol: options.clientProtocol,
    targetProtocol: options.targetProtocol,
    provider: options.providerName,
    canonicalPublicName: options.canonicalName,
  };

  const elapsedMs = (): number => clock.nowMonotonicMs() - started;

  const finalizeNow = (fact: Omit<TerminalFact, "durationMs">): Promise<unknown> =>
    coordinator.finalize({ ...fact, durationMs: elapsedMs() });

  const completeSinks = async (): Promise<void> => {
    for (const sink of options.sinks) {
      await sink.complete().catch(() => undefined);
    }
  };

  const discardSinks = async (): Promise<void> => {
    for (const sink of options.sinks) {
      await sink.discard().catch(() => undefined);
    }
  };

  /** Once-only terminal claim: returns true only for the first terminal path to win. */
  const claim = (): boolean => {
    if (closed) return false;
    closed = true;
    return true;
  };

  const recordCancellation = async (by: "client" | "shutdown"): Promise<void> => {
    await trace.recordJson("cancellation", { phase: "relay", by });
    observer.observe({
      type: "cancelled",
      aptusRequestId: options.aptusRequestId,
      phase: "relay",
      by,
    });
  };

  /**
   * Classifies the request signal and finalizes the corresponding timeout or cancellation fact.
   */
  const finalizeByAbort = async (): Promise<void> => {
    const reason = classifyAbortReason(requestSignal);
    if (reason === "timeout") {
      // The vocabulary derives the timeout category's fixed 504 status.
      await finalizeNow(buildTerminalFact(terminalContext, { kind: "failed", failure: timeoutFailure() }));
    } else {
      const by = reason === "shutdown" ? "shutdown" : "client";
      await recordCancellation(by);
      await finalizeNow(buildTerminalFact(terminalContext, { kind: "cancelled", by }));
    }
  };

  /** Finalizes an exceptional failure by erroring the stream controller. */
  async function finalizeFailure(
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NormalizedFailure,
  ): Promise<void> {
    if (!claim()) return;
    await completeSinks();
    await finalizeNow(buildTerminalFact(terminalContext, { kind: "failed", failure }));
    controller.error(new Error(failure.message));
  }

  /** Finalizes a clean terminal, deferring the fact until client delivery completes. */
  async function finalizeCleanSuccess(
    controller: ReadableStreamDefaultController<Uint8Array>,
    verdict: Extract<StreamEofVerdict, { readonly kind: "complete" }>,
  ): Promise<void> {
    if (!claim()) return;
    await completeSinks();

    let estimatedCostUsd: string | undefined;
    if (options.pricing !== null && verdict.costUsage !== undefined) {
      try {
        estimatedCostUsd = estimateCostUsd(options.pricing, verdict.costUsage);
      } catch {
        // Suppress pricing calculation error
      }
    }

    // Capture the duration-free fact now; delivery spreads the actual client-end duration.
    const fact = buildTerminalFact(terminalContext, {
      kind: "complete",
      status: options.status,
      usage: verdict.usageRecord,
      estimatedCostUsd,
    });
    deliver = async (durationMs) => {
      await coordinator.finalize({ ...fact, durationMs });
    };

    controller.close();
  }

  /** Finalizes an in-band provider failure politely as SSE error frames. */
  async function finalizeInBandFailure(
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NormalizedFailure,
  ): Promise<void> {
    if (!claim()) return;
    await completeSinks();

    // Capture the duration-free fact now; delivery spreads the actual client-end duration.
    const fact = buildTerminalFact(terminalContext, { kind: "failed", failure });
    deliver = async (durationMs) => {
      await coordinator.finalize({ ...fact, durationMs });
    };

    controller.close();
  }

  /** Concludes relay once the client queue drains and the provider stream is exhausted. */
  async function finishRelay(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const verdict = eofVerdict;
    if (verdict === undefined) {
      // Defensive: every path that sets `streamDone` also establishes a verdict first.
      await finalizeFailure(controller, interruptedFailure());
      return;
    }
    if (verdict.kind === "inband_failure") {
      await finalizeInBandFailure(controller, verdict.failure);
    } else if (verdict.kind === "complete") {
      await finalizeCleanSuccess(controller, verdict);
    } else {
      await finalizeFailure(controller, interruptedFailure());
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (clientQueue.length > 0) {
          const nextChunk = clientQueue.shift();
          if (nextChunk !== undefined) {
            controller.enqueue(nextChunk);
          }
          if (clientQueue.length === 0 && streamDone) {
            await finishRelay(controller);
          }
          return;
        }

        if (streamDone) {
          await finishRelay(controller);
          return;
        }

        while (clientQueue.length === 0 && !streamDone) {
          const chunk = await reader.read();
          if (chunk.done) {
            streamDone = true;

            const finishResult = transform.finish();
            if (!finishResult.ok) {
              await finalizeFailure(controller, finishResult.error);
              return;
            }
            clientQueue.push(...finishResult.value);
            eofVerdict = transform.eofVerdict();

            if (eofVerdict.kind === "no_terminal") {
              await finalizeFailure(controller, interruptedFailure());
              return;
            }
            break;
          }

          if (chunk.value !== undefined && chunk.value.length > 0) {
            const pushResult = transform.feed(chunk.value);
            if (!pushResult.ok) {
              await finalizeFailure(controller, pushResult.error);
              return;
            }
            clientQueue.push(...pushResult.value);
          }
        }

        if (clientQueue.length > 0) {
          const nextChunk = clientQueue.shift();
          if (nextChunk !== undefined) {
            controller.enqueue(nextChunk);
          }
          if (clientQueue.length === 0 && streamDone) {
            await finishRelay(controller);
          }
        } else if (streamDone) {
          await finishRelay(controller);
        }
      } catch (error) {
        if (!claim()) return;
        await discardSinks();

        if (requestSignal.aborted) {
          await finalizeByAbort();
        } else {
          const failure = streamFailure(error);
          await finalizeNow(buildTerminalFact(terminalContext, { kind: "failed", failure }));
        }
        controller.error(error);
      }
    },

    async cancel(reason) {
      if (!claim()) return;
      // Finalize terminal accounting before awaiting the provider teardown. The provider
      // reader cancel is a network round trip, so sequencing it first would let the HTTP
      // layer's fallback finalization win the exactly-once coordinator claim and write
      // the terminal without the cancellation stage. The trace recorder serializes stage
      // writes, so invoking the abort finalizer in this same tick enqueues the
      // cancellation stage ahead of any terminal write by construction. The provider
      // cancel and sink discards run concurrently and are only awaited before cancel
      // resolves, so teardown still completes before the consumer observes the end.
      const teardown = Promise.all([reader.cancel(reason).catch(() => undefined), discardSinks()]);
      await finalizeByAbort();
      await teardown;
    },
  });

  return {
    kind: "stream",
    status: options.status,
    headers: options.headers,
    body,
    onDelivered: async (durationMs: number) => {
      await deliver?.(durationMs);
    },
  };
}
