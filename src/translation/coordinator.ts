import { randomUUID } from "node:crypto";
import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
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
import { unsupportedCapabilityFailure } from "./failures.ts";
import type { IrOutcome, IrRequest } from "./ir.ts";
import { preflightOutcome, preflightRequest, preflightStreamRequest } from "./preflight.ts";
import { prepareTranslatedProviderRequest } from "./prepare.ts";
import { validateIrOutcome, validateIrRequest } from "./validate.ts";

/**
 * Creates the pure, side-effect-free cross-protocol translation coordinator.
 *
 * Coordinates request decoding, IR validation, capability preflight, and target encoding,
 * as well as provider response decoding, outcome validation, preflight, and client encoding.
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

      // 1. Decode source request into IR
      const decodeResult = decoder.decodeRequest(input.sourceBody);
      if (!decodeResult.ok) {
        return decodeResult;
      }

      // Rebuild with canonical logical model name
      const irRequest: IrRequest = {
        ...decodeResult.value,
        model: input.logicalModel,
      };

      // 2. Validate IR request invariants
      const validateResult = validateIrRequest(irRequest);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight capability feasibility
      const preflightResult = preflightRequest(irRequest, direction);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Encode to target provider request body
      const encodedBody = encoder.encodeRequest(irRequest, input.targetModel);

      // 5. Anthropic Messages target: inject required max_tokens from model defaults
      if (input.targetProtocol === "anthropic-messages") {
        if (
          typeof input.targetDefaultMaxTokens === "number" &&
          Number.isSafeInteger(input.targetDefaultMaxTokens) &&
          input.targetDefaultMaxTokens > 0
        ) {
          (encodedBody as Record<string, unknown>).max_tokens = input.targetDefaultMaxTokens;
        } else {
          return {
            ok: false,
            error: unsupportedCapabilityFailure(
              "output-token-limit",
              "Target Anthropic model missing required positive safe integer 'defaults.max_tokens' configuration",
            ),
          };
        }
      }

      return {
        ok: true,
        value: {
          body: encodedBody,
          irRequest,
        },
      };
    },

    translateStreamRequest(
      input: TranslateStreamRequestInput,
    ): Result<TranslateStreamRequestResult, NormalizedFailure> {
      const direction = `${input.sourceProtocol}->${input.targetProtocol}` as Direction;
      const streamDecoder = codecs.streamRequestDecoders[input.sourceProtocol];
      const streamEncoder = codecs.streamRequestEncoders[input.targetProtocol];

      // 1. Decode source stream request into IR and source wire options
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
      const validateResult = validateIrRequest(irRequest);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight stream capability feasibility
      const preflightResult = preflightStreamRequest(irRequest, direction);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Encode to target provider stream request body
      const encodedBody = streamEncoder.encodeRequest(
        irRequest,
        input.targetModel,
        decodeResult.value.sourceWireOptions,
      );

      // 5. Anthropic Messages target: inject required max_tokens from model defaults
      if (input.targetProtocol === "anthropic-messages") {
        if (
          typeof input.targetDefaultMaxTokens === "number" &&
          Number.isSafeInteger(input.targetDefaultMaxTokens) &&
          input.targetDefaultMaxTokens > 0
        ) {
          (encodedBody as Record<string, unknown>).max_tokens = input.targetDefaultMaxTokens;
        } else {
          return {
            ok: false,
            error: unsupportedCapabilityFailure(
              "output-token-limit",
              "Target Anthropic model missing required positive safe integer 'defaults.max_tokens' configuration",
            ),
          };
        }
      }

      return {
        ok: true,
        value: {
          body: encodedBody,
          irRequest,
          sourceWireOptions: decodeResult.value.sourceWireOptions,
        },
      };
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

      // 1. Decode upstream provider response into IR outcome
      const decodeResult = decoder.decodeOutcome(input.status, input.headers, input.body);
      if (!decodeResult.ok) {
        return decodeResult;
      }

      // Rebuild with canonical logical model name
      const irOutcome: IrOutcome = {
        ...decodeResult.value,
        model: input.logicalModel,
      };

      // 2. Validate IR outcome invariants
      const validateResult = validateIrOutcome(irOutcome);
      if (!validateResult.ok) {
        return validateResult;
      }

      // 3. Preflight outcome finish/parts feasibility
      const preflightResult = preflightOutcome(irOutcome, direction);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Encode to client-native outcome representation
      const clientEncoded = encoder.encodeOutcome(irOutcome);

      return {
        ok: true,
        value: {
          status: clientEncoded.status,
          headers: clientEncoded.headers,
          body: clientEncoded.body,
          irOutcome,
        },
      };
    },

    prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput) {
      return prepareTranslatedProviderRequest(input);
    },
  };
}
