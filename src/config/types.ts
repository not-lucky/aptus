import type { HeaderMap, JsonObject, Protocol } from "../domain/contracts.js";
import type { IrFailureCategory } from "../domain/operations.js";
import type { DecimalUsdPerMillion, PricingConfig } from "../domain/pricing.js";

export type { DecimalUsdPerMillion, PricingConfig };

/** A resolved secret. It can be read only by bootstrap and request preparation. */
export type SecretString = string & { readonly __secret: unique symbol };

/** A CIDR used to trust proxy forwarding headers. */
export type Cidr = string;

/** Client listener and lifecycle limits. */
export interface ServerConfig {
  /** Bind host. Default `0.0.0.0`. */
  readonly host: string;
  /** Bind TCP port. Default `8080`. */
  readonly port: number;
  /** Maximum identity-encoded request body. Default 32 MiB. */
  readonly bodyLimitBytes: number;
  /** Process-local accepted request limit. Default `1000`. */
  readonly maxInFlight: number;
  /** Total request deadline, including waits and body relay. Default 600000 ms. */
  readonly requestDeadlineMs: number;
  /** Maximum interval between upstream stream bytes. Default 60000 ms. */
  readonly streamIdleMs: number;
  /** Graceful shutdown drain limit. Default 30000 ms. */
  readonly shutdownDrainMs: number;
  /** Proxy CIDRs whose forwarding headers Aptus accepts. Default empty. */
  readonly trustedProxyCidrs: readonly Cidr[];
}

/** Unauthenticated operations listener. */
export interface OperationsConfig {
  /** Bind host. Default `127.0.0.1`. */
  readonly host: string;
  /** Bind TCP port. Default `9090`. */
  readonly port: number;
}

/** One authenticated client identity. */
export interface ClientKeyConfig {
  /** Unique safe name used in logs, never the credential. */
  readonly name: string;
  /** Secret resolved from an exact environment reference. */
  readonly secret: SecretString;
  /** Allowed canonical names and aliases. Omission means all public names. */
  readonly allow?: readonly string[];
}

/** Client authentication configuration. */
export interface AuthConfig {
  /** Non-empty client keys with unique names and resolved secrets. */
  readonly clientKeys: readonly ClientKeyConfig[];
}

/** Provider key selection algorithm. */
export type KeyStrategy = "fill-first" | "round-robin";

/** One named provider credential. */
export interface ProviderKeyConfig {
  /** Name unique within its Key Pool. */
  readonly name: string;
  /** Environment-resolved provider secret. */
  readonly secret: SecretString;
  /** Whether routing can acquire this key. Default `true`. */
  readonly enabled: boolean;
}

/** One protocol-specific provider and Key Pool. */
export interface ProviderConfig {
  /** Name unique across providers. */
  readonly name: string;
  /** Exactly one Provider Protocol. */
  readonly protocol: Protocol;
  /** HTTP or HTTPS API root with no user-info, query, fragment, or trailing slash after normalization. */
  readonly baseUrl: string;
  /** Provider-native static end-to-end headers with lower-case unique names. */
  readonly headers: HeaderMap;
  /** Ordered non-empty provider keys. Duplicate resolved secrets within this array are fatal. */
  readonly keys: readonly ProviderKeyConfig[];
  /** Key selection strategy. */
  readonly keyStrategy: KeyStrategy;
}

/** OpenAI local catalog metadata. */
export interface OpenAiCatalogMetadata {
  /** Unix creation time in seconds. */
  readonly created: number;
  /** Organization owner string. */
  readonly ownedBy: string;
}

/** Nullable Anthropic model capability indicators. */
export interface AnthropicCapabilities {
  /** Batch support, or null when not asserted. */
  readonly batch: boolean | null;
  /** Citation support, or null when not asserted. */
  readonly citations: boolean | null;
  /** Code-execution support, or null when not asserted. */
  readonly codeExecution: boolean | null;
  /** Image input support, or null when not asserted. */
  readonly imageInput: boolean | null;
  /** PDF input support, or null when not asserted. */
  readonly pdfInput: boolean | null;
  /** Structured-output support, or null when not asserted. */
  readonly structuredOutput: boolean | null;
  /** Thinking support, or null when not asserted. */
  readonly thinking: boolean | null;
}

/** Anthropic local catalog metadata. */
export interface AnthropicCatalogMetadata {
  /** RFC 3339 creation timestamp. */
  readonly createdAt: string;
  /** Client-visible display name. */
  readonly displayName: string;
  /** Informational capabilities. They never gate dispatch. */
  readonly capabilities: AnthropicCapabilities | null;
  /** Informational input-token limit, or null. */
  readonly maxInputTokens: number | null;
  /** Informational output-token limit, or null. */
  readonly maxOutputTokens: number | null;
}

