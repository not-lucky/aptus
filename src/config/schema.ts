import { z } from "zod";
import type { HeaderMap, JsonObject, JsonValue } from "../domain/contracts.js";
import { PUBLIC_NAME_PATTERN } from "../domain/names.js";
import type { AptusConfig, SecretString } from "./types.js";

/** Validates canonical names (1-128 chars, alphanumeric start, dots, underscores, dashes). */
const nameSchema = z.string().regex(PUBLIC_NAME_PATTERN);

/** Positive integer validator (> 0). */
const positiveInt = z.number().int().positive();

/**
 * Recursive schema for arbitrary JSON values.
 * Uses `z.lazy()` to handle nested arrays and records without infinite recursion during type synthesis.
 */
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

/** Schema validating a plain JSON object record. */
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema).readonly();

/**
 * Validates an HTTP header dictionary.
 * Keys must be valid lower-case HTTP token characters; values must be strings.
 */
const headerMapSchema: z.ZodType<HeaderMap> = z
  .record(z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/), z.string())
  .readonly();

/** Custom validator for non-empty secret strings. */
const secretSchema = z.custom<SecretString>((value) => typeof value === "string" && value.length > 0);

/** Canonical 13-member failure category enum schema. */
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

/** Schema for multi-protocol model catalog metadata. */
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

/** Schema for unit pricing rates in USD per million tokens. */
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
 * Strict structural Zod schema for validating the resolved startup configuration.
 *
 * Enforces strict object shapes (`.strict()`), default values, port bounds, positive limits,
 * and URI formats.
 *
 * @remarks
 * Structural validation occurs after secret resolution and before cross-reference semantic checks.
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
