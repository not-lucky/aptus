import type {
  CanonicalBatchResult,
  CanonicalBatchSubmission,
  CanonicalChunk,
  CanonicalJob,
  CanonicalRequest,
  CanonicalResponse,
  Capability,
  ContentBlock,
  ExtensionParameters,
  GatewayError,
  ProtocolParameterSet,
  ToolDefinition,
} from "../../src/domain/index.js";

const content: ContentBlock[] = [
  {
    type: "text",
    text: "answer",
    citations: [{ kind: "url", url: "https://example.test", raw: null }],
  },
  { type: "refusal", refusal: "no" },
  { type: "image_url", url: "https://example.test/image", detail: "high" },
  { type: "image_base64", mediaType: "image/png", data: "aGVsbG8=" },
  {
    type: "generated_image",
    mediaType: "image/png",
    data: "aGVsbG8=",
    revisedPrompt: "safe",
    size: "1x1",
    background: "transparent",
  },
  { type: "audio_url", url: "https://example.test/audio", format: "wav" },
  { type: "audio_base64", mediaType: "audio/wav", data: "aGVsbG8=" },
  {
    type: "audio_output",
    mediaType: "audio/wav",
    transcript: "hello",
    expiresAt: "2026-07-19T00:00:00Z",
  },
  {
    type: "document_url",
    url: "https://example.test/doc",
    mediaType: "application/pdf",
    title: "doc",
    citationsEnabled: true,
  },
  {
    type: "document_base64",
    mediaType: "application/pdf",
    data: "aGVsbG8=",
    title: "doc",
    citationsEnabled: true,
  },
  {
    type: "file_reference",
    fileId: "file-1",
    mediaType: "text/plain",
    filename: "a.txt",
  },
  {
    type: "search_result",
    sourceId: "source-1",
    title: "result",
    text: "body",
    citationsEnabled: true,
  },
  {
    type: "reasoning",
    text: "think",
    signature: "sig",
    redactedData: "redacted",
    encryptedContent: "encrypted",
  },
  {
    type: "tool_call",
    toolCallId: "call-1",
    name: "lookup",
    argumentsJson: '{"q":"x"}',
    caller: "model",
  },
  {
    type: "tool_result",
    toolCallId: "call-1",
    content: [{ type: "text", text: "found" }],
  },
  {
    type: "server_tool_call",
    toolCallId: "call-2",
    toolKind: "future_search",
    name: "search",
    serverName: "mcp",
    input: { q: null },
    argumentsJson: "{}",
    caller: "program",
  },
  {
    type: "server_tool_result",
    toolCallId: "call-2",
    toolKind: "future_search",
    content: [
      {
        type: "tool_result",
        toolCallId: "nested",
        content: [{ type: "text", text: "nested" }],
      },
    ],
  },
  {
    type: "tool_approval_request",
    toolCallId: "call-3",
    toolKind: "computer",
    reason: "confirm",
  },
  { type: "tool_approval_response", toolCallId: "call-3", approved: true },
];

const tools: ToolDefinition[] = [
  {
    kind: "function",
    name: "lookup",
    description: "Lookup",
    inputSchema: { type: "object" },
    strict: true,
    cacheBreakpoint: { ttl: "5m" },
  },
  {
    kind: "server",
    serverType: "future_tool_20990101",
    name: "future",
    serverName: "remote",
    providerParameters: { unknown: null },
  },
];

const extensions: ExtensionParameters = {
  protocols: {
    "openai-chat": {
      protocol: "openai-chat",
      body: { unknown: null, nested: [1, "x", true] },
      headers: { "X-Original-Case": "value" },
      sourceFields: ["body.unknown"],
    },
  },
  providers: {
    future: {
      provider: "provider-2099",
      body: { mode: "new" },
      headers: { "X-Future": "1" },
    },
  },
  custom: { explicitNull: null },
};

const capability: Capability = "provider-capability-2099";
const request: CanonicalRequest = {
  requestId: "req_1",
  receivedAt: "2026-07-19T00:00:00Z",
  source: { adapter: "edge", protocol: "custom", path: "/future/v1/messages" },
  model: "alias-model",
  messages: [
    { role: "developer", content: [{ type: "text", text: "instructions" }] },
    { role: "assistant", content },
  ],
  tools,
  toolChoice: { mode: "allowed", names: ["lookup"], allowRequired: true },
  parallelToolCalls: true,
  mcpServers: [
    {
      name: "remote",
      url: "https://mcp.example.test",
      authorizationToken: "opaque",
      headers: { Authorization: "opaque" },
      toolsEnabled: true,
      allowedTools: ["future"],
      requireApproval: { toolNames: ["future"] },
    },
  ],
  sampling: {
    temperature: 0.2,
    topP: 0.9,
    topK: 10,
    frequencyPenalty: 0,
    presencePenalty: 0,
    seed: 1,
    maxTokens: 100,
    stop: ["stop"],
    n: 2,
  },
  reasoning: {
    mode: "adaptive",
    budgetTokens: 1000,
    display: "omitted",
    persistAcrossTurns: "all_turns",
    requestEncryptedContent: true,
    providerParameters: { future: null },
  },
  output: {
    effort: "max",
    verbosity: "low",
    format: "json_schema",
    jsonSchema: {
      name: "result",
      description: "result",
      schema: { type: "object" },
      strict: true,
    },
    logprobs: { enabled: true, topLogprobs: 3 },
    providerParameters: { future: null },
  },
  serviceTier: { tier: "priority", providerParameters: { lane: "fast" } },
  conversation: { previousResponseId: "resp-0", conversationId: "conv-1" },
  persistence: { store: false, zeroDataRetention: true },
  execution: {
    mode: "background",
    callbackUrl: "https://callback.example.test",
  },
  routing: {
    modelAlias: "alias",
    requiredCapabilities: [capability],
    preferredProviders: ["future"],
    excludedProviders: ["legacy"],
    overrideRoute: "route",
    maxCostUsd: 1,
    maxLatencyMs: 500,
    dryRun: false,
  },
  stream: true,
  streamOptions: { includeUsage: true, resumeFrom: "cursor" },
  metadata: { tenant: "test", explicitNull: null },
  extensions,
};

