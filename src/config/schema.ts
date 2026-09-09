/**
 * @fileoverview Structural Zod schema for startup configuration in the Aptus gateway.
 *
 * Defines the complete structural validation schema for `AptusConfig`, specifying field types,
 * mandatory bounds, default values, and strict object handling to reject unexpected properties.
 *
 * Executed as stage four of config loading after secret resolution and prior to semantic cross-reference
 * validation in `src/config/validate.ts`. Failures emit `CONFIG_SCHEMA` startup errors.
 */

import { z } from "zod";
import type { HeaderMap, JsonObject, JsonValue } from "../domain/contracts.ts";
import { PUBLIC_NAME_PATTERN } from "../domain/names.ts";
import type { AptusConfig, SecretString } from "./types.ts";

/** Validates canonical names matching the public identifier format. */
const nameSchema = z.string().regex(PUBLIC_NAME_PATTERN);

/** Validates positive integers for ports, limits, timeouts, and counters. */
const positiveInt = z.number().int().positive();

/** Recursive validator for arbitrary read-only JSON values. */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema).readonly(),
    z.record(z.string(), jsonValueSchema).readonly(),
  ]),
);

/** Validates plain JSON objects used for payload fragments and overrides. */
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema).readonly();

/** Validates static provider headers with lowercase token names. */
const headerMapSchema: z.ZodType<HeaderMap> = z
  .record(z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/), z.string())
  .readonly();

/** Validates resolved non-empty credential strings. */
const secretSchema = z.custom<SecretString>((value) => typeof value === "string" && value.length > 0);

/** Validates protocol-neutral failure categories for route retry and fallback rules. */
const failureCategorySchema = z.enum([
  "invalid_request",
  "authentication",
  "permission",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limit",
  "quota",
  "timeout",
  "unavailable",
  "provider",
  "unsupported_capability",
  "stream_interrupted",
]);

/** Validates multi-protocol catalog metadata for model and route discovery. */
const catalogSchema = z
  .object({
    openai: z.object({ created: z.number().int().nonnegative(), ownedBy: z.string().min(1) }).strict(),
    anthropic: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        displayName: z.string().min(1),
        capabilities: z
          .object({
            batch: z.boolean().nullable(),
            citations: z.boolean().nullable(),
            codeExecution: z.boolean().nullable(),
            imageInput: z.boolean().nullable(),
            pdfInput: z.boolean().nullable(),
            structuredOutput: z.boolean().nullable(),
            thinking: z.boolean().nullable(),
          })
          .strict()
          .nullable(),
        maxInputTokens: positiveInt.nullable(),
        maxOutputTokens: positiveInt.nullable(),
      })
      .strict(),
  })
  .strict();

/** Validates token pricing rates per million tokens in USD. */
const pricingSchema = z
  .object({
    inputUsdPerMillionTokens: z.string().regex(/^\d+(?:\.\d+)?$/),
    outputUsdPerMillionTokens: z.string().regex(/^\d+(?:\.\d+)?$/),
    cacheReadUsdPerMillionTokens: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .nullable(),
    cacheWriteUsdPerMillionTokens: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .nullable(),
  })
  .strict();

/**
 * Strict structural Zod schema for the resolved startup configuration snapshot.
 *
 * Enforces field types, default values, bounds, and strict unknown-property rejection
 * across all server, auth, provider, model, route, tracing, and operational settings.
 */
export const aptusConfigSchema: z.ZodType<AptusConfig, unknown> = z
  .object({
    server: z
      .object({
        host: z.string().min(1).default("0.0.0.0"),
        port: z.number().int().min(0).max(65535).default(8080),
        bodyLimitBytes: positiveInt.default(33_554_432),
        maxInFlight: positiveInt.default(1000),
        requestDeadlineMs: positiveInt.default(600_000),
        streamIdleMs: positiveInt.default(60_000),
        shutdownDrainMs: positiveInt.default(30_000),
        trustedProxyCidrs: z.array(z.string().min(1)).readonly().default([]),
      })
      .strict(),
    operations: z
      .object({ host: z.string().min(1).default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(9090) })
      .strict(),
    auth: z
      .object({
        clientKeys: z
          .array(
            z
              .object({
                name: nameSchema,
                secret: secretSchema,
                allow: z.array(nameSchema).readonly().optional(),
              })
              .strict(),
          )
          .min(1)
          .readonly(),
      })
      .strict(),
    providers: z
      .array(
        z
          .object({
            name: nameSchema,
            protocol: z.enum(["openai-chat", "openai-responses", "anthropic-messages"]),
            baseUrl: z.string().url(),
            headers: headerMapSchema.default({}),
            keyStrategy: z.enum(["fill-first", "round-robin"]),
            keys: z
              .array(
                z
                  .object({
                    name: nameSchema,
                    secret: secretSchema,
                    enabled: z.boolean().default(true),
                  })
                  .strict(),
              )
              .min(1)
              .readonly(),
          })
          .strict(),
      )
      .min(1)
      .readonly(),
    models: z
      .array(
        z
          .object({
            name: nameSchema,
            aliases: z.array(nameSchema).readonly().default([]),
            provider: nameSchema,
            upstreamModel: z.string().min(1),
            defaults: jsonObjectSchema.default({}),
            extraBody: jsonObjectSchema.default({}),
            overrides: jsonObjectSchema.default({}),
            catalog: catalogSchema,
            pricing: pricingSchema.nullable().default(null),
          })
          .strict(),
      )
      .readonly(),
    routes: z
      .array(
        z
          .object({
            name: nameSchema,
            aliases: z.array(nameSchema).readonly().default([]),
            candidates: z.array(nameSchema).min(1).readonly(),
            retryOn: z.array(failureCategorySchema).readonly(),
            fallbackOn: z.array(failureCategorySchema).readonly(),
            catalog: catalogSchema,
          })
          .strict(),
      )
      .readonly(),
    routing: z
      .object({
        keyPool: z
          .object({
            failureCooldownMs: z.tuple([positiveInt, positiveInt]).default([250, 1000]),
            rateLimitFallbackMs: positiveInt.default(1000),
            maxRetryAfterMs: positiveInt.default(30_000),
            jitterRatio: z.number().min(0).max(1).default(0.25),
          })
          .strict(),
      })
      .strict(),
    tracing: z
      .object({
        enabled: z.boolean().default(true),
        root: z.string().min(1).default("./traces"),
        retention: z
          .object({
            maxAgeMs: positiveInt.default(604_800_000),
            maxBytes: positiveInt.default(1_073_741_824),
            cleanupIntervalMs: positiveInt.default(3_600_000),
          })
          .strict(),
      })
      .strict(),
    logging: z
      .object({
        enabled: z.boolean().default(true),
        level: z.enum(["debug", "info", "warning", "error"]).default("info"),
      })
      .strict(),
    metrics: z.object({ enabled: z.boolean().default(true) }).strict(),
    dryRun: z.object({ enabled: z.boolean().default(false) }).strict(),
  })
  .strict();
