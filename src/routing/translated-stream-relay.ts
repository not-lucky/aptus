/**
 * @fileoverview
 * Delivery and backpressure management for cross-protocol translated SSE streams.
 *
 * Implements the streaming relay pipeline: {@link bootstrapTranslatedStream} reads initial provider
 * chunks and drives the pump before client HTTP headers commit (preserving retry/fallback capabilities),
 * while {@link relayTranslatedStream} drives incremental streaming with strict client backpressure,
 * recording raw provider chunks, intermediate IR events, and finalizing terminal lifecycle facts.
 */

import type {
  GatewayResult,
  HeaderMap,
  Protocol,
  ProviderResponse,
  TerminalCoordinator,
  TraceByteSink,
  TraceSession,
} from "../domain/contracts.ts";
import type { NormalizedFailure, TraceTerminal } from "../domain/operations.ts";
import { estimateCostUsd, type PricingConfig } from "../domain/pricing.ts";
import type { Direction, StreamSessionBundle } from "../translation/contracts.ts";
import { createSseDecoder, createSseEncoder, type ResponseOwnership } from "../translation/sse.ts";
import { TranslatedStreamPump } from "../translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../translation/stream-state.ts";
import { classifyAbortReason } from "./attempt.ts";
import { dispatchFailure, interruptedFailure, statusFromCategory, timeoutFailure } from "./failures.ts";
import type { Clock } from "./timing.ts";

const utf8Encoder = new TextEncoder();

/** Input parameters for bootstrapping a translated stream before committing client headers. */
export interface TranslatedStreamBootstrapInput {
  /** Active trace session for sink creation. */
  readonly trace: TraceSession;
  /** Provider response holding the readable stream body. */
  readonly response: ProviderResponse;
  /** Stream session bundle providing decoders, state machine, and client encoders. */
  readonly sessionBundle: StreamSessionBundle;
  /** Cross-protocol translation direction (e.g. `openai-chat->anthropic-messages`). */
  readonly direction: Direction;
}

/** Result of pre-header bootstrap decoding. */
export type TranslatedStreamBootstrap =
  | { readonly kind: "failure"; readonly failure: NormalizedFailure }
  | {
      readonly kind: "ready";
      readonly reader: ReadableStreamDefaultReader<Uint8Array>;
      readonly pump: TranslatedStreamPump;
      readonly providerSink: TraceByteSink;
      readonly irEventsSink: TraceByteSink;
      readonly initialClientChunks: Uint8Array[];
      readonly isInitialComplete: boolean;
    };

/**
 * Initializes the stream pump and reads initial provider chunks before committing client headers.
 *
 * @param input - Trace session, provider response, session bundle, and direction.
 * @returns Bootstrap outcome: ready pump bundle on success, or normalized failure on error.
 */
