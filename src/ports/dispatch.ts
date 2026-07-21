import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  RouteCandidate,
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
