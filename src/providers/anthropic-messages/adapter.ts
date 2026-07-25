import type { AttemptObservation, JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.js";
import type { IrFailureCategory } from "../../domain/operations.js";
import { parseRetryAfter } from "../shared/headers.js";
import { createNativeAdapter } from "../shared/native.js";

/**
 * Creates the Anthropic Messages {@link ProtocolAdapter}.
 *
 * This adapter owns only Messages wire facts: the create path, `x-api-key`
 * auth, the Messages status table, and the Anthropic model-list envelope.
 * Model reading, mutation, header filtering, and encoding are shared native
 * behavior.
 *
 * @returns A fully implemented Messages adapter.
 */
export function createMessagesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "anthropic-messages",
    createPath: "/v1/messages",
    createAuth: (secret) => ({ name: "x-api-key", value: secret }),
    classify: classifyMessages,
    buildModelList(input: ModelListInput): JsonObject {
      const data: readonly JsonObject[] = input.entries.map((entry) => ({
        ...entry.metadata,
        type: "model",
        id: entry.id,
      }));
      return {
        data,
        has_more: false,
        first_id: input.entries[0]?.id ?? null,
        last_id: input.entries.at(-1)?.id ?? null,
      };
    },
  });
}

/**
 * Maps an Anthropic Messages response head into a normalized attempt observation.
 * Runs before any client bytes, so `beforeClientBytes` is always `true`.
 *
 * @param status - The HTTP response status code.
 * @param retryAfter - The raw `Retry-After` header value if present.
 * @returns An {@link AttemptObservation} classified according to protocol mapping rules.
 */
export function classifyMessages(status: number, retryAfter?: string): AttemptObservation {
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
                : status === 408 || status === 504
                  ? "timeout"
                  : status === 500 || status === 503 || status === 529
                    ? "unavailable"
                    : undefined;
  return { result: category ?? "provider", status, beforeClientBytes: true };
}
