import type { Result } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import type { StreamSession } from "../../contracts.ts";
import type { IrCitation, IrFinish, IrStreamEvent, IrUsage } from "../../ir.ts";
import { invalidRequest, ok } from "../../result.ts";
import { parseFunctionArgumentsOnce } from "./hosted-tools.ts";
import { StreamToolArgumentsBudget } from "./stream-limits.ts";

/**
 * @fileoverview Stream shape tracking and delta routing for provider stream decoders.
 *
 * Implements wire-agnostic bookkeeping for streaming responses: lazy and explicit part opening,
 * tool call argument accumulation and budget enforcement, identity deduplication, and single-emission
 * guarantees for response start and terminal events.
 *
 * Used by OpenAI Chat, OpenAI Responses, and Anthropic Messages stream decoders to emit well-formed
 * intermediate representation (IR) stream event sequences.
 */
export class StreamShapeTracker {
  private readonly session: StreamSession;
  private readonly wireLabel: string;
  private readonly budget: StreamToolArgumentsBudget;

  private started = false;
  private terminal = false;
  private refusalSeen = false;
  private functionPartsStarted = 0;

  /** Wire identities claimed across the stream session to prevent duplicate reuse. */
  private readonly claimedIdentities = new Set<string>();

  /** Currently open streaming parts indexed by decoder wire slot. */
  private readonly openParts = new Map<string, OpenPart>();

  /**
   * Initializes a stream shape tracker bound to a stream session.
   *
   * @param options - Tracker configuration options.
   */
  constructor(options: StreamShapeTrackerOptions) {
    this.session = options.session;
    this.wireLabel = options.wireLabel;
    this.budget = new StreamToolArgumentsBudget(options.maxArgumentBytes);
  }

  /**
   * Guards against frames received after the stream has reached a terminal event.
   *
   * @returns Success if stream is active, or `invalid_request` failure if already terminal.
   */
  guardFrame(): Result<void, NormalizedFailure> {
    if (this.terminal) {
      return invalidRequest(`${this.wireLabel} stream received an event after the terminal event`);
    }
    return ok(undefined);
  }

  /** Marks the stream as terminal so subsequent frames fail guard checks. */
  markTerminal(): void {
    this.terminal = true;
  }

  /**
   * Reports whether the stream has reached a terminal state.
   *
   * @returns `true` if terminal, `false` otherwise.
   */
  isTerminal(): boolean {
    return this.terminal;
  }

  /**
   * Emits a `response_start` event on first invocation; no-op on subsequent calls.
   *
   * @param events - Stream event buffer to append `response_start` to.
   */
  ensureStarted(events: IrStreamEvent[]): void {
    if (this.started) return;
    this.started = true;
    events.push({ type: "response_start", responseId: this.session.responseId, model: this.session.model });
  }

  /**
   * Explicitly emits `response_start` once, failing if already started.
   *
   * @param events - Stream event buffer to append `response_start` to.
   * @returns Success on first call, or `invalid_request` failure on duplicate start.
   */
  start(events: IrStreamEvent[]): Result<void, NormalizedFailure> {
    if (this.started) {
      return invalidRequest("Duplicate 'response_start' received during active stream");
    }
    this.ensureStarted(events);
    return ok(undefined);
  }

  /**
   * Reserves a unique wire identity (e.g. tool call ID) for the lifetime of the stream.
   *
   * @param identity - Wire identity string to reserve.
   * @returns Success if identity was unclaimed, or `invalid_request` failure if already claimed.
   */
  claimIdentity(identity: string): Result<void, NormalizedFailure> {
    if (this.claimedIdentities.has(identity)) {
      return invalidRequest(`Duplicate stream part identity '${identity}'`);
    }
    this.claimedIdentities.add(identity);
    return ok(undefined);
  }

  /**
   * Checks whether a wire identity has been claimed during this stream session.
   *
   * @param identity - Wire identity string to check.
   * @returns `true` if previously claimed, `false` otherwise.
   */
  hasIdentity(identity: string): boolean {
    return this.claimedIdentities.has(identity);
  }

  /**
   * Opens or reuses a text streaming part for the given wire slot.
   *
   * @param events - Stream event buffer to append `part_start` to if opened.
   * @param slot - Wire slot key for part correlation.
   * @param mode - Part resolution mode (`reuse-typed` or `force-new`).
   * @returns Allocated IR part ID.
   */
  openTextPart(events: IrStreamEvent[], slot: string, mode: OpenPartMode): string {
    return this.openPart(events, slot, { type: "text" }, mode).partId;
  }

