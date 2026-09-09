/**
 * @fileoverview
 * Delivery of complete and streaming provider responses to downstream HTTP clients.
 *
 * Coordinates the terminal phase of request execution: {@link relayComplete} transfers non-streaming
 * payloads (spooling memory vs disk payloads to trace), {@link relayTranslatedComplete} delivers
 * cross-protocol converted JSON responses, and {@link relayStream} streams chunked SSE events while
 * capturing raw bytes, collecting token usage, and finalizing lifecycle facts.
 */

import type {
  AttemptObservation,
  GatewayRequest,
  GatewayResult,
  JsonObject,
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
import type { TranslateCompleteOutcomeResult } from "../translation/contracts.ts";
import { classifyAbortReason } from "./attempt.ts";
import { failureFromObservation, interruptedFailure, streamFailure, timeoutFailure } from "./failures.ts";
import { createOwnedMemoryBody } from "./spool.ts";
import type { Clock } from "./timing.ts";
import { createStreamUsageCollector, extractCompleteUsage } from "./usage.ts";

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Shared context required for relaying provider responses to the client. */
export interface RelayContext {
  /** Unique request identifier. */
  readonly aptusRequestId: GatewayRequest["aptusRequestId"];
  /** Monotonic millisecond timestamp when request admission completed. */
  readonly started: number;
  /** Ingress protocol spoken by the client endpoint. */
  readonly endpointProtocol: Protocol;
  /** Canonical model or route name requested by client. */
  readonly canonicalName: string;
  /** Upstream provider identifier. */
  readonly providerName: string;
  /** Protocol spoken by the upstream provider. */
  readonly targetProtocol: Protocol;
  /** Total number of attempts executed across all candidates. */
  readonly attemptCount: number;
  /** Active trace session for recording client/provider responses. */
  readonly trace: TraceSession;
  /** Terminal coordinator tracking lifecycle completion. */
  readonly coordinator: TerminalCoordinator;
  /** Telemetry observer for lifecycle and cancellation events. */
  readonly observer: GatewayObservability;
  /** Inbound request abort signal. */
  readonly requestSignal: AbortSignal;
  /** Monotonic and wall clock source. */
  readonly clock: Clock;
  /** Pricing configuration for calculating estimated cost. */
  readonly pricing: PricingConfig | null;
}

/**
 * Relays a non-streaming provider response, recording client traces and finalizing the terminal fact.
 *
 * @param response - Received provider response head.
 * @param body - Buffered owned body.
 * @param observation - Classified attempt observation.
 * @param context - Relay execution context.
 * @returns Complete gateway result with delivery finalization callback.
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
 * Relays an egress-encoded cross-protocol translated response to HTTP.
 *
 * @param _response - Original upstream response.
 * @param rawProviderBody - Raw upstream body to be disposed.
 * @param outcome - Translated outcome containing client-facing body, status, and headers.
 * @param context - Relay execution context.
 * @returns Complete gateway result with delivery finalization callback.
 */
export async function relayTranslatedComplete(
  _response: ProviderResponse,
  rawProviderBody: OwnedBody,
  outcome: TranslateCompleteOutcomeResult,
  context: RelayContext,
): Promise<GatewayResult> {
  await rawProviderBody.dispose().catch(() => undefined);

  const clientBytes = utf8Encoder.encode(JSON.stringify(outcome.body));
  const clientBody = createOwnedMemoryBody(clientBytes);

  let rawUsage: JsonObject | undefined;
  let estimatedCostUsd: string | undefined;

  if (outcome.irOutcome.usage !== undefined) {
    rawUsage = {
      input_tokens: outcome.irOutcome.usage.input,
      output_tokens: outcome.irOutcome.usage.output,
      ...(outcome.irOutcome.usage.total !== undefined ? { total_tokens: outcome.irOutcome.usage.total } : {}),
    };

    if (context.pricing !== null) {
      try {
        estimatedCostUsd = estimateCostUsd(context.pricing, {
          input: outcome.irOutcome.usage.input,
          output: outcome.irOutcome.usage.output,
          total: outcome.irOutcome.usage.total,
        });
      } catch {
        // Suppress cost if estimation fails
      }
    }
  }

  const fact: Omit<TerminalFact, "durationMs"> = {
    terminal: {
      kind: "complete",
      status: outcome.status,
      ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    },
    outcomeCategory: "complete",
    status: outcome.status,
    attempts: context.attemptCount,
    stream: false,
    targetProtocol: context.targetProtocol,
    provider: context.providerName,
    canonicalPublicName: context.canonicalName,
    usage: rawUsage,
    estimatedCostUsd,
  };

  return {
    kind: "complete",
    status: outcome.status,
    headers: outcome.headers,
    body: clientBody,
    onDelivered: async (durationMs: number) => {
      await context.trace.recordJson("client_response", outcome.body);
      await context.coordinator.finalize({ ...fact, durationMs });
    },
  };
}

/**
 * Wraps a native streaming provider body for client relay, tapping chunks into trace and usage collectors.
 *
 * @param response - Upstream provider response holding readable stream body.
 * @param context - Relay execution context.
 * @returns Streaming gateway result managing chunk delivery and terminal finalization.
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
