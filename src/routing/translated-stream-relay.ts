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

/**
 * Input for bootstrapping a translated stream before client headers commit.
 *
 * The relay module owns pump plus sink creation and the pre-header read loop
 * wholly behind its seam; the attempt module retains key-lease observation
 * and only consumes the ready pump/reader or the pre-header failure.
 */
export interface TranslatedStreamBootstrapInput {
  readonly trace: TraceSession;
  readonly response: ProviderResponse;
  readonly sessionBundle: StreamSessionBundle;
  readonly direction: Direction;
}

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
 * Creates the stream pump and trace sinks and reads until the first client
 * chunk (or terminal) without committing client headers.
 *
 * Zero-byte failures return `failure` for the caller to observe before client
 * bytes (retryable across candidates). Success transfers pump/reader/sink
 * ownership to `relayTranslatedStream`.
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
      // Zero-prior-bytes split: headers are not sent yet, so an in-band
      // failure here stays pre-header (retryable across candidates).
      // Once client bytes exist the relay owns the stream instead.
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

/**
 * Context dependencies for relaying a translated stream.
 */
export interface TranslatedStreamRelayContext {
  readonly coordinator: TerminalCoordinator;
  readonly clock: Clock;
  readonly started: number;
  readonly attemptCount: number;
  readonly targetProtocol: Protocol;
  /** Client protocol owning the response envelope; maps failure categories to status. */
  readonly clientProtocol: Protocol;
  readonly providerName: string;
  readonly canonicalName: string;
  readonly pricing: PricingConfig | null;
  readonly requestSignal: AbortSignal;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly pump: TranslatedStreamPump;
  readonly providerSink: TraceByteSink;
  readonly irEventsSink: TraceByteSink;
  readonly initialClientChunks: readonly Uint8Array[];
  readonly isInitialComplete: boolean;
}

/**
 * Relays an active translated SSE stream with strict backpressure and ordered trace sinks.
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

  async function finalizeInBandError(
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NormalizedFailure,
  ): Promise<void> {
    if (isClosed()) return;
    ownership = { kind: "closed", reason: "failed" };

    await providerSink.complete().catch(() => undefined);
    await irEventsSink.complete().catch(() => undefined);

    // The wire status is already 200 once headers are sent; this status is
    // Trace bookkeeping derived from the failure category exactly like the
    // pre-header path via statusFromCategory.
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

  async function finishRelay(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const failure = pump.getFailure();
    if (failure !== undefined) {
      await finalizeInBandError(controller, failure);
    } else {
      await finalizeCleanSuccess(controller);
    }
  }

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
