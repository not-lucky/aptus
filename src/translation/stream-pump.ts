/**
 * @fileoverview Cross-protocol streaming pipeline pumping upstream provider bytes to client SSE chunks.
 *
 * Implements {@link TranslatedStreamPump} to coordinate framing, decoding provider SSE chunks
 * into IR stream events, validating event sequences with {@link IrStreamStateMachine},
 * observing usage accounting, applying outcome wire sidecars, and encoding target client SSE frames.
 */

import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import type { ClientStreamEncoder, OutcomeWireOptions, ProviderStreamDecoder } from "./contracts.ts";
import type { IrStreamEvent, IrUsage } from "./ir.ts";
import { normalizeOutcomeWireOptions, outcomeWireOptionsFailure } from "./preflight.ts";
import { failure, ok } from "./result.ts";
import type { SseDecoder, SseEncoder, SseFrame } from "./sse.ts";
import type { IrStreamStateMachine } from "./stream-state.ts";

/**
 * Pipeline coordinating byte framing, IR event parsing, lifecycle validation, and client encoding.
 */
export class TranslatedStreamPump {
  /** Terminal usage metrics captured from the provider response end event. */
  private observedUsage: IrUsage | undefined;

  /** Terminal failure recorded if an in-band error occurs during streaming. */
  private observedFailure: NormalizedFailure | undefined;

  /** Incremental SSE framing decoder for incoming provider bytes. */
  private readonly sseDecoder: SseDecoder;

  /** Canonical SSE frame serializer for outgoing client chunks. */
  private readonly sseEncoder: SseEncoder;

  /** Protocol-specific stream decoder yielding semantic IR events. */
  private readonly providerDecoder: ProviderStreamDecoder;

  /** Stateful lifecycle validator enforcing IR stream sequence invariants. */
  private readonly stateMachine: IrStreamStateMachine;

  /** Protocol-specific stream encoder transforming IR events to client SSE frames. */
  private readonly clientEncoder: ClientStreamEncoder;

  /** Callback invoked synchronously for each validated IR stream event. */
  private readonly onEvent: (event: IrStreamEvent) => void;

  /**
   * Initializes a translated streaming pump with framing and codec pipeline stages.
   *
   * @param sseDecoder - Incremental SSE framing decoder for provider bytes.
   * @param sseEncoder - Canonical SSE encoder for client chunks.
   * @param providerDecoder - Protocol-specific stream decoder bound to the provider session.
   * @param stateMachine - Lifecycle state machine tracking event sequencing.
   * @param clientEncoder - Protocol-specific stream encoder bound to the client session.
   * @param onEvent - Event listener callback for telemetry and observation.
   */
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

  /**
   * Retrieves the final usage metrics captured from the stream, if reported by the provider.
   *
   * @returns Terminal {@link IrUsage} metrics, or `undefined` if absent or stream is incomplete.
   */
  getUsage(): IrUsage | undefined {
    return this.observedUsage;
  }

  /**
   * Retrieves the in-band provider error failure, if one occurred during streaming.
   *
   * @returns Terminal {@link NormalizedFailure}, or `undefined` if no in-band error occurred.
   */
  getFailure(): NormalizedFailure | undefined {
    return this.observedFailure;
  }

  /**
   * Checks whether the stream lifecycle state machine has reached a terminal state.
   *
   * @returns True if stream reached terminal completion or error.
   */
  isTerminal(): boolean {
    return this.stateMachine.isTerminal();
  }

  /**
   * Consumes an incoming chunk of provider bytes, returning encoded client SSE byte chunks.
   *
   * @param bytes - Incoming raw byte segment from upstream provider transport.
   * @returns List of encoded client byte chunks, or normalized failure if parsing or validation failed.
   */
  pushBytes(bytes: Uint8Array): Result<readonly Uint8Array[], NormalizedFailure> {
    // Ignore bytes received after an in-band provider error has already terminated the stream.
    if (this.observedFailure !== undefined) return ok([]);

    const chunks: Uint8Array[] = [];
    for (const res of this.sseDecoder.push(bytes)) {
      if (this.observedFailure !== undefined) break;
      if (res.kind === "failure") {
        return failure(res.failure);
      }
      if (res.kind === "frame") {
        const frameResult = this.processFrame(res.frame, chunks);
        if (!frameResult.ok) return frameResult;
      }
    }
    return ok(chunks);
  }

