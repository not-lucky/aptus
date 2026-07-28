import type {
  AttemptObservation,
  GatewayRequest,
  GatewayResult,
  Protocol,
  ProviderResponse,
  TraceSession,
} from "../domain/contracts.js";
import type { TraceTerminal } from "../domain/operations.js";
import type { GatewayObservability } from "../observability/lifecycle-observer.js";
import { parseJsonBytes } from "./attempt.js";
import { failureFromObservation, streamFailure } from "./failures.js";
import type { Clock } from "./timing.js";

/**
 * Reads a response body stream fully into a single byte buffer.
 */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return concat(chunks);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Context for relaying one attempt's owned response to HTTP.
 */
export interface RelayContext {
  readonly aptusRequestId: GatewayRequest["aptusRequestId"];
  /** Monotonic request start used for duration and TTFT metrics. */
  readonly started: number;
  readonly endpointProtocol: Protocol;
  readonly canonicalName: string;
  readonly providerName: string;
  readonly targetProtocol: Protocol;
  readonly attemptCount: number;
  readonly trace: TraceSession;
  readonly finish: (terminal: TraceTerminal) => Promise<void>;
  readonly observer: GatewayObservability;
  readonly requestSignal: AbortSignal;
  readonly clock: Clock;
}

/**
 * Relays an already fully read (non-streaming) response to HTTP, recording the
 * terminal Trace and telemetry exactly once.
 *
 * The caller reads the body before any client byte so an interrupted provider
 * body can still fall back by policy; this function only completes requests.
 */
export async function relayComplete(
  response: ProviderResponse,
  body: Uint8Array,
  observation: AttemptObservation,
  context: RelayContext,
): Promise<GatewayResult> {
  const success = observation.result === "success";
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("json")) {
    const parsed = parseJsonBytes(body);
    await context.trace.recordJson("provider_response", parsed);
    await context.trace.recordJson("client_response", parsed);
  } else {
    await context.trace.recordBytes("provider_response", body);
    await context.trace.recordBytes("client_response", body);
  }

  const durationMs = context.clock.nowMonotonicMs() - context.started;
  if (success) {
    await context.finish({ kind: "complete", status: response.status });
  } else {
    await context.finish({ kind: "failed", failure: failureFromObservation(observation) });
  }
  context.observer.completed({
    aptusRequestId: context.aptusRequestId,
    endpointProtocol: context.endpointProtocol,
    targetProtocol: context.targetProtocol,
    provider: context.providerName,
    canonicalPublicName: context.canonicalName,
    outcomeCategory: success ? "complete" : "failed",
    status: response.status,
    attempts: context.attemptCount,
    stream: false,
    durationMs,
    firstByteMs: durationMs,
  });

  return { kind: "complete", status: response.status, headers: response.headers, body };
}

/**
 * Wraps a streaming provider body for relay, buffering bytes for the `.sse`
 * Trace files and finishing the Trace/telemetry exactly once at end/error/cancel.
 */
export function relayStream(response: ProviderResponse, context: RelayContext): GatewayResult {
  const reader = response.body.getReader();
  const buffered: Uint8Array[] = [];
  let firstByteMs: number | undefined;
  let streamTerminalDone = false;

  const finishStream = async (terminal: TraceTerminal, outcome: "complete" | "failed" | "cancelled"): Promise<void> => {
    if (streamTerminalDone) return;
    streamTerminalDone = true;
    // Write identical provider/client stream bytes, then the terminal marker.
    const bytes = concat(buffered);
    if (outcome !== "cancelled") {
      await context.trace.recordBytes("provider_stream", bytes);
      await context.trace.recordBytes("client_stream", bytes);
    }
    if (outcome === "cancelled") {
      await context.finish(terminal);
      context.observer.cancelled({ aptusRequestId: context.aptusRequestId, phase: "stream", by: "client" });
      return;
    }
    await context.finish(terminal);
    const durationMs = context.clock.nowMonotonicMs() - context.started;
    context.observer.completed({
      aptusRequestId: context.aptusRequestId,
      endpointProtocol: context.endpointProtocol,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
      outcomeCategory: outcome,
      status: response.status,
      attempts: context.attemptCount,
      stream: true,
      durationMs,
      firstByteMs: firstByteMs ?? durationMs,
    });
  };

  return {
    kind: "stream",
    status: response.status,
    headers: response.headers,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (firstByteMs === undefined) {
            firstByteMs = context.clock.nowMonotonicMs() - context.started;
            context.observer.firstByte({
              aptusRequestId: context.aptusRequestId,
              attemptNumber: context.attemptCount,
              durationMs: firstByteMs,
            });
          }
          if (chunk.done) {
            await finishStream({ kind: "complete", status: response.status }, "complete");
            controller.close();
            return;
          }
          buffered.push(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (context.requestSignal.aborted) {
            await finishStream({ kind: "cancelled", by: "client" }, "cancelled");
          } else {
            await finishStream({ kind: "failed", failure: streamFailure(error) }, "failed");
          }
          controller.error(error);
        }
      },
      cancel() {
        void reader.cancel();
        void finishStream({ kind: "cancelled", by: "client" }, "cancelled");
      },
    }),
  };
}
