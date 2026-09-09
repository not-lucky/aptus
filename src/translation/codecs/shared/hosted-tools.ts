/**
 * @fileoverview Recognition tables and helpers for hosted and provider-specific capabilities.
 *
 * Maps provider tool types, server tools, and output items (web search, code execution, computer use,
 * etc.) onto matrix capability identifiers for fail-closed rejection during cross-protocol translation.
 *
 * Shared across OpenAI Chat, OpenAI Responses, and Anthropic Messages ingress/egress codecs to ensure
 * unsupported native capabilities fail closed with their documented capability row rather than generic errors.
 */

import type { JsonObject } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import { unsupportedCapabilityFailure } from "../../failures.ts";
import type { MatrixRowId } from "../../matrix.ts";

/** Responses `tools[]` entry types that correspond to hosted or provider capabilities. */
export const RESPONSES_HOSTED_TOOL_TYPES: Readonly<Record<string, MatrixRowId>> = {
  web_search: "hosted-web-search",
  web_search_2025_08_26: "hosted-web-search",
  web_search_preview: "hosted-web-search-preview",
  web_search_preview_2025_03_11: "hosted-web-search-preview",
  file_search: "hosted-file-search",
  computer: "hosted-computer-use",
  computer_use_preview: "hosted-computer-use-preview",
  code_interpreter: "hosted-code-execution",
  image_generation: "hosted-image-generation",
  mcp: "hosted-mcp",
  tool_search: "hosted-tool-search",
  local_shell: "hosted-local-shell-preview",
  shell: "hosted-shell",
  apply_patch: "hosted-apply-patch",
  namespace: "tool-namespaces",
  programmatic_tool_calling: "programmatic-tools",
};

/** Responses output item types representing hosted or provider capabilities. */
export const RESPONSES_HOSTED_OUTPUT_ITEMS: Readonly<Record<string, MatrixRowId>> = {
  file_search_call: "hosted-file-search",
  code_interpreter_call: "hosted-code-execution",
  image_generation_call: "hosted-image-generation",
  mcp_call: "hosted-mcp",
  mcp_list_tools: "hosted-mcp",
  mcp_approval_request: "hosted-mcp",
  mcp_approval_response: "hosted-mcp",
  tool_search_call: "hosted-tool-search",
  tool_search_output: "hosted-tool-search",
  local_shell_call: "hosted-local-shell-preview",
  local_shell_call_output: "hosted-local-shell-preview",
  shell_call: "hosted-shell",
  shell_call_output: "hosted-shell",
  apply_patch_call: "hosted-apply-patch",
  apply_patch_call_output: "hosted-apply-patch",
  program: "programmatic-tools",
  program_output: "programmatic-tools",
  additional_tools: "programmatic-tools",
  compaction: "responses-compaction",
  compaction_trigger: "responses-compaction",
};

/** Messages `tools[]` entry types for server tools across all documented dated variants. */
export const MESSAGES_HOSTED_TOOL_TYPES: Readonly<Record<string, MatrixRowId>> = {
  web_search_20250305: "hosted-web-search",
  web_search_20260209: "hosted-web-search",
  web_search_20260318: "hosted-web-search",
  web_fetch_20250910: "hosted-web-fetch",
  web_fetch_20260209: "hosted-web-fetch",
  web_fetch_20260309: "hosted-web-fetch",
  web_fetch_20260318: "hosted-web-fetch",
  code_execution_20250522: "hosted-code-execution",
  code_execution_20250825: "hosted-code-execution",
  code_execution_20260120: "hosted-code-execution",
  code_execution_20260521: "hosted-code-execution",
  bash_20250124: "hosted-shell",
  text_editor_20250124: "hosted-text-editor",
  text_editor_20250429: "hosted-text-editor",
  text_editor_20250728: "hosted-text-editor",
  memory_20250818: "hosted-memory",
  tool_search_tool_bm25_20251119: "hosted-tool-search",
  tool_search_tool_bm25: "hosted-tool-search",
  tool_search_tool_regex_20251119: "hosted-tool-search",
  tool_search_tool_regex: "hosted-tool-search",
};

/** Messages `server_tool_use` tool names mapped to their owning capability rows. */
export const MESSAGES_SERVER_TOOL_USE_NAMES: Readonly<Record<string, MatrixRowId>> = {
  web_search: "hosted-web-search",
  web_fetch: "hosted-web-fetch",
  code_execution: "hosted-code-execution",
  bash_code_execution: "hosted-shell",
  text_editor_code_execution: "hosted-text-editor",
  tool_search_tool_bm25: "hosted-tool-search",
  tool_search_tool_regex: "hosted-tool-search",
};

/** Messages content block types representing hosted or provider capabilities. */
export const MESSAGES_HOSTED_BLOCK_TYPES: Readonly<Record<string, MatrixRowId>> = {
  web_search_tool_result: "hosted-web-search",
  web_fetch_tool_result: "hosted-web-fetch",
  code_execution_tool_result: "hosted-code-execution",
  bash_code_execution_tool_result: "hosted-shell",
  text_editor_code_execution_tool_result: "hosted-text-editor",
  tool_search_tool_result: "hosted-tool-search",
  search_result: "hosted-web-search",
  tool_reference: "deferred-tools",
  container_upload: "provider-container",
};

/**
 * Recursively detects hosted tool result encryption markers (`encrypted_content`, `encrypted_stdout`).
 *
 * @param value - Decoded JSON payload to scan.
 * @returns `true` if any encryption marker key is found at any depth, `false` otherwise.
 */
export function containsEncryptedToolContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsEncryptedToolContent);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "encrypted_content" || key === "encrypted_stdout" || containsEncryptedToolContent(entry)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns a `hosted-tool-result-encryption` failure if the value contains encryption markers.
 *
 * @param value - Decoded JSON value to scan.
 * @returns NormalizedFailure if encryption markers are present, otherwise `undefined`.
 */
export function encryptedContentFailure(value: unknown): NormalizedFailure | undefined {
  if (!containsEncryptedToolContent(value)) return undefined;
  return unsupportedCapabilityFailure("hosted-tool-result-encryption");
}

/**
 * Constructs a capability failure for a Responses reasoning output item.
 * Distinguishes encrypted reasoning from readable reasoning items.
 *
 * @param item - Decoded reasoning item object.
 * @returns NormalizedFailure with either `encrypted-reasoning` or `readable-reasoning`.
 */
export function responsesReasoningItemFailure(item: Record<string, unknown>): NormalizedFailure {
  return unsupportedCapabilityFailure(
    item.encrypted_content !== undefined ? "encrypted-reasoning" : "readable-reasoning",
  );
}

/**
 * Parses accumulated function call argument JSON text into an object exactly once.
 * Malformed JSON or non-object values yield `undefined`, leaving raw text intact.
 *
 * @param argumentsText - Accumulated JSON argument text.
 * @returns Parsed JSON object, or `undefined` if parsing fails or result is not a plain object.
 */
export function parseFunctionArgumentsOnce(argumentsText: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // Invalid JSON stays text-only; the IR carries argumentsText verbatim.
  }
  return undefined;
}
