/**
 * @fileoverview Startup configuration shapes for the Aptus gateway.
 *
 * Declares the immutable, deep-frozen configuration schema contracts loaded and verified at startup.
 * Represents listener bindings, client authentication identities, upstream provider key pools,
 * public models, fallback routes, adaptive routing timers, trace retention, logging, metrics, and dry-run modes.
 *
 * Interfaces defined here provide the read-only data vocabulary shared across ingress admission,
 * candidate resolution, protocol translation, provider dispatch, and telemetry subsystems.
 */

import type { HeaderMap, JsonObject, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory } from "../domain/operations.ts";
import type { DecimalUsdPerMillion, PricingConfig } from "../domain/pricing.ts";

/** Re-exported pricing shapes for model token rate configuration. */
export type { DecimalUsdPerMillion, PricingConfig };

/** Nominal branded string representing a sensitive credential resolved from the environment. */
export type SecretString = string & { readonly __secret: unique symbol };

/** IPv4 network address in CIDR notation (e.g., `10.0.0.0/8`). */
export type Cidr = string;

/**
 * Network bindings and admission limits for the authenticated client ingress server.
 */
export interface ServerConfig {
  /** Bind host address for client traffic (defaults to `"0.0.0.0"`). */
  readonly host: string;

  /** TCP port for client traffic (defaults to `8080`). */
  readonly port: number;

  /** Maximum request body size in bytes for inbound JSON payloads (defaults to `33554432` / 32 MiB). */
  readonly bodyLimitBytes: number;

  /** Maximum concurrent in-flight requests admitted before shedding load (defaults to `1000`). */
  readonly maxInFlight: number;

  /** Overall request timeout in milliseconds from admission to response completion (defaults to `600000` / 10m). */
  readonly requestDeadlineMs: number;

  /** Maximum allowed silence between upstream streaming chunks in milliseconds (defaults to `60000` / 1m). */
  readonly streamIdleMs: number;

  /** Grace period in milliseconds to allow in-flight requests to drain during shutdown (defaults to `30000` / 30s). */
  readonly shutdownDrainMs: number;

  /** List of trusted reverse proxy CIDR blocks whose forwarding headers are honored. */
  readonly trustedProxyCidrs: readonly Cidr[];
}

/**
 * Network binding configuration for unauthenticated operations and metrics endpoints.
 */
export interface OperationsConfig {
  /** Bind host address for operational endpoints (defaults to `"127.0.0.1"`). */
  readonly host: string;

  /** TCP port for operational endpoints (defaults to `9090`). */
  readonly port: number;
}

/**
 * Authenticated client credential identity and route access permissions.
 */
export interface ClientKeyConfig {
  /** Human-readable identifier for the client, used in logging and metrics. */
  readonly name: string;

  /** Resolved secret token used for bearer or API key authentication. */
  readonly secret: SecretString;

  /** Optional allowlist of public model and route names accessible by this client. */
  readonly allow?: readonly string[];
}

/**
 * Client authentication credentials accepted by the gateway.
 */
export interface AuthConfig {
  /** Configured client identities with unique names and secrets. */
  readonly clientKeys: readonly ClientKeyConfig[];
}

/** Upstream key selection strategy within a provider's key pool (`fill-first` or `round-robin`). */
export type KeyStrategy = "fill-first" | "round-robin";

/**
 * Individual upstream provider credential managed within a provider key pool.
 */
export interface ProviderKeyConfig {
  /** Key identifier within the owning provider pool. */
  readonly name: string;

  /** Resolved secret credential for authenticating with the upstream provider. */
  readonly secret: SecretString;

  /** Whether this key is currently active for request leasing (defaults to `true`). */
  readonly enabled: boolean;
}

/**
 * Upstream provider endpoint target, wire protocol, headers, and credential key pool.
 */
export interface ProviderConfig {
  /** Unique provider name referenced by models. */
  readonly name: string;

  /** Protocol dialect spoken by the upstream provider endpoint. */
  readonly protocol: Protocol;

  /** Normalized base URL of the upstream provider without trailing slashes or queries. */
  readonly baseUrl: string;

  /** Static headers appended to all outbound requests to this provider. */
  readonly headers: HeaderMap;

  /** Credential key pool available for dispatching attempts to this provider. */
  readonly keys: readonly ProviderKeyConfig[];

