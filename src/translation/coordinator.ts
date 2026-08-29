import { randomUUID } from "node:crypto";
import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { TRANSLATED_MEDIA_BODY_LIMIT_BYTES } from "./codecs/shared/media.ts";
import type {
  CreateStreamSessionInput,
  Direction,
  PrepareTranslatedRequestInput,
  StreamSession,
  StreamSessionBundle,
  TranslateCompleteInput,
  TranslateCompleteOutcomeInput,
  TranslateCompleteOutcomeResult,
  TranslateCompleteRequestResult,
  TranslateStreamRequestInput,
  TranslateStreamRequestResult,
  TranslationCodecs,
  TranslationCoordinator,
} from "./contracts.ts";
import type { IrOutcome, IrRequest } from "./ir.ts";
import {
  normalizeOutcomeWireOptions,
  preflightOutcome,
  preflightRequest,
  preflightStreamRequest,
} from "./preflight.ts";
import { prepareTranslatedProviderRequest } from "./prepare.ts";
import { ok, payloadTooLarge, unsupportedCapability } from "./result.ts";
import { validateIrOutcome, validateIrRequest } from "./validate.ts";

/**
 * Resolves the required Anthropic Messages `max_tokens`: the caller's output
 * token limit wins; the target model's configured default fills in when absent.
 * Returns a fail-closed failure when no positive safe integer can be resolved.
 */
function resolveMessagesMaxTokens(
  irRequest: IrRequest,
  targetDefaultMaxTokens: number | undefined,
): Result<number, NormalizedFailure> {
  const maxTokens = irRequest.generation?.maxOutputTokens ?? targetDefaultMaxTokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return unsupportedCapability(
      "output-token-limit",
      "No positive safe integer max_tokens could be resolved from the request or the target model defaults",
    );
  }
  return ok(maxTokens);
}

function finalizeMessagesRequestBody(
  encodedBody: Record<string, unknown>,
  irRequest: IrRequest,
  targetDefaultMaxTokens: number | undefined,
): Result<void, NormalizedFailure> {
  const maxTokens = resolveMessagesMaxTokens(irRequest, targetDefaultMaxTokens);
  if (!maxTokens.ok) return maxTokens;
  encodedBody.max_tokens = maxTokens.value;
  const serializedBytes = Buffer.byteLength(JSON.stringify(encodedBody), "utf8");
  if (serializedBytes > TRANSLATED_MEDIA_BODY_LIMIT_BYTES) {
    return payloadTooLarge("serialized Anthropic Messages request body exceeds 32 MiB limit");
  }
  return ok(undefined);
}

/**
 * Creates the pure, side-effect-free cross-protocol translation coordinator.
 *
 * Coordinates request decoding (IR + wire-options sidecar), IR validation,
 * capability preflight (including per-direction sidecar feasibility), and
 * target encoding, as well as provider response decoding, outcome validation,
 * preflight, sidecar normalization, and client encoding.
 *
 * @param codecs - Registered ingress decoders and egress encoders for each protocol.
 * @returns A {@link TranslationCoordinator} bundle.
 */
