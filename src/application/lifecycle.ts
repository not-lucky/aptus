import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
  RouteCandidate,
} from "../domain/index.js";
import type { EgressValue, RawIngressInput } from "../ports/translation.js";

/** Lifecycle stages at which injected plugins may observe or transform values. */
export type HookName =
  | "onIngressReceived"
  | "onCanonicalTranslate"
  | "onRouteResolve"
  | "beforeUpstreamDispatch"
  | "onUpstreamResponse"
  | "onStreamChunk"
  | "onEgressTranslate"
  | "onError";

/** Explicit timeout and retry policy for each lifecycle hook. */
export type HookTimeoutConfiguration = Readonly<
  Record<HookName, { readonly timeoutMs: number; readonly retryable: boolean }>
>;

/** Generates a request identity when ingress did not provide one. */
export type RequestIdFactory = () => string;

/** Cancellable lifecycle command with optional caller-owned undo cleanup. */
export interface GatewayCommand<T = unknown> {
  /** Executes once while observing the supplied cancellation signal. */
  execute(signal: AbortSignal): Promise<T>;
  /** Undoes command-owned effects; the caller owns invocation timing. */
  undo?(): Promise<void>;
}

/** Monotonic request-local state indicating that egress bytes are committed. */
export interface DispatchCommitmentState {
  /** Returns whether a writer has synchronously committed egress bytes. */
  isCommitted(): boolean;
}

/** Request-scoped canonical exchange including the adapter-owned egress boundary. */
export interface GatewayExchange {
  /** Runs canonical non-stream processing. */
  handle(): Promise<CanonicalResponse | GatewayError>;
  /** Runs bounded canonical stream processing. */
  stream(): AsyncIterable<CanonicalChunk>;
  /** Runs the egress hook over one encoded adapter value. */
  runEgress(value: EgressValue): Promise<EgressValue | GatewayError>;
  /** Commits the prepared egress value and releases its stream gate. */
  commitEgress(): void;
  /** Finalizes the exchange and all request-owned resources. */
  close(): Promise<void>;
}

/** Opens an isolated request-scoped exchange. */
export interface GatewayExchangeFactory {
  /** Opens one isolated request-scoped exchange. */
  open(input: RawIngressInput): GatewayExchange;
}

/** Deterministic result used to retain, replace, short-circuit, or abort a stage. */
export type HookResult<T> =
  | { kind: "continue"; value?: T }
  | { kind: "replace"; value: T }
  | { kind: "shortCircuit"; value: T }
  | { kind: "abort"; error: GatewayError };

/** Safe authentication result exposed to request-scoped policy plugins. */
export interface GatewayAuthenticationResult {
  /** Stable safe client identity. */
  readonly clientId: string;
  /** Model aliases this client may route. */
  readonly allowedModelAliases: ReadonlySet<string>;
  /** Authenticated request and daily budget limits. */
  readonly limits: {
    /** Maximum requests per minute. */
    readonly rpm: number;
    /** Maximum tokens per minute. */
    readonly tpm: number;
    /** Maximum tokens per day. */
    readonly dailyTokens: number;
    /** Maximum daily cost in US dollars. */
    readonly dailyCostUsd: number;
  };
  /** Whether this client is restricted to dry-run execution. */
  readonly dryRun: boolean;
}

/** Injected capability that authenticates only at the outer boundary. */
export interface GatewayAuthenticationCapability {
  /** Resolves an outer authorization value into safe client policy data. */
  authenticate(
    authorization: string | undefined,
    signal: AbortSignal,
  ): Promise<GatewayAuthenticationResult | undefined>;
}
/** Request-local immutable snapshot plus namespaced mutable plugin state. */
export interface GatewayContext {
  /** Canonical request snapshot for the current stage. */
  readonly request: CanonicalRequest;
  /** Stable request identity. */
  readonly requestId: string;
  /** Cancellation signal owned by the request orchestrator. */
  readonly signal: AbortSignal;
  /** Monotonic commitment state for the adapter egress boundary. */
  readonly commitment: DispatchCommitmentState;
  /** Outer-boundary authorization view; never part of canonical request or state. */
  readonly authorization?: string;
  /** Safe authentication capability injected by the application boundary. */
  readonly auth: GatewayAuthenticationCapability;
  /** Sole shared mutable plugin-state mechanism for this request. */
  readonly state: Map<string, unknown>;
  /** Reads a typed namespaced state value. */
  getState<T>(key: string): T | undefined;
  /** Writes a typed namespaced state value. */
  setState<T>(key: string, value: T): void;
  /** Candidate selected for the current route stage, when available. */
  readonly selectedCandidate?: RouteCandidate;
  /** Executes a command and registers its undo after successful completion. */
  execute<T>(command: GatewayCommand<T>): Promise<T>;
}

/** Injected plugin contract with distinct typed lifecycle transformations. */
export interface GatewayPlugin {
  /** Stable plugin identifier. */
  readonly id: string;
  /** Validated plugin version. */
  readonly version: string;
  /** Lifecycle methods declared by this plugin. */
  readonly hooks: ReadonlyArray<HookName>;
  /** Stable ordering priority used by the registry. */
  readonly priority: number;
  /** Plugin IDs that must precede this plugin. */
  readonly before?: ReadonlyArray<string>;
  /** Plugin IDs that must follow this plugin. */
  readonly after?: ReadonlyArray<string>;
  /** Transforms the initial canonical request. */
  onIngressReceived?(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<HookResult<CanonicalRequest>> | HookResult<CanonicalRequest>;
  /** Transforms canonical normalization output. */
  onCanonicalTranslate?(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<HookResult<CanonicalRequest>> | HookResult<CanonicalRequest>;
  /** Transforms ordered route candidates. */
  onRouteResolve?(
    context: GatewayContext,
    candidates: ReadonlyArray<RouteCandidate>,
  ):
    | Promise<HookResult<ReadonlyArray<RouteCandidate>>>
    | HookResult<ReadonlyArray<RouteCandidate>>;
  /** Transforms the request immediately before dispatch. */
  beforeUpstreamDispatch?(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<HookResult<CanonicalRequest>> | HookResult<CanonicalRequest>;
  /** Transforms one complete upstream response. */
  onUpstreamResponse?(
    context: GatewayContext,
    response: CanonicalResponse,
  ): Promise<HookResult<CanonicalResponse>> | HookResult<CanonicalResponse>;
  /** Transforms one bounded canonical stream chunk. */
  onStreamChunk?(
    context: GatewayContext,
    chunk: CanonicalChunk,
  ): Promise<HookResult<CanonicalChunk>> | HookResult<CanonicalChunk>;
  /** Transforms one egress value after encoding. */
  onEgressTranslate?(
    context: GatewayContext,
    value: EgressValue,
  ): Promise<HookResult<EgressValue>> | HookResult<EgressValue>;
  /** Handles one owned safe gateway error. */
  onError?(
    context: GatewayContext,
    error: GatewayError,
  ): Promise<HookResult<GatewayError>> | HookResult<GatewayError>;
}

/** Orders and executes injected lifecycle plugins without owning their state. */
export interface HookManager {
  /** Registers one plugin for the process/application lifetime. */
  register(plugin: GatewayPlugin): void;
  /** Reduces one typed stage value through the ordered hook chain. */
  run<T>(
    hook: HookName,
    context: GatewayContext,
    value: T,
  ): Promise<HookResult<T>>;
  /** Returns the deterministic order for a lifecycle stage. */
  ordered(hook: HookName): ReadonlyArray<GatewayPlugin>;
  /** Releases manager-owned plugin resources. */
  close(): Promise<void>;
}
