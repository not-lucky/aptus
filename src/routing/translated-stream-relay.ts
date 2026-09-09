/**
 * @fileoverview
 * Delivery and backpressure management for cross-protocol translated SSE streams.
 *
 * Implements the translated streaming path on top of the shared {@link runStreamRelay} engine:
 * {@link bootstrapTranslatedStream} reads initial provider chunks and drives the translation pump
 * before client HTTP headers commit (preserving retry/fallback capabilities), while
 * {@link relayTranslatedStream} hands the bootstrapped reader, pump, and trace sinks to the
 * engine, supplying a stream transform that re-frames provider bytes through the pump.
 */

import type {
  AptusRequestId,
  GatewayResult,
  HeaderMap,
  Protocol,
  ProviderResponse,
  TerminalCoordinator,
  TraceByteSink,
  TraceSession,
} from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import type { Direction, StreamSessionBundle } from "../translation/contracts.ts";
import { createSseDecoder, createSseEncoder } from "../translation/sse.ts";
import { TranslatedStreamPump } from "../translation/stream-pump.ts";
import { createIrStreamStateMachine } from "../translation/stream-state.ts";
import { dispatchFailure } from "./failures.ts";
import { runStreamRelay, type StreamEofVerdict, type StreamTransform } from "./stream-relay.ts";
import type { Clock } from "./timing.ts";

const utf8Encoder = new TextEncoder();

/** Standard downstream SSE response headers for translated stream relay. */
const STREAM_HEADERS: HeaderMap = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

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
  /** Unique request identifier recorded in cancellation telemetry. */
  readonly aptusRequestId: AptusRequestId;
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
  readonly pricing: import("../domain/pricing.ts").PricingConfig | null;
  /** Inbound request abort signal. */
  readonly requestSignal: AbortSignal;
  /** Active trace session recording cancellation stages. */
  readonly trace: TraceSession;
  /** Telemetry observer receiving lifecycle and cancellation events. */
  readonly observer: GatewayObservability;
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
 * Delegates the delivery spine to the shared {@link runStreamRelay} engine with a stream
 * transform that pushes provider bytes through the bootstrapped translation pump.
 *
 * @param context - Stream reader, translation pump, trace sinks, and lifecycle context.
 * @returns Gateway streaming result with standard SSE headers.
 */
export function relayTranslatedStream(context: TranslatedStreamRelayContext): GatewayResult {
  const { reader, pump, providerSink, irEventsSink } = context;

  return runStreamRelay({
    aptusRequestId: context.aptusRequestId,
    coordinator: context.coordinator,
    clock: context.clock,
    started: context.started,
    attemptCount: context.attemptCount,
    targetProtocol: context.targetProtocol,
    clientProtocol: context.clientProtocol,
    providerName: context.providerName,
    canonicalName: context.canonicalName,
    pricing: context.pricing,
    requestSignal: context.requestSignal,
    trace: context.trace,
    observer: context.observer,
    reader,
    sinks: [providerSink, irEventsSink],
    transform: createTranslatedStreamTransform(pump, providerSink),
    status: 200,
    headers: STREAM_HEADERS,
    initialClientChunks: context.initialClientChunks,
    isInitialComplete: context.isInitialComplete,
  });
}

/**
 * Builds the translated stream transform used by {@link relayTranslatedStream}.
 *
 * The transform pushes provider chunks through the bootstrapped {@link TranslatedStreamPump},
 * which decodes provider SSE frames, drives the IR state machine, and encodes client SSE frames.
 * Its end-of-stream verdict reads the pump terminal state: a terminal stream with an in-band
 * provider error is reported as an in-band failure (emitted politely as SSE error frames), a
 * terminal stream without one is a clean completion carrying the pump's observed usage, and a
 * stream that never reached a terminal state is interrupted.
 *
 * @param pump - Bootstrapped translation pump.
 * @param providerSink - Trace byte sink receiving raw upstream provider stream bytes.
 * @returns Translated stream transform adapter.
 */
function createTranslatedStreamTransform(pump: TranslatedStreamPump, providerSink: TraceByteSink): StreamTransform {
  return {
    feed(chunk: Uint8Array) {
      void providerSink.append(chunk);
      return pump.pushBytes(chunk);
    },

    finish() {
      return pump.finish();
    },

    eofVerdict(): StreamEofVerdict {
      if (!pump.isTerminal()) {
        return { kind: "no_terminal" };
      }
      const failure = pump.getFailure();
      if (failure !== undefined) {
        return { kind: "inband_failure", failure };
      }
      const observedUsage = pump.getUsage();
      if (observedUsage === undefined) {
        return { kind: "complete" };
      }
      return {
        kind: "complete",
        usageRecord: {
          input_tokens: observedUsage.input,
          output_tokens: observedUsage.output,
          ...(observedUsage.total !== undefined ? { total_tokens: observedUsage.total } : {}),
        },
        costUsage: observedUsage,
      };
    },
  };
}
