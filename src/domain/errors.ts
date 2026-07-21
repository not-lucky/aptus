/**
 * Deterministic construction and classification of safe gateway errors.
 *
 * Every failure that crosses a boundary is a canonical {@link GatewayError}: it
 * carries a stable `code`, one of the eight fixed categories, a safe `message`,
 * a resolved HTTP `status`, `retryable`, and the correlating `requestId`. This
 * module owns the category/status/retryability defaults and the upstream-status
 * classification table, and it always runs `details` through recursive redaction
 * so no secret can leak through an error. It is pure and performs no I/O.
 *
 * Retryability here describes gateway routing behavior only; it never promises
 * that a caller may safely replay a non-idempotent request.
 */

import type { GatewayError } from "./canonical.js";
import type { CostErrorReason } from "./cost.js";
import { redactDetails } from "./redaction.js";

/** The eight canonical error categories. */
export type GatewayErrorCategory = GatewayError["category"];

/**
 * Inputs for {@link createGatewayError}. `message` must already be a safe,
 * data-free string; only `details` is redacted. `status` and `retryable`
 * override the category defaults when provided.
 */
export interface CreateGatewayErrorInput {
  readonly category: GatewayErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly credentialId?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Route-level status policy from configuration. Statuses listed here force the
 * corresponding retryability regardless of the default classification.
 */
export interface UpstreamStatusPolicy {
  readonly retryable: readonly number[];
  readonly nonRetryable: readonly number[];
}

/** Deterministic classification of a single upstream HTTP status. */
export interface UpstreamClassification {
  readonly category: GatewayErrorCategory;
  readonly retryable: boolean;
  readonly status: number;
}

const CATEGORY_STATUS: Record<GatewayErrorCategory, number> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  rate_limit: 429,
  upstream: 502,
  timeout: 504,
  routing: 503,
  internal: 500,
};

const CATEGORY_RETRYABLE: Record<GatewayErrorCategory, boolean> = {
  validation: false,
  authentication: false,
  authorization: false,
  rate_limit: true,
  upstream: true,
  timeout: true,
  routing: true,
  internal: false,
};

/** Default gateway-facing HTTP status for a category. */
export function defaultStatusForCategory(
  category: GatewayErrorCategory,
): number {
  return CATEGORY_STATUS[category];
}

/** Default retryability for a category. */
export function defaultRetryableForCategory(
  category: GatewayErrorCategory,
): boolean {
  return CATEGORY_RETRYABLE[category];
}

/**
 * Build a {@link GatewayError} with category defaults applied and `details`
 * recursively redacted. Optional fields are included only when defined so the
 * result satisfies `exactOptionalPropertyTypes` (absent, never `undefined`).
 */
export function createGatewayError(
  input: CreateGatewayErrorInput,
): GatewayError {
  const redactedDetails = redactDetails(input.details);
  return {
    code: input.code,
    message: input.message,
    category: input.category,
    retryable: input.retryable ?? defaultRetryableForCategory(input.category),
    status: input.status ?? defaultStatusForCategory(input.category),
    requestId: input.requestId,
    ...(input.retryAfterMs !== undefined
      ? { retryAfterMs: input.retryAfterMs }
      : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.credentialId !== undefined
      ? { credentialId: input.credentialId }
      : {}),
    ...(redactedDetails !== undefined ? { details: redactedDetails } : {}),
  };
}

/**
 * Classify a raw upstream HTTP status into a gateway category, retryability, and
 * gateway-facing status. A route `policy` override, when supplied, wins over the
 * default retryability. This is the pure provider-facing classification only;
 * credential quarantine and 503 escalation are Application concerns.
 */
export function classifyUpstreamStatus(
  upstreamStatus: number,
  policy?: UpstreamStatusPolicy,
): UpstreamClassification {
  const base = baseClassification(upstreamStatus);
  let retryable = base.retryable;
  if (policy?.nonRetryable.includes(upstreamStatus)) retryable = false;
  else if (policy?.retryable.includes(upstreamStatus)) retryable = true;
  return { category: base.category, retryable, status: base.status };
}

function baseClassification(upstreamStatus: number): UpstreamClassification {
  switch (upstreamStatus) {
    case 401:
      return { category: "authentication", retryable: false, status: 401 };
    case 403:
      return { category: "authorization", retryable: false, status: 403 };
    case 413:
      return { category: "validation", retryable: false, status: 413 };
    case 415:
      return { category: "validation", retryable: false, status: 415 };
    case 422:
      return { category: "upstream", retryable: false, status: 422 };
    case 429:
      return { category: "rate_limit", retryable: true, status: 429 };
    case 503:
      return { category: "upstream", retryable: true, status: 503 };
    case 504:
      return { category: "timeout", retryable: true, status: 504 };
    default:
      break;
  }
  if (upstreamStatus >= 500)
    return { category: "upstream", retryable: true, status: 502 };
  if (upstreamStatus >= 400)
    return { category: "upstream", retryable: false, status: 502 };
  return { category: "upstream", retryable: true, status: 502 };
}

/**
 * Lift a pure cost-calculation failure into a canonical internal error, keeping
 * {@link GatewayError} as the only error object that crosses module boundaries.
 */
export function costFailureToError(
  reason: CostErrorReason,
  requestId: string,
): GatewayError {
  return createGatewayError({
    category: "internal",
    code: "cost_calculation_failed",
    message: "Cost calculation failed.",
    requestId,
    details: { reason },
  });
}
