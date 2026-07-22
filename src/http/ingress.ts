import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import type { HeaderMap, JsonObject, JsonValue } from "../domain/contracts.js";
import type { IrFailureCategory } from "../domain/operations.js";

/**
 * Ingress admission failure description.
 */
export interface IngressFailure {
  /** Failure category for status mapping (e.g. `invalid_request` or `payload_too_large`). */
  readonly category: IrFailureCategory;
  /** Bounded error description. */
  readonly message: string;
}

/**
 * Result of duplicate-free JSON parsing.
 */
export type JsonParseResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: IngressFailure };

/**
 * Result of request body admission and header filtering.
 */
export type AdmissionResult =
  | { readonly ok: true; readonly body: JsonObject; readonly headers: HeaderMap }
  | { readonly ok: false; readonly failure: IngressFailure };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Admits an incoming HTTP request body:
 * 1. Checks `Content-Type` is `application/json` (with optional `utf-8` charset).
 * 2. Checks `Content-Encoding` is `identity` or omitted.
 * 3. Streams body bytes up to `bodyLimitBytes`, rejecting with `payload_too_large` if exceeded.
 * 4. Validates UTF-8 encoding.
 * 5. Parses JSON with strict duplicate key rejection.
 * 6. Validates root payload is a JSON object.
 * 7. Filters inbound headers against forbidden and trusted proxy forwarding rules.
 *
 * @param request - Incoming Node HTTP request.
 * @param bodyLimitBytes - Configured maximum body size limit in bytes.
 * @param trustedProxyCidrs - List of trusted reverse proxy IPv4 CIDRs.
 * @returns Promise resolving to {@link AdmissionResult}.
 */
export async function admitJsonObject(
  request: IncomingMessage,
  bodyLimitBytes: number,
  trustedProxyCidrs: readonly string[] = [],
): Promise<AdmissionResult> {
  const contentType = request.headers["content-type"];
  if (!isJsonContentType(contentType)) return failure("invalid_request", "content-type must be application/json");
  const contentEncoding = request.headers["content-encoding"];
  if (!isIdentityEncoding(contentEncoding)) return failure("invalid_request", "content-encoding must be identity");

  const chunks: Buffer[] = [];
  let length = 0;
  try {
    // Stream chunks with destroyOnReturn: false so the underlying socket isn't closed if loop breaks.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > bodyLimitBytes) {
        request.resume();
        return failure("payload_too_large", "request body exceeds configured limit");
      }
      chunks.push(bytes);
    }
  } catch {
    return failure("invalid_request", "request body could not be read");
  }
  if (request.aborted) return failure("invalid_request", "request body could not be read");

  let text: string;
  try {
    text = utf8Decoder.decode(Buffer.concat(chunks, length));
  } catch {
    return failure("invalid_request", "request body must be valid UTF-8");
  }

  const parsed = parseDuplicateFreeJson(text);
  if (!parsed.ok) return parsed;
  if (!isJsonObject(parsed.value)) return failure("invalid_request", "request body must be one JSON object");
  return {
    ok: true,
    body: parsed.value,
    headers: filterClientHeaders(request.headers, request.socket?.remoteAddress, trustedProxyCidrs),
  };
}

/**
 * Parses a JSON text string, strictly rejecting duplicate object keys at all nesting depths.
 *
 * @param text - Raw JSON string to parse.
 * @returns Result containing the parsed {@link JsonValue} or an {@link IngressFailure}.
 */
export function parseDuplicateFreeJson(text: string): JsonParseResult {
  const parser = new JsonParser(text);
  const value = parser.parse();
  if (value === undefined) return failure("invalid_request", parser.error ?? "invalid JSON request body");
  parser.skipWhitespace();
  return parser.atEnd() ? { ok: true, value } : failure("invalid_request", "request body must contain one JSON value");
}

