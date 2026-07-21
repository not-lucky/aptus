/** JSON scalar value retained without protocol normalization. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value retained without protocol normalization. */
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Canonical ordered-message role. */
export type CanonicalRole =
  "system" | "developer" | "user" | "assistant" | "tool";

/**
 * Known capability tags used for routing and validation. Deliberately an open
 * string type: literals provide autocomplete while providers may add values.
 */
export type KnownCapability =
  | "reasoning"
  | "tools"
  | "server_tools"
  | "mcp"
  | "vision"
  | "multimodal"
  | "audio_input"
  | "audio_output"
  | "image_generation"
  | "computer_use"
  | "code_execution"
  | "web_search"
  | "citations"
  | "structured_outputs"
  | "strict_tools"
  | "prompt_caching"
  | "logprobs"
  | "multiple_choices"
  | "json"
  | "long_context"
  | "batch"
  | "background_execution";
/** Open capability name retaining unknown provider capabilities. */
export type Capability = KnownCapability | (string & {});

/** Structured source pointer attached to generated or search text. */
export interface Citation {
  kind:
    | "char_span"
    | "page_span"
    | "block_span"
    | "search_result_span"
    | "url"
    | "file";
  sourceId?: string;
  sourceTitle?: string;
  citedText?: string;
  startIndex?: number;
  endIndex?: number;
  pageStart?: number;
  pageEnd?: number;
  url?: string;
  raw?: JsonValue;
}

/** Fields shared by all ordered content variants. */
export interface ContentBlockBase {
  /** Native block/item identifier. */
  id?: string;
  /** Explicit prompt-cache breakpoint. */
  cacheBreakpoint?: { ttl?: string };
  /** Source item lifecycle status, when available. */
  status?: "in_progress" | "completed" | "incomplete";
  /** Unknown provider block data retained losslessly. */
  providerMetadata?: Record<string, JsonValue>;
}

/**
 * Ordered canonical content. Reasoning, text, and tool blocks remain interleaved
 * exactly as observed. Nested results preserve their own ordered content.
 */
export type ContentBlock = ContentBlockBase &
  (
    | { type: "text"; text: string; citations?: Citation[] }
    | { type: "refusal"; refusal: string }
    | { type: "image_url"; url: string; detail?: "auto" | "low" | "high" }
    | { type: "image_base64"; mediaType: string; data: string }
    | {
        type: "generated_image";
        mediaType: string;
        data: string;
        revisedPrompt?: string;
        size?: string;
        background?: "transparent" | "opaque" | "auto";
      }
    | { type: "audio_url"; url: string; format?: string }
    | { type: "audio_base64"; mediaType: string; data: string }
    | {
        type: "audio_output";
        mediaType: string;
        data?: string;
        transcript?: string;
        expiresAt?: string;
      }
    | {
        type: "document_url";
        url: string;
        mediaType?: string;
        title?: string;
        citationsEnabled?: boolean;
      }
    | {
        type: "document_base64";
        mediaType: string;
        data: string;
        title?: string;
        citationsEnabled?: boolean;
      }
    | {
        type: "file_reference";
        fileId: string;
        mediaType?: string;
        filename?: string;
      }
    | {
        type: "search_result";
        sourceId: string;
        title: string;
        text: string;
        citationsEnabled?: boolean;
      }
    | {
        type: "reasoning";
        text?: string;
        signature?: string;
        redactedData?: string;
        encryptedContent?: string;
      }
    | {
        type: "tool_call";
        toolCallId: string;
        name: string;
        argumentsJson: string;
        caller?: "model" | "program";
      }
    | {
        type: "tool_result";
        toolCallId: string;
        content: ContentBlock[];
        isError?: boolean;
      }
    | {
        type: "server_tool_call";
        toolCallId: string;
        toolKind: string;
        name?: string;
        serverName?: string;
        input?: JsonValue;
        argumentsJson?: string;
        caller?: "model" | "program";
      }
    | {
        type: "server_tool_result";
        toolCallId: string;
        toolKind: string;
        content: ContentBlock[];
        isError?: boolean;
      }
    | {
        type: "tool_approval_request";
        toolCallId: string;
        toolKind?: string;
        reason?: string;
      }
    | { type: "tool_approval_response"; toolCallId: string; approved: boolean }
  );

