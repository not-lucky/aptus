import type {
  CanonicalChunk,
  ChunkAddress,
  CostMetrics,
  GatewayError,
  TokenUsage,
} from "../../domain/index.js";
import {
  createGatewayError,
  validateToolCallArgumentsJson,
  zeroCost,
} from "../../domain/index.js";

interface ToolArgumentsState {
  readonly address: ChunkAddress;
  value: string;
  bytes: number;
  observed: boolean;
  open: boolean;
}

/** Collates request-local usage and validates bounded streamed tool arguments. */
export class CanonicalChunkCollator {
  private readonly encoder = new TextEncoder();
  private readonly tools = new Map<string, ToolArgumentsState>();
  private usage: TokenUsage | undefined;
  private cost: CostMetrics | undefined;
  private usageSequenceNumber: number | undefined;
  private started = false;
  private ended = false;
  private failed = false;

  /** Creates a collator with a hard cumulative argument-byte limit. */
  public constructor(
    private readonly maxToolArgumentsBytes: number,
    private readonly requestId: string,
  ) {}

  /** Accepts one canonical chunk and returns only chunks ready for delivery. */
  public accept(chunk: CanonicalChunk): ReadonlyArray<CanonicalChunk> {
    if (this.ended || this.failed) {
      throw this.error("upstream_stream_lifecycle_invalid");
    }

    switch (chunk.type) {
      case "response_start":
        if (this.started) throw this.error("upstream_stream_lifecycle_invalid");
        this.started = true;
        return [chunk];
      case "content_block_start":
        if (chunk.block.type === "tool_call") {
          const key = addressKey(chunk.address);
          const state = this.tools.get(key);
          if (state?.open) {
            throw this.error("upstream_stream_lifecycle_invalid");
          }
          this.tools.set(key, {
            address: chunk.address,
            value: "",
            bytes: 0,
            observed: false,
            open: true,
          });
        }
        return [chunk];
      case "tool_call_delta":
        this.acceptToolDelta(chunk);
        return [chunk];
      case "content_block_stop":
        this.validateToolAt(chunk.address);
        return [chunk];
      case "usage":
        this.mergeUsage(chunk);
        return [];
      case "response_end": {
        if (!this.started) throw this.error("upstream_stream_lifecycle_invalid");
        this.validateOpenTools();
        this.ended = true;
        const output: CanonicalChunk[] = [];
        const usage = this.finalUsageChunk();
        if (usage !== undefined) output.push(usage);
        output.push(chunk);
        return output;
      }
      case "error":
        this.failed = true;
        return [chunk];
      default:
        return [chunk];
    }
  }

  /** Validates terminal state without inventing a successful response end. */
  public finish(): ReadonlyArray<CanonicalChunk> {
    if (this.failed || this.ended) return [];
    this.validateOpenTools();
    throw this.error("upstream_stream_incomplete");
  }

  private acceptToolDelta(
    chunk: Extract<CanonicalChunk, { type: "tool_call_delta" }>,
  ): void {
    const key = addressKey(chunk.address);
    let state = this.tools.get(key);
    if (state === undefined) {
      state = {
        address: chunk.address,
        value: "",
        bytes: 0,
        observed: false,
        open: true,
      };
      this.tools.set(key, state);
    }
    if (!state.open) throw this.error("upstream_stream_lifecycle_invalid");
    if (chunk.argumentsDelta === undefined) return;
    const deltaBytes = this.encoder.encode(chunk.argumentsDelta).byteLength;
    if (deltaBytes > this.maxToolArgumentsBytes - state.bytes) {
      throw this.error("upstream_tool_arguments_too_large");
    }
    state.value += chunk.argumentsDelta;
    state.bytes += deltaBytes;
    state.observed = true;
  }

  private validateToolAt(address: ChunkAddress): void {
    const state = this.tools.get(addressKey(address));
    if (state === undefined || !state.open) return;
    this.validateTool(state);
    state.open = false;
  }

