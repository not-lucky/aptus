import { randomUUID } from "node:crypto";

/**
 * Nominal type representing an admitted Aptus request identity (canonical UUID v4).
 *
 * Generated immediately upon ingress admission and attached to response headers (`x-aptus-request-id`),
 * structured logs, and trace manifests.
 */
export type AptusRequestId = string & { readonly __aptusRequestId: unique symbol };

export function createRequestId(): AptusRequestId {
  return randomUUID() as AptusRequestId;
}
