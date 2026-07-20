import { randomUUID } from "node:crypto";

/** An Aptus request identity created after ingress admission. */
export type AptusRequestId = string & { readonly __aptusRequestId: unique symbol };

/** Standard UUID shape pattern. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creates one fresh request identity. */
export function createRequestId(): AptusRequestId {
  return randomUUID() as AptusRequestId;
}

/** Guards one request identity against the UUID shape. */
export function isAptusRequestId(value: string): value is AptusRequestId {
  return UUID_PATTERN.test(value);
}
