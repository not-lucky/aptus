/**
 * @fileoverview
 * Client delivery pump: backpressured transfer of a response body to the HTTP transport.
 *
 * Owns the single pull loop used by both complete-body and streaming gateway results:
 * read chunks with abort racing, apply drain backpressure when the transport buffer is
 * full, record the client first-byte mark, append chunks to an optional trace sink, and
 * finish with the transport end and the delivered hook. Cleanup is unconditional: the
 * reader is released, cancellation listeners are removed, and the settle hook runs on
 * every exit, so aborted and errored deliveries discard their sinks exactly like clean
 * ones.
 */

import type { TerminalCoordinator } from "../domain/contracts.ts";
import { raceWithAbort } from "./abort-race.ts";

/** Trace sink receiving relayed bytes; discarded on aborted or errored delivery. */
export interface DeliverySink {
  /** Appends one delivered chunk. */
  append(chunk: Uint8Array): Promise<void>;
  /** Marks the sink complete after a clean delivery. */
  complete(): Promise<void>;
  /** Discards the sink after an aborted or errored delivery. */
  discard(): Promise<void>;
}

/**
 * Minimal structural transport contract satisfied by the Express response.
 *
 * Kept intentionally narrow so the pump can be tested against a fake without
 * coupling to Express: write returns false when the socket buffer is full,
 * and drain / close are the backpressure and disconnect events.
 */
export interface DeliveryTransport {
  /** Writes one chunk; returns false when backpressured (wait for drain). */
  write(chunk: Uint8Array): boolean;
  /** Finishes the response body. */
  end(): void;
  /** Subscribes a one-shot event listener. */
  once(event: "drain" | "close", listener: () => void): unknown;
  /** Removes a previously subscribed listener. */
  off(event: "drain" | "close", listener: () => void): unknown;
}

/** Options configuring one delivery pump run. */
export interface DeliveryPumpOptions {
  /** Source reader yielding the response body chunks. */
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** HTTP transport receiving the chunks. */
  readonly transport: DeliveryTransport;
  /** Abort signal racing chunk reads and drain waits. */
  readonly signal: AbortSignal;
  /** Terminal coordinator receiving the first-byte mark. */
  readonly coordinator: Pick<TerminalCoordinator, "markClientFirstByte">;
  /** Optional trace sink recording delivered bytes; omitted for in-memory bodies. */
  readonly sink?: DeliverySink;
  /** When true, cancels the reader on signal abort and transport close (streaming sources). */
  readonly cancelOnAbort?: boolean;
  /** Invoked after the transport end on the clean delivery path. */
  readonly onDelivered?: () => Promise<void>;
  /** Invoked after the pump settles on every exit path (e.g. owned-body disposal). */
  readonly onSettled?: () => Promise<void>;
}

/** Outcome of a delivery pump run. */
export type DeliveryResult = "complete" | "aborted";

/**
 * Pumps a response body to the transport with backpressure, abort racing, and unconditional cleanup.
 *
 * @param options - Reader, transport, signal, coordinator, sink, and terminal hooks.
 * @returns `"complete"` when the body fully transferred, `"aborted"` when the signal cut it short.
 */
export async function pumpDelivery(options: DeliveryPumpOptions): Promise<DeliveryResult> {
  const { reader, transport, signal, coordinator, sink, cancelOnAbort, onDelivered, onSettled } = options;

  const cancelSource = (): void => {
    void reader.cancel();
  };
  const cancelWired = cancelOnAbort === true;
  if (cancelWired) {
    signal.addEventListener("abort", cancelSource, { once: true });
    transport.once("close", cancelSource);
  }

  const discardSink = async (): Promise<void> => {
    if (sink !== undefined) await sink.discard().catch(() => undefined);
  };

  let outcome: DeliveryResult = "complete";
  try {
    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      if (chunk.aborted) {
        outcome = "aborted";
        await discardSink();
        break;
      }
      if (chunk.value.done) break;
      // Write chunk; when the socket buffer is full (false), wait for drain before reading the next chunk.
      if (!transport.write(chunk.value.value)) {
        const drained = await raceWithAbort(waitForDrain(transport), signal);
        if (drained.aborted) {
          outcome = "aborted";
          await discardSink();
          break;
        }
      }
      coordinator.markClientFirstByte();
      if (sink !== undefined) {
        await sink.append(chunk.value.value);
      }
    }
    if (outcome === "complete") {
      // The terminal mark also records first byte for empty bodies that never wrote a chunk.
      coordinator.markClientFirstByte();
      await sink?.complete().catch(() => undefined);
      transport.end();
      await onDelivered?.();
    }
  } catch (error) {
    await discardSink();
    throw error;
  } finally {
    reader.releaseLock();
    if (cancelWired) {
      signal.removeEventListener("abort", cancelSource);
      transport.off("close", cancelSource);
    }
    await onSettled?.();
  }
  return outcome;
}

/**
 * Resolves when the transport emits drain, removing the listener on fire.
 *
 * @param transport - Transport whose drain event is awaited.
 * @returns Promise resolving on the next drain emission.
 */
function waitForDrain(transport: DeliveryTransport): Promise<void> {
  return new Promise((resolve) => {
    const listener = (): void => {
      transport.off("drain", listener);
      resolve();
    };
    transport.once("drain", listener);
  });
}
