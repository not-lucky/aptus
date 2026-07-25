import type { AttemptObservation, JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.js";
import type { IrFailureCategory } from "../../domain/operations.js";
import { parseRetryAfter } from "../shared/headers.js";
import { createNativeAdapter } from "../shared/native.js";

/**
 * Creates the OpenAI Chat Completions {@link ProtocolAdapter}.
 *
 * This adapter owns only Chat wire facts: the create path, Bearer auth, the
 * Chat status table, and the OpenAI model-list envelope. Model reading,
 * mutation, header filtering, and encoding are shared native behavior.
 *
 * @returns A fully implemented Chat adapter.
 */
export function createChatAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "openai-chat",
    createPath: "/chat/completions",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
    classify: classifyChat,
    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        ...entry.metadata,
        id: entry.id,
        object: "model",
      }));
      return { object: "list", data };
    },
  });
}

/**
 * Maps a Chat response head into a normalized attempt observation. Runs before
 * any client bytes, so `beforeClientBytes` is always `true`.
 */
export function classifyChat(status: number, retryAfter?: string): AttemptObservation {
  if (status >= 200 && status < 300) return { result: "success", status, beforeClientBytes: true };
  if (status === 429) {
    return { result: "rate_limit", status, retryDelayMs: parseRetryAfter(retryAfter), beforeClientBytes: true };
  }
  const category: IrFailureCategory | undefined =
    status === 401
      ? "authentication"
      : status === 403
        ? "permission"
        : status === 400
          ? "invalid_request"
          : status === 404
            ? "not_found"
            : status === 409
              ? "conflict"
              : status === 413
                ? "payload_too_large"
                : status === 422
                  ? "invalid_request"
                  : status === 408 || status === 504
                    ? "timeout"
                    : status === 500 || status === 503 || status === 529
                      ? "unavailable"
                      : undefined;
  return { result: category ?? "provider", status, beforeClientBytes: true };
}
