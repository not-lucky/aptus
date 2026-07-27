import type {
  CachePort,
  ClockPort,
  CredentialState,
  CredentialStatePort,
  CredentialStorePort,
  EgressTranslationAdapter,
  EgressValue,
  HealthPort,
  IngressTranslationAdapter,
  LoggerPort,
  MetricsPort,
  ProviderDispatchPort,
  ProviderTransportPort,
  RateLimitPort,
  RawIngressInput,
  RouteConfigPort,
  SecretResolverPort,
  TracePort,
  StreamResponseMetadata,
  TranslationContext,
} from "../../src/ports/index.js";
import type {
  CanonicalResponse,
  JsonValue,
  RouteCandidate,
} from "../../src/domain/index.js";

const signal = new AbortController().signal;
const candidate: RouteCandidate = {
  routeId: "route",
  providerId: "provider",
  credentialId: "credential",
  physicalModel: "model",
  capabilities: new Set(),
  estimatedCostUsd: 0,
};
const response = {} as CanonicalResponse;
const context: TranslationContext = {
  requestId: "req",
  signal,
  trustedRoutingHeaders: { "x-route": "route" },
};
const streamResponse: Readonly<StreamResponseMetadata> = Object.freeze({
  responseId: "resp",
  model: "model",
  createdAt: "2026-07-21T12:00:00.000Z",
});
const streamContext: TranslationContext = Object.freeze({
  ...context,
  streamResponse,
});
const egressValue: EgressValue = "encoded";
const jsonRecord: Record<string, JsonValue> = {
  requestId: context.requestId,
  value: "encoded",
};

const clock: ClockPort = {
  now: () => Date.now(),
  sleep: async (_delay, observed) => {
    if (observed !== signal) return;
  },
};
const transport: ProviderTransportPort<{ id: string }, { ok: true }> = {
  request: async (request, observed) => {
    if (observed !== signal) throw new Error(request.id);
    return { ok: true };
  },
  stream: async function* (_request, observed) {
    if (observed !== signal) return;
    yield new Uint8Array([1]);
  },
};
const secrets: SecretResolverPort = {
  resolve: async (reference, observed) => `${reference}:${observed === signal}`,
};
const credentials: CredentialStorePort<{ token: string }> = {
  get: async (_id, _signal) => ({ token: "redacted" }),
  set: async (_id, _value, _signal) => undefined,
};
const config: RouteConfigPort<{ route: string }> = {
  snapshot: () => ({ route: "route" }),
};
const cache: CachePort = {
  get: async (_key, _signal) => response,
  set: async (_key, _value, _signal) => undefined,
};
const limits: RateLimitPort<{ cost: number }, { reservation: string }> = {
  reserve: async (_request, _signal) => ({ reservation: "r" }),
  release: async (_reservation) => undefined,
};
const metrics: MetricsPort = {
  incrementCounter: () => undefined,
  observeHistogram: () => undefined,
  setGauge: () => undefined,
};
const trace: TracePort = { record: async (_entry) => undefined };
const logger: LoggerPort = { log: async (_entry) => undefined };
const health: HealthPort<{ healthy: true }> = {
  check: async (_signal) => ({ healthy: true }),
};
const state: CredentialStatePort = {
  state: (_id): CredentialState => "active",
  snapshot: (_id) => ({ state: "active", penaltyCount: 0 }),
  eligible: (_id) => true,
  hasEligible: () => true,
  counts: () => ({ active: 1, cooldown: 0, critical_failure: 0, suspended: 0 }),
  failure: (_id, _outcome) => ({ state: "active", delayMs: 0, retryable: false }),
  success: (_id) => undefined,
  quarantine: (_id, _audit) => undefined,
  reset: (_id, _audit) => undefined,
  probe: (_id) => undefined,
};

const dispatch: ProviderDispatchPort = {
  dispatch: async (_candidate, _request, _signal) => response,
  stream: async function* (_candidate, _request, _signal) {
    yield {} as never;
  },
};
const ingress: IngressTranslationAdapter = {
  protocol: "custom",
  paths: new Set(["/v1/custom"]),
  canTranslate: () => true,
  translate: (_input: RawIngressInput, _context: TranslationContext) =>
    ({}) as never,
};
const egress: EgressTranslationAdapter = {
  protocol: "custom",
  encodeResponse: () => "response",
  encodeChunk: () => "chunk",
  encodeError: () => "error",
};

void [
  clock,
  transport,
  secrets,
  credentials,
  config,
  cache,
  limits,
  metrics,
  trace,
  logger,
  health,
  state,
  dispatch,
  ingress,
  egress,
  candidate,
  context,
  egressValue,
  jsonRecord,
];

// @ts-expect-error readonly candidate capabilities cannot be mutated through the port view
candidate.capabilities.add("tools");
// @ts-expect-error readonly transport signal is required
void clock.sleep(1, new Event("abort"));
// @ts-expect-error credential failure kinds are a closed union
state.failure("credential", { kind: "ready" });
// @ts-expect-error trusted routing headers are readonly
context.trustedRoutingHeaders["x-route"] = "changed";