/**
 * System/developer instructions remain ordinary messages at their original
 * positions because position carries meaning and protects cached prefixes.
 * Egress adapters may hoist only a leading contiguous run where their protocol
 * requires it; mid-conversation instructions and structured blocks stay ordered.
 */
export interface CanonicalMessage {
  id?: string;
  role: CanonicalRole;
  content: ContentBlock[];
  name?: string;
  toolCallId?: string;
  createdAt?: string;
}

/**
 * Callable client function or open-ended provider/server tool definition.
 * Server tool kinds and versions evolve too quickly for a closed union, so
 * unstable tool configuration is retained in providerParameters/extensions.
 */
export type ToolDefinition =
  | {
      kind: "function";
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      strict?: boolean;
      cacheBreakpoint?: { ttl?: string };
    }
  | {
      kind: "server";
      serverType: string;
      name?: string;
      serverName?: string;
      providerParameters?: Record<string, JsonValue>;
      cacheBreakpoint?: { ttl?: string };
    };

/** Tool-selection policy shared by canonical protocols. */
export type ToolChoice =
  | { mode: "auto" | "none" | "required" }
  | { mode: "named"; name: string }
  | { mode: "allowed"; names: string[]; allowRequired?: boolean };

/**
 * One remote MCP connection, modeled at request level despite different wire
 * placements. Adapters map it to their protocol; validation never resolves or
 * transmits authorizationToken and never performs network I/O.
 */
export interface McpServerConnection {
  name: string;
  url: string;
  authorizationToken?: string;
  headers?: Record<string, string>;
  toolsEnabled?: boolean;
  allowedTools?: string[];
  requireApproval?: "always" | "never" | { toolNames: string[] };
}

/** Canonical reasoning mode. */
export type ReasoningMode = "disabled" | "adaptive" | "enabled";
/** Requested visibility of reasoning content. */
export type ThinkingDisplay =
  "summarized" | "omitted" | "auto" | "concise" | "detailed";

/**
 * Reasoning controls. Manual budgets remain available for older models;
 * persistAcrossTurns has no stateless-protocol equivalent. Requested encrypted
 * content is distinct from model-initiated redacted thinking.
 */
export interface ReasoningRequest {
  mode: ReasoningMode;
  budgetTokens?: number;
  display?: ThinkingDisplay;
  persistAcrossTurns?: "current_turn" | "all_turns";
  requestEncryptedContent?: boolean;
  providerParameters?: Record<string, JsonValue>;
}

/**
 * Per-choice reasoning accounting/configuration echo. Reasoning content itself
 * stays in ordered ContentBlocks so interleaving with tools and text is retained.
 */
export interface ReasoningResponse {
  mode: ReasoningMode;
  display?: ThinkingDisplay;
  effort?: "none" | "low" | "medium" | "high" | "max";
  thinkingTokens?: number;
  context?: "current_turn" | "all_turns";
}

/**
 * Output controls. Effort governs reasoning depth independently from verbosity;
 * provider-only values remain in providerParameters until portable.
 */
export interface OutputConfiguration {
  effort?: "none" | "low" | "medium" | "high" | "max";
  verbosity?: "low" | "medium" | "high";
  format?: "text" | "json_object" | "json_schema";
  jsonSchema?: {
    name?: string;
    description?: string;
    schema: Record<string, JsonValue>;
    strict?: boolean;
  };
  logprobs?: { enabled: boolean; topLogprobs?: number };
  providerParameters?: Record<string, JsonValue>;
}

/** Portable and protocol-specific sampling controls. */
export interface SamplingParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  maxTokens?: number;
  stop?: string | string[];
  n?: number;
}

/** Routing policy constraints; this object carries no resolved credential. */
export interface RoutingConstraints {
  modelAlias?: string;
  requiredCapabilities?: Capability[];
  preferredProviders?: string[];
  excludedProviders?: string[];
  overrideRoute?: string;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  dryRun?: boolean;
}

