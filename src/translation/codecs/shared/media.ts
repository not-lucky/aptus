/**
 * @fileoverview Media validation, constants, and payload size helpers for translation.
 *
 * Validates remote HTTPS media URLs, parses base64 data URIs, measures decoded payload lengths
 * in a single allocation-free pass, and infers media types from document file extensions.
 *
 * Used during request ingress, validation, and preflight across OpenAI Chat, OpenAI Responses, and
 * Anthropic Messages codecs to ensure media payloads stay bounded and conform to provider wire rules.
 */

/** Maximum size in bytes of a translated inline media payload (32 MiB). */
export const TRANSLATED_MEDIA_BODY_LIMIT_BYTES = 33_554_432; // 32 MiB

/** Image media types admitted by the Anthropic Messages wire format. */
export const M_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Media type for byte-oriented document payloads (PDF). */
export const M_DOCUMENT_BYTES_MEDIA_TYPE = "application/pdf";

/** Media type for plain text documents. */
export const TEXT_DOCUMENT_MEDIA_TYPE = "text/plain";

/**
 * Checks whether an ASCII character code represents whitespace (space, tab, LF, CR, FF).
 *
 * @param code - ASCII character code to test.
 * @returns `true` if whitespace, `false` otherwise.
 */
function isWhitespaceCharCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * Checks whether an ASCII character code belongs to the standard base64 alphabet [A-Za-z0-9+/].
 *
 * @param code - ASCII character code to test.
 * @returns `true` if a base64 digit character, `false` otherwise.
 */
function isBase64DigitCharCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f // /
  );
}

/**
 * Validates that a value is a well-formed absolute HTTPS URL with a non-empty hostname.
 *
 * @param url - Raw value to validate.
 * @returns `true` with type narrowing if valid HTTPS URL, `false` otherwise.
 */
export function validateHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parses a base64 data URI of the form `data:<mediaType>;base64,<payload>`.
 *
 * @param uri - Raw URI string to parse.
 * @returns Extracted lowercase mediaType and trimmed base64 payload, or `undefined` if malformed.
 */
export function parseDataUri(uri: unknown): { mediaType: string; base64: string } | undefined {
  if (typeof uri !== "string" || !uri.startsWith("data:")) {
    return undefined;
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  if (!match) {
    return undefined;
  }
  const mediaType = match[1]?.trim().toLowerCase();
  const base64 = match[2]?.trim();
  if (!mediaType || !base64) {
    return undefined;
  }
  return { mediaType, base64 };
}

/**
 * Measures the decoded byte length of a base64 string in a single pass without byte allocation.
 * Enforces valid padding (at most 2 '=' at the end) and 4-character block alignment.
 *
 * @param base64 - Base64 payload string to measure.
 * @returns Decoded byte count, or `undefined` if malformed or empty.
 */
export function base64DecodedLength(base64: unknown): number | undefined {
  if (typeof base64 !== "string") return undefined;
  let count = 0;
  let padCount = 0;
  for (let i = 0; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    if (isWhitespaceCharCode(code)) continue;
    if (code === 0x3d) {
      padCount++;
      count++;
      if (padCount > 2) return undefined;
    } else {
      if (padCount > 0) return undefined;
      if (!isBase64DigitCharCode(code)) return undefined;
      count++;
    }
  }
  if (count === 0 || count % 4 !== 0) return undefined;
  const pad = Math.min(padCount, 2);
  return Math.max(0, Math.floor((count * 3) / 4) - pad);
}

/**
 * Type guard verifying whether a value is valid base64 payload text.
 *
 * @param base64 - Value to validate.
 * @returns `true` with type narrowing if valid base64, `false` otherwise.
 */
export function isBase64Valid(base64: unknown): base64 is string {
  return base64DecodedLength(base64) !== undefined;
}

/**
 * Infers document media type and representation kind from a filename extension.
 *
 * @param filename - Filename to inspect.
 * @returns Inferred mediaType and representation kind ('bytes' or 'text'), or `undefined` if unknown.
 */
export function inferExtensionMediaType(
  filename: string | undefined,
): { mediaType: string; kind: "bytes" | "text" } | undefined {
  if (typeof filename !== "string") return undefined;
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".pdf")) {
    return { mediaType: M_DOCUMENT_BYTES_MEDIA_TYPE, kind: "bytes" };
  }
  if (lower.endsWith(".txt")) {
    return { mediaType: TEXT_DOCUMENT_MEDIA_TYPE, kind: "text" };
  }
  return undefined;
}