  /** Key selection policy for rotating across available keys in this pool. */
  readonly keyStrategy: KeyStrategy;
}

/**
 * Model listing metadata returned by OpenAI-compatible `/v1/models` endpoints.
 */
export interface OpenAiCatalogMetadata {
  /** Model publication timestamp in Unix epoch seconds. */
  readonly created: number;

  /** Organization or vendor identifier owning the model. */
  readonly ownedBy: string;
}

/**
 * Capability flags for Anthropic-compatible model catalog discovery.
 */
export interface AnthropicCapabilities {
  /** Whether the model supports batch inference, or `null` if unspecified. */
  readonly batch: boolean | null;

  /** Whether the model supports citation generation, or `null` if unspecified. */
  readonly citations: boolean | null;

  /** Whether the model supports server-side code execution, or `null` if unspecified. */
  readonly codeExecution: boolean | null;

  /** Whether the model accepts image input, or `null` if unspecified. */
  readonly imageInput: boolean | null;

  /** Whether the model accepts PDF document input, or `null` if unspecified. */
  readonly pdfInput: boolean | null;

  /** Whether the model supports JSON schema constrained output, or `null` if unspecified. */
  readonly structuredOutput: boolean | null;

  /** Whether the model supports extended reasoning/thinking mode, or `null` if unspecified. */
  readonly thinking: boolean | null;
}

/**
 * Model listing metadata returned by Anthropic-compatible `/v1/models` endpoints.
 */
export interface AnthropicCatalogMetadata {
  /** Creation timestamp in ISO 8601 format with timezone offset. */
  readonly createdAt: string;

  /** Human-readable display label shown in listings. */
  readonly displayName: string;

  /** Supported feature capability flags, or `null` if omitted. */
  readonly capabilities: AnthropicCapabilities | null;

  /** Maximum input token context window, or `null` if unconstrained. */
  readonly maxInputTokens: number | null;

  /** Maximum generation token limit, or `null` if unconstrained. */
  readonly maxOutputTokens: number | null;
}

/**
 * Unified multi-protocol catalog discovery metadata for a model or route.
 */
export interface CatalogMetadata {
  /** Metadata returned to OpenAI-compatible clients. */
  readonly openai: OpenAiCatalogMetadata;

  /** Metadata returned to Anthropic-compatible clients. */
  readonly anthropic: AnthropicCatalogMetadata;
}

/**
 * Canonical public model mapped to an upstream provider target and parameter modifications.
 */
export interface ModelConfig {
  /** Canonical public identifier addressed by clients in request bodies. */
  readonly name: string;

  /** Input-only alias names resolving to this canonical model. */
  readonly aliases: readonly string[];

  /** Name of the configured provider that serves this model. */
  readonly provider: string;

  /** Upstream model identifier passed in outbound payloads to the provider. */
  readonly upstreamModel: string;

  /** Default payload fields applied when omitted in client requests. */
  readonly defaults: JsonObject;

  /** Provider-specific extension fields merged into outbound payloads. */
  readonly extraBody: JsonObject;

  /** Hard override payload fields forced onto every outbound request. */
  readonly overrides: JsonObject;

  /** Multi-protocol listing metadata for catalog discovery. */
  readonly catalog: CatalogMetadata;

  /** Token unit pricing rates in USD per million tokens, or `null` if disabled. */
  readonly pricing: PricingConfig | null;
}

/**
 * Fallback route that tries an ordered list of models in sequence.
 *
 * Configures priority-ordered model candidates, retry/fallback failure categories,
 * and discovery metadata. Route names must be globally unique across models and routes.
 */
export interface RouteConfig {
  /** Canonical public route name addressed by clients. Must be unique across models and routes. */
  readonly name: string;

  /** Input-only aliases that resolve to this route's canonical name. */
  readonly aliases: readonly string[];

  /** Priority-ordered list of canonical model names tried as candidates. */
  readonly candidates: readonly string[];

  /** Failure categories permitted to retry on the same candidate. */
  readonly retryOn: readonly IrFailureCategory[];

  /** Failure categories permitted to fall back to the next candidate model. */
  readonly fallbackOn: readonly IrFailureCategory[];

  /** Multi-protocol listing metadata for catalog discovery. */
  readonly catalog: CatalogMetadata;
}

/**
 * Timing values for adaptive key health in one provider pool.
 *
 * Controls fixed cooldown rungs for server faults, fallback waits for bare 429
 * responses, delay ceilings, and proportional jitter for key desynchronization.
 */