/** Service-tier request and retained provider parameters. */
export interface ServiceTierConfiguration {
  tier: "auto" | "standard_only" | "standard" | "priority" | "batch";
  providerParameters?: Record<string, JsonValue>;
}

/**
 * Link to provider-managed conversation state. Stateless adapters must resolve
 * it to message history before translation rather than silently passing it on.
 */
export interface ConversationLink {
  previousResponseId?: string;
  conversationId?: string;
}

/** Provider persistence and zero-data-retention preferences. */
export interface PersistenceOptions {
  store?: boolean;
  zeroDataRetention?: boolean;
}

/**
 * Synchronous, background, or batch-member execution. These represent distinct
 * lifecycle shapes rather than aliases for a synchronous request.
 */
export interface ExecutionOptions {
  mode: "sync" | "background" | "batch_member";
  callbackUrl?: string;
}

/** Streaming usage and resumability options. */
export interface StreamOptions {
  includeUsage?: boolean;
  resumeFrom?: string;
}

/**
 * Transport-free request snapshot. Its owned values are independent of
 * cancellation; unknown protocol/provider data stays in extension bags.
 */
export interface CanonicalRequest {
  requestId: string;
  receivedAt: string;
  source: {
    adapter: string;
    protocol:
      "openai-chat" | "openai-responses" | "anthropic-messages" | "custom";
    path: string;
  };
  model: string;
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  mcpServers?: McpServerConnection[];
  sampling?: SamplingParameters;
  reasoning?: ReasoningRequest;
  output?: OutputConfiguration;
  serviceTier?: ServiceTierConfiguration;
  conversation?: ConversationLink;
  persistence?: PersistenceOptions;
  execution?: ExecutionOptions;
  routing: RoutingConstraints;
  stream: boolean;
  streamOptions?: StreamOptions;
  metadata?: Record<string, JsonValue>;
  extensions?: ExtensionParameters;
}

/** Token accounting across modalities, caching, and server tools. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteBreakdown?: { ttlSeconds: number; tokens: number }[];
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
  serverToolUsage?: Record<string, number>;
}

/** USD cost components for a completed or partial response. */
export interface CostMetrics {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  currency: "USD";
}

/** Provider execution metadata and original response-header casing. */
export interface ProviderMetadata {
  providerId: string;
  credentialId: string;
  physicalModel: string;
  responseHeaders: Record<string, string>;
  upstreamStatus: number;
}

/** Log probability for one output token and its alternatives. */
export interface TokenLogprob {
  token: string;
  logprob: number;
  bytes?: number[];
  topAlternatives?: { token: string; logprob: number; bytes?: number[] }[];
}

/** Canonical terminal reason for one response choice. */
export type FinishReason =
  | "stop"
  | "max_tokens"
  | "stop_sequence"
  | "tool_calls"
  | "pause_turn"
  | "refusal"
  | "content_filter"
  | "incomplete"
  | "cancelled"
  | "error";

/** Lifecycle status shared by responses, jobs, and batches. */
export type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

/** One independently generated response choice with ordered output. */
export interface CanonicalChoice {
  index: number;
  output: ContentBlock[];
  reasoning?: ReasoningResponse;
  finishReason: FinishReason;
  stopSequence?: string;
  logprobs?: TokenLogprob[];
}

/**
 * Cancellation-independent response snapshot. Choices own ordered content and
 * retain unknown protocol/provider data without resolving secrets or doing I/O.
 */
export interface CanonicalResponse {
  requestId: string;
  responseId: string;
  createdAt: string;
  model: string;
  status: ResponseStatus;
  choices: CanonicalChoice[];
  usage: TokenUsage;
  cost: CostMetrics;
  provider: ProviderMetadata;
  error?: GatewayError;
  extensions?: ExtensionParameters;
}

/** Stable address of streamed content in a choice. */
export interface ChunkAddress {
  choiceIndex?: number;
  outputIndex: number;
  contentIndex?: number;
}

/**
 * Ordered lifecycle event emitted by a canonical stream. Chunk snapshots own
 * their values independently of cancellation and preserve sequence/address data.
 */
