/**
 * Media validation, constants, and payload size helpers for cross-protocol translation.
 */

export const TRANSLATED_MEDIA_BODY_LIMIT_BYTES = 33_554_432; // 32 MiB

export const M_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const M_DOCUMENT_BYTES_MEDIA_TYPE = "application/pdf";
export const TEXT_DOCUMENT_MEDIA_TYPE = "text/plain";

/**
 * Returns true if the character code represents an ASCII whitespace character.
 */
function isWhitespaceCharCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * Returns true if the character code represents a valid standard base64 character
 * ([A-Za-z0-9+/]).
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
 * Validates that a string is a well-formed absolute HTTPS URL with a non-empty host.
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
 * Parses a `data:<mediaType>;base64,<payload>` URI.
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
 * Returns the decoded byte length of a base64 string, or `undefined` if the
 * input is not valid base64 (whitespace tolerated). Single-pass validation
 * and length computation so callers need not run two loops.
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
  // The loop guard caps padCount at 2, so a complete group always decodes to
  // at least one byte and no zero/negative length can leave this function.
  const pad = Math.min(padCount, 2);
  return Math.max(0, Math.floor((count * 3) / 4) - pad);
}

/**
 * Validates whether a string is valid base64 (allowing internal whitespace).
 * Validates character legality, correct padding alignment, and non-empty payload
 * in a single zero-allocation pass.
 */
export function isBase64Valid(base64: unknown): base64 is string {
  return base64DecodedLength(base64) !== undefined;
}

/**
 * Infers document media type and representation kind from filename extension.
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
