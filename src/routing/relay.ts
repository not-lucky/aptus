import type {
  AttemptObservation,
  GatewayRequest,
  GatewayResult,
  JsonValue,
  OwnedBody,
  Protocol,
  ProviderResponse,
  TerminalCoordinator,
  TerminalFact,
  TraceSession,
} from "../domain/contracts.ts";
import type { TraceTerminal } from "../domain/operations.ts";
import { estimateCostUsd, type PricingConfig } from "../domain/pricing.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import { classifyAbortReason } from "./attempt.ts";
import { failureFromObservation, interruptedFailure, streamFailure, timeoutFailure } from "./failures.ts";
import type { Clock } from "./timing.ts";
import { createStreamUsageCollector, extractCompleteUsage } from "./usage.ts";

const utf8Decoder = new TextDecoder();

/**
 * Context for relaying one attempt's owned response to HTTP.
 */
export interface RelayContext {
  readonly aptusRequestId: GatewayRequest["aptusRequestId"];
  /** Monotonic request start used for duration and TTFF metrics. */
  readonly started: number;
  readonly endpointProtocol: Protocol;
  readonly canonicalName: string;
  readonly providerName: string;
  readonly targetProtocol: Protocol;
  readonly attemptCount: number;
  readonly trace: TraceSession;
  readonly coordinator: TerminalCoordinator;
  readonly observer: GatewayObservability;
  readonly requestSignal: AbortSignal;
  readonly clock: Clock;
  readonly pricing: PricingConfig | null;
}

/**
 * Relays an already fully read (non-streaming) response to HTTP, recording the
 * terminal Trace and telemetry exactly once.
 *
 * @param response - Response head and metadata.
 * @param body - The owned response body abstraction.
 * @param observation - Attempt observation.
 * @param context - Relay execution context.
 * @returns Complete {@link GatewayResult}.
 */
export async function relayComplete(
  response: ProviderResponse,
  body: OwnedBody,
  observation: AttemptObservation,
  context: RelayContext,
): Promise<GatewayResult> {
  const success = observation.result === "success";

  let rawUsage: import("../domain/contracts.ts").JsonObject | undefined;
  let estimatedCostUsd: string | undefined;
  let parsedJson: JsonValue | undefined;
  let rawBytes: Uint8Array | undefined;

  if (body.inMemoryBytes !== undefined) {
    rawBytes = body.inMemoryBytes;
    try {
      parsedJson = JSON.parse(utf8Decoder.decode(rawBytes)) as JsonValue;
    } catch {
      parsedJson = undefined;
    }

    if (parsedJson !== undefined) {
      await context.trace.recordJson("provider_response", parsedJson);
      if (success && parsedJson !== null && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
        const usageResult = extractCompleteUsage(
          context.targetProtocol,
          parsedJson as import("../domain/contracts.ts").JsonObject,
        );
        rawUsage = usageResult.rawUsage;
        if (context.pricing !== null && usageResult.normalizedUsage !== undefined) {
          try {
            estimatedCostUsd = estimateCostUsd(context.pricing, usageResult.normalizedUsage);
          } catch {
            // Suppress cost if estimation fails
          }
        }
      }
    } else {
      await context.trace.recordBytes("provider_response", rawBytes);
    }
  } else {
    // Disk-backed response: stream directly to provider trace sink without full-RAM materialization
    const providerSink = context.trace.openBytes("provider_response");
    const usageCollector = createStreamUsageCollector(context.targetProtocol);
    const reader = body.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0) {
          usageCollector.feed(value);
          await providerSink.append(value);
        }
      }
      await providerSink.complete();
      if (success) {
        const usageResult = usageCollector.finish();
        rawUsage = usageResult.rawUsage;
        if (context.pricing !== null && usageResult.normalizedUsage !== undefined) {
          try {
            estimatedCostUsd = estimateCostUsd(context.pricing, usageResult.normalizedUsage);
          } catch {
            // Suppress cost if estimation fails
          }
        }
      }
    } catch {
      await providerSink.discard().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }

  const baseFact = {
    attempts: context.attemptCount,
    stream: false as const,
    targetProtocol: context.targetProtocol,
    provider: context.providerName,
    canonicalPublicName: context.canonicalName,
  };

  const fact: Omit<TerminalFact, "durationMs"> = success
    ? {
        terminal: {
          kind: "complete",
          status: response.status,
          ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
          ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        },
        outcomeCategory: "complete",
        status: response.status,
        ...baseFact,
        usage: rawUsage,
        estimatedCostUsd,
      }
    : {
        terminal: { kind: "failed", failure: failureFromObservation(observation) },
        outcomeCategory: "failed",
        status: response.status,
        ...baseFact,
      };

  return {
    kind: "complete",
    status: response.status,
    headers: response.headers,
    body,
    onDelivered: async (durationMs: number) => {
      if (body.inMemoryBytes !== undefined) {
        if (parsedJson !== undefined) {
          await context.trace.recordJson("client_response", parsedJson);
        } else if (rawBytes !== undefined) {
          await context.trace.recordBytes("client_response", rawBytes);
        }
      }
      await context.coordinator.finalize({ ...fact, durationMs });
    },
  };
}

