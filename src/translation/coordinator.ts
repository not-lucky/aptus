/**
 * @fileoverview Coordinates cross-protocol request and outcome translation between client and provider wire formats.
 *
 * Implements {@link TranslationCoordinator} to execute the ordered translation pipeline:
 * decode to Intermediate Representation (IR), validate semantic invariants, preflight capability
 * compatibility, and encode into target wire formats. For Anthropic Messages targets, resolves
 * and injects mandatory `max_tokens` limits.
 *
 * Exposes both ticketed (`TranslatedTicket`) and direct execution paths for complete and streaming flows.
 */

import { randomUUID } from "node:crypto";
import type { Result } from "../domain/contracts.ts";
import type { NormalizedFailure } from "../domain/operations.ts";
import { TRANSLATED_MEDIA_BODY_LIMIT_BYTES } from "./codecs/shared/media.ts";
import type {
  CreateStreamSessionInput,
  Direction,
  PrepareTicketRequestInput,
  PrepareTranslatedRequestInput,
  StreamSession,
  StreamSessionBundle,
  TranslateCompleteInput,
  TranslateCompleteOutcomeInput,
  TranslateCompleteOutcomeResult,
  TranslateCompleteRequestResult,
  TranslatedTicket,
  TranslateRequestInput,
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
 * Resolves the mandatory `max_tokens` limit required by Anthropic Messages targets,
 * preferring explicit request-level limits over configured target model defaults.
 *
 * @param irRequest - Validated intermediate representation of the inbound request.
 * @param targetDefaultMaxTokens - Configured default limit for the target model.
 * @returns Resolved positive safe integer token limit, or unsupported capability failure if unresolvable.
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

/**
 * Injects resolved `max_tokens` into an Anthropic Messages request body and verifies
 * serialized size does not exceed the media body limit.
 *
 * @param encodedBody - Mutable JSON request body to finalize.
 * @param irRequest - Validated semantic request representation.
 * @param targetDefaultMaxTokens - Configured fallback token limit.
 * @returns Successful result or normalized failure if limit is missing or payload too large.
 */
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
 * Extracts a numeric `max_tokens` default from loosely typed provider catalog defaults.
 *
 * @param defaults - Upstream provider model configuration defaults.
 * @returns Numeric token limit if present and valid, otherwise `undefined`.
 */
export function targetDefaultMaxTokensFrom(
  defaults: { readonly max_tokens?: unknown } | undefined,
): number | undefined {
  const value = defaults?.max_tokens;
  return typeof value === "number" ? value : undefined;
}

/**
 * Instantiates a stateless {@link TranslationCoordinator} closing over the provided protocol codecs.
 *
 * @param codecs - Registry of complete and streaming codecs for supported protocols.
 * @returns Configured coordinator supporting ticketed and direct translation workflows.
 */
export function createTranslationCoordinator(codecs: TranslationCodecs): TranslationCoordinator {
  /**
   * Executes the 5-stage complete request translation pipeline: decode, re-key model,
   * validate, preflight capabilities, and encode target body with protocol finalization.
   */
  const runComplete = (
    input: TranslateCompleteInput,
  ): Result<{ body: TranslateCompleteRequestResult["body"]; irRequest: IrRequest }, NormalizedFailure> => {
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

    return ok({ body: encodedBody, irRequest });
  };

  /**
   * Executes the 5-stage streaming request translation pipeline, preserving stream wire
   * options for subsequent session binding.
   */
  const runStream = (input: TranslateStreamRequestInput): Result<TranslateStreamRequestResult, NormalizedFailure> => {
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
  };

  /**
   * Translates a request and wraps the verified result in a branded {@link TranslatedTicket}.
   */
  const buildTicket = (input: TranslateRequestInput): Result<TranslatedTicket, NormalizedFailure> => {
    if (input.stream) {
      const result = runStream({
        sourceProtocol: input.sourceProtocol,
        targetProtocol: input.targetProtocol,
        sourceBody: input.sourceBody,
        logicalModel: input.logicalModel,
        targetModel: input.targetModel,
        targetDefaultMaxTokens: input.targetDefaultMaxTokens,
      });
      if (!result.ok) return result;
      return ok({
        __brand: "TranslatedTicket",
        sourceProtocol: input.sourceProtocol,
        targetProtocol: input.targetProtocol,
        logicalModel: input.logicalModel,
        targetModel: input.targetModel,
        stream: true,
        body: result.value.body,
        irRequest: result.value.irRequest,
        sourceWireOptions: result.value.sourceWireOptions,
      });
    }
    const result = runComplete({
      sourceProtocol: input.sourceProtocol,
      targetProtocol: input.targetProtocol,
      sourceBody: input.sourceBody,
      logicalModel: input.logicalModel,
      targetModel: input.targetModel,
      targetDefaultMaxTokens: input.targetDefaultMaxTokens,
    });
    if (!result.ok) return result;
    return ok({
      __brand: "TranslatedTicket",
      sourceProtocol: input.sourceProtocol,
      targetProtocol: input.targetProtocol,
      logicalModel: input.logicalModel,
      targetModel: input.targetModel,
      stream: false,
      body: result.value.body,
      irRequest: result.value.irRequest,
      sourceWireOptions: {},
    });
  };

  /**
   * Constructs a paired stream decoder and encoder bundle bound to a common session identity.
   */
  const buildSession = (
    ticket: TranslatedTicket,
    responseId: string | undefined,
    createPartId: (() => string) | undefined,
  ): StreamSessionBundle => {
    if (!ticket.stream) {
      throw new Error("internal fault: complete ticket cannot back a stream session");
    }
    const resolvedResponseId = responseId ?? randomUUID();
    const resolvedCreatePartId = createPartId ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
    const session: StreamSession = {
      responseId: resolvedResponseId,
      model: ticket.logicalModel,
      createPartId: resolvedCreatePartId,
    };

    const providerDecoder = codecs.createProviderStreamDecoder(ticket.targetProtocol, session);
    const clientEncoder = codecs.createClientStreamEncoder(ticket.sourceProtocol, session, ticket.sourceWireOptions);

    return { session, providerDecoder, clientEncoder };
  };

  return {
    /**
     * Translates an inbound request into a branded {@link TranslatedTicket} for provider dispatch.
     *
     * @param input - Inbound request parameters, models, and delivery mode.
     * @returns Successful ticket containing encoded body and semantic IR, or normalized failure.
     */
    translateRequest(input: TranslateRequestInput): Result<TranslatedTicket, NormalizedFailure> {
      return buildTicket(input);
    },

    /**
     * Prepares an outbound provider HTTP request from an already-translated ticket.
     *
     * @param ticket - Verified ticket produced by {@link translateRequest}.
     * @param input - Provider connection, authentication, headers, and timeout settings.
     * @returns Prepared provider request ready for HTTP dispatch.
     */
    prepareTicketRequest(ticket: TranslatedTicket, input: PrepareTicketRequestInput) {
      return prepareTranslatedProviderRequest({
        providerName: input.providerName,
        targetProtocol: ticket.targetProtocol,
        baseUrl: input.baseUrl,
        clientHeaders: input.clientHeaders,
        providerHeaders: input.providerHeaders,
        providerSecret: input.providerSecret,
        body: ticket.body,
        deadlineMs: input.deadlineMs,
        streamIdleMs: input.streamIdleMs,
        stream: ticket.stream,
      });
    },

    /**
     * Creates a streaming session bundle from a verified streaming ticket.
     *
     * @param ticket - Streaming ticket that the session will serve.
     * @param input - Optional overrides for response ID and part ID generation.
     * @returns Session bundle holding shared session identity, provider decoder, and client encoder.
     * @throws {Error} When `ticket.stream` is false.
     */
    createTicketSession(ticket, input) {
      return buildSession(ticket, input?.responseId, input?.createPartId);
    },

    /**
     * Translates a complete (non-streaming) request without producing a branded ticket.
     *
     * @param input - Inbound request parameters, models, and fallback token limits.
     * @returns Encoded target body and semantic IR request, or normalized failure.
     */
    translateCompleteRequest(input: TranslateCompleteInput): Result<TranslateCompleteRequestResult, NormalizedFailure> {
      return runComplete(input);
    },

    /**
     * Translates a streaming request without producing a branded ticket.
     *
     * @param input - Inbound streaming request parameters, models, and fallback token limits.
     * @returns Encoded target streaming body, IR request, and stream wire options, or normalized failure.
     */
    translateStreamRequest(
      input: TranslateStreamRequestInput,
    ): Result<TranslateStreamRequestResult, NormalizedFailure> {
      return runStream(input);
    },

    /**
     * Constructs a streaming session bundle from direct parameters without a ticket.
     *
     * @param input - Source/target protocols, logical model, wire options, and optional ID overrides.
     * @returns Session bundle holding shared session identity, provider decoder, and client encoder.
     */
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

    /**
     * Translates an upstream provider response back into the client-native protocol format.
     *
     * @param input - Response status, headers, body, protocols, and canonical model name.
     * @returns Client response envelope and semantic IR outcome, or normalized failure.
     */
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

      // 3. Preflight outcome finish/parts/sidecar feasibility
      const preflightResult = preflightOutcome(irOutcome, direction, decodeResult.value.outcomeWireOptions);
      if (!preflightResult.ok) {
        return preflightResult;
      }

      // 4. Normalize the sidecar for the direction, then encode to client representation
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

    /**
     * Prepares an outbound provider HTTP request from direct input parameters without a ticket.
     *
     * @param input - Connection parameters, protocols, headers, credentials, body, and timeouts.
     * @returns Prepared provider request ready for HTTP dispatch.
     */
    prepareTranslatedProviderRequest(input: PrepareTranslatedRequestInput) {
      return prepareTranslatedProviderRequest(input);
    },
  };
}
