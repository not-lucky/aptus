/**
 * @fileoverview Request identity for admitted Aptus requests.
 *
 * Defines the branded {@link AptusRequestId} nominal type and the {@link createRequestId}
 * generator function. Unique identifiers are minted during HTTP admission and carried
 * across logs, metrics, response headers (`x-aptus-request-id`), and trace sessions.
 */

import { randomUUID } from "node:crypto";

/**
 * Unique identifier for a single admitted request.
 *
 * Branded nominal type wrapping a canonical UUID v4 string. Branding ensures identifiers
 * are generated via {@link createRequestId} rather than arbitrary string assignments.
 */
export type AptusRequestId = string & { readonly __aptusRequestId: unique symbol };

/**
 * Creates a fresh UUID v4 request identifier for an admitted request.
 *
 * Minted once per request during HTTP admission to correlate logs, metrics,
 * traces, and the downstream response header.
 *
 * @returns A unique {@link AptusRequestId} branded UUID v4 string.
 */
export function createRequestId(): AptusRequestId {
  return randomUUID() as AptusRequestId;
}
