import type { CanonicalResponse } from "./canonical.js";
import { validateContentBlock } from "./validation.js";

/** Checks bounded canonical response fields before cached data is returned. */
export function isSafeCanonicalResponse(
  value: unknown,
  requestId?: string,
): value is CanonicalResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<CanonicalResponse>;
  const statuses: Readonly<Record<string, true>> = {
    queued: true,
    in_progress: true,
    completed: true,
    incomplete: true,
    failed: true,
    cancelled: true,
  };
  const finiteNonNegative = (number: unknown): number is number =>
    typeof number === "number" && Number.isFinite(number) && number >= 0;
  return (
    typeof response.requestId === "string" &&
    (requestId === undefined || response.requestId === requestId) &&
    typeof response.responseId === "string" &&
    typeof response.createdAt === "string" &&
    typeof response.model === "string" &&
    typeof response.status === "string" &&
    statuses[response.status] === true &&
    Array.isArray(response.choices) &&
    response.choices.every((choice) =>
      typeof choice === "object" &&
      choice !== null &&
      Number.isSafeInteger(choice.index) &&
      choice.index >= 0 &&
      Array.isArray(choice.output) &&
      choice.output.every((block, index) =>
        validateContentBlock(block, `choices[${choice.index}].output[${index}]`).valid,
      ) &&
      typeof choice.finishReason === "string",
    ) &&
    typeof response.usage === "object" &&
    response.usage !== null &&
    finiteNonNegative(response.usage.inputTokens) &&
    finiteNonNegative(response.usage.outputTokens) &&
    finiteNonNegative(response.usage.totalTokens) &&
    typeof response.cost === "object" &&
    response.cost !== null &&
    finiteNonNegative(response.cost.inputUsd) &&
    finiteNonNegative(response.cost.outputUsd) &&
    finiteNonNegative(response.cost.cacheReadUsd) &&
    finiteNonNegative(response.cost.cacheWriteUsd) &&
    finiteNonNegative(response.cost.totalUsd) &&
    response.cost.currency === "USD" &&
    typeof response.provider === "object" &&
    response.provider !== null &&
    typeof response.provider.providerId === "string" &&
    typeof response.provider.credentialId === "string" &&
    typeof response.provider.physicalModel === "string" &&
    Number.isInteger(response.provider.upstreamStatus) &&
    response.provider.upstreamStatus >= 100 &&
    response.provider.upstreamStatus <= 599
  );
}