export type CanonicalChunk =
  | {
      type: "response_start";
      responseId: string;
      model: string;
      createdAt: string;
      sequenceNumber?: number;
    }
  | {
      type: "content_block_start";
      address: ChunkAddress;
      block: {
        type: ContentBlock["type"];
        id?: string;
        name?: string;
        toolKind?: string;
        serverName?: string;
      };
      sequenceNumber?: number;
    }
  | {
      type: "text_delta";
      address: ChunkAddress;
      text: string;
      sequenceNumber?: number;
    }
  | {
      type: "refusal_delta";
      address: ChunkAddress;
      text: string;
      sequenceNumber?: number;
    }
  | {
      type: "reasoning_delta";
      address: ChunkAddress;
      text?: string;
      signatureDelta?: string;
      redactedDataDelta?: string;
      encryptedContentDelta?: string;
      sequenceNumber?: number;
    }
  | {
      type: "audio_delta";
      address: ChunkAddress;
      audioBase64?: string;
      transcriptDelta?: string;
      sequenceNumber?: number;
    }
  | {
      type: "tool_call_delta";
      address: ChunkAddress;
      id?: string;
      name?: string;
      argumentsDelta?: string;
      sequenceNumber?: number;
    }
  | {
      type: "citation_added";
      address: ChunkAddress;
      citation: Citation;
      sequenceNumber?: number;
    }
  | {
      type: "content_block_stop";
      address: ChunkAddress;
      block?: ContentBlock;
      sequenceNumber?: number;
    }
  | {
      type: "usage";
      usage: TokenUsage;
      cost?: CostMetrics;
      sequenceNumber?: number;
    }
  | {
      type: "choice_end";
      choiceIndex?: number;
      finishReason: FinishReason;
      stopSequence?: string;
      sequenceNumber?: number;
    }
  | { type: "response_end"; status: ResponseStatus; sequenceNumber?: number }
  | { type: "ping" }
  | { type: "error"; error: GatewayError; sequenceNumber?: number };

/** Safe gateway error contract; details must not contain secrets. */
export interface GatewayError {
  code: string;
  message: string;
  category:
    | "validation"
    | "authentication"
    | "authorization"
    | "rate_limit"
    | "upstream"
    | "timeout"
    | "routing"
    | "internal";
  retryable: boolean;
  retryAfterMs?: number;
  status: number;
  requestId: string;
  providerId?: string;
  credentialId?: string;
  details?: Record<string, unknown>;
}

/** Lossless fields belonging to a source protocol. */
export interface ProtocolParameterSet {
  protocol:
    "openai-chat" | "openai-responses" | "anthropic-messages" | "custom";
  body: Record<string, JsonValue>;
  headers: Record<string, string>;
  sourceFields: ReadonlyArray<string>;
}
/** Lossless fields belonging to a target provider. */
export interface ProviderParameterSet {
  provider: string;
  body: Record<string, JsonValue>;
  headers: Record<string, string>;
}
/**
 * Lossless extension bags. Unknown values, including explicit null, are owned
 * boundary data and are retained without network I/O or secret resolution.
 */
export interface ExtensionParameters {
  protocols?: Record<string, ProtocolParameterSet>;
  providers?: Record<string, ProviderParameterSet>;
  custom?: Record<string, JsonValue>;
}

/** Cancellation-independent snapshot of asynchronous request execution. */
export interface CanonicalJob {
  jobId: string;
  status: ResponseStatus;
  createdAt: string;
  completedAt?: string;
  request: CanonicalRequest;
  result?: CanonicalResponse;
  error?: GatewayError;
  callbackUrl?: string;
  streamResumeCursor?: string;
}

/**
 * Many canonical requests submitted under one opaque batch identifier, shared
 * by vendor batch surfaces without changing the canonical request shape.
 */
export interface CanonicalBatchSubmission {
  batchId: string;
  items: { customId: string; request: CanonicalRequest }[];
}
/** Retrieved results for a canonical batch submission. */
export interface CanonicalBatchResult {
  batchId: string;
  status: ResponseStatus;
  results: {
    customId: string;
    response?: CanonicalResponse;
    error?: GatewayError;
  }[];
}
