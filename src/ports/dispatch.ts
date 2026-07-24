import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
  UpstreamStatusPolicy,
} from "../domain/index.js";

/** Dispatches canonical requests to one selected, credential-safe route target. */
export interface ProviderDispatchPort {
  /** Performs one bounded request and returns a canonical response. */
  dispatch(
    candidate: RouteCandidate,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse>;
  /** Streams bounded canonical chunks while observing cancellation. */
  stream(
    candidate: RouteCandidate,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalChunk>;
}

/** Hard request-local limits shared by every candidate attempt. */
export interface DispatchAttemptBudget {
  /** Maximum number of provider attempts. */
  readonly maxAttempts: number;
  /** Maximum elapsed dispatch latency in milliseconds. */
  readonly maxLatencyMs: number;
  /** Maximum estimated or observed provider cost in US dollars. */
  readonly maxCostUsd: number;
}

/** Candidate-specific dispatch limits captured from one policy snapshot. */
export interface DispatchCandidatePolicy {
  /** Request-local attempt, latency, and cost limits. */
  readonly attemptBudget: DispatchAttemptBudget;
  /** Safe upstream status overrides for cascade classification. */
  readonly statusPolicy: UpstreamStatusPolicy;
  /** Maximum non-stream provider duration in milliseconds. */
  readonly providerTimeoutMs: number;
  /** Maximum idle duration between stream chunks in milliseconds. */
  readonly streamIdleTimeoutMs: number;
  /** Model context capacity in tokens. */
  readonly contextTokens: number;
}

/** Immutable policy view reused for the complete request exchange. */
export interface DispatchPolicySnapshot {
  /** Whether configuration enables dry-run by default. */
  readonly defaultDryRun: boolean;
  /** Resolves captured policy for an already-resolved candidate. */
  resolve(candidate: RouteCandidate): DispatchCandidatePolicy;
}

/** Supplies one immutable dispatch policy snapshot per exchange. */
export interface DispatchPolicyPort {
  /** Captures policy without exposing configuration DTOs. */
  snapshot(): DispatchPolicySnapshot;
}
