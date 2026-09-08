import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { StreamSession } from "../../contracts.ts";
import type { IrCitation, IrFinish, IrStreamEvent, IrUsage } from "../../ir.ts";
import { invalidRequest, ok } from "../../result.ts";
import { parseFunctionArgumentsOnce } from "./hosted-tools.ts";
import { StreamToolArgumentsBudget } from "./stream-limits.ts";

/**
 * The wire-agnostic shape bookkeeping every provider stream decoder needs,
 * owned once instead of re-derived per protocol.
 *
 * The three provider decoders differ in wire dispatch (which SSE event carries
 * which meaning, which wire key addresses which part) but re-derive the same
 * shape bookkeeping: lazy part opening and typed delta routing, call-id dedup,
 * refusal pairing, argument budget accounting, start-once, and terminal-once.
 * This tracker absorbs all of it. Decoders address parts by an opaque wire
 * `slot` string of their choosing (`tool:0`, `block:2`, an item id, or a
 * single `current` slot) and the tracker owns the rest.
 *
 * Layering: the tracker is the decoders' private helper, not a normative gate.
 * The `IrStreamStateMachine` downstream still validates the full
 * lifecycle of every emitted event; the tracker merely lets each decoder emit
 * well-formed sequences by construction and fail closed at the wire with
 * protocol context.
 */

/** Part descriptors the IR stream admits. */
export type ShapePartType = "text" | "refusal" | "function_call";

/**
 * How an open call resolves a slot that already carries an open part:
 * `reuse-typed` reuses it only when the descriptor type matches (the lazy
 * delta pattern), `force-new` always opens a fresh part (the explicit
 * part-announced pattern). A replaced part stays open in the IR, so a wire
 * that abandons a part without closing it still fails the terminal check.
 */
export type OpenPartMode = "reuse-typed" | "force-new";

/** Read-only view of one open function part, for wire-side correlation. */
export interface OpenFunctionPartInfo {
  /** The decoder's wire slot the part was opened under. */
  readonly slot: string;
  readonly partId: string;
  readonly callId: string;
  readonly name: string;
  readonly outputIndex: number | undefined;
}

interface OpenPart {
  readonly slot: string;
  readonly partId: string;
  readonly type: ShapePartType;
  readonly callId: string | undefined;
  readonly name: string | undefined;
  readonly outputIndex: number | undefined;
  /** Accumulated function argument fragments, parsed once at close. */
  arguments: string;
  deltaCount: number;
}

export interface StreamShapeTrackerOptions {
  readonly session: StreamSession;
  readonly maxArgumentBytes?: number;
  /** Wire label used in fail-closed messages ("Chat", "Responses", "Messages"). */
  readonly wireLabel: string;
}

export class StreamShapeTracker {
  private readonly session: StreamSession;
  private readonly wireLabel: string;
  private readonly budget: StreamToolArgumentsBudget;

  private started = false;
  private terminal = false;
  private refusalSeen = false;
  private functionPartsStarted = 0;

  /** Wire identities (call ids, item ids, block indexes) claimed for the whole stream. */
  private readonly claimedIdentities = new Set<string>();
  /** Open parts by wire slot, in open order. */
  private readonly openParts = new Map<string, OpenPart>();

  constructor(options: StreamShapeTrackerOptions) {
    this.session = options.session;
    this.wireLabel = options.wireLabel;
    this.budget = new StreamToolArgumentsBudget(options.maxArgumentBytes);
  }

  // =====================================================================
  // Terminal-once
  // =====================================================================

  /**
   * Fails once the stream reached a terminal event, so a misbehaving provider
   * cannot re-terminate; every decoder calls this before parsing a frame.
   */
  guardFrame(): Result<void, NormalizedFailure> {
    if (this.terminal) {
      return invalidRequest(`${this.wireLabel} stream received an event after the terminal event`);
    }
    return ok(undefined);
  }

