import type { RouteCandidate } from "../domain/index.js";
import type { CredentialSelector } from "./routing.js";

/** Configured credential selection strategy names. */
export type CredentialSelectionStrategyName =
  | "fill-first"
  | "round-robin"
  | "weighted-round-robin"
  | "least-connections";

/** Caller-owned snapshot support used by credential selectors. */
export interface CredentialSelectionSupport {
  /** Returns the configured positive integer weight for one candidate. */
  weight(candidate: RouteCandidate): number;
  /** Returns the current non-negative integer connection count. */
  connections(candidate: RouteCandidate): number;
  /** Returns a deterministic integer cursor for the named snapshot. */
  cursor(namespace: string, length: number): number;
}

/** Stable safe selection policy failure codes. */
export type CredentialSelectionPolicyErrorCode = "invalid_support";

/** Typed selector failure whose message contains no candidate identity. */
export class CredentialSelectionPolicyError extends Error {
  /** Stable safe failure code. */
  readonly code: CredentialSelectionPolicyErrorCode;

  /** Creates a safe selector policy failure. */
  constructor() {
    super("credential selection support is invalid");
    this.name = "CredentialSelectionPolicyError";
    this.code = "invalid_support";
  }
}

function key(candidate: RouteCandidate): string {
  return `${candidate.providerId}\u0000${candidate.credentialId}\u0000${candidate.physicalModel}`;
}

function compareKey(left: RouteCandidate, right: RouteCandidate): number {
  const leftKey = key(left);
  const rightKey = key(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function integer(value: number, positive = false): number {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value < (positive ? 1 : 0))
    throw new CredentialSelectionPolicyError();
  return value;
}

function cursor(support: CredentialSelectionSupport, namespace: string, length: number): number {
  if (length === 0) return 0;
  return integer(support.cursor(namespace, length)) % length;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

/** Preserves the already-filtered candidate order. */
export class FillFirstSelector implements CredentialSelector {
  /** Copies and freezes the input ordering. */
  select(candidates: ReadonlyArray<RouteCandidate>): ReadonlyArray<RouteCandidate> {
    return Object.freeze([...candidates]);
  }
}

/** Rotates stable candidate keys by an injected namespace cursor. */
export class RoundRobinSelector implements CredentialSelector {
  /** Creates a namespace-isolated deterministic selector. */
  constructor(
    private readonly namespace: string,
    private readonly support: CredentialSelectionSupport,
  ) {}

  /** Returns a stable-key rotation without mutating the input. */
  select(candidates: ReadonlyArray<RouteCandidate>): ReadonlyArray<RouteCandidate> {
    const stable = [...candidates].sort(compareKey);
    return Object.freeze(rotate(stable, cursor(this.support, this.namespace, stable.length)));
  }
}

/** Orders one snapshot using smooth weighted round-robin scoring. */
export class WeightedRoundRobinSelector implements CredentialSelector {
  /** Creates a namespace-isolated deterministic selector. */
  constructor(
    private readonly namespace: string,
    private readonly support: CredentialSelectionSupport,
  ) {}

  /** Returns the complete smooth weighted ordering for one immutable snapshot. */
  select(candidates: ReadonlyArray<RouteCandidate>): ReadonlyArray<RouteCandidate> {
    const stable = [...candidates].sort(compareKey);
    if (stable.length === 0) return Object.freeze([]);
    const offset = cursor(this.support, this.namespace, stable.length);
    const rotated = rotate(stable, offset);
    const entries = rotated.map((candidate, index) => ({
      candidate,
      index,
      weight: integer(this.support.weight(candidate), true),
      score: 0,
    }));
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (!Number.isSafeInteger(total)) throw new CredentialSelectionPolicyError();
    const output: RouteCandidate[] = [];
    const selectionCount = entries.length;
    for (let position = 0; position < selectionCount; position += 1) {
      for (const entry of entries) entry.score += entry.weight;
      let selected = entries[0]!;
      for (const entry of entries.slice(1)) {
        if (
          entry.score > selected.score ||
          (entry.score === selected.score && entry.index < selected.index)
        ) selected = entry;
      }
      selected.score -= total;
      output.push(selected.candidate);
      entries.splice(entries.indexOf(selected), 1);
    }
    return Object.freeze(output);
  }
}

/** Sorts by connections, descending weight, then stable candidate key. */
export class LeastConnectionsSelector implements CredentialSelector {
  /** Creates a selector backed by one caller-owned support snapshot. */
  constructor(private readonly support: CredentialSelectionSupport) {}

  /** Returns a copied frozen least-connections ordering. */
  select(candidates: ReadonlyArray<RouteCandidate>): ReadonlyArray<RouteCandidate> {
    const annotated = candidates.map((candidate) => ({
      candidate,
      connections: integer(this.support.connections(candidate)),
      weight: integer(this.support.weight(candidate)),
    }));
    annotated.sort((left, right) =>
      left.connections - right.connections ||
      right.weight - left.weight ||
      compareKey(left.candidate, right.candidate));
    return Object.freeze(annotated.map(({ candidate }) => candidate));
  }
}

/** Factory signature injectable into configured routing. */
export type CredentialSelectorFactory = (
  strategy: CredentialSelectionStrategyName,
  namespace: string,
  support: CredentialSelectionSupport,
) => CredentialSelector;

/** Creates one stateless selector for a configured strategy. */
export function createCredentialSelector(
  strategy: CredentialSelectionStrategyName,
  namespace: string,
  support: CredentialSelectionSupport,
): CredentialSelector {
  if (strategy === "fill-first") return new FillFirstSelector();
  if (strategy === "round-robin") return new RoundRobinSelector(namespace, support);
  if (strategy === "weighted-round-robin")
    return new WeightedRoundRobinSelector(namespace, support);
  if (strategy === "least-connections") return new LeastConnectionsSelector(support);
  throw new CredentialSelectionPolicyError();
}
