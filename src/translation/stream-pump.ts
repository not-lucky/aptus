import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { ClientStreamEncoder, ProviderStreamDecoder } from "./contracts.ts";
import type { IrStreamEvent, IrUsage } from "./ir.ts";
import type { SseDecoder, SseEncoder, SseFrame } from "./sse.ts";
import type { IrStreamStateMachine } from "./stream-state.ts";

/**
 * Owns the cross-protocol streaming pipeline: strict SSE framing, provider
 * stream decoding, IR state-machine validation, and client stream encoding.
 *
 * The pre-header bootstrap (translated-stream-attempt) and the post-header
 * relay (translated-stream-relay) both drive the same pipeline through this
 * class, so the decode/validate/encode loop lives in exactly one place.
 */
export class TranslatedStreamPump {
  private observedUsage: IrUsage | undefined;
  private readonly sseDecoder: SseDecoder;
  private readonly sseEncoder: SseEncoder;
  private readonly providerDecoder: ProviderStreamDecoder;
  private readonly stateMachine: IrStreamStateMachine;
  private readonly clientEncoder: ClientStreamEncoder;
  private readonly onEvent: (event: IrStreamEvent) => void;

  constructor(
    sseDecoder: SseDecoder,
    sseEncoder: SseEncoder,
    providerDecoder: ProviderStreamDecoder,
    stateMachine: IrStreamStateMachine,
    clientEncoder: ClientStreamEncoder,
    onEvent: (event: IrStreamEvent) => void,
  ) {
    this.sseDecoder = sseDecoder;
    this.sseEncoder = sseEncoder;
    this.providerDecoder = providerDecoder;
    this.stateMachine = stateMachine;
    this.clientEncoder = clientEncoder;
    this.onEvent = onEvent;
  }

  /** Final usage observed on the stream's `response_end`, if any. */
  getUsage(): IrUsage | undefined {
    return this.observedUsage;
  }

  /** Whether the IR state machine has reached a terminal state. */
  isTerminal(): boolean {
    return this.stateMachine.isTerminal();
  }

  /**
   * Feeds one provider byte segment through SSE framing and the semantic pipeline.
   *
   * @returns Ordered target client chunks, or a terminal fail-closed failure.
   */
  pushBytes(bytes: Uint8Array): Result<readonly Uint8Array[], NormalizedFailure> {
    const chunks: Uint8Array[] = [];
    for (const res of this.sseDecoder.push(bytes)) {
      if (res.kind === "failure") {
        return { ok: false, error: res.failure };
      }
      if (res.kind === "frame") {
        const frameResult = this.processFrame(res.frame, chunks);
        if (!frameResult.ok) return frameResult;
      }
    }
    return { ok: true, value: chunks };
  }

  /**
   * Finishes at EOF: flushes SSE framing, the provider decoder, and the client encoder.
   *
   * @returns Remaining target client chunks, or a terminal fail-closed failure.
   */
  finish(): Result<readonly Uint8Array[], NormalizedFailure> {
    const chunks: Uint8Array[] = [];

    for (const res of this.sseDecoder.finish()) {
      if (res.kind === "failure") {
        return { ok: false, error: res.failure };
      }
      if (res.kind === "frame") {
        const frameResult = this.processFrame(res.frame, chunks);
        if (!frameResult.ok) return frameResult;
      }
    }

    const providerFinish = this.providerDecoder.finish();
    if (!providerFinish.ok) {
      return { ok: false, error: providerFinish.error };
    }
    for (const evt of providerFinish.value) {
      const eventResult = this.processEvent(evt, chunks);
      if (!eventResult.ok) return eventResult;
    }

    const clientFinish = this.clientEncoder.finish();
    if (!clientFinish.ok) {
      return { ok: false, error: clientFinish.error };
    }
    for (const frame of clientFinish.value) {
      chunks.push(this.sseEncoder.encode(frame));
    }

    return { ok: true, value: chunks };
  }

  private processFrame(frame: SseFrame, chunks: Uint8Array[]): Result<void, NormalizedFailure> {
    const providerResult = this.providerDecoder.push(frame);
    if (!providerResult.ok) {
      return { ok: false, error: providerResult.error };
    }
    for (const evt of providerResult.value) {
      const eventResult = this.processEvent(evt, chunks);
      if (!eventResult.ok) return eventResult;
    }
    return { ok: true, value: undefined };
  }

  private processEvent(evt: IrStreamEvent, chunks: Uint8Array[]): Result<void, NormalizedFailure> {
    const smResult = this.stateMachine.feed(evt);
    if (!smResult.ok) {
      return { ok: false, error: smResult.error };
    }
    this.onEvent(evt);
    if (evt.type === "response_end" && evt.usage !== undefined) {
      this.observedUsage = evt.usage;
    }
    const clientResult = this.clientEncoder.encode(evt);
    if (!clientResult.ok) {
      return { ok: false, error: clientResult.error };
    }
    for (const frame of clientResult.value) {
      chunks.push(this.sseEncoder.encode(frame));
    }
    return { ok: true, value: undefined };
  }
}