/**
 * Sanitizes and normalizes incoming client HTTP headers before passing to routing:
 * - Converts header names to lowercase.
 * - Strips authentication credentials (`authorization`, `x-api-key`).
 * - Strips hop-by-hop and transport framing headers (`connection`, `content-length`, etc.).
 * - Strips forwarding headers (`X-Forwarded-*`, `Forwarded`) unless peer IP is within `trustedProxyCidrs`.
 *
 * @param headers - Raw incoming HTTP headers.
 * @param peerAddress - Remote socket IP address.
 * @param trustedProxyCidrs - List of trusted reverse proxy IPv4 CIDRs.
 * @returns Cleaned {@link HeaderMap}.
 */
export function filterClientHeaders(
  headers: IncomingHttpHeaders,
  peerAddress?: string,
  trustedProxyCidrs: readonly string[] = [],
): HeaderMap {
  const result: Record<string, string> = {};
  const trusted = isTrustedProxy(peerAddress, trustedProxyCidrs);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || FORBIDDEN_CLIENT_HEADERS[normalized] === true) continue;
    // Discard proxy forwarding headers if the connecting peer is not in trusted CIDRs.
    if (FORWARDING_HEADERS[normalized] === true && !trusted) continue;
    result[normalized] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function failure(
  category: IrFailureCategory,
  message: string,
): { readonly ok: false; readonly failure: IngressFailure } {
  return { ok: false, failure: { category, message } };
}

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?$/i.test(value.trim());
}

