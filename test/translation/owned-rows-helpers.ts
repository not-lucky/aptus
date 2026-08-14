/**
 * Shared fixtures for the owned-rows suites: the six directed translation
 * paths, one minimal source body per protocol, one coordinator round-trip
 * helper, and the minimal IR request builder.
 */
import type { JsonObject, Protocol } from "../../src/domain/contracts.ts";
import type { TranslationCoordinator } from "../../src/translation/contracts.ts";
import type { IrRequest } from "../../src/translation/ir.ts";

/**
 * One direction/tier test per owned plain-text complete capability row.
 * Directions use the fixed [C→R, C→M, R→C, R→M, M→C, M→R] order.
 */
export const ALL_DIRECTIONS: ReadonlyArray<readonly [Protocol, Protocol]> = [
  ["openai-chat", "openai-responses"],
  ["openai-chat", "anthropic-messages"],
  ["openai-responses", "openai-chat"],
  ["openai-responses", "anthropic-messages"],
  ["anthropic-messages", "openai-chat"],
  ["anthropic-messages", "openai-responses"],
];

export function sourceBodyFor(protocol: Protocol): JsonObject {
  if (protocol === "openai-chat") {
    return { model: "wire-model", messages: [{ role: "user", content: "Hello!" }] };
  }
  if (protocol === "openai-responses") {
    return { model: "wire-model", input: "Hello!" };
  }
  return { model: "wire-model", max_tokens: 1024, messages: [{ role: "user", content: "Hello!" }] };
}

export function translateRequest(
  coordinator: TranslationCoordinator,
  source: Protocol,
  target: Protocol,
  body: JsonObject,
) {
  return coordinator.translateCompleteRequest({
    sourceProtocol: source,
    targetProtocol: target,
    sourceBody: body,
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: target === "anthropic-messages" ? 2048 : undefined,
  });
}

export function irBase(): IrRequest {
  return {
    model: "logical-key",
    delivery: "complete",
    items: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello!" }] }],
  };
}
