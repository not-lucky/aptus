/**
 * @fileoverview
 * Ingress admission and security validation gate for incoming client requests.
 *
 * Validates request headers and bodies before gateway dispatch: enforces JSON content types,
 * streams payloads with hard size limits, validates UTF-8 byte sequences, parses JSON with
 * strict duplicate-key rejection (preventing parameter-smuggling attacks), and filters inbound
 * headers against credentials, hop-by-hop framing, and untrusted proxy forwarding.
 */

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { TextDecoder } from "node:util";
import type { HeaderMap, JsonObject, JsonValue } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";

/**
 * Ingress admission failure description.
 *
 * A plain data carrier: the error-encoder maps the category to an HTTP
 * status and relays the message to the client, so neither field is ever
 * mutated after creation. Messages are bounded and never echo header
 * values or body content, to keep them safe to log.
 */
export interface IngressFailure {
  /** Failure category for status mapping (e.g. `invalid_request` or `payload_too_large`). */
  readonly category: IrFailureCategory;
  /** Bounded error description. */
  readonly message: string;
}

/**
 * Result of duplicate-free JSON parsing.
 *
 * The ok variant carries the parsed value; the failure variant carries the
 * exact reason the text was rejected (syntax error, duplicate key, trailing
 * content), so tests can pin the message.
 */
export type JsonParseResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: IngressFailure };

/**
 * Result of request body admission and header filtering.
 *
 * This is the all-or-nothing verdict on one incoming request: on success it
 * carries the parsed JSON object and the sanitized header map that the
 * gateway should see, and on failure the request never proceeds any
 * further. There is no partial admission.
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
 * @param request - The incoming Node HTTP request. The body is consumed by
 *   this function; headers are read but never modified.
 * @param bodyLimitBytes - The configured maximum body size in bytes. The
 *   count includes every byte received, so a body one byte over the limit
 *   is rejected. It must be a positive integer.
 * @param trustedProxyCidrs - The trusted reverse proxy IPv4 CIDR allowlist
 *   used by the header filtering step. When empty, no peer is trusted and
 *   all forwarding headers are stripped. The default is empty, which is the
 *   safe posture for a deployment without a reverse proxy.
 * @returns A promise resolving to {@link AdmissionResult}: on success the
 *   parsed body and cleaned headers, and on failure the ingress failure
 *   describing the first check that did not pass, in the order documented
 *   in the summary. The promise never rejects; transport-level read errors
 *   are reported as `invalid_request` failures.
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
 * Parses a JSON text string, strictly rejecting duplicate object keys at
 * all nesting depths.
 *
 * The function also enforces single-value documents: trailing content after
 * the first JSON value (two objects back to back, or trailing garbage) is
 * rejected, which `JSON.parse` alone would not catch.
 *
 * The function is synchronous, pure, and never throws; every invalid input
 * is reported through the failure variant.
 *
 * @param text - The raw JSON string to parse. It is expected to be valid
 *   UTF-8 text already; encoding problems are the caller's step and are
 *   rejected there.
 * @returns A result containing the parsed {@link JsonValue} on success, or
 *   an `invalid_request` {@link IngressFailure} naming the first syntax
 *   problem (including the duplicate-key and trailing-content cases) on
 *   failure.
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
 * @param headers - The raw incoming HTTP headers, with Node's
 *   lowercase-name and possible array-value conventions. They are read
 *   only; the input object is never modified.
 * @param peerAddress - The remote socket IP address, used for the
 *   trusted-proxy decision. It can be `undefined` (for example on a
 *   Unix socket), which is treated as untrusted.
 * @param trustedProxyCidrs - The trusted reverse proxy IPv4 CIDR allowlist.
 *   When empty, or when the peer is not inside any listed network, all
 *   forwarding headers are stripped rather than trusted.
 * @returns The cleaned {@link HeaderMap}: lowercase names, array values
 *   joined with a comma and a space, credentials and hop-by-hop headers
 *   removed, and forwarding headers present only when the peer is a
 *   trusted proxy.
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

/**
 * Builds the failure variant shared by every admission check.
 *
 * A tiny constructor that keeps the failure shape in one place so the
 * category and message fields stay consistent across the many checks in
 * this module. It is synchronous, pure, and never throws.
 *
 * @param category - The failure category to report, which the error encoder
 *   maps onto an HTTP status.
 * @param message - The bounded, client-safe error description.
 * @returns The failure-shaped result object.
 */
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
  if (peerAddress === undefined || isIP(peerAddress) !== 4) return false;
  return trustedProxyCidrs.some((cidr) => isIpv4InCidr(peerAddress, cidr));
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [address, prefixText, ...extra] = cidr.split("/");
  if (address === undefined || prefixText === undefined || extra.length > 0 || !/^\d{1,2}$/.test(prefixText))
    return false;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (isIP(address) !== 4) return false;
  if (prefix === 0) return true;
  try {
    const list = new BlockList();
    list.addSubnet(address, prefix, "ipv4");
    return list.check(ip, "ipv4");
  } catch {
    return false;
  }
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
 * Fast recursive-descent JSON parser that detects duplicate keys in objects
 * at every nesting level.
 *
 * The class exists to back {@link parseDuplicateFreeJson}; the built-in
 * `JSON.parse` cannot express the duplicate-key rejection, and wrapping it
 * with a second scan would parse everything twice. The parser follows RFC
 * 8259: it accepts objects, arrays, strings (with full escape and UTF-16
 * surrogate-pair handling), numbers (with strict grammar and a finiteness
 * check), and the three literals, and it rejects trailing content. Errors
 * are reported by setting the public `error` field and returning
 * `undefined`, because parse failures are a normal, expected outcome here
 * rather than an exceptional one.
 *
 * One instance parses one document; instances are not reusable after a
 * completed parse. All methods are synchronous and side-effect free beyond
 * the instance's own cursor and error state.
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