export function createTranslationCoordinator(codecs: TranslationCodecs): TranslationCoordinator {
  return {
    translateCompleteRequest(input: TranslateCompleteInput): Result<TranslateCompleteRequestResult, NormalizedFailure> {
      const direction = `${input.sourceProtocol}->${input.targetProtocol}` as Direction;
      const decoder = codecs.ingress[input.sourceProtocol];
      const encoder = codecs.egress[input.targetProtocol];

      // 1. Decode source request into IR plus the wire-only sidecar
      const decodeResult = decoder.decodeRequest(input.sourceBody);
      if (!decodeResult.ok) {
        return decodeResult;
      }

      // Rebuild with canonical logical model name
      const irRequest: IrRequest = {
        ...decodeResult.value.irRequest,
        model: input.logicalModel,
      };

      // 2. Validate IR request invariants and sidecar mutual exclusion
      const validateResult = validateIrRequest(irRequest, decodeResult.value.requestWireOptions);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight capability feasibility, including per-direction sidecar rows
      const preflightResult = preflightRequest(irRequest, direction, decodeResult.value.requestWireOptions);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Encode to target provider request body, projecting the sidecar
      const encodedBody = encoder.encodeRequest(irRequest, input.targetModel, decodeResult.value.requestWireOptions);

      // 5. Anthropic Messages target: inject the resolved required max_tokens
      //    (caller limit first, configured model default as fallback).
      if (input.targetProtocol === "anthropic-messages") {
        const finalize = finalizeMessagesRequestBody(
          encodedBody as Record<string, unknown>,
          irRequest,
          input.targetDefaultMaxTokens,
        );
        if (!finalize.ok) return finalize;
      }

      return ok({
        body: encodedBody,
        irRequest,
      });
    },

    translateStreamRequest(
      input: TranslateStreamRequestInput,
    ): Result<TranslateStreamRequestResult, NormalizedFailure> {
      const direction = `${input.sourceProtocol}->${input.targetProtocol}` as Direction;
      const streamDecoder = codecs.streamRequestDecoders[input.sourceProtocol];
      const streamEncoder = codecs.streamRequestEncoders[input.targetProtocol];

      // 1. Decode source stream request into IR and both wire-option sets
      const decodeResult = streamDecoder.decodeRequest(input.sourceBody);
      if (!decodeResult.ok) {
        return decodeResult;
      }

      // Rebuild with canonical logical model name
      const irRequest: IrRequest = {
        ...decodeResult.value.irRequest,
        model: input.logicalModel,
      };

      // 2. Validate IR request invariants
      const validateResult = validateIrRequest(irRequest, decodeResult.value.requestWireOptions);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight stream capability feasibility, including sidecar rows
      const preflightResult = preflightStreamRequest(irRequest, direction, decodeResult.value.requestWireOptions);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Encode to target provider stream request body, projecting the sidecar
      const encodedBody = streamEncoder.encodeRequest(
        irRequest,
        input.targetModel,
        decodeResult.value.sourceWireOptions,
        decodeResult.value.requestWireOptions,
      );

      // 5. Anthropic Messages target: inject the resolved required max_tokens
      if (input.targetProtocol === "anthropic-messages") {
        const finalize = finalizeMessagesRequestBody(
          encodedBody as Record<string, unknown>,
          irRequest,
          input.targetDefaultMaxTokens,
        );
        if (!finalize.ok) return finalize;
      }

      return ok({
        body: encodedBody,
        irRequest,
        sourceWireOptions: decodeResult.value.sourceWireOptions,
      });
    },

    createStreamSession(input: CreateStreamSessionInput): StreamSessionBundle {
      const responseId = input.responseId ?? randomUUID();
      const createPartId = input.createPartId ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
      const session: StreamSession = {
        responseId,
        model: input.logicalModel,
        createPartId,
      };

      const providerDecoder = codecs.createProviderStreamDecoder(input.targetProtocol, session);
      const clientEncoder = codecs.createClientStreamEncoder(
        input.sourceProtocol,
        session,
        input.sourceWireOptions ?? {},
      );

      return {
        session,
        providerDecoder,
        clientEncoder,
      };
    },

    translateCompleteOutcome(
      input: TranslateCompleteOutcomeInput,
    ): Result<TranslateCompleteOutcomeResult, NormalizedFailure> {
      const direction = `${input.sourceProtocol}->${input.targetProtocol}` as Direction;
      const decoder = codecs.ingress[input.targetProtocol];
      const encoder = codecs.egress[input.sourceProtocol];

      // 1. Decode upstream provider response into IR outcome plus its sidecar
      const decodeResult = decoder.decodeOutcome(input.status, input.headers, input.body);
      if (!decodeResult.ok) {
        return decodeResult;
      }

      // Rebuild with canonical logical model name
      const irOutcome: IrOutcome = {
        ...decodeResult.value.irOutcome,
        model: input.logicalModel,
      };

      // 2. Validate IR outcome invariants (IR-only: never inspects the sidecar)
      const validateResult = validateIrOutcome(irOutcome);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight outcome finish/parts/sidecar feasibility (e.g. moderation
      //    discovered for a Messages client fails closed here)
      const preflightResult = preflightOutcome(irOutcome, direction, decodeResult.value.outcomeWireOptions);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Normalize the sidecar for the direction, then encode to the
      //    client-native outcome representation
      const normalizedWireOptions = normalizeOutcomeWireOptions(
        decodeResult.value.outcomeWireOptions,
        input.sourceProtocol,
        input.targetProtocol,
      );
      const clientEncoded = encoder.encodeOutcome(irOutcome, normalizedWireOptions);

      return ok({
        status: clientEncoded.status,
        headers: clientEncoded.headers,
        body: clientEncoded.body,
        irOutcome,
      });
    },

    prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput) {
      return prepareTranslatedProviderRequest(input);
    },
  };
}
