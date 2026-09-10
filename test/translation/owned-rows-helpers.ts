/**
 * Shared fixtures for the owned-rows suites: the six directed translation
 * paths, one minimal source body per protocol, one coordinator round-trip
 * helper, and the minimal IR request builder.
 */
import { randomUUID } from "node:crypto";
import type { JsonObject, Protocol } from "../../src/domain/contracts.ts";
import type {
  StreamSession,
  StreamSessionBundle,
  StreamWireOptions,
  TranslationCoordinator,
} from "../../src/translation/contracts.ts";
import type { IrRequest } from "../../src/translation/ir.ts";
import { createTranslationCodecs } from "../../src/translation/index.ts";

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
  return coordinator.translateRequest({
    sourceProtocol: source,
    targetProtocol: target,
    sourceBody: body,
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: target === "anthropic-messages" ? 2048 : undefined,
    stream: false,
  });
}

/** Input parameters for building a codec session bundle without a request ticket. */
export interface SessionBundleInput {
  /** Protocol format of the upstream provider stream. */
  readonly sourceProtocol: Protocol;
  /** Protocol format expected by the client stream. */
  readonly targetProtocol: Protocol;
  /** Logical model key stamped on streaming protocol envelopes. */
  readonly logicalModel: string;
  /** Optional response identifier override; generated if omitted. */
  readonly responseId?: string;
  /** Optional factory for part identifiers; defaults to a 16-hex identifier. */
  readonly createPartId?: () => string;
  /** Stream options decoded from a client request, when applicable. */
  readonly sourceWireOptions?: StreamWireOptions;
}

/**
 * Builds a streaming session bundle straight from the codec registry.
 *
 * Test-side counterpart of the coordinator's ticket-bound session construction:
 * pairs a provider stream decoder with a client stream encoder around a shared
 * session identity for codec-level exercises that never run the request pipeline.
 *
 * @param input - Protocols, model identity, and optional identifier overrides.
 * @returns Session bundle holding shared session identity and initialized codecs.
 */
export function createSessionBundle(input: SessionBundleInput): StreamSessionBundle {
  const codecs = createTranslationCodecs();
  const responseId = input.responseId ?? randomUUID();
  const createPartId = input.createPartId ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
  const session: StreamSession = {
    responseId,
    model: input.logicalModel,
    createPartId,
  };

  return {
    session,
    providerDecoder: codecs.createProviderStreamDecoder(input.targetProtocol, session),
    clientEncoder: codecs.createClientStreamEncoder(input.sourceProtocol, session, input.sourceWireOptions ?? {}),
  };
}

export function irBase(): IrRequest {
  return {
    model: "logical-key",
    delivery: "complete",
    items: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello!" }] }],
  };
}
