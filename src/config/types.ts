import type { HeaderMap, JsonObject, Protocol } from "../domain/contracts.js";
import type { IrFailureCategory } from "../domain/operations.js";
import type { DecimalUsdPerMillion, PricingConfig } from "../domain/pricing.js";

export type { DecimalUsdPerMillion, PricingConfig };

/**
 * Nominal type representing an environment-resolved secret string.
 *
 * Resolved strictly during startup configuration loading and never exposed in telemetry, logs, or error responses.
 */
export type SecretString = string & { readonly __secret: unique symbol };

/**
 * An IPv4 CIDR notation string (e.g., `"10.0.0.0/8"`, `"192.168.1.0/24"`) used to evaluate trusted reverse proxy peers.
 */
export type Cidr = string;

/**
 * Configuration options for the client ingress HTTP listener and connection lifecycle limits.
 */
export interface ServerConfig {
  /**
   * Host address to bind the client HTTP listener to. Defaults to `"0.0.0.0"`.
   */
  readonly host: string;

  /**
   * TCP port to bind the client HTTP listener to. Defaults to `8080`.
   */
  readonly port: number;

  /**
   * Maximum allowed request body size in bytes for identity-encoded JSON payloads. Defaults to `33554432` (32 MiB).
   */
  readonly bodyLimitBytes: number;

  /**
   * Maximum concurrent in-flight requests admitted by the process before returning HTTP 429. Defaults to `1000`.
   */
  readonly maxInFlight: number;

  /**
   * Total request deadline in milliseconds including queueing, candidate selection, retries, and body transfer. Defaults to `600000` (10 minutes).
   */
  readonly requestDeadlineMs: number;

  /**
   * Maximum allowed idle duration in milliseconds between incoming upstream stream chunks before aborting. Defaults to `60000` (1 minute).
   */
  readonly streamIdleMs: number;

  /**
   * Graceful shutdown timeout in milliseconds allowed for in-flight requests to complete during process drain. Defaults to `30000` (30 seconds).
   */
  readonly shutdownDrainMs: number;

  /**
   * List of IPv4 CIDRs whose `X-Forwarded-*` / `Forwarded` client headers are trusted. Defaults to empty `[]`.
   */
  readonly trustedProxyCidrs: readonly Cidr[];
}

/**
 * Configuration options for the unauthenticated operations/observability HTTP listener.
 */
export interface OperationsConfig {
  /**
   * Host address to bind the operations HTTP listener to. Defaults to `"127.0.0.1"`.
   */
  readonly host: string;

  /**
   * TCP port to bind the operations HTTP listener to. Defaults to `9090`.
   */
  readonly port: number;
}

/**
 * Authenticated client key configuration.
 */
export interface ClientKeyConfig {
  /**
   * Unique, safe identification name for the client key used in metrics and logs (never the secret).
   */
  readonly name: string;

  /**
   * Secret resolved from environment variable reference `${ENV_NAME}`.
   */
  readonly secret: SecretString;

  /**
   * Optional whitelist of public model names and route names accessible by this key.
   * When omitted or undefined, all public models and routes are authorized.
   */
  readonly allow?: readonly string[];
}

/**
 * Client authentication and authorization configuration section.
 */
export interface AuthConfig {
  /**
   * List of non-empty configured client credentials with unique names and distinct secrets.
   */
  readonly clientKeys: readonly ClientKeyConfig[];
}

/**
 * Key lease acquisition strategy within a provider's key pool.
 *
 * - `"fill-first"`: Always selects the first available non-cooldown enabled key.
 * - `"round-robin"`: Rotates sequentially across available non-cooldown enabled keys.
 */
export type KeyStrategy = "fill-first" | "round-robin";

/**
 * Named provider API key credential configuration.
 */
export interface ProviderKeyConfig {
  /**
   * Unique name of the key within its provider Key Pool.
   */
  readonly name: string;

  /**
   * Resolved provider secret string from environment variable reference.
   */
  readonly secret: SecretString;

  /**
   * Whether this key is currently enabled for candidate acquisition. Defaults to `true`.
   */
  readonly enabled: boolean;
}

/**
 * Upstream provider service and key pool configuration.
 */
export interface ProviderConfig {
  /**
   * Unique provider identifier.
   */
  readonly name: string;