const error: GatewayError = {
  code: "upstream_error",
  message: "failed",
  category: "upstream",
  retryable: true,
  retryAfterMs: 10,
  status: 502,
  requestId: request.requestId,
  providerId: "future",
  credentialId: "cred",
  details: { safe: true },
};
const response: CanonicalResponse = {
  requestId: request.requestId,
  responseId: "resp-1",
  createdAt: "2026-07-19T00:00:01Z",
  model: "physical-model",
  status: "completed",
  choices: [
    {
      index: 0,
      output: content,
      reasoning: {
        mode: "adaptive",
        display: "omitted",
        effort: "max",
        thinkingTokens: 12,
        context: "all_turns",
      },
      finishReason: "tool_calls",
      stopSequence: "stop",
      logprobs: [
        {
          token: "x",
          logprob: -0.1,
          bytes: [120],
          topAlternatives: [{ token: "y", logprob: -0.2, bytes: [121] }],
        },
      ],
    },
  ],
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 2,
    audioInputTokens: 1,
    audioOutputTokens: 1,
    cachedInputTokens: 3,
    cacheWriteBreakdown: [{ ttlSeconds: 300, tokens: 2 }],
    acceptedPredictionTokens: 1,
    rejectedPredictionTokens: 0,
    serverToolUsage: { future_search: 1 },
  },
  cost: {
    inputUsd: 0.1,
    outputUsd: 0.2,
    cacheReadUsd: 0.01,
    cacheWriteUsd: 0.02,
    totalUsd: 0.33,
    currency: "USD",
  },
  provider: {
    providerId: "future",
    credentialId: "cred",
    physicalModel: "physical-model",
    responseHeaders: { "X-Mixed-Case": "value" },
    upstreamStatus: 200,
  },
  extensions,
};

const chunks: CanonicalChunk[] = [
  {
    type: "response_start",
    responseId: "resp-1",
    model: "model",
    createdAt: "2026-07-19T00:00:01Z",
    sequenceNumber: 1,
  },
  {
    type: "content_block_start",
    address: { choiceIndex: 0, outputIndex: 0, contentIndex: 0 },
    block: {
      type: "tool_call",
      id: "item",
      name: "lookup",
      toolKind: "function",
      serverName: "remote",
    },
    sequenceNumber: 2,
  },
  {
    type: "text_delta",
    address: { outputIndex: 0 },
    text: "x",
    sequenceNumber: 3,
  },
  { type: "refusal_delta", address: { outputIndex: 0 }, text: "no" },
  {
    type: "reasoning_delta",
    address: { outputIndex: 1 },
    text: "think",
    signatureDelta: "sig",
    redactedDataDelta: "redacted",
    encryptedContentDelta: "encrypted",
  },
  {
    type: "audio_delta",
    address: { outputIndex: 2 },
    audioBase64: "aA==",
    transcriptDelta: "h",
  },
  {
    type: "tool_call_delta",
    address: { outputIndex: 3 },
    id: "call",
    name: "tool",
    argumentsDelta: "{}",
  },
  {
    type: "citation_added",
    address: { outputIndex: 0 },
    citation: { kind: "file", sourceId: "file" },
  },
  {
    type: "content_block_stop",
    address: { outputIndex: 0 },
    block: { type: "text", text: "done" },
  },
  { type: "usage", usage: response.usage, cost: response.cost },
  {
    type: "choice_end",
    choiceIndex: 0,
    finishReason: "stop",
    stopSequence: "stop",
  },
  { type: "response_end", status: "completed" },
  { type: "ping" },
  { type: "error", error },
];

const job: CanonicalJob = {
  jobId: "job-1",
  status: "completed",
  createdAt: request.receivedAt,
  completedAt: response.createdAt,
  request,
  result: response,
  error,
  callbackUrl: "https://callback.example.test",
  streamResumeCursor: "cursor",
};
const submission: CanonicalBatchSubmission = {
  batchId: "batch-1",
  items: [{ customId: "item-1", request }],
};
const batchResult: CanonicalBatchResult = {
  batchId: submission.batchId,
  status: "completed",
  results: [
    { customId: "item-1", response },
    { customId: "item-2", error },
  ],
};

const protocolSet: ProtocolParameterSet = extensions.protocols!["openai-chat"]!;
// @ts-expect-error sourceFields is the sole readonly array exception.
protocolSet.sourceFields.push("later");
// Mutable canonical arrays remain mutable.
request.messages.push({
  role: "user",
  content: [{ type: "text", text: "next" }],
});
// @ts-expect-error argumentsJson must be a string, never an object.
const invalidArguments: ContentBlock = {
  type: "tool_call",
  toolCallId: "call",
  name: "tool",
  argumentsJson: {},
};
// @ts-expect-error roles are a closed canonical union.
const invalidRole: CanonicalRequest = {
  ...request,
  messages: [{ role: "admin", content: [] }],
};
// @ts-expect-error response status is closed.
const invalidStatus: CanonicalResponse = { ...response, status: "done" };

void [chunks, job, batchResult, invalidArguments, invalidRole, invalidStatus];
