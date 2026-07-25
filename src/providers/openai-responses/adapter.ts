import type { AttemptObservation, JsonObject, ModelListInput, ProtocolAdapter } from "../../domain/contracts.js";
import type { IrFailureCategory } from "../../domain/operations.js";
import { parseRetryAfter } from "../shared/headers.js";
import { createNativeAdapter } from "../shared/native.js";

/**
 * Creates the OpenAI Responses {@link ProtocolAdapter}.
 *
 * This adapter owns only Responses wire facts: the create path, Bearer auth,
 * the Responses status table, and the OpenAI model-list envelope. Model
 * reading, mutation, header filtering, and encoding are shared native behavior.
 *
 * @returns A fully implemented Responses adapter.
 */
export function createResponsesAdapter(): ProtocolAdapter {
  return createNativeAdapter({
    protocol: "openai-responses",
    createPath: "/responses",
    createAuth: (secret) => ({ name: "authorization", value: `Bearer ${secret}` }),
    classify: classifyResponses,
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
 * Maps an OpenAI Responses response head into a normalized attempt observation.
 * Runs before any client bytes, so `beforeClientBytes` is always `true`.
 *
 * @param status - The HTTP response status code.
 * @param retryAfter - The raw `Retry-After` header value if present.
 * @returns An {@link AttemptObservation} classified according to protocol mapping rules.
 */
export function classifyResponses(status: number, retryAfter?: string): AttemptObservation {
  if (status >= 200 && status < 300) return { result: "success", status, beforeClientBytes: true };
  if (status === 429) {
    return { result: "rate_limit", status, retryDelayMs: parseRetryAfter(retryAfter), beforeClientBytes: true };
  }
  const category: IrFailureCategory | undefined =
    status === 401
      ? "authentication"
      : status === 403
        ? "permission"
        : status === 400 || status === 422
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