  /**
   * Finalizes framing and flushes remaining client chunks at provider end-of-stream.
   *
   * @returns Final encoded client byte chunks, or normalized failure if stream was truncated.
   */
  finish(): Result<readonly Uint8Array[], NormalizedFailure> {
    if (this.observedFailure !== undefined) return ok([]);

    const chunks: Uint8Array[] = [];

    for (const res of this.sseDecoder.finish()) {
      if (res.kind === "failure") {
        return failure(res.failure);
      }
      if (res.kind === "frame") {
        const frameResult = this.processFrame(res.frame, chunks);
        if (!frameResult.ok) return frameResult;
      }
    }

    if (this.observedFailure !== undefined) return ok(chunks);

    const providerFinish = this.providerDecoder.finish();
    if (!providerFinish.ok) {
      return failure(providerFinish.error);
    }
    for (const evt of providerFinish.value) {
      const eventResult = this.processEvent(evt, chunks);
      if (!eventResult.ok) return eventResult;
      if (this.observedFailure !== undefined) break;
    }

    if (this.observedFailure !== undefined) return ok(chunks);

    const clientFinish = this.clientEncoder.finish();
    if (!clientFinish.ok) {
      return failure(clientFinish.error);
    }
    for (const frame of clientFinish.value) {
      chunks.push(this.sseEncoder.encode(frame));
    }

    return ok(chunks);
  }

  /**
   * Decodes one SSE frame into IR stream events and processes them in sequence.
   */
  private processFrame(frame: SseFrame, chunks: Uint8Array[]): Result<void, NormalizedFailure> {
    if (this.observedFailure !== undefined) return ok(undefined);

    const providerResult = this.providerDecoder.push(frame);
    if (!providerResult.ok) {
      return failure(providerResult.error);
    }
    for (const evt of providerResult.value) {
      const eventResult = this.processEvent(evt, chunks);
      if (!eventResult.ok) return eventResult;
      if (this.observedFailure !== undefined) break;
    }
    return ok(undefined);
  }

  /**
   * Validates one IR stream event, updates telemetry/usage, applies wire options, and encodes client frames.
   */
  private processEvent(evt: IrStreamEvent, chunks: Uint8Array[]): Result<void, NormalizedFailure> {
    const smResult = this.stateMachine.feed(evt);
    if (!smResult.ok) {
      return failure(smResult.error);
    }
    this.onEvent(evt);
    if (evt.type === "error") {
      this.observedFailure = evt.failure;
    }
    if (evt.type === "response_end" && evt.usage !== undefined) {
      this.observedUsage = evt.usage;
    }
    // Outcome wire options: evaluate direction feasibility at response_end before client framing.
    if (evt.type === "response_end") {
      const wireOptions = this.providerDecoder.getOutcomeWireOptions();
      const failResult = this.applyOutcomeWireOptions(wireOptions);
      if (!failResult.ok) return failResult;
    }
    const clientResult = this.clientEncoder.encode(evt);
    if (!clientResult.ok) {
      return failure(clientResult.error);
    }
    for (const frame of clientResult.value) {
      chunks.push(this.sseEncoder.encode(frame));
    }
    return ok(undefined);
  }

  /**
   * Enforces direction feasibility and normalizes outcome wire options before terminal frame encoding.
   */
  private applyOutcomeWireOptions(wireOptions: OutcomeWireOptions): Result<void, NormalizedFailure> {
    if (wireOptions.moderation === undefined && wireOptions.serviceTier === undefined) {
      return ok(undefined);
    }
    const rejection = outcomeWireOptionsFailure(this.clientEncoder.protocol, wireOptions);
    if (rejection !== undefined) return failure(rejection);
    const normalized = normalizeOutcomeWireOptions(
      wireOptions,
      this.clientEncoder.protocol,
      this.providerDecoder.protocol,
    );
    if (normalized.moderation !== undefined || normalized.serviceTier !== undefined) {
      this.clientEncoder.setOutcomeWireOptions(normalized);
    }
    return ok(undefined);
  }
}