/**
 * Wraps a streaming provider body for relay, streaming chunks to trace sinks and
 * finishing the Trace/telemetry exactly once at end/error/cancel.
 *
 * @param response - Upstream provider response.
 * @param context - Relay execution context.
 * @returns Streaming {@link GatewayResult}.
 */
export function relayStream(response: ProviderResponse, context: RelayContext): GatewayResult {
  const reader = response.body.getReader();
  const providerSink = context.trace.openBytes("provider_stream");
  const usageCollector = createStreamUsageCollector(context.targetProtocol);

  let streamFinalized = false;
  let deliver: ((durationMs: number) => Promise<void>) | undefined;

  return {
    kind: "stream",
    status: response.status,
    headers: response.headers,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (streamFinalized) return;
            streamFinalized = true;

            const usageResult = usageCollector.finish();
            await providerSink.complete().catch(() => undefined);

            if (!usageResult.hasValidTerminal && !usageResult.isProviderError) {
              // Interrupted before terminal marker
              const durationMs = context.clock.nowMonotonicMs() - context.started;
              const failure = interruptedFailure();
              await context.coordinator.finalize({
                terminal: { kind: "failed", failure },
                outcomeCategory: "failed",
                status: response.status,
                attempts: context.attemptCount,
                stream: true,
                durationMs,
                targetProtocol: context.targetProtocol,
                provider: context.providerName,
                canonicalPublicName: context.canonicalName,
              });
              controller.error(new Error("stream ended unexpectedly before terminal marker"));
              return;
            }

            let estimatedCostUsd: string | undefined;
            if (context.pricing !== null && usageResult.normalizedUsage !== undefined) {
              try {
                estimatedCostUsd = estimateCostUsd(context.pricing, usageResult.normalizedUsage);
              } catch {
                // Suppress cost
              }
            }

            const terminal: TraceTerminal = {
              kind: "complete",
              status: response.status,
              ...(usageResult.rawUsage !== undefined ? { usage: usageResult.rawUsage } : {}),
              ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
            };

            deliver = async (durationMs) => {
              await context.coordinator.finalize({
                terminal,
                outcomeCategory: "complete",
                status: response.status,
                attempts: context.attemptCount,
                stream: true,
                durationMs,
                targetProtocol: context.targetProtocol,
                provider: context.providerName,
                canonicalPublicName: context.canonicalName,
                usage: usageResult.rawUsage,
                estimatedCostUsd,
              });
            };
            controller.close();
            return;
          }

          usageCollector.feed(chunk.value);
          void providerSink.append(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (streamFinalized) return;
          streamFinalized = true;

          const durationMs = context.clock.nowMonotonicMs() - context.started;
          if (context.requestSignal.aborted) {
            const reason = classifyAbortReason(context.requestSignal);
            await providerSink.discard().catch(() => undefined);
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
              const by = reason === "shutdown" ? "shutdown" : "client";
              await context.trace.recordJson("cancellation", { phase: "relay", by });
              context.observer.cancelled({ aptusRequestId: context.aptusRequestId, phase: "relay", by });
              await context.coordinator.finalize({
                terminal: { kind: "cancelled", by },
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
            await providerSink.complete().catch(() => undefined);
            const failure = streamFailure(error);
            await context.coordinator.finalize({
              terminal: { kind: "failed", failure },
              outcomeCategory: "failed",
              status: response.status,
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
      cancel() {
        if (streamFinalized) return;
        streamFinalized = true;
        void reader.cancel();
        void providerSink.discard().catch(() => undefined);
        const durationMs = context.clock.nowMonotonicMs() - context.started;
        const reason = classifyAbortReason(context.requestSignal);
        if (reason === "timeout") {
          void context.coordinator.finalize({
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
          const by = reason === "shutdown" ? "shutdown" : "client";
          void context.trace.recordJson("cancellation", { phase: "relay", by });
          context.observer.cancelled({ aptusRequestId: context.aptusRequestId, phase: "relay", by });
          void context.coordinator.finalize({
            terminal: { kind: "cancelled", by },
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
      },
    }),
    onDelivered: async (durationMs) => {
      await deliver?.(durationMs);
    },
  };
}
