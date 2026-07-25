/**
 * Pinned test fixtures for OpenAI Responses.
 *
 * Grounded in official research snapshot `research/openai-responses-api.md`
 * (retrieved 2026-08-11).
 */

const encoder = new TextEncoder();

/**
 * Pinned canonical minimal request body for OpenAI Responses.
 * Source snapshot: `research/openai-responses-api.md` (retrieved 2026-08-11).
 */
export const MINIMAL_RESPONSES_REQUEST = {
  model: "responses-main",
  input: "Tell me a three sentence bedtime story about a unicorn.",
};

/**
 * Pinned complete `response` object with usage, output items, and an unknown field
 * (relayed byte-exact on the native path).
 */
export const COMPLETE_RESPONSES_BODY = {
  id: "resp_01abc123",
  object: "response",
  status: "completed",
  model: "gpt-5.4",
  output: [
    {
      type: "message",
      id: "msg_01",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Once upon a time in a starlit glade, a tiny unicorn learned to gallop across rainbows.",
        },
      ],
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 24,
    total_tokens: 36,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  unknown_custom_field: { preserved: true },
};

export const COMPLETE_RESPONSES_BYTES = encoder.encode(JSON.stringify(COMPLETE_RESPONSES_BODY));

/**
 * Pinned SSE byte stream for OpenAI Responses.
 * Preserves named events, sequence_number, unknown events, and terminal response.completed.
 * Explicitly does NOT end in `data: [DONE]`.
 */
export const SSE_RESPONSES_BYTES = encoder.encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01abc123","status":"in_progress"},"sequence_number":1}',
    "",
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_01"},"sequence_number":2}',
    "",
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from Responses","sequence_number":3}',
    "",
    'event: response.unknown_event\ndata: {"type":"response.unknown_event","info":"custom","sequence_number":4}',
    "",
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":5}',
    "",
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_01abc123","status":"completed","usage":{"input_tokens":12,"output_tokens":24,"total_tokens":36}},"sequence_number":6}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned failed SSE stream bytes for OpenAI Responses (`response.failed` terminal).
 */
export const SSE_RESPONSES_FAILED_BYTES = encoder.encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01fail","status":"in_progress"},"sequence_number":1}',
    "",
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_01fail","status":"failed","error":{"code":"server_error","message":"failed"}},"sequence_number":2}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned incomplete SSE stream bytes for OpenAI Responses (`response.incomplete` terminal).
 */
export const SSE_RESPONSES_INCOMPLETE_BYTES = encoder.encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01incomp","status":"in_progress"},"sequence_number":1}',
    "",
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_01incomp","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}},"sequence_number":2}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned in-band error SSE stream bytes for OpenAI Responses (`error` terminal).
 */
export const SSE_RESPONSES_ERROR_BYTES = encoder.encode(
  [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01err","status":"in_progress"},"sequence_number":1}',
    "",
    'event: error\ndata: {"type":"error","code":"server_error","message":"internal server error"}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned HTTP error body for terminal non-2xx native passthrough.
 */
export const ERROR_RESPONSES_BODY =
  '{"error":{"message":"Invalid input","type":"invalid_request_error","param":null,"code":null}}';

export const ERROR_RESPONSES_BYTES = encoder.encode(ERROR_RESPONSES_BODY);
