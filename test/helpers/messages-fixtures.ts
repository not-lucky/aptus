/**
 * Pinned test fixtures for Anthropic Messages.
 *
 * Grounded in official research snapshot `research/anthropic-messages-api.md`
 * (retrieved 2026-08-11).
 */

const encoder = new TextEncoder();

/**
 * Pinned canonical minimal request body for Anthropic Messages.
 * Source snapshot: `research/anthropic-messages-api.md` (retrieved 2026-08-11).
 */
export const MINIMAL_MESSAGES_REQUEST = {
  model: "claude-main",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello, Claude" }],
};

/**
 * Pinned complete `message` response object with usage, content blocks, and an unknown field
 * (relayed byte-exact on the native path).
 */
export const COMPLETE_MESSAGES_BODY = {
  id: "msg_013Zva2CMHLNnXjNJJKqJ2EF",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-1",
  content: [{ type: "text", text: "Hello from Messages" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 25,
    output_tokens: 15,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  unknown_custom_field: { preserved: true },
};

export const COMPLETE_MESSAGES_BYTES = encoder.encode(JSON.stringify(COMPLETE_MESSAGES_BODY));

/**
 * Pinned SSE byte stream for Anthropic Messages.
 * Preserves message_start, content_block_start, ping, content_block_delta (text and input_json_delta),
 * content_block_stop, custom_native_event, message_delta (with cumulative usage), and message_stop.
 * Explicitly does NOT append a forged terminator.
 */
export const SSE_MESSAGES_BYTES = encoder.encode(
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_013Zva2CMHLNnXjNJJKqJ2EF","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}',
    "",
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: ping\ndata: {"type":"ping"}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    "",
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    "",
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather","input":{}}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":"}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"San Francisco\\"}"}}',
    "",
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    "",
    'event: custom_native_event\ndata: {"type":"custom_native_event","custom_data":true}',
    "",
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}',
    "",
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned post-200 in-band stream error for Anthropic Messages.
 */
export const SSE_MESSAGES_POST200_ERROR_BYTES = encoder.encode(
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","content":[],"model":"claude-opus-4-1"}}',
    "",
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "",
    "",
  ].join("\n"),
);

/**
 * Pinned HTTP error body for terminal non-2xx native passthrough.
 */
export const ERROR_MESSAGES_BODY =
  '{"type":"error","error":{"type":"not_found_error","message":"The requested resource could not be found."},"request_id":"req_011CSHoEeqs5C35K2UUqR7Fy"}';

export const ERROR_MESSAGES_BYTES = encoder.encode(ERROR_MESSAGES_BODY);