  /**
   * Opens or reuses a refusal streaming part for the given wire slot.
   *
   * @param events - Stream event buffer to append `part_start` to if opened.
   * @param slot - Wire slot key for part correlation.
   * @param mode - Part resolution mode (`reuse-typed` or `force-new`).
   * @returns Allocated IR part ID.
   */
  openRefusalPart(events: IrStreamEvent[], slot: string, mode: OpenPartMode): string {
    this.refusalSeen = true;
    return this.openPart(events, slot, { type: "refusal" }, mode).partId;
  }

  /**
   * Opens a function call streaming part in the specified wire slot.
   *
   * @param events - Stream event buffer to append `part_start` to.
   * @param slot - Wire slot key for part correlation.
   * @param callId - Wire tool call identifier.
   * @param name - Function name.
   * @param opts - Optional configuration for call ID deduplication and output indexing.
   * @returns Allocated IR part ID, or failure if slot is occupied or call ID duplicate.
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

  /**
   * Returns the IR part ID of the part currently open in the given slot.
   *
   * @param slot - Wire slot key to inspect.
   * @returns Open IR part ID, or `undefined` if slot holds no open part.
   */
  partIdOf(slot: string): string | undefined {
    return this.openParts.get(slot)?.partId;
  }

  /**
   * Returns the part type currently open in the given slot.
   *
   * @param slot - Wire slot key to inspect.
   * @returns ShapePartType of the open part, or `undefined` if not open.
   */
  partTypeOf(slot: string): ShapePartType | undefined {
    return this.openParts.get(slot)?.type;
  }

  /**
   * Returns a read-only snapshot of the open function part in the given slot.
   *
   * @param slot - Wire slot key to inspect.
   * @returns OpenFunctionPartInfo snapshot, or `undefined` if slot is not an open function part.
   */
  openFunctionPartInfo(slot: string): OpenFunctionPartInfo | undefined {
    const part = this.openParts.get(slot);
    return part !== undefined && part.type === "function_call" ? functionPartInfo(part) : undefined;
  }

