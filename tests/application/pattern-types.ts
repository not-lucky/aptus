import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  ContentBlock,
  GatewayError,
  JsonValue,
  RouteCandidate,
} from "../../src/domain/index.js";
import type {
  AdapterRegistry,
  CacheLookup,
  CandidateIterator,
  CanonicalRequestBuilder,
  ChunkVisitor,
  ContentBlockVisitor,
  CostAudit,
  CostAuditDecorator,
  CooldownPlugin,
  CredentialSelectionStrategy,
  CredentialSelector,
  CredentialState,
  CredentialStatePort,
  FillFirst,
  FallbackGroup,
  GatewayApplication,
  GatewayCommand,
  GatewayContext,
  GatewayExchange,
  GatewayExchangeFactory,
  GatewayPlugin,
  GuardedDispatchProxy,
  HookCommand,
  HookManager,
  HookTimeoutConfiguration,
  HookName,
  HookResult,
  LeastConnections,
  ModelDescriptor,
  PluginGroup,
  ProtocolAdapterFactory,
  ProviderAdapterFactory,
  ProviderDispatchDecorator,
  ProviderFactory,
  ProviderPayloadBuilder,
  RedactingTraceDecorator,
  RetryBudgetDecorator,
  RouteAttempt,
  RouteResolver,
  RouteValidation,
  RoundRobin,
  SelectionStrategy,
  TimeoutDecorator,
  TraceRecord,
  TraceRecordBuilder,
  Weighted,
} from "../../src/application/index.js";
import type {
  EgressTranslationAdapter,
  IngressTranslationAdapter,
  ProviderDispatchPort,
  RawIngressInput,
} from "../../src/ports/index.js";

const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential",
  physicalModel: "model",
  capabilities: new Set(),
  estimatedCostUsd: 0,
};
const request = {} as CanonicalRequest;
const response = {} as never;
const error = {} as GatewayError;
const ingress = {} as IngressTranslationAdapter;
const egress = {} as EgressTranslationAdapter;
const dispatch: ProviderDispatchPort = {
  dispatch: async () => response,
  stream: async function* () {
    yield {} as CanonicalChunk;
  },
};

const resolver: RouteResolver = { resolve: async () => [candidate] };
const strategy: SelectionStrategy = { select: (candidates) => candidates };
const selector: CredentialSelector = { select: (candidates) => candidates };
const credentialStrategy: CredentialSelectionStrategy = selector;
const aliases: [FillFirst, RoundRobin, Weighted, LeastConnections] = [
  selector,
  selector,
  selector,
  selector,
];
const fallback: FallbackGroup = [candidate];
const iterator: CandidateIterator = {
  async *[Symbol.asyncIterator]() {
    yield candidate;
  },
};
const descriptor: ModelDescriptor = {
  alias: "test",
  physicalModel: "model",
  capabilities: new Set(),
  contextTokens: 1,
};
const attempt: RouteAttempt = {
  candidate,
  startedAt: "2026-07-19T00:00:00Z",
  emittedBytes: false,
};