  private validateOpenTools(): void {
    for (const state of this.tools.values()) {
      if (!state.open) continue;
      this.validateTool(state);
      state.open = false;
    }
  }

  private validateTool(state: ToolArgumentsState): void {
    if (
      state.observed &&
      !validateToolCallArgumentsJson(state.value).valid
    ) {
      throw this.error("upstream_tool_arguments_invalid");
    }
  }

  private mergeUsage(
    chunk: Extract<CanonicalChunk, { type: "usage" }>,
  ): void {
    this.usageSequenceNumber = maxOptional(
      this.usageSequenceNumber,
      chunk.sequenceNumber,
    );
    this.usage = mergeUsage(this.usage, chunk.usage);
    if (chunk.cost !== undefined) this.cost = mergeCost(this.cost, chunk.cost);
  }

  private finalUsageChunk(): CanonicalChunk | undefined {
    if (this.usage === undefined) return undefined;
    return {
      type: "usage",
      usage: this.usage,
      ...(this.cost !== undefined ? { cost: this.cost } : {}),
      ...(this.usageSequenceNumber !== undefined
        ? { sequenceNumber: this.usageSequenceNumber }
        : {}),
    };
  }

  private error(code: string): GatewayError {
    return createGatewayError({
      category: "upstream",
      code,
      message: "The upstream provider stream is invalid.",
      requestId: this.requestId,
      retryable: false,
      status: 502,
    });
  }
}

function addressKey(address: ChunkAddress): string {
  return `${address.choiceIndex === undefined ? "u" : `n${address.choiceIndex}`}|${address.outputIndex}|${address.contentIndex === undefined ? "u" : `n${address.contentIndex}`}`;
}

function mergeUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const base = current ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const inputTokens = Math.max(base.inputTokens, next.inputTokens);
  const outputTokens = Math.max(base.outputTokens, next.outputTokens);
  const result: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(base.totalTokens, next.totalTokens, inputTokens + outputTokens),
  };
  for (const key of [
    "reasoningTokens",
    "audioInputTokens",
    "audioOutputTokens",
    "cachedInputTokens",
    "acceptedPredictionTokens",
    "rejectedPredictionTokens",
  ] as const) {
    const value = maxOptional(base[key], next[key]);
    if (value !== undefined) result[key] = value;
  }

  const cache = new Map<number, number>();
  for (const entry of base.cacheWriteBreakdown ?? []) {
    cache.set(entry.ttlSeconds, entry.tokens);
  }
  for (const entry of next.cacheWriteBreakdown ?? []) {
    cache.set(entry.ttlSeconds, Math.max(cache.get(entry.ttlSeconds) ?? 0, entry.tokens));
  }
  if (cache.size > 0) {
    result.cacheWriteBreakdown = [...cache.entries()]
      .sort(([left], [right]) => left - right)
      .map(([ttlSeconds, tokens]) => ({ ttlSeconds, tokens }));
  }

  const serverToolUsage: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.serverToolUsage ?? {})) {
    serverToolUsage[key] = value;
  }
  for (const [key, value] of Object.entries(next.serverToolUsage ?? {})) {
    serverToolUsage[key] = Math.max(serverToolUsage[key] ?? 0, value);
  }
  if (Object.keys(serverToolUsage).length > 0) result.serverToolUsage = serverToolUsage;
  return result;
}

function mergeCost(current: CostMetrics | undefined, next: CostMetrics): CostMetrics {
  const base = current ?? zeroCost();
  const inputUsd = Math.max(base.inputUsd, next.inputUsd);
  const outputUsd = Math.max(base.outputUsd, next.outputUsd);
  const cacheReadUsd = Math.max(base.cacheReadUsd, next.cacheReadUsd);
  const cacheWriteUsd = Math.max(base.cacheWriteUsd, next.cacheWriteUsd);
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd: Math.max(
      base.totalUsd,
      next.totalUsd,
      inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    ),
    currency: "USD",
  };
}

function maxOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