export interface KeyPoolConfig {
  /** Fixed cooldown rungs in milliseconds [firstFailure, streakFailure] for 5xx and transport errors. */
  readonly failureCooldownMs: readonly [number, number];

  /** Fallback cooldown in milliseconds for 429 rate limit responses lacking a retry delay. */
  readonly rateLimitFallbackMs: number;

  /** Maximum ceiling in milliseconds for any rate limit cooldown before jitter. */
  readonly maxRetryAfterMs: number;

  /** Proportional jitter ratio (0 to 1) applied to rate limit cooldowns. */
  readonly jitterRatio: number;
}

/**
 * Routing subsystem configuration snapshot.
 *
 * Groups shared adaptive timing policies applied across all provider key pools.
 */
export interface RoutingConfig {
  /** Adaptive cooldown timing values shared across every provider key pool. */
  readonly keyPool: KeyPoolConfig;
}

/**
 * Retention limits for completed trace directories on disk.
 *
 * Bounds trace storage by maximum age and total bytes, with a periodic
 * cleanup interval that deletes oldest traces first when limits are exceeded.
 */
export interface TraceRetentionConfig {
  /** Maximum age of a completed trace in milliseconds before deletion. */
  readonly maxAgeMs: number;

  /** Maximum disk space budget in bytes for completed traces before pruning oldest first. */
  readonly maxBytes: number;

  /** Interval in milliseconds between retention sweep runs. */
  readonly cleanupIntervalMs: number;
}

/**
 * Filesystem trace recording configuration snapshot.
 *
 * Controls whether per-request filesystem tracing is enabled, its root directory,
 * and disk retention bounds.
 */
export interface TracingConfig {
  /** Whether per-request filesystem trace recording is active. */
  readonly enabled: boolean;

  /** Filesystem root directory where per-request trace subdirectories are written. */
  readonly root: string;

  /** Age and size retention policies governing trace directory pruning. */
  readonly retention: TraceRetentionConfig;
}

/**
 * Structured logging configuration snapshot.
 *
 * Governs LogTape output enablement and minimum severity filtering.
 */
export interface LoggingConfig {
  /** Whether structured logging emits records. */
  readonly enabled: boolean;

  /** Minimum log severity level admitted by the LogTape sink. */
  readonly level: "debug" | "info" | "warning" | "error";
}

/**
 * Metrics collection configuration snapshot.
 *
 * Controls whether Prometheus metrics collection and the `/metrics` endpoint are enabled.
 */
export interface MetricsConfig {
  /** Whether Prometheus metrics collection and exposition are active. */
  readonly enabled: boolean;
}

/**
 * Dry-run execution configuration snapshot.
 *
 * When enabled, requests resolve candidates and prepare provider payloads without
 * leasing keys or making upstream network calls, returning a preview response.
 */
export interface DryRunConfig {
  /** Whether admitted requests generate preview responses without upstream dispatch. */
  readonly enabled: boolean;
}

/**
 * Immutable application configuration snapshot validated at startup.
 *
 * Unifies all subsystem configurations into a frozen root object shared across
 * the server, gateway, admission, and telemetry components.
 */
export interface AptusConfig {
  /** Client listener binding addresses and lifecycle bounds (timeouts, body limits, drain). */
  readonly server: ServerConfig;

  /** Operations listener binding addresses for unauthenticated health and metrics probes. */
  readonly operations: OperationsConfig;

  /** Client authentication credentials and CIDR network allowlists. */
  readonly auth: AuthConfig;

  /** Upstream provider configurations, key pools, and network transport settings. */
  readonly providers: readonly ProviderConfig[];

  /** Canonical single-candidate public models exposed to clients. */
  readonly models: readonly ModelConfig[];

  /** Fallback routing chains mapping public names to ordered model candidates. */
  readonly routes: readonly RouteConfig[];

  /** Routing and key pool timing policies shared across providers. */
  readonly routing: RoutingConfig;

  /** Filesystem trace recording settings and disk retention limits. */
  readonly tracing: TracingConfig;

  /** Structured logging enablement and minimum log severity. */
  readonly logging: LoggingConfig;

  /** Prometheus metrics collection and exposition settings. */
  readonly metrics: MetricsConfig;

  /** Dry-run preview execution mode toggle. */
  readonly dryRun: DryRunConfig;
}
