import type {
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
  RouteCandidate,
} from "../domain/index.js";
import type { GatewayContext } from "./lifecycle.js";

/** Resolves a canonical request into deterministic, policy-eligible candidates. */
export interface RouteResolver {
  /** Returns ordered candidates without exposing credentials or configuration DTOs. */
  resolve(
    request: CanonicalRequest,
    context: GatewayContext,
  ): Promise<ReadonlyArray<RouteCandidate>>;
}

/** Reorders candidates according to one injected deterministic policy. */
export interface SelectionStrategy {
  /** Returns a selected readonly ordering without mutating the input. */
  select(
    candidates: ReadonlyArray<RouteCandidate>,
  ): ReadonlyArray<RouteCandidate>;
}

/** Alias retained for strategy implementations selecting credential-safe targets. */
export type CredentialSelectionStrategy = SelectionStrategy;

/** Selects candidates according to a named credential policy. */
export interface CredentialSelector {
  /** Returns a deterministic readonly candidate ordering. */
  select(
    candidates: ReadonlyArray<RouteCandidate>,
  ): ReadonlyArray<RouteCandidate>;
}

/** Bounded asynchronous candidate traversal owned by the caller. */
export interface CandidateIterator extends AsyncIterable<RouteCandidate> {}

/** Candidate fallback group evaluated by routing policy. */
export type FallbackGroup = ReadonlyArray<RouteCandidate>;

/** Immutable model metadata used during alias resolution. */
export interface ModelDescriptor {
  /** Public alias accepted by canonical requests. */
  readonly alias: string;
  /** Physical model identifier sent to a provider. */
  readonly physicalModel: string;
  /** Capabilities available from the model. */
  readonly capabilities: ReadonlySet<string>;
  /** Maximum context size in tokens. */
  readonly contextTokens: number;
}

/** Audit value for one candidate attempt and its terminal outcome. */
export interface RouteAttempt {
  /** Candidate used by this attempt. */
  readonly candidate: RouteCandidate;
  /** RFC 3339 attempt start time. */
  readonly startedAt: string;
  /** Whether egress bytes committed the attempt. */
  readonly emittedBytes: boolean;
  /** Safe response or error when the attempt has ended. */
  readonly outcome?: GatewayError | CanonicalResponse;
}

/** First-eligible credential selection policy. */
export type FillFirst = CredentialSelector;
/** Cyclic credential selection policy. */
export type RoundRobin = CredentialSelector;
/** Weighted credential selection policy. */
export type Weighted = CredentialSelector;
/** Least-active-connection selection policy. */
export type LeastConnections = CredentialSelector;