export async function bootstrapTranslatedStream(
  input: TranslatedStreamBootstrapInput,
): Promise<TranslatedStreamBootstrap> {
  const sseDecoder = createSseDecoder();
  const sseEncoder = createSseEncoder();
  const stateMachine = createIrStreamStateMachine({
    expectedResponseId: input.sessionBundle.session.responseId,
    expectedModel: input.sessionBundle.session.model,
    direction: input.direction,
  });

  const providerSink = input.trace.openBytes("provider_stream");
  const irEventsSink = input.trace.openBytes("ir_events");

  const pump = new TranslatedStreamPump(
    sseDecoder,
    sseEncoder,
    input.sessionBundle.providerDecoder,
    stateMachine,
    input.sessionBundle.clientEncoder,
    (evt) => {
      void irEventsSink.append(utf8Encoder.encode(`${JSON.stringify(evt)}\n`));
    },
  );

  const discardTraceSinks = async (): Promise<void> => {
    await providerSink.discard().catch(() => undefined);
    await irEventsSink.discard().catch(() => undefined);
  };

  const reader = input.response.body.getReader();
  const initialClientChunks: Uint8Array[] = [];
  let isInitialComplete = false;

  while (initialClientChunks.length === 0 && !isInitialComplete) {
    let chunkResult: { done: boolean; value?: Uint8Array };
    try {
      chunkResult = await reader.read();
    } catch (readErr) {
      await discardTraceSinks();
      return { kind: "failure", failure: dispatchFailure(readErr) };
    }

    if (chunkResult.done) {
      isInitialComplete = true;

      const finishResult = pump.finish();
      if (!finishResult.ok) {
        await discardTraceSinks();
        return { kind: "failure", failure: finishResult.error };
      }
      initialClientChunks.push(...finishResult.value);

      const pumpFailure = pump.getFailure();
      // Zero-prior-bytes split: headers are not sent yet, so an in-band failure stays pre-header.
      if (pumpFailure !== undefined && initialClientChunks.length === 0) {
        await discardTraceSinks();
        return { kind: "failure", failure: pumpFailure };
      }

      if (!pump.isTerminal()) {
        await discardTraceSinks();
        return {
          kind: "failure",
          failure: {
            category: "stream_interrupted",
            message: "Upstream stream ended abruptly before reaching a terminal state",
            retryable: false,
          },
        };
      }
      break;
    }

    if (chunkResult.value !== undefined && chunkResult.value.length > 0) {
      void providerSink.append(chunkResult.value);

      const pushResult = pump.pushBytes(chunkResult.value);
      if (!pushResult.ok) {
        await discardTraceSinks();
        await reader.cancel().catch(() => undefined);
        return { kind: "failure", failure: pushResult.error };
      }
      initialClientChunks.push(...pushResult.value);
    }
  }

  return { kind: "ready", reader, pump, providerSink, irEventsSink, initialClientChunks, isInitialComplete };
}

/** Dependencies and state required for relaying a bootstrapped translated stream. */
export interface TranslatedStreamRelayContext {
  /** Terminal coordinator tracking request lifecycle. */
  readonly coordinator: TerminalCoordinator;
  /** Monotonic and wall clock source. */
  readonly clock: Clock;
  /** Monotonic millisecond timestamp when request processing began. */
  readonly started: number;
  /** Cumulative attempt count executed for this request. */
  readonly attemptCount: number;
  /** Wire protocol spoken by the upstream provider. */
  readonly targetProtocol: Protocol;
  /** Client protocol owning the downstream response. */
  readonly clientProtocol: Protocol;
  /** Provider identifier producing the stream. */
  readonly providerName: string;
  /** Canonical model or route name requested by client. */
  readonly canonicalName: string;
  /** Model pricing configuration for cost estimation. */
  readonly pricing: PricingConfig | null;
  /** Inbound request abort signal. */
  readonly requestSignal: AbortSignal;
  /** Provider stream reader transferred from bootstrap. */
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Translation pump instance transferred from bootstrap. */
  readonly pump: TranslatedStreamPump;
  /** Trace sink receiving raw upstream provider bytes. */
  readonly providerSink: TraceByteSink;
  /** Trace sink receiving intermediate-representation stream events. */
  readonly irEventsSink: TraceByteSink;
  /** Buffered client chunks produced during the bootstrap phase. */
  readonly initialClientChunks: readonly Uint8Array[];
  /** Whether the provider stream concluded during bootstrap. */
  readonly isInitialComplete: boolean;
}

/**
 * Relays an active translated SSE stream to the client with backpressure management.
 *
 * @param context - Stream reader, translation pump, trace sinks, and lifecycle context.
 * @returns Gateway streaming result with standard SSE headers.
 */
