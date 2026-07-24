const encoder = new TextEncoder();

/**
 * A pinned complete `chat.completion` response with `usage`, an unknown field,
 * and a `tool_calls` entry (relayed byte-exact on the native path).
 */
export const COMPLETE_CHAT_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1775606400,
  model: "gpt-5.4",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "hello from origin",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  unknown_field: { nested: true },
};

export const COMPLETE_CHAT_BYTES = encoder.encode(JSON.stringify(COMPLETE_CHAT_BODY));

/**
 * A pinned SSE byte stream ending in `data: [DONE]`, carrying a usage chunk and
 * an unknown chunk that the native relay must preserve byte-for-byte.
 */
export const SSE_CHAT_BYTES = encoder.encode(
  [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1775606400,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n"),
);

/**
 * A pinned error body for terminal non-2xx native passthrough.
 */
export const ERROR_BODY = '{"error":{"message":"upstream error","type":"api_error","param":null,"code":null}}';

export const ERROR_BYTES = encoder.encode(ERROR_BODY);