  /** Marks the stream terminal; idempotent. */
  markTerminal(): void {
    this.terminal = true;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  // =====================================================================
  // Start-once
  // =====================================================================

  /**
   * Emits `response_start` on the first call and no-ops afterwards. For wires
   * whose start event is implicit (Chat emits it lazily on the first content
   * chunk, and every later chunk must not re-emit).
   */
  ensureStarted(events: IrStreamEvent[]): void {
    if (this.started) return;
    this.started = true;
    events.push({ type: "response_start", responseId: this.session.responseId, model: this.session.model });
  }

  /**
   * Emits `response_start` exactly once and fails on a second explicit start
   * event. For wires whose start event is a named frame (R response.created,
   * M message_start): a duplicate frame is malformed provider output.
   */
  start(events: IrStreamEvent[]): Result<void, NormalizedFailure> {
    if (this.started) {
      return invalidRequest("Duplicate 'response_start' received during active stream");
    }
    this.ensureStarted(events);
    return ok(undefined);
  }

  // =====================================================================
  // Identity dedup
  // =====================================================================

  /**
   * Claims a wire identity (tool call id, item id, block index) for the whole
   * stream: a second claim of the same identity fails, including after the
   * owning part closed.
   */
  claimIdentity(identity: string): Result<void, NormalizedFailure> {
    if (this.claimedIdentities.has(identity)) {
      return invalidRequest(`Duplicate stream part identity '${identity}'`);
    }
    this.claimedIdentities.add(identity);
    return ok(undefined);
  }

  /** Whether a wire identity was already claimed (terminal-output announcement checks). */
  hasIdentity(identity: string): boolean {
    return this.claimedIdentities.has(identity);
  }

  // =====================================================================
  // Part lifecycle
  // =====================================================================

  /**
   * Opens (or reuses) the text part in `slot` and emits `part_start` when a
   * new part is created.
   *
   * @returns The open part's IR partId.
   */
  openTextPart(events: IrStreamEvent[], slot: string, mode: OpenPartMode): string {
    return this.openPart(events, slot, { type: "text" }, mode).partId;
  }

  /**
   * Opens (or reuses) the refusal part in `slot` and emits `part_start` when
   * a new part is created. Records that the stream saw a refusal part, which
   * gates finish-reason derivation.
   *
   * @returns The open part's IR partId.
   */
  openRefusalPart(events: IrStreamEvent[], slot: string, mode: OpenPartMode): string {
    this.refusalSeen = true;
    return this.openPart(events, slot, { type: "refusal" }, mode).partId;
  }

  /**
   * Opens a function-call part in `slot` and emits its `part_start`.
   *
   * @param dedupCallId - Fails when the call id was already used by another
   * part on this stream (wires whose call ids are stream-unique by contract).
   * @param outputIndex - Optional wire correlation hint remembered for
   * {@link findFunctionPart}.
   * @returns The open part's IR partId.
   */
  openFunctionPart(
    events: IrStreamEvent[],
    slot: string,
    callId: string,
    name: string,
    opts?: { dedupCallId?: boolean; outputIndex?: number },
  ): Result<string, NormalizedFailure> {
    if (opts?.dedupCallId === true) {
      const claimRes = this.claimIdentity(`call:${callId}`);
      if (!claimRes.ok) return claimRes;
    }
    if (this.openParts.has(slot)) {
      return invalidRequest(`${this.wireLabel} stream part is already open for '${slot}'`);
    }
    const part: OpenPart = {
      slot,
      partId: this.session.createPartId(),
      type: "function_call",
      callId,
      name,
      outputIndex: opts?.outputIndex,
      arguments: "",
      deltaCount: 0,
    };
    this.functionPartsStarted++;
    this.openParts.set(slot, part);
    events.push({
      type: "part_start",
      responseId: this.session.responseId,
      partId: part.partId,
      part: { type: "function_call", callId, name },
    });
    return ok(part.partId);
  }

  /** The IR partId of the open part in `slot`, or undefined. */
  partIdOf(slot: string): string | undefined {
    return this.openParts.get(slot)?.partId;
  }

  /** The type of the open part in `slot`, or undefined. */
  partTypeOf(slot: string): ShapePartType | undefined {
    return this.openParts.get(slot)?.type;
  }

  /** The open function part in `slot`, or undefined. */
  openFunctionPartInfo(slot: string): OpenFunctionPartInfo | undefined {
    const part = this.openParts.get(slot);
    return part !== undefined && part.type === "function_call" ? functionPartInfo(part) : undefined;
  }

  /**
   * Resolves an open function part by wire identity or output index, in the
   * correlation order the R wire needs: a direct slot hit first, then a scan
   * for a matching call id or IR partId, with a conflicting `outputIndex`
   * rejecting the match; an omitted key falls back to the output index alone.
   */
  findFunctionPart(key: string | undefined, outputIndex: number | undefined): OpenFunctionPartInfo | undefined {
    if (key !== undefined) {
      const direct = this.openParts.get(key);
      let match: OpenPart | undefined = direct !== undefined && direct.type === "function_call" ? direct : undefined;
      if (match === undefined) {
        for (const part of this.openParts.values()) {
          if (part.type === "function_call" && (part.callId === key || part.partId === key)) {
            match = part;
            break;
          }
        }
      }
      if (match === undefined) return undefined;
      if (outputIndex !== undefined && match.outputIndex !== undefined && match.outputIndex !== outputIndex) {
        return undefined;
      }
      return functionPartInfo(match);
    }
    if (outputIndex !== undefined) {
      for (const part of this.openParts.values()) {
        if (part.type === "function_call" && part.outputIndex === outputIndex) {
          return functionPartInfo(part);
        }
      }
    }
    return undefined;
  }

  // =====================================================================
  // Deltas
  // =====================================================================

  /**
   * Routes a text delta to the open text part in `slot`. With `lazy` the part
   * is opened on demand (wires whose deltas imply the part); without it the
   * part must already be open (wires that announce every part).
   */
  textDelta(events: IrStreamEvent[], slot: string, text: string, opts?: { lazy?: boolean }): Result<void, NormalizedFailure> {
    let part = this.openParts.get(slot);
    if (opts?.lazy === true) {
      part = this.openPart(events, slot, { type: "text" }, "reuse-typed");
    } else if (part === undefined) {
      return invalidRequest(`${this.wireLabel} stream text delta received for non-open part '${slot}'`);
    } else if (part.type !== "text") {
      return invalidRequest(`${this.wireLabel} stream text delta received for part '${slot}' of type '${part.type}'`);
    }
    if (typeof text !== "string") {
      return invalidRequest("text delta text must be a string");
    }
    events.push({ type: "text_delta", responseId: this.session.responseId, partId: part.partId, text });
    return ok(undefined);
  }

  /**
   * Routes a refusal delta to the open refusal part in `slot`, opening the
   * part on demand (refusal deltas imply the part on both wires that carry
   * them). Refusal pairing — one open refusal part per slot, deltas only on
   * refusal parts — is owned here.
   */
  refusalDelta(events: IrStreamEvent[], slot: string, text: string): Result<void, NormalizedFailure> {
    const partId = this.openRefusalPart(events, slot, "reuse-typed");
    if (typeof text !== "string") {
      return invalidRequest("refusal delta text must be a string");
    }
    events.push({ type: "refusal_delta", responseId: this.session.responseId, partId, text });
    return ok(undefined);
  }

  /**
   * Routes a tool-argument fragment to the open function part in `slot`,
   * claiming the stream argument budget and accumulating the fragment for the
   * once-only parse at close.
   *
   * @param expectedCallId - Fails when it does not match the open part's call
   * id (wires whose fragments may drift from the announced call id).
   */
  toolArgumentsDelta(
    events: IrStreamEvent[],
    slot: string,
    fragment: string,
    expectedCallId?: string,
  ): Result<void, NormalizedFailure> {
    const part = this.openParts.get(slot);
    if (part === undefined || part.type !== "function_call") {
      return invalidRequest(`${this.wireLabel} stream tool arguments delta received for non-open function part '${slot}'`);
    }
    if (expectedCallId !== undefined && part.callId !== expectedCallId) {
      return invalidRequest(
        `Tool arguments delta call id '${expectedCallId}' does not match open part call id '${part.callId}'`,
      );
    }
    if (typeof fragment !== "string") {
      return invalidRequest("tool arguments delta text must be a string");
    }
    const claimRes = this.budget.claim(fragment);
    if (!claimRes.ok) return claimRes;
    part.arguments += fragment;
    part.deltaCount++;
    events.push({
      type: "tool_arguments_delta",
      responseId: this.session.responseId,
      partId: part.partId,
      callId: part.callId as string,
      text: fragment,
    });
    return ok(undefined);
  }

  /** How many argument fragments the open function part in `slot` has received. */
  argumentDeltaCount(slot: string): number {
    return this.openParts.get(slot)?.deltaCount ?? 0;
  }

  /**
   * Emits a citation routed to the open part in `slot`. Part-type admission is
   * left to the normative state machine, matching the wires that carry
   * citations without restating the rule here.
   */
  citation(events: IrStreamEvent[], slot: string, citation: IrCitation): Result<void, NormalizedFailure> {
    const part = this.openParts.get(slot);
    if (part === undefined) {
      return invalidRequest(`${this.wireLabel} stream citation received for non-open part '${slot}'`);
    }
    events.push({ type: "citation", responseId: this.session.responseId, partId: part.partId, citation });
    return ok(undefined);
  }

  // =====================================================================
  // Close
  // =====================================================================

  /**
   * Closes the open part in `slot`, type-checked. Function parts carry their
   * accumulated argument text parsed exactly once into `part_end.arguments`;
   * an unparseable accumulation is carried as raw text only (never forged
   * into an object).
   */
  closePart(events: IrStreamEvent[], slot: string, expectedType: ShapePartType): Result<void, NormalizedFailure> {
    const part = this.openParts.get(slot);
    if (part === undefined) {
      return invalidRequest(`${this.wireLabel} stream part_end received for non-open part '${slot}'`);
    }
    if (part.type !== expectedType) {
      return invalidRequest(`part_end partType '${expectedType}' does not match open part type '${part.type}'`);
    }
    this.openParts.delete(slot);
    if (part.type === "function_call") {
      const parsed = parseFunctionArgumentsOnce(part.arguments);
      events.push({
        type: "part_end",
        responseId: this.session.responseId,
        partId: part.partId,
        partType: "function_call",
        ...(parsed !== undefined ? { arguments: parsed } : {}),
      });
    } else {
      events.push({
        type: "part_end",
        responseId: this.session.responseId,
        partId: part.partId,
        partType: part.type,
      });
    }
    return ok(undefined);
  }

  /**
   * Closes every open function part in open order (the finish path of wires
   * that close all parts at the finish marker rather than per part).
   */
  closeAllFunctionParts(events: IrStreamEvent[]): void {
    for (const part of [...this.openParts.values()]) {
      if (part.type !== "function_call") continue;
      this.openParts.delete(part.slot);
      const parsed = parseFunctionArgumentsOnce(part.arguments);
      events.push({
        type: "part_end",
        responseId: this.session.responseId,
        partId: part.partId,
        partType: "function_call",
        ...(parsed !== undefined ? { arguments: parsed } : {}),
      });
    }
  }

  // =====================================================================
  // Finish-derivation state
  // =====================================================================

  /** Whether any refusal part was opened on this stream. */
  sawRefusal(): boolean {
    return this.refusalSeen;
  }

  /** How many function parts were opened (started), closed or not. */
  startedFunctionPartCount(): number {
    return this.functionPartsStarted;
  }

  // =====================================================================
  // Terminal events
  // =====================================================================

  /** Emits the terminal `response_end` and marks the stream terminal. */
  responseEnd(events: IrStreamEvent[], finish: IrFinish, usage?: IrUsage): void {
    events.push({
      type: "response_end",
      responseId: this.session.responseId,
      finish,
      ...(usage !== undefined ? { usage } : {}),
    });
    this.terminal = true;
  }

  /** Emits the terminal in-band `error` event and marks the stream terminal. */
  error(events: IrStreamEvent[], failure: NormalizedFailure): void {
    events.push({ type: "error", responseId: this.session.responseId, failure });
    this.terminal = true;
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private openPart(
    events: IrStreamEvent[],
    slot: string,
    descriptor: { type: "text" } | { type: "refusal" },
    mode: OpenPartMode,
  ): OpenPart {
    const existing = this.openParts.get(slot);
    if (mode === "reuse-typed" && existing !== undefined && existing.type === descriptor.type) {
      return existing;
    }
    const part: OpenPart = {
      slot,
      partId: this.session.createPartId(),
      type: descriptor.type,
      callId: undefined,
      name: undefined,
      outputIndex: undefined,
      arguments: "",
      deltaCount: 0,
    };
    this.openParts.set(slot, part);
    events.push({
      type: "part_start",
      responseId: this.session.responseId,
      partId: part.partId,
      part: { type: descriptor.type },
    });
    return part;
  }
}

function functionPartInfo(part: OpenPart): OpenFunctionPartInfo {
  return {
    slot: part.slot,
    partId: part.partId,
    callId: part.callId as string,
    name: part.name as string,
    outputIndex: part.outputIndex,
  };
}
