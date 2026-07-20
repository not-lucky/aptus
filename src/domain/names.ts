/** One canonical public name or alias: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. */
export const PUBLIC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A canonical public model or route name, or a public alias. */
export type PublicName = string & { readonly __publicName: unique symbol };

/** Guards one public name or alias against the pinned pattern. */
export function isPublicName(value: string): value is PublicName {
  return PUBLIC_NAME_PATTERN.test(value);
}
