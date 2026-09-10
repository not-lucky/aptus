/**
 * @fileoverview
 * Delivery of complete and streaming provider responses to downstream HTTP clients.
 *
 * Coordinates the terminal phase of request execution: {@link relayComplete} transfers non-streaming
 * payloads (spooling memory vs disk payloads to trace), {@link relayTranslatedComplete} delivers
 * cross-protocol converted JSON responses, and {@link relayStream} streams chunked SSE events while
 * capturing raw bytes and collecting token usage. Streaming delivery itself runs on the shared
 * {@link runStreamRelay} engine in `stream-relay.ts`; this module supplies the native pass-through
 * stream transform and the complete-response relay paths.
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
  TraceByteSink,
  TraceSession,
} from "../domain/contracts.ts";
import { estimateCostUsd, type PricingConfig } from "../domain/pricing.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import type { TranslateCompleteOutcomeResult } from "../translation/contracts.ts";
import { failureFromObservation } from "./failures.ts";
import { createOwnedMemoryBody } from "./spool.ts";
import { runStreamRelay, type StreamEofVerdict, type StreamTransform } from "./stream-relay.ts";
import { buildTerminalFact } from "./terminal-outcome.ts";
import type { Clock } from "./timing.ts";
import {
  createStreamUsageCollector,
  extractCompleteUsage,
  type StreamUsageCollector,
  type UsageExtractionResult,
} from "./usage.ts";

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
  readonly observer: LifecycleObserver;
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

  // A success relays a clean complete terminal with whatever usage/cost was extracted;
  // a failure relays the upstream error body verbatim, so the fact reports the upstream
  // status that was actually delivered (an explicit status, not a category derivation).
  const fact = buildTerminalFact(
    {
      attempts: context.attemptCount,
      stream: false,
      clientProtocol: context.endpointProtocol,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
    },
    success
      ? { kind: "complete", status: response.status, usage: rawUsage, estimatedCostUsd }
      : { kind: "failed", failure: failureFromObservation(observation), status: response.status },
  );

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

  const fact = buildTerminalFact(
    {
      attempts: context.attemptCount,
      stream: false,
      clientProtocol: context.endpointProtocol,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
    },
    { kind: "complete", status: outcome.status, usage: rawUsage, estimatedCostUsd },
  );

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
 * Delegates the delivery spine to the shared {@link runStreamRelay} engine with a native
 * pass-through stream transform: provider chunks are byte-relayed unchanged while the usage
 * collector verifies protocol terminal markers and extracts token usage.
 *
 * @param response - Upstream provider response holding readable stream body.
 * @param context - Relay execution context.
 * @returns Streaming gateway result managing chunk delivery and terminal finalization.
 */
export function relayStream(response: ProviderResponse, context: RelayContext): GatewayResult {
  const providerSink = context.trace.openBytes("provider_stream");
  const usageCollector = createStreamUsageCollector(context.targetProtocol);
  return runStreamRelay({
    aptusRequestId: context.aptusRequestId,
    coordinator: context.coordinator,
    clock: context.clock,
    started: context.started,
    attemptCount: context.attemptCount,
    targetProtocol: context.targetProtocol,
    clientProtocol: context.endpointProtocol,
    providerName: context.providerName,
    canonicalName: context.canonicalName,
    pricing: context.pricing,
    requestSignal: context.requestSignal,
    trace: context.trace,
    observer: context.observer,
    reader: response.body.getReader(),
    sinks: [providerSink],
    transform: createNativeStreamTransform(usageCollector, providerSink),
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Builds the native pass-through stream transform used by {@link relayStream}.
 *
 * The transform byte-relays each provider chunk unchanged, feeding it to the stream usage
 * collector for terminal-marker verification and usage extraction. Its end-of-stream verdict
 * mirrors native relay semantics: a stream that reached a valid terminal marker or carried an
 * explicit provider error event is a clean completion (the client parses any error payload from
 * the relayed bytes), while a stream ending without either is interrupted.
 *
 * @param usageCollector - Incremental SSE usage and terminal-marker collector.
 * @param providerSink - Trace byte sink receiving raw provider stream bytes.
 * @returns Native pass-through stream transform adapter.
 */
function createNativeStreamTransform(
  usageCollector: StreamUsageCollector,
  providerSink: TraceByteSink,
): StreamTransform {
  let usageResult: UsageExtractionResult | undefined;

  return {
    feed(chunk: Uint8Array) {
      usageCollector.feed(chunk);
      void providerSink.append(chunk);
      return { ok: true as const, value: [chunk] };
    },

    finish() {
      usageResult = usageCollector.finish();
      return { ok: true as const, value: [] };
    },

    eofVerdict(): StreamEofVerdict {
      const result = usageResult;
      if (result === undefined || (!result.hasValidTerminal && !result.isProviderError)) {
        return { kind: "no_terminal" };
      }
      return {
        kind: "complete",
        ...(result.rawUsage !== undefined ? { usageRecord: result.rawUsage } : {}),
        ...(result.normalizedUsage !== undefined ? { costUsage: result.normalizedUsage } : {}),
      };
    },
  };
}