  /**
   * Upstream protocol expected by this provider.
   */
  readonly protocol: Protocol;

  /**
   * Normalized base API URL (e.g., `"https://api.openai.com/v1"`), without trailing slash or query parameters.
   */
  readonly baseUrl: string;

  /**
   * Static HTTP headers attached to all outbound requests to this provider.
   */
  readonly headers: HeaderMap;

  /**
   * List of provider API keys configured for this provider.
   */
  readonly keys: readonly ProviderKeyConfig[];

  /**
   * Key selection algorithm used when acquiring keys for this provider.
   */
  readonly keyStrategy: KeyStrategy;
}

/**
 * Metadata fields for OpenAI model catalog representations.
 */
export interface OpenAiCatalogMetadata {
  /**
   * Unix timestamp in seconds when the model was created.
   */
  readonly created: number;

  /**
   * Organization or vendor owning the model.
   */
  readonly ownedBy: string;
}

/**
 * Optional capability flags for Anthropic model catalog representation.
 */
export interface AnthropicCapabilities {
  /** Batch inference support flag. */
  readonly batch: boolean | null;
  /** Document citation support flag. */
  readonly citations: boolean | null;
  /** Code execution tool support flag. */
  readonly codeExecution: boolean | null;
  /** Vision / image input support flag. */
  readonly imageInput: boolean | null;
  /** PDF input support flag. */
  readonly pdfInput: boolean | null;
  /** Structured output / JSON schema support flag. */
  readonly structuredOutput: boolean | null;
  /** Extended thinking / reasoning support flag. */
  readonly thinking: boolean | null;
}

/**
 * Metadata fields for Anthropic model catalog representations.
 */
export interface AnthropicCatalogMetadata {
  /**
   * RFC 3339 formatted creation timestamp with timezone offset.
   */
  readonly createdAt: string;

  /**
   * Human-readable display name for the model.
   */
  readonly displayName: string;

  /**
   * Informational capability flags.
   */
  readonly capabilities: AnthropicCapabilities | null;

  /**
   * Maximum input context tokens supported, or `null`.
   */
  readonly maxInputTokens: number | null;

  /**
   * Maximum output completion tokens supported, or `null`.
   */
  readonly maxOutputTokens: number | null;
}

/**
 * Multi-protocol catalog metadata attached to models and routes.
 */
export interface CatalogMetadata {
  /** Metadata returned when catalog is queried via OpenAI-compatible endpoints (`/v1/models` with Bearer auth). */
  readonly openai: OpenAiCatalogMetadata;

  /** Metadata returned when catalog is queried via Anthropic-compatible endpoints (`/v1/models` with `x-api-key`). */
  readonly anthropic: AnthropicCatalogMetadata;
}

/**
 * Public model configuration mapping a client-visible model name to a provider model ID.
 */
export interface ModelConfig {
  /**
   * Canonical public model name.
   */
  readonly name: string;

  /**
   * List of unique input-only aliases resolving to this model.
   */
  readonly aliases: readonly string[];

  /**
   * Name of the configured provider that serves this model.
   */
  readonly provider: string;

  /**
   * Upstream model ID expected by the target provider.
   */
  readonly upstreamModel: string;

  /**
   * JSON payload default values inserted only if absent in client request.
   */
  readonly defaults: JsonObject;

  /**
   * Provider-native extension fields merged after defaults.
   */
  readonly extraBody: JsonObject;

  /**
   * Values that override or replace client request fields.
   */
  readonly overrides: JsonObject;

  /**
   * Protocol catalog metadata for this model.
   */
  readonly catalog: CatalogMetadata;

  /**
   * Unit pricing per million tokens for cost estimation, or `null` if pricing is unconfigured.
   */
  readonly pricing: PricingConfig | null;
}

/**
 * Fallback route configuration directing traffic across an ordered list of candidate models.
 */
export interface RouteConfig {
  /**
   * Canonical public route name.
   */
  readonly name: string;

  /**
   * List of unique input-only aliases resolving to this route.
   */
  readonly aliases: readonly string[];

  /**
   * Ordered non-empty list of canonical model names tried as candidates.
   */
  readonly candidates: readonly string[];

  /**
   * Failure categories that permit same-candidate retries (up to 2 retries).
   */
  readonly retryOn: readonly IrFailureCategory[];