const requestBuilder: CanonicalRequestBuilder = {
  addMessage: function (_message: CanonicalMessage) {
    return this;
  },
  setModel: function (_model: string) {
    return this;
  },
  build: () => request,
};
const payloadBuilder: ProviderPayloadBuilder = {
  setRequest: function (_request) {
    return this;
  },
  build: (): Record<string, JsonValue> => ({ ok: true }),
};
const traceBuilder: TraceRecordBuilder = {
  phase: function (_phase) {
    return this;
  },
  field: function (_name, _value) {
    return this;
  },
  build: (): Record<string, JsonValue> => ({ safe: true }),
};
const trace: TraceRecord = {
  schemaVersion: 1,
  requestId: "req",
  phase: "onError",
};
const factory: ProviderFactory = { create: () => dispatch };
const adapterFactory: ProtocolAdapterFactory = {
  createIngress: () => ingress,
  createEgress: () => egress,
};
const providerAdapterFactory: ProviderAdapterFactory = factory;
const registry: AdapterRegistry = {
  ingress: () => ingress,
  egress: () => egress,
};
const app: GatewayApplication = {
  handle: async () => response,
  stream: async function* () {
    yield {} as CanonicalChunk;
  },
};
const state: CredentialStatePort = {
  state: (): CredentialState => "active",
  snapshot: () => ({ state: "active", penaltyCount: 0 }),
  eligible: () => true,
  hasEligible: () => true,
  counts: () => ({ active: 1, cooldown: 0, critical_failure: 0, suspended: 0 }),
  failure: () => ({ state: "active", delayMs: 0, retryable: false }),
  success: () => undefined,
  quarantine: () => undefined,
  reset: () => undefined,
  probe: () => undefined,
};
const context: GatewayContext = {
  request,
  requestId: "req",
  signal: new AbortController().signal,
  commitment: { isCommitted: () => false },
  auth: { authenticate: async () => undefined },
  state: new Map(),
  getState: () => undefined,
  setState: () => undefined,
  execute: async (command) => command.execute(new AbortController().signal),
};
const exchange: GatewayExchange = {
  handle: async () => response,
  stream: async function* () {
    yield {} as CanonicalChunk;
  },
  runEgress: async (value) => value,
  commitEgress: () => undefined,
  close: async () => undefined,
};
const exchanges: GatewayExchangeFactory = { open: () => exchange };
const hookTimeouts: HookTimeoutConfiguration = {
  onIngressReceived: { timeoutMs: 1, retryable: false },
  onCanonicalTranslate: { timeoutMs: 1, retryable: false },
  onRouteResolve: { timeoutMs: 1, retryable: true },
  beforeUpstreamDispatch: { timeoutMs: 1, retryable: true },
  onUpstreamResponse: { timeoutMs: 1, retryable: true },
  onStreamChunk: { timeoutMs: 1, retryable: true },
  onEgressTranslate: { timeoutMs: 1, retryable: false },
  onError: { timeoutMs: 1, retryable: false },
};
const hookResult: HookResult<CanonicalResponse> = { kind: "continue" };
const manager: HookManager = {
  register: () => undefined,
  run: async <T>(
    _hook: HookName,
    _context: GatewayContext,
    _value: T,
  ): Promise<HookResult<T>> => ({ kind: "continue" }),
  ordered: () => [],
  close: async () => undefined,
};
const hookName: HookName = "onError";
const command: GatewayCommand<string> = {
  execute: async (signal) => (signal.aborted ? "aborted" : "done"),
  undo: async () => undefined,
};
const hookCommand: HookCommand<string> = {
  pluginId: "plugin",
  hook: "onError",
  execute: async () => ({ kind: "continue" }),
};
const plugin = {} as GatewayPlugin;
const group: PluginGroup = [plugin];
const decorator: ProviderDispatchDecorator = { ...dispatch, inner: dispatch };
const timeout: TimeoutDecorator = decorator;
const retry: RetryBudgetDecorator = decorator;
const cost: CostAudit = plugin;
const validation: RouteValidation = plugin;
const redacting: RedactingTraceDecorator = decorator;
const cooldown: CooldownPlugin = { ...plugin, hooks: ["onError"] };
const cacheLookup: CacheLookup = plugin;
const guarded: GuardedDispatchProxy = decorator;
const costDecorator: CostAuditDecorator = decorator;
const visitBlock: ContentBlockVisitor<string> = {
  visit: (block: ContentBlock) => block.type,
};
const visitChunk: ChunkVisitor<string> = {
  visit: (chunk: CanonicalChunk) => chunk.type,
};

void [
  resolver,
  strategy,
  aliases,
  credentialStrategy,
  iterator,
  descriptor,
  attempt,
  requestBuilder,
  payloadBuilder,
  traceBuilder,
  trace,
  factory,
  adapterFactory,
  providerAdapterFactory,
  registry,
  app,
  state,
  context,
  exchange,
  exchanges,
  hookTimeouts,
  manager,
  hookName,
  command,
  hookCommand,
  group,
  timeout,
  retry,
  cost,
  validation,
  redacting,
  cooldown,
  cacheLookup,
  guarded,
  costDecorator,
  visitBlock,
  visitChunk,
];

const input: RawIngressInput = { path: "/v1/custom", headers: {}, body: {} };
void input;
const badApp: GatewayApplication = {
  // @ts-expect-error facade must not return an SDK/HTTP object
  handle: async () => ({ sdkResponse: true }),
  stream: async function* () {
    yield {} as CanonicalChunk;
  },
};
void badApp;
const badDispatch: ProviderDispatchPort = {
  // @ts-expect-error dispatch must return a canonical response, not an SDK/HTTP object
  dispatch: async () => ({ sdkResponse: true }),
  stream: async function* () {
    yield {} as CanonicalChunk;
  },
};
void badDispatch;
// @ts-expect-error fallback groups expose a readonly array view
fallback.push(candidate);