  /**
   * Resolves an open function part by key (slot, callId, partId) or output index.
   *
   * @param key - Wire slot, callId, or partId reference.
   * @param outputIndex - Wire output index correlation hint.
   * @returns Matching OpenFunctionPartInfo snapshot, or `undefined` if not found.
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

  /**
   * Appends a text delta to the open text part in the specified slot.
   *
   * @param events - Stream event buffer to append `text_delta` to.
   * @param slot - Wire slot key for the target part.
   * @param text - Text fragment to append.
   * @param opts - Optional flags (e.g. `lazy` to open part on demand).
   * @returns Success if routed, or `invalid_request` failure if part missing or mismatched.
   */
  textDelta(
    events: IrStreamEvent[],
    slot: string,
    text: string,
    opts?: { lazy?: boolean },
  ): Result<void, NormalizedFailure> {
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
   * Appends a refusal delta to the refusal part in the specified slot, opening lazily if needed.
   *
   * @param events - Stream event buffer to append `refusal_delta` to.
   * @param slot - Wire slot key for the refusal part.
   * @param text - Refusal text fragment to append.
   * @returns Success if routed, or `invalid_request` failure.
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
   * Routes a tool argument fragment to an open function part, claiming session budget.
   *
   * @param events - Stream event buffer to append `tool_arguments_delta` to.
   * @param slot - Wire slot key for the target function part.
   * @param fragment - Raw JSON argument fragment.
   * @param expectedCallId - Optional expected call ID to verify against the open part.
   * @returns Success if routed, or failure if budget exceeded, slot missing, or call ID mismatched.
   */
  toolArgumentsDelta(
    events: IrStreamEvent[],
    slot: string,
    fragment: string,
    expectedCallId?: string,
  ): Result<void, NormalizedFailure> {
    const part = this.openParts.get(slot);
    if (part === undefined || part.type !== "function_call") {
      return invalidRequest(
        `${this.wireLabel} stream tool arguments delta received for non-open function part '${slot}'`,
      );
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

  /**
   * Returns the count of argument deltas received so far for an open function part.
   *
   * @param slot - Wire slot key to inspect.
   * @returns Number of deltas received, or 0 if slot is not open.
   */
  argumentDeltaCount(slot: string): number {
    return this.openParts.get(slot)?.deltaCount ?? 0;
  }

  /**
   * Routes a citation event to the open part in the specified slot.
   *
   * @param events - Stream event buffer to append `citation` to.
   * @param slot - Wire slot key for the target part.
   * @param citation - Decoded IR citation object.
   * @returns Success if routed, or `invalid_request` failure if slot holds no open part.
   */
  citation(events: IrStreamEvent[], slot: string, citation: IrCitation): Result<void, NormalizedFailure> {
    const part = this.openParts.get(slot);
    if (part === undefined) {
      return invalidRequest(`${this.wireLabel} stream citation received for non-open part '${slot}'`);
    }
    events.push({ type: "citation", responseId: this.session.responseId, partId: part.partId, citation });
    return ok(undefined);
  }

  /**
   * Closes the open part in the specified slot, verifying expected part type.
   * Function parts have their accumulated arguments parsed exactly once.
   *
   * @param events - Stream event buffer to append `part_end` to.
   * @param slot - Wire slot key of the part to close.
   * @param expectedType - Expected ShapePartType for validation.
   * @returns Success if closed, or `invalid_request` failure if slot not open or type mismatched.
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
   * Closes all currently open function parts in open order.
   *
   * @param events - Stream event buffer to append `part_end` events to.
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

  /**
   * Reports whether any refusal part was opened during this stream.
   *
   * @returns `true` if a refusal part was opened, `false` otherwise.
   */
  sawRefusal(): boolean {
    return this.refusalSeen;
  }

  /**
   * Returns the total count of function parts opened during the stream session.
   *
   * @returns Total number of started function parts.
   */
  startedFunctionPartCount(): number {
    return this.functionPartsStarted;
  }

  /**
   * Emits terminal `response_end` event and marks the tracker as terminal.
   *
   * @param events - Stream event buffer to append `response_end` to.
   * @param finish - Terminal finish details.
   * @param usage - Optional token usage details.
   */
  responseEnd(events: IrStreamEvent[], finish: IrFinish, usage?: IrUsage): void {
    events.push({
      type: "response_end",
      responseId: this.session.responseId,
      finish,
      ...(usage !== undefined ? { usage } : {}),
    });
    this.terminal = true;
  }

  /**
   * Emits an in-band stream `error` event and marks the tracker as terminal.
   *
   * @param events - Stream event buffer to append `error` to.
   * @param failure - Normalized failure to emit.
   */
  error(events: IrStreamEvent[], failure: NormalizedFailure): void {
    events.push({ type: "error", responseId: this.session.responseId, failure });
    this.terminal = true;
  }

  /**
   * Internal helper to open or reuse non-function parts (text or refusal).
   *
   * @param events - Stream event buffer to append `part_start` to if new.
   * @param slot - Wire slot key for the part.
   * @param descriptor - Part descriptor defining part type.
   * @param mode - Resolution mode (`reuse-typed` or `force-new`).
   * @returns OpenPart tracking record.
   */
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

/** Streaming part types admitted by the intermediate representation. */
export type ShapePartType = "text" | "refusal" | "function_call";

/**
 * Resolution mode when opening a part in an already occupied wire slot.
 * `reuse-typed` reuses existing part if type matches; `force-new` always opens a new part.
 */
export type OpenPartMode = "reuse-typed" | "force-new";

/** Read-only snapshot of an open function part for wire-side correlation. */
export interface OpenFunctionPartInfo {
  /** Decoder wire slot string under which the part was opened. */
  readonly slot: string;

  /** IR part identifier allocated for this part. */
  readonly partId: string;

  /** Wire-announced call identifier for the function call. */
  readonly callId: string;

  /** Function name as announced by the provider. */
  readonly name: string;

  /** Optional wire output index hint for correlation. */
  readonly outputIndex: number | undefined;
}

/** Internal tracking record for an open streaming part in the tracker. */
interface OpenPart {
  /** Decoder wire slot key under which the part is open. */
  readonly slot: string;

  /** IR part identifier allocated for this part. */
  readonly partId: string;

  /** Streaming part type. */
  readonly type: ShapePartType;

  /** Wire call identifier for function parts, or `undefined`. */
  readonly callId: string | undefined;

  /** Function name for function parts, or `undefined`. */
  readonly name: string | undefined;

  /** Output index hint for wire correlation, or `undefined`. */
  readonly outputIndex: number | undefined;

  /** Accumulated raw argument text fragments. */
  arguments: string;

  /** Total number of argument fragments received. */
  deltaCount: number;
}

/** Construction options for {@link StreamShapeTracker}. */
export interface StreamShapeTrackerOptions {
  /** Stream session providing response ID, model name, and part ID generator. */
  readonly session: StreamSession;

  /** Optional byte budget ceiling override for accumulated tool arguments. */
  readonly maxArgumentBytes?: number;

  /** Short wire protocol label (e.g. 'Chat', 'Responses', 'Messages') for error messages. */
  readonly wireLabel: string;
}

/**
 * Projects an internal function part record into a read-only snapshot.
 *
 * @param part - Internal function part record to project.
 * @returns Read-only OpenFunctionPartInfo snapshot.
 */
function functionPartInfo(part: OpenPart): OpenFunctionPartInfo {
  return {
    slot: part.slot,
    partId: part.partId,
    callId: part.callId as string,
    name: part.name as string,
    outputIndex: part.outputIndex,
  };
}