  /**
   * Failure categories that trigger fallback to the next candidate model in {@link candidates}.
   */
  readonly fallbackOn: readonly IrFailureCategory[];

  /**
   * Protocol catalog metadata for this route.
   */
  readonly catalog: CatalogMetadata;
}

/**
 * Adaptive Key Pool timing parameters and cooldown intervals.
 */
export interface KeyPoolConfig {
  /**
   * Two positive cooldown step durations in milliseconds `[step1Ms, step2Ms]`. Defaults to `[250, 1000]`.
   */
  readonly failureCooldownMs: readonly [number, number];

  /**
   * Fallback cooldown duration in milliseconds when a 429 response lacks a `Retry-After` header. Defaults to `1000`.
   */
  readonly rateLimitFallbackMs: number;

  /**
   * Maximum allowed retry delay in milliseconds capped for adaptive health. Defaults to `30000`.
   */
  readonly maxRetryAfterMs: number;

  /**
   * Uniform random jitter ratio in `[0, 1]` added to retry delays. Defaults to `0.25`.
   */
  readonly jitterRatio: number;
}

/**
 * Gateway routing subsystem configuration.
 */
export interface RoutingConfig {
  /**
   * Key pool adaptive timing settings.
   */
  readonly keyPool: KeyPoolConfig;
}

/**
 * Configuration for completed trace storage retention and automatic pruning.
 */
export interface TraceRetentionConfig {
  /**
   * Maximum age of completed traces in milliseconds before deletion. Defaults to `604800000` (7 days).
   */
  readonly maxAgeMs: number;

  /**
   * Maximum total disk space in bytes for completed traces before oldest traces are pruned. Defaults to `1073741824` (1 GiB).
   */
  readonly maxBytes: number;

  /**
   * Cleanup timer execution interval in milliseconds. Defaults to `3600000` (1 hour).
   */
  readonly cleanupIntervalMs: number;
}

/**
 * Full-payload filesystem tracing configuration.
 */
export interface TracingConfig {
  /**
   * Whether trace recording is enabled. Defaults to `true`.
   */
  readonly enabled: boolean;

  /**
   * Local filesystem root directory where request traces are stored with 0700 permissions. Defaults to `"./traces"`.
   */
  readonly root: string;

  /**
   * Trace retention and disk space limits.
   */
  readonly retention: TraceRetentionConfig;
}

/**
 * Structured logging configuration options.
 */
export interface LoggingConfig {
  /**
   * Whether structured LogTape logging is enabled. Defaults to `true`.
   */
  readonly enabled: boolean;

  /**
   * Minimum log level threshold to emit. Defaults to `"info"`.
   */
  readonly level: "debug" | "info" | "warning" | "error";
}

/**
 * Prometheus metrics exporter configuration options.
 */
export interface MetricsConfig {
  /**
   * Whether Prometheus metrics collection and `/metrics` endpoint are enabled. Defaults to `true`.
   */
  readonly enabled: boolean;
}

/**
 * Global dry-run configuration.
 */
export interface DryRunConfig {
  /**
   * When `true`, forces all admitted create requests to execute candidate selection and preparation without network dispatch. Defaults to `false`.
   */
  readonly enabled: boolean;
}

/**
 * The deep-frozen, immutable application configuration snapshot validated at startup.
 */
export interface AptusConfig {
  /** Client listener and connection lifecycle limits. */
  readonly server: ServerConfig;

  /** Operations and health check listener settings. */
  readonly operations: OperationsConfig;

  /** Client authentication identities and allowlists. */
  readonly auth: AuthConfig;

  /** Upstream providers and their protocol-specific key pools. */
  readonly providers: readonly ProviderConfig[];

  /** Canonical public models. */
  readonly models: readonly ModelConfig[];

  /** Canonical fallback routes. */
  readonly routes: readonly RouteConfig[];

  /** Routing and adaptive key health settings. */
  readonly routing: RoutingConfig;

  /** Filesystem payload tracing settings. */
  readonly tracing: TracingConfig;

  /** Structured logging settings. */
  readonly logging: LoggingConfig;

  /** Prometheus metrics settings. */
  readonly metrics: MetricsConfig;

  /** Dry-run execution settings. */
  readonly dryRun: DryRunConfig;
}