export function relayTranslatedStream(context: TranslatedStreamRelayContext): GatewayResult {
  const { reader, pump, providerSink, irEventsSink } = context;

  const clientQueue: Uint8Array[] = [...context.initialClientChunks];
  let isStreamDone = context.isInitialComplete;
  let ownership: ResponseOwnership = { kind: "owned", attemptNumber: context.attemptCount, status: 200 };
  let deliver: ((durationMs: number) => Promise<void>) | undefined;

  const isClosed = (): boolean => ownership.kind === "closed";

  const streamHeaders: HeaderMap = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };

  /** Finalizes a clean stream completion, recording token usage and cost metrics. */
  async function finalizeCleanSuccess(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (isClosed()) return;
    ownership = { kind: "closed", reason: "complete" };

    await providerSink.complete().catch(() => undefined);
    await irEventsSink.complete().catch(() => undefined);

    const observedUsage = pump.getUsage();
    let estimatedCostUsd: string | undefined;
    if (context.pricing !== null && observedUsage !== undefined) {
      try {
        estimatedCostUsd = estimateCostUsd(context.pricing, {
          input: observedUsage.input,
          output: observedUsage.output,
          cacheReadInput: observedUsage.cacheReadInput,
          cacheWriteInput: observedUsage.cacheWriteInput,
        });
      } catch {
        // Suppress pricing calculation error
      }
    }

    const terminalUsage =
      observedUsage !== undefined
        ? {
            input_tokens: observedUsage.input,
            output_tokens: observedUsage.output,
            ...(observedUsage.total !== undefined ? { total_tokens: observedUsage.total } : {}),
          }
        : undefined;

    const terminal: TraceTerminal = {
      kind: "complete",
      status: 200,
      ...(terminalUsage !== undefined ? { usage: terminalUsage } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    };

    deliver = async (durationMs) => {
      await context.coordinator.finalize({
        terminal,
        outcomeCategory: "complete",
        status: 200,
        attempts: context.attemptCount,
        stream: true,
        durationMs,
        targetProtocol: context.targetProtocol,
        provider: context.providerName,
        canonicalPublicName: context.canonicalName,
        usage: terminalUsage,
        estimatedCostUsd,
      });
    };

    controller.close();
  }

  /** Finalizes an in-band failure emitted politely as SSE error frames. */
  async function finalizeInBandError(
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NormalizedFailure,
  ): Promise<void> {
    if (isClosed()) return;
    ownership = { kind: "closed", reason: "failed" };

    await providerSink.complete().catch(() => undefined);
    await irEventsSink.complete().catch(() => undefined);

    const status = statusFromCategory(failure.category, context.clientProtocol);
    deliver = async (durationMs) => {
      await context.coordinator.finalize({
        terminal: {
          kind: "failed",
          failure,
        },
        outcomeCategory: "failed",
        status,
        attempts: context.attemptCount,
        stream: true,
        durationMs,
        targetProtocol: context.targetProtocol,
        provider: context.providerName,
        canonicalPublicName: context.canonicalName,
      });
    };

    controller.close();
  }

  /** Concludes relay once all queues drain and provider stream is exhausted. */
  async function finishRelay(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const failure = pump.getFailure();
    if (failure !== undefined) {
      await finalizeInBandError(controller, failure);
    } else {
      await finalizeCleanSuccess(controller);
    }
  }

  /** Finalizes an exceptional mid-stream failure by erroring the stream controller. */
  async function finalizeFailure(
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NormalizedFailure,
  ): Promise<void> {
    if (isClosed()) return;
    ownership = { kind: "closed", reason: "failed" };

    const durationMs = context.clock.nowMonotonicMs() - context.started;
    await providerSink.complete().catch(() => undefined);
    await irEventsSink.complete().catch(() => undefined);

    await context.coordinator.finalize({
      terminal: {
        kind: "failed",
        failure,
      },
      outcomeCategory: "failed",
      status: statusFromCategory(failure.category, context.clientProtocol),
      attempts: context.attemptCount,
      stream: true,
      durationMs,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
    });

    controller.error(new Error(failure.message));
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (clientQueue.length > 0) {
          const nextChunk = clientQueue.shift();
          if (nextChunk !== undefined) {
            controller.enqueue(nextChunk);
          }
          if (clientQueue.length === 0 && isStreamDone) {
            await finishRelay(controller);
          }
          return;
        }

        if (isStreamDone) {
          await finishRelay(controller);
          return;
        }

        while (clientQueue.length === 0 && !isStreamDone) {
          const chunk = await reader.read();
          if (chunk.done) {
            isStreamDone = true;

            const finishResult = pump.finish();
            if (!finishResult.ok) {
              await finalizeFailure(controller, finishResult.error);
              return;
            }
            clientQueue.push(...finishResult.value);

            if (!pump.isTerminal()) {
              await finalizeFailure(controller, interruptedFailure());
              return;
            }
            break;
          }

          void providerSink.append(chunk.value);

          const pushResult = pump.pushBytes(chunk.value);
          if (!pushResult.ok) {
            await finalizeFailure(controller, pushResult.error);
            return;
          }
          clientQueue.push(...pushResult.value);
        }

        if (clientQueue.length > 0) {
          const nextChunk = clientQueue.shift();
          if (nextChunk !== undefined) {
            controller.enqueue(nextChunk);
          }
          if (clientQueue.length === 0 && isStreamDone) {
            await finishRelay(controller);
          }
        } else if (isStreamDone) {
          await finishRelay(controller);
        }
      } catch (error) {
        if (isClosed()) return;
        ownership = { kind: "closed", reason: "cancelled" };

        const durationMs = context.clock.nowMonotonicMs() - context.started;
        await providerSink.discard().catch(() => undefined);
        await irEventsSink.discard().catch(() => undefined);

        if (context.requestSignal.aborted) {
          const reason = classifyAbortReason(context.requestSignal);
          if (reason === "timeout") {
            await context.coordinator.finalize({
              terminal: { kind: "failed", failure: timeoutFailure() },
              outcomeCategory: "failed",
              status: 504,
              attempts: context.attemptCount,
              stream: true,
              durationMs,
              targetProtocol: context.targetProtocol,
              provider: context.providerName,
              canonicalPublicName: context.canonicalName,
            });
          } else {
            await context.coordinator.finalize({
              terminal: { kind: "cancelled", by: reason === "client" ? "client" : "shutdown" },
              outcomeCategory: "cancelled",
              status: 499,
              attempts: context.attemptCount,
              stream: true,
              durationMs,
              targetProtocol: context.targetProtocol,
              provider: context.providerName,
              canonicalPublicName: context.canonicalName,
            });
          }
        } else {
          await context.coordinator.finalize({
            terminal: { kind: "failed", failure: interruptedFailure() },
            outcomeCategory: "failed",
            status: 502,
            attempts: context.attemptCount,
            stream: true,
            durationMs,
            targetProtocol: context.targetProtocol,
            provider: context.providerName,
            canonicalPublicName: context.canonicalName,
          });
        }
        controller.error(error);
      }
    },

    async cancel(reason) {
      if (isClosed()) return;
      ownership = { kind: "closed", reason: "cancelled" };

      const durationMs = context.clock.nowMonotonicMs() - context.started;
      await reader.cancel(reason).catch(() => undefined);
      await providerSink.discard().catch(() => undefined);
      await irEventsSink.discard().catch(() => undefined);

      await context.coordinator.finalize({
        terminal: { kind: "cancelled", by: "client" },
        outcomeCategory: "cancelled",
        status: 499,
        attempts: context.attemptCount,
        stream: true,
        durationMs,
        targetProtocol: context.targetProtocol,
        provider: context.providerName,
        canonicalPublicName: context.canonicalName,
      });
    },
  });

  return {
    kind: "stream",
    status: 200,
    headers: streamHeaders,
    body,
    onDelivered: async (durationMs: number) => {
      if (deliver !== undefined) {
        await deliver(durationMs);
      }
    },
  };
}
