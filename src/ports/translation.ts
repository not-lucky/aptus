import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
} from "../domain/index.js";

/** Value emitted by an egress adapter; ownership remains with the adapter. */
export type EgressValue = Uint8Array | string | Record<string, unknown>;

/** Protocol input before canonical translation; headers are intentionally mutable for parsing. */
export interface RawIngressInput {
  /** Normalized or raw request path supplied by the outer adapter. */
  path: string;
  /** Parsed request headers; translation may consume or normalize them. */
  headers: Record<string, string>;
  /** Untrusted protocol body awaiting validation. */
  body: unknown;
  /** Optional caller-owned cancellation signal linked to the application scope. */
  readonly signal?: AbortSignal;
  /** Optional externally supplied request identity. */
  requestId?: string;
}

/** Request-local context shared across translation boundaries. */
export interface TranslationContext {
  /** Stable request identity. */
  readonly requestId: string;
  /** Cancellation signal forwarded from the owning request. */
  readonly signal: AbortSignal;
  /** Trusted routing headers exposed only as a readonly view. */
  readonly trustedRoutingHeaders: Readonly<Record<string, string>>;
}

/** Converts one protocol request into the canonical request model. */
export interface IngressTranslationAdapter {
  /** Protocol namespace owned by this adapter. */
  readonly protocol: CanonicalRequest["source"]["protocol"];
  /** Route paths accepted by this adapter. */
  readonly paths: ReadonlySet<string>;
  /** Checks whether this adapter can parse a path/body pair. */
  canTranslate(path: string, body: unknown): boolean;
  /** Produces a validated canonical request without outer transport types. */
  translate(
    input: RawIngressInput,
    context: TranslationContext,
  ): CanonicalRequest;
}

/** Converts canonical output and errors into one protocol’s egress values. */
export interface EgressTranslationAdapter {
  /** Protocol namespace encoded by this adapter. */
  readonly protocol: CanonicalRequest["source"]["protocol"];
  /** Encodes a complete canonical response. */
  encodeResponse(
    response: CanonicalResponse,
    context: TranslationContext,
  ): EgressValue;
  /** Encodes one bounded canonical stream chunk. */
  encodeChunk(chunk: CanonicalChunk, context: TranslationContext): EgressValue;
  /** Encodes a safe canonical gateway error. */
  encodeError(error: GatewayError, context: TranslationContext): EgressValue;
}
