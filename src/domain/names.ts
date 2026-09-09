/**
 * @fileoverview Public model names, route names, and aliases for the gateway catalog.
 *
 * Client-facing model identifiers, routes, and aliases share a common syntax and
 * branded string representation. This module defines the validation regular expression,
 * the nominal {@link PublicName} type, and the {@link isPublicName} type guard.
 *
 * Restricting names to alphanumeric characters and safe punctuation ensures that
 * model and route names can be safely embedded in URLs, log records, Prometheus metric
 * labels, and trace files without escaping.
 */

/**
 * Validation pattern for canonical public model names, route names, and aliases.
 *
 * Rules:
 * - Must start with an alphanumeric character (`[A-Za-z0-9]`).
 * - May be followed by up to 127 alphanumeric characters, dots, underscores, or hyphens.
 * - Total length is bounded between 1 and 128 characters.
 *
 * The configuration schema in `src/config/schema.ts` uses this pattern to reject invalid
 * model and route names at startup.
 */
export const PUBLIC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A validated canonical public model name, route name, or alias.
 *
 * Uses unique symbol branding to prevent unvalidated strings from being passed directly
 * into routing candidate resolution or catalog queries without first being checked
 * through {@link isPublicName}.
 */
export type PublicName = string & { readonly __publicName: unique symbol };

/**
 * Tests whether an arbitrary string matches the canonical public name pattern.
 *
 * Validates untrusted input strings at system boundaries (such as HTTP request bodies
 * and configuration files) and narrows the type to {@link PublicName}.
 *
 * @param value - Candidate string to validate.
 * @returns `true` if the string matches {@link PUBLIC_NAME_PATTERN} and can be safely
 *   treated as a {@link PublicName}; otherwise `false`.
 *
 * @example
 * ```ts
 * if (isPublicName(req.body.model)) {
 *   // req.body.model is narrowed to PublicName
 *   resolveRoute(req.body.model);
 * }
 * ```
 */
export function isPublicName(value: string): value is PublicName {
  return PUBLIC_NAME_PATTERN.test(value);
}
