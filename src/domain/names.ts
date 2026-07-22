/**
 * Regular expression validating a canonical public model name, route name, or alias.
 *
 * Pattern constraints:
 * - Must begin with an alphanumeric character (`[A-Za-z0-9]`).
 * - Followed by 0 to 127 characters consisting of alphanumeric, period, underscore, or hyphen (`[A-Za-z0-9._-]`).
 * - Total length: 1 to 128 characters.
 */
export const PUBLIC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Nominal type representing a validated canonical public model name, route name, or alias.
 *
 * Uses a unique symbol branding to prevent unvalidated strings from being passed
 * to routing and catalog resolution functions without validation.
 */
export type PublicName = string & { readonly __publicName: unique symbol };

/**
 * Type guard validating whether an arbitrary string matches the canonical public name pattern.
 *
 * @param value - The string candidate to validate.
 * @returns `true` if the string conforms to {@link PUBLIC_NAME_PATTERN} and is safe to cast to {@link PublicName}; otherwise `false`.
 *
 * @example
 * ```ts
 * if (isPublicName("gpt-4o")) {
 *   // value is typed as PublicName
 * }
 * ```
 */
export function isPublicName(value: string): value is PublicName {
  return PUBLIC_NAME_PATTERN.test(value);
}