function isIdentityEncoding(value: string | undefined): boolean {
  return value === undefined || /^identity$/i.test(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTrustedProxy(peerAddress: string | undefined, trustedProxyCidrs: readonly string[]): boolean {
  const peer = parseIpv4(peerAddress);
  if (peer === undefined) return false;
  return trustedProxyCidrs.some((cidr) => containsIpv4(peer, cidr));
}

/**
 * Tests whether an IPv4 numeric address falls within a given CIDR network range.
 */
function containsIpv4(peer: number, cidr: string): boolean {
  const [address, prefixText, ...extra] = cidr.split("/");
  if (address === undefined || prefixText === undefined || extra.length > 0 || !/^\d{1,2}$/.test(prefixText))
    return false;
  const prefix = Number(prefixText);
  const network = parseIpv4(address);
  if (network === undefined || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  // Compute netmask using unsigned 32-bit bitwise shift.
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (peer & mask) === (network & mask);
}

/**
 * Converts an IPv4 dotted-decimal string into an unsigned 32-bit integer.
 */
function parseIpv4(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const octets = value.split(".");
  if (octets.length !== 4) return undefined;
  let output = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined;
    const number = Number(octet);
    if (number > 255) return undefined;
    output = (output << 8) | number;
  }
  return output >>> 0;
}

const FORBIDDEN_CLIENT_HEADERS: Record<string, true> = {
  authorization: true,
  connection: true,
  "content-length": true,
  "content-encoding": true,
  host: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  "x-api-key": true,
};

const FORWARDING_HEADERS: Record<string, true> = {
  forwarded: true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-port": true,
  "x-forwarded-proto": true,
};

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

/**
 * Fast recursive-descent JSON parser that detects duplicate keys in objects at every nesting level.
 */
class JsonParser {
  readonly #text: string;
  #offset = 0;
  error: string | undefined;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsonValue | undefined {
    this.skipWhitespace();
    return this.parseValue();
  }

  skipWhitespace(): void {
    while (isJsonWhitespace(this.#text[this.#offset])) this.#offset++;
  }

  atEnd(): boolean {
    return this.#offset === this.#text.length;
  }

  private parseValue(): JsonValue | undefined {
    const token = this.#text[this.#offset];
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (token === "-") return this.parseNumber();
    if (token !== undefined && /[0-9]/.test(token)) return this.parseNumber();
    this.error = "invalid JSON value";
    return undefined;
  }

  private parseObject(): JsonObject | undefined {
    this.#offset++;
    this.skipWhitespace();
    const value: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    if (this.consume("}")) return value;
    while (true) {
      if (this.#text[this.#offset] !== '"') return this.fail("object keys must be strings");
      const key = this.parseString();
      if (key === undefined) return undefined;
      // Strict duplicate key rejection.
      if (keys.has(key)) return this.fail("duplicate JSON object key");
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) return this.fail("object key must have a value");
      this.skipWhitespace();
      const child = this.parseValue();
      if (child === undefined) return undefined;
      value[key] = child;
      this.skipWhitespace();
      if (this.consume("}")) return value;
      if (!this.consume(",")) return this.fail("object entries must be comma separated");
      this.skipWhitespace();
    }
  }

  private parseArray(): readonly JsonValue[] | undefined {
    this.#offset++;
    this.skipWhitespace();
    const values: JsonValue[] = [];
    if (this.consume("]")) return values;
    while (true) {
      const value = this.parseValue();
      if (value === undefined) return undefined;
      values.push(value);
      this.skipWhitespace();
      if (this.consume("]")) return values;
      if (!this.consume(",")) return this.fail("array entries must be comma separated");
      this.skipWhitespace();
    }
  }

  private parseString(): string | undefined {
    this.#offset++;
    let output = "";
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset++];
      if (character === undefined) break;
      if (character === '"') return output;
      // Control characters (< 0x20) must be escaped.
      if (character.charCodeAt(0) < 0x20) return this.fail("invalid JSON string");
      if (character !== "\\") {
        output += character;
        continue;
      }
      const escaped = this.#text[this.#offset++];
      if (escaped === undefined) return this.fail("invalid JSON string");
      switch (escaped) {
        case '"':
        case "\\":
        case "/":
          output += escaped;
          break;
        case "b":
          output += "\b";
          break;
        case "f":
          output += "\f";
          break;
        case "n":
          output += "\n";
          break;
        case "r":
          output += "\r";
          break;
        case "t":
          output += "\t";
          break;
        case "u": {
          const codeUnit = this.parseUnicodeEscape();
          if (codeUnit === undefined) return undefined;
          // Handle UTF-16 surrogate pairs: High surrogate 0xD800..0xDBFF, Low surrogate 0xDC00..0xDFFF.
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            if (this.#text.slice(this.#offset, this.#offset + 2) !== "\\u") return this.fail("invalid JSON string");
            this.#offset += 2;
            const lowSurrogate = this.parseUnicodeEscape();
            if (lowSurrogate === undefined) return undefined;
            if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return this.fail("invalid JSON string");
            // Reconstruct full Unicode code point.
            output += String.fromCodePoint(0x10000 + (codeUnit - 0xd800) * 0x400 + (lowSurrogate - 0xdc00));
          } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return this.fail("invalid JSON string");
          } else {
            output += String.fromCharCode(codeUnit);
          }
          break;
        }
        default:
          return this.fail("invalid JSON string");
      }
    }
    return this.fail("unterminated JSON string");
  }

  private parseUnicodeEscape(): number | undefined {
    const hex = this.#text.slice(this.#offset, this.#offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) return this.fail("invalid JSON string");
    this.#offset += 4;
    return Number.parseInt(hex, 16);
  }

  private parseLiteral(literal: string, value: boolean | null): boolean | null | undefined {
    if (this.#text.slice(this.#offset, this.#offset + literal.length) !== literal) {
      return this.fail("invalid JSON literal");
    }
    const next = this.#text[this.#offset + literal.length];
    if (next !== undefined && !isJsonWhitespace(next) && next !== "," && next !== "]" && next !== "}") {
      return this.fail("invalid JSON literal");
    }
    this.#offset += literal.length;
    return value;
  }

  private parseNumber(): number | undefined {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.#text.slice(this.#offset));
    if (match === null) return this.fail("invalid JSON number");
    const next = this.#text[this.#offset + match[0].length];
    if (next !== undefined && !isJsonWhitespace(next) && next !== "," && next !== "]" && next !== "}") {
      return this.fail("invalid JSON number");
    }
    this.#offset += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : this.fail("invalid JSON number");
  }

  private consume(token: "}" | "]" | ":" | ","): boolean {
    if (this.#text[this.#offset] !== token) return false;
    this.#offset++;
    return true;
  }

  private fail(message: string): undefined {
    this.error = message;
    return undefined;
  }
}
