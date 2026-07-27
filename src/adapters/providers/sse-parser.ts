import type { CanonicalChunk } from "../../domain/index.js";
import { createGatewayError } from "../../domain/index.js";
import type {
  ProviderAdapterLimits,
  ProviderDecodeContext,
  ProviderEventDecoder,
  ProviderStreamParser,
} from "./types.js";

/** Frames bounded UTF-8 SSE bytes and decodes complete JSON provider events. */
export class SseProviderStreamParser implements ProviderStreamParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();
  private carry = "";
  private dataLines: string[] = [];
  private frameBytes = 0;
  private bodyBytes = 0;
  private closed = false;

  /** Creates request-local SSE framing around one provider event decoder. */
  public constructor(
    private readonly decodeEvent: ProviderEventDecoder,
    private readonly limits: Pick<
      ProviderAdapterLimits,
      "maxBodyBytes" | "maxFrameBytes"
    >,
  ) {}

  /** Consumes one bounded transport byte chunk and returns ordered chunks. */
  public push(
    frame: Uint8Array,
    context: ProviderDecodeContext,
  ): ReadonlyArray<CanonicalChunk> {
    if (this.closed) {
      throw this.error(context, "upstream_stream_lifecycle_invalid");
    }
    this.bodyBytes += frame.byteLength;
    if (this.bodyBytes > this.limits.maxBodyBytes) {
      throw this.error(context, "upstream_body_too_large");
    }

    let text: string;
    try {
      text = this.decoder.decode(frame, { stream: true });
    } catch {
      throw this.error(context, "upstream_invalid_utf8");
    }
    this.carry += text;
    const chunks = this.consumeLines(context);
    if (this.encoder.encode(this.carry).byteLength > this.limits.maxFrameBytes) {
      const code = this.carry.startsWith("data:")
        ? "upstream_frame_too_large"
        : "upstream_event_malformed";
      throw this.error(context, code);
    }
    return chunks;
  }

  /** Completes UTF-8 state and rejects incomplete lines or provider events. */
  public finish(context: ProviderDecodeContext): ReadonlyArray<CanonicalChunk> {
    if (this.closed) {
      throw this.error(context, "upstream_stream_lifecycle_invalid");
    }
    try {
      this.carry += this.decoder.decode();
    } catch {
      throw this.error(context, "upstream_invalid_utf8");
    }
    const chunks = this.consumeLines(context);
    if (this.carry.length > 0 || this.dataLines.length > 0) {
      throw this.error(context, "upstream_incomplete_frame");
    }
    return chunks;
  }

  /** Clears all request-local framing carry; repeated calls are harmless. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.carry = "";
    this.dataLines = [];
    this.frameBytes = 0;
    this.bodyBytes = 0;
  }

  private consumeLines(
    context: ProviderDecodeContext,
  ): ReadonlyArray<CanonicalChunk> {
    const chunks: CanonicalChunk[] = [];
    let newline = this.carry.indexOf("\n");
    while (newline >= 0) {
      let line = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      chunks.push(...this.consumeLine(line, context));
      newline = this.carry.indexOf("\n");
    }
    return chunks;
  }

  private consumeLine(
    line: string,
    context: ProviderDecodeContext,
  ): ReadonlyArray<CanonicalChunk> {
    if (line === "") return this.dispatchEvent(context);
    if (line.startsWith(":")) return [];
    if (line.startsWith("event:") || line.startsWith("id:")) return [];
    if (!line.startsWith("data:")) {
      throw this.error(context, "upstream_event_malformed");
    }

    let data = line.slice(5);
    if (data.startsWith(" ")) data = data.slice(1);
    const encodedBytes = this.encoder.encode(data).byteLength;
    const separatorBytes = this.dataLines.length > 0 ? 1 : 0;
    if (
      encodedBytes > this.limits.maxFrameBytes - this.frameBytes - separatorBytes
    ) {
      throw this.error(context, "upstream_frame_too_large");
    }
    this.frameBytes += separatorBytes + encodedBytes;
    this.dataLines.push(data);
    return [];
  }

  private dispatchEvent(
    context: ProviderDecodeContext,
  ): ReadonlyArray<CanonicalChunk> {
    if (this.dataLines.length === 0) return [];
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    this.frameBytes = 0;
    if (data === "[DONE]") return [];

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw this.error(context, "upstream_event_malformed");
    }
    try {
      return [...this.decodeEvent(event, context)];
    } catch (error) {
      if (this.isGatewayError(error)) throw error;
      throw this.error(context, "upstream_event_malformed");
    }
  }

  private error(
    context: ProviderDecodeContext,
    code: string,
  ): ReturnType<typeof createGatewayError> {
    return createGatewayError({
      category: "upstream",
      code,
      message: "The upstream provider stream is invalid.",
      requestId: context.requestId,
      retryable: false,
      status: 502,
    });
  }

  private isGatewayError(value: unknown): value is ReturnType<typeof createGatewayError> {
    return (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      typeof value.code === "string" &&
      "category" in value &&
      typeof value.category === "string" &&
      "requestId" in value &&
      typeof value.requestId === "string"
    );
  }
}
