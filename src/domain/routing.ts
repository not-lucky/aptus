/**
 * A validated physical target considered for one canonical request.
 * Capability names and identifiers are transport-independent and contain no
 * credential material.
 */
export interface RouteCandidate {
  /** Stable configured route identifier. */
  routeId: string;
  /** Provider namespace selected for this attempt. */
  providerId: string;
  /** Opaque credential reference; never the credential itself. */
  credentialId: string;
  /** Physical provider model selected for dispatch. */
  physicalModel: string;
  /** Capabilities available from this target. */
  capabilities: ReadonlySet<string>;
  /** Pre-dispatch cost estimate in US dollars. */
  estimatedCostUsd: number;
  /** Optional deterministic pre-dispatch latency estimate in milliseconds. */
  estimatedLatencyMs?: number;
}
