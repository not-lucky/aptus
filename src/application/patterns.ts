import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  ContentBlock,
  GatewayError,
  JsonValue,
  ProtocolNamespace,
} from "../domain/index.js";
import type { ProviderDispatchPort } from "../ports/dispatch.js";
import type {
  EgressTranslationAdapter,
  IngressTranslationAdapter,
  RawIngressInput,
} from "../ports/translation.js";
import type {
  GatewayPlugin,
  GatewayCommand,
  HookName,
  HookResult,
} from "./lifecycle.js";

/** Re-exports credential state ownership from the Ports layer. */
export type { CredentialState, CredentialStatePort } from "../ports/index.js";

/** Creates protocol translation ports for an injected protocol namespace. */
export interface ProtocolAdapterFactory {
  /** Creates an ingress adapter for a canonical source protocol. */
  createIngress(protocol: ProtocolNamespace): IngressTranslationAdapter;
  /** Creates an egress adapter for a canonical source protocol. */
  createEgress(protocol: ProtocolNamespace): EgressTranslationAdapter;
}

/** Creates provider dispatch ports without exposing SDK implementations. */
export interface ProviderFactory {
  /** Creates a dispatch port for one provider namespace. */
  create(providerId: string): ProviderDispatchPort;
}

/** Fluent builder that produces a validated canonical request. */
export interface CanonicalRequestBuilder {
  /** Appends one canonical message owned by the resulting request. */
  addMessage(message: CanonicalMessage): this;
  /** Sets the canonical model alias. */
  setModel(model: string): this;
  /** Validates and returns the built canonical request. */
  build(): CanonicalRequest;
}

/** Fluent builder for a provider payload represented only as JSON. */
export interface ProviderPayloadBuilder {
  /** Sets the canonical request source for payload generation. */
  setRequest(request: CanonicalRequest): this;
  /** Builds a provider payload with no SDK or transport objects. */
  build(): Record<string, JsonValue>;
}

/** Fluent builder for caller-redacted trace records. */
export interface TraceRecordBuilder {
  /** Sets the lifecycle phase represented by the record. */
  phase(name: HookName): this;
  /** Adds one JSON-safe record field. */
  field(name: string, value: JsonValue): this;
  /** Builds a record whose sensitive values were redacted by the builder. */
  build(): Record<string, JsonValue>;
}

/** Application facade consumed by outer transports and black-box callers. */
export interface GatewayApplication {
  /** Handles one raw ingress input and returns a response or safe gateway error. */
  handle(input: RawIngressInput): Promise<CanonicalResponse | GatewayError>;
  /** Streams bounded canonical chunks for one raw ingress input. */
  stream(input: RawIngressInput): AsyncIterable<CanonicalChunk>;
}

/** Applies an exhaustive operation to every canonical content-block variant. */
export interface ContentBlockVisitor<T> {
  /** Visits one discriminated canonical content block. */
  visit(block: ContentBlock): T;
}

/** Applies an exhaustive operation to every canonical stream-chunk variant. */
export interface ChunkVisitor<T> {
  /** Visits one discriminated canonical stream chunk. */
  visit(chunk: CanonicalChunk): T;
}

/** Plugin specialized to upstream outcomes and errors for cooldown updates. */
export interface CooldownPlugin extends GatewayPlugin {
  /** Restricts lifecycle declarations to the two cooldown-relevant hooks. */
  readonly hooks: ReadonlyArray<"onUpstreamResponse" | "onError">;
}

/** Decorator contract that forwards provider dispatch and stream operations. */
export interface ProviderDispatchDecorator extends ProviderDispatchPort {
  /** Inner port receiving forwarded calls exactly once. */
  readonly inner: ProviderDispatchPort;
}

/** Immutable ordered group of plugins. */
export type PluginGroup = ReadonlyArray<GatewayPlugin>;

/** Registry for path and protocol translation adapters. */
export interface AdapterRegistry {
  /** Looks up an ingress adapter by route path or throws a typed safe failure. */
  ingress(path: string, requestId?: string): IngressTranslationAdapter;
  /** Looks up an egress adapter by canonical source protocol or throws safely. */
  egress(
    protocol: ProtocolNamespace,
    requestId?: string,
  ): EgressTranslationAdapter;
}

/** Alias retaining the provider factory role at the adapter boundary. */
export type ProviderAdapterFactory = ProviderFactory;

/** Cancellable command associated with one plugin lifecycle hook. */
export interface HookCommand<T = unknown> extends GatewayCommand<
  HookResult<T>
> {
  /** Plugin owning this command. */
  readonly pluginId: string;
  /** Hook represented by this command. */
  readonly hook: HookName;
}

/** Trace value with schema, request, and lifecycle identity. */
export interface TraceRecord extends Record<string, JsonValue> {
  /** Trace schema version. */
  schemaVersion: number;
  /** Non-secret request identity. */
  requestId: string;
  /** Lifecycle phase represented by this record. */
  phase: HookName;
}

/** Proxy that guards and forwards provider dispatch operations. */
export interface GuardedDispatchProxy extends ProviderDispatchDecorator {}
/** Plugin role for route validation. */
export interface RouteValidation extends GatewayPlugin {}
/** Plugin role for cost accounting. */
export interface CostAudit extends GatewayPlugin {}
/** Plugin role for cache lookup. */
export interface CacheLookup extends GatewayPlugin {}
/** Decorator role for timeout enforcement. */
export interface TimeoutDecorator extends ProviderDispatchDecorator {}
/** Decorator role for retry-budget enforcement. */
export interface RetryBudgetDecorator extends ProviderDispatchDecorator {}
/** Decorator role for cost accounting around dispatch. */
export interface CostAuditDecorator extends ProviderDispatchDecorator {}
/** Decorator role for redacting trace observations. */
export interface RedactingTraceDecorator extends ProviderDispatchDecorator {}
