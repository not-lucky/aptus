import type { JsonObject } from "../../../domain/contracts.ts";
import type { NormalizedFailure } from "../../../domain/operations.ts";
import { unsupportedCapabilityFailure } from "../../failures.ts";
import type { MatrixRowId } from "../../matrix.ts";

/**
 * Hosted and provider tool recognition for the six protocol codecs.
 *
 * Every non-admitted hosted or provider tool capability fails closed with its
 * exact matrix row ID. Recognition is keyed by the documented wire spellings
 * per protocol, so request decode and outcome decode reject with the owning
 * row instead of a generic unknown-structure error. Map values are
 * {@link MatrixRowId}s, so a value naming no matrix row fails compilation.
 */

/**
 * R `tools[]` entry types that are hosted or provider capabilities, including
 * the namespace and programmatic-calling meta-tools. Dated variants map to
 * the same row as their GA spelling.
 */
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

/**
 * R output item types (also valid as replayed input items) that are hosted or
 * provider capabilities. `web_search_call` refines on `action.type` and
 * `computer_call`/`computer_call_output` refine on safety-check fields at the
 * call site; every other entry rejects on type alone.
 */
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

/**
 * M `tools[]` entry `type` literals that are server tools, keyed by every
 * dated variant documented for the tool family.
 */
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

/**
 * M `server_tool_use` names and their owning hosted rows. Unknown or missing
 * names fail closed as unknown content at the call site.
 */
export const MESSAGES_SERVER_TOOL_USE_NAMES: Readonly<Record<string, MatrixRowId>> = {
  web_search: "hosted-web-search",
  web_fetch: "hosted-web-fetch",
  code_execution: "hosted-code-execution",
  bash_code_execution: "hosted-shell",
  text_editor_code_execution: "hosted-text-editor",
  tool_search_tool_bm25: "hosted-tool-search",
  tool_search_tool_regex: "hosted-tool-search",
};

/**
 * M content block types (request user blocks and response blocks) that are
 * hosted or provider capabilities. `server_tool_use` is resolved through
 * {@link MESSAGES_SERVER_TOOL_USE_NAMES} instead.
 */
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
 * Recursively detects hosted tool result encryption markers (`encrypted_content`,
 * `encrypted_stdout`) anywhere inside a decoded wire value. Encrypted payloads
 * are provider-opaque and can never be translated, so any marker fails closed
 * with `hosted-tool-result-encryption`.
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
 * The `hosted-tool-result-encryption` failure when a decoded wire value carries
 * an encryption marker anywhere inside it; `undefined` otherwise. Every wire
 * container that can hold a hosted tool result calls this before any other
 * recognition so a marker never passes as translatable content.
 */
export function encryptedContentFailure(value: unknown): NormalizedFailure | undefined {
  if (!containsEncryptedToolContent(value)) return undefined;
  return unsupportedCapabilityFailure("hosted-tool-result-encryption");
}

/**
 * Failure for a provider-owned Responses reasoning output item: encrypted
 * content maps to `encrypted-reasoning`, readable reasoning parts to
 * `readable-reasoning`. Shared by every R discovery site (request input item,
 * complete outcome output item, stream item events, terminal response scan).
 */
export function responsesReasoningItemFailure(item: Record<string, unknown>): NormalizedFailure {
  return unsupportedCapabilityFailure(
    item.encrypted_content !== undefined ? "encrypted-reasoning" : "readable-reasoning",
  );
}

/**
 * Parses a function call's wire argument text exactly once: a successful parse
 * to a non-null, non-array JSON object becomes the IR `arguments` field; any
 * other outcome leaves `arguments` undefined so the raw text stays observable
 * (`invalid-function-json` never fabricates or normalizes).
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
