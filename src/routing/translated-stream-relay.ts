import type { GatewayResult, HeaderMap, Protocol, TerminalCoordinator, TraceByteSink } from "../domain/contracts.ts";
import type { NormalizedFailure, TraceTerminal } from "../domain/operations.ts";
import { estimateCostUsd, type PricingConfig } from "../domain/pricing.ts";
import type { ResponseOwnership } from "../translation/sse.ts";
import type { TranslatedStreamPump } from "../translation/stream-pump.ts";
import { classifyAbortReason } from "./attempt.ts";
import { interruptedFailure, timeoutFailure } from "./failures.ts";
import type { Clock } from "./timing.ts";

/**
 * Context dependencies for relaying a translated stream.
 */
export interface TranslatedStreamRelayContext {
  readonly coordinator: TerminalCoordinator;
  readonly clock: Clock;
  readonly started: number;
  readonly attemptCount: number;
  readonly targetProtocol: Protocol;
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
      status: 502,
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
            await finalizeCleanSuccess(controller);
          }
          return;
        }

        if (isStreamDone) {
          await finalizeCleanSuccess(controller);
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
            await finalizeCleanSuccess(controller);
          }
        } else if (isStreamDone) {
          await finalizeCleanSuccess(controller);
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
