import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  FinishReason,
  GatewayError,
} from "../domain/index.js";
import type { TokenUsage } from "../domain/index.js";

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
  /** Optional outer-boundary authorization value; never copied into canonical data. */
  readonly authorization?: string;
  /** Optional caller-owned cancellation signal linked to the application scope. */
  readonly signal?: AbortSignal;
  /** Optional externally supplied request identity. */
  requestId?: string;
}

/** Immutable response identity carried by the request-owned stream writer. */
export interface StreamResponseMetadata {
  /** Stable protocol response identifier learned from the stream start. */
  readonly responseId: string;
  /** Model reported by the canonical stream. */
  readonly model: string;
  /** RFC 3339 response creation timestamp. */
  readonly createdAt: string;
}

/**
 * Mutable state owned by exactly one request-owned protocol stream.
 * Sequence and protocol-specific lifecycle state are request-local and must
 * not be shared across concurrent streams.
 */
export interface StreamTranslationState {
  /** Last allocated sequence number by request-local event address. */
  readonly sequenceNumbers: Map<string, number>;
  /** Sequence numbers already reserved, including resume-suppressed records. */
  readonly emittedSequences: Set<number>;
  /** Inclusive request-local cursor: records at or below it stay off wire. */
  readonly resumeFrom?: number;
  /** Stable response identity established by the canonical start chunk. */
  response?: {
    /** Stable protocol response identifier. */
    readonly responseId: string;
    /** Model reported by the canonical stream. */
    readonly model: string;
    /** RFC 3339 response creation timestamp. */
    readonly createdAt: string;
  };
  /** Latest validated usage retained for the terminal response snapshot. */
  usage?: TokenUsage;
  /** Anthropic-compatible block address allocation by canonical address. */
  blockIndexes?: Map<string, number>;
  /** Anthropic-compatible open block lifecycle by canonical address. */
  openBlocks?: Map<
    string,
    { readonly kind: string; readonly emitted: boolean; readonly index?: number }
  >;
  /** Next protocol block index to allocate. */
  nextBlockIndex?: number;
  /** Canonical finish reason retained until terminal response emission. */
  finishReason?: FinishReason;
  /** Canonical stop sequence retained until terminal response emission. */
  stopSequence?: string;
  /** Stable keys for citations already emitted on a stream. */
  emittedCitationKeys?: Set<string>;
  /** Whether a terminal or typed-error record has been consumed. */
  terminal: boolean;
  /** Whether at least one non-resumed typed record reached the wire. */
  bytesEmitted: boolean;
 }

/** Request-local context shared across translation boundaries. */
export interface TranslationContext {
  /** Stable request identity. */
  readonly requestId: string;
  /** Cancellation signal forwarded from the owning request. */
  readonly signal: AbortSignal;
  /** Trusted routing headers exposed only as a readonly view. */
  readonly trustedRoutingHeaders: Readonly<Record<string, string>>;
  /** Optional immutable response identity used to encode non-start stream chunks. */
  readonly streamResponse?: StreamResponseMetadata;
  /** Optional request-owned state shared by one protocol stream encoder. */
  readonly streamState?: StreamTranslationState;
}

/**
 * Creates fresh request-owned state for one protocol stream.
 * Callers must create it once per HTTP stream and reuse it for every chunk.
 */
export function createStreamTranslationState(
  response?: StreamResponseMetadata,
): StreamTranslationState {
  return {
    sequenceNumbers: new Map(),
    emittedSequences: new Set(),
    ...(response === undefined ? {} : { response: { ...response } }),
    blockIndexes: new Map(),
    openBlocks: new Map(),
    nextBlockIndex: 0,
    emittedCitationKeys: new Set(),
    terminal: false,
    bytesEmitted: false,
  };
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