/** Metadata needed to build both supported local catalog envelopes. */
export interface CatalogMetadata {
  /** OpenAI envelope fields. */
  readonly openai: OpenAiCatalogMetadata;
  /** Anthropic envelope fields. */
  readonly anthropic: AnthropicCatalogMetadata;
}

/** One canonical Public Model. */
export interface ModelConfig {
  /** Canonical public name in the global namespace. */
  readonly name: string;
  /** Unique input-only aliases. */
  readonly aliases: readonly string[];
  /** Referenced Provider name. */
  readonly provider: string;
  /** Provider-native model ID. */
  readonly upstreamModel: string;
  /** Absent-only native defaults. */
  readonly defaults: JsonObject;
  /** Provider-native extension merge. */
  readonly extraBody: JsonObject;
  /** Final replacing native merge. */
  readonly overrides: JsonObject;
  /** Required local catalog metadata. */
  readonly catalog: CatalogMetadata;
  /** Optional estimated-cost inputs. */
  readonly pricing: PricingConfig | null;
}

/** One ordered fallback Route. */
export interface RouteConfig {
  /** Canonical public name in the global namespace. */
  readonly name: string;
  /** Unique input-only aliases. */
  readonly aliases: readonly string[];
  /** Non-empty ordered canonical Public Model references. */
  readonly candidates: readonly string[];
  /** Categories that permit up to two same-Candidate retries. Empty disables retry. */
  readonly retryOn: readonly IrFailureCategory[];
  /** Categories that permit the next Candidate. Empty disables fallback. */
  readonly fallbackOn: readonly IrFailureCategory[];
  /** Required route-owned local catalog metadata. */
  readonly catalog: CatalogMetadata;
}

/** Adaptive process-local Key Pool timing. */
export interface KeyPoolConfig {
  /** Exactly two positive cooldown rungs. Defaults to `[250, 1000]`. */
  readonly failureCooldownMs: readonly [number, number];
  /** Delay used when a 429 has no usable provider delay. Default 1000 ms. */
  readonly rateLimitFallbackMs: number;
  /** Maximum base retry delay. Default 30000 ms. */
  readonly maxRetryAfterMs: number;
  /** Uniform added jitter ratio in `[0, 1]`. Default `0.25`. */
  readonly jitterRatio: number;
}

/** Routing runtime settings. */
export interface RoutingConfig {
  /** Adaptive key settings. */
  readonly keyPool: KeyPoolConfig;
}

/** Completed-Trace retention settings. */
export interface TraceRetentionConfig {
  /** Maximum completed Trace age. Default seven days. */
  readonly maxAgeMs: number;
  /** Maximum total completed Trace bytes. Default one GiB. */
  readonly maxBytes: number;
  /** Cleanup timer interval. Default one hour. */
  readonly cleanupIntervalMs: number;
}

/** Full-payload file tracing settings. */
export interface TracingConfig {
  /** Enables Trace creation. Default `true`. */
  readonly enabled: boolean;
  /** Trace root path. Default `./traces`. */
  readonly root: string;
  /** Bounded completed-Trace retention. */
  readonly retention: TraceRetentionConfig;
}

/** LogTape settings. */
export interface LoggingConfig {
  /** Enables structured logs. Default `true`. */
  readonly enabled: boolean;
  /** Minimum LogTape level. Default `info`. */
  readonly level: "debug" | "info" | "warning" | "error";
}

/** Prometheus export settings. */
export interface MetricsConfig {
  /** Enables metric collection and `/metrics`. Default `true`. */
  readonly enabled: boolean;
}

/** Global dry-run behavior. */
export interface DryRunConfig {
  /** Makes all accepted create requests run without dispatch. Default `false`. */
  readonly enabled: boolean;
}

/** The deeply frozen startup config snapshot. */
export interface AptusConfig {
  /** Client listener and lifecycle limits. */
  readonly server: ServerConfig;
  /** Operations listener. */
  readonly operations: OperationsConfig;
  /** Client keys. */
  readonly auth: AuthConfig;
  /** Providers with distinct protocol-specific Key Pools. */
  readonly providers: readonly ProviderConfig[];
  /** Canonical Public Models. */
  readonly models: readonly ModelConfig[];
  /** Canonical Routes. */
  readonly routes: readonly RouteConfig[];
  /** Routing and key timing. */
  readonly routing: RoutingConfig;
  /** Trace settings. */
  readonly tracing: TracingConfig;
  /** Log settings. */
  readonly logging: LoggingConfig;
  /** Metric settings. */
  readonly metrics: MetricsConfig;
  /** Dry-run settings. */
  readonly dryRun: DryRunConfig;
}
