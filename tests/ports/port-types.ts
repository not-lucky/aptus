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
  TranslationContext,
} from "../../src/ports/index.js";
import type { CanonicalResponse, JsonValue, RouteCandidate } from "../../src/domain/index.js";

const signal = new AbortController().signal;
const candidate: RouteCandidate = { routeId: "route", providerId: "provider", credentialId: "credential", physicalModel: "model", capabilities: new Set(), estimatedCostUsd: 0 };
const response = {} as CanonicalResponse;
const context: TranslationContext = { requestId: "req", signal, trustedRoutingHeaders: { "x-route": "route" } };
const egressValue: EgressValue = "encoded";
const jsonRecord: Record<string, JsonValue> = { requestId: context.requestId, value: "encoded" };

const clock: ClockPort = { now: () => Date.now(), sleep: async (_delay, observed) => { if (observed !== signal) return; } };
const transport: ProviderTransportPort<{ id: string }, { ok: true }> = {
  request: async (request, observed) => { if (observed !== signal) throw new Error(request.id); return { ok: true }; },
  stream: async function* (_request, observed) { if (observed !== signal) return; yield new Uint8Array([1]); },
};
const secrets: SecretResolverPort = { resolve: async (reference, observed) => `${reference}:${observed === signal}` };
const credentials: CredentialStorePort<{ token: string }> = {
  get: async (_id, _signal) => ({ token: "redacted" }),
  set: async (_id, _value, _signal) => undefined,
};
const config: RouteConfigPort<{ route: string }> = { snapshot: () => ({ route: "route" }) };
const cache: CachePort = { get: async (_key, _signal) => response, set: async (_key, _value, _signal) => undefined };
const limits: RateLimitPort<{ cost: number }, { reservation: string }> = { reserve: async (_request, _signal) => ({ reservation: "r" }), release: async (_reservation) => undefined };
const metrics: MetricsPort = { incrementCounter: () => undefined, observeHistogram: () => undefined, setGauge: () => undefined };
const trace: TracePort = { record: async (_entry) => undefined };
const logger: LoggerPort = { log: async (_entry) => undefined };
const health: HealthPort<{ healthy: true }> = { check: async (_signal) => ({ healthy: true }) };
const state: CredentialStatePort = { state: (_id): CredentialState => "active", transition: (_id, _next) => undefined };

const dispatch: ProviderDispatchPort = {
  dispatch: async (_candidate, _request, _signal) => response,
  stream: async function* (_candidate, _request, _signal) { yield {} as never; },
};
const ingress: IngressTranslationAdapter = {
  protocol: "custom", paths: new Set(["/v1/custom"]), canTranslate: () => true,
  translate: (_input: RawIngressInput, _context: TranslationContext) => ({}) as never,
};
const egress: EgressTranslationAdapter = {
  protocol: "custom", encodeResponse: () => "response", encodeChunk: () => "chunk", encodeError: () => "error",
};

void [clock, transport, secrets, credentials, config, cache, limits, metrics, trace, logger, health, state, dispatch, ingress, egress, candidate, context, egressValue, jsonRecord];

// @ts-expect-error readonly candidate capabilities cannot be mutated through the port view
candidate.capabilities.add("tools");
// @ts-expect-error readonly transport signal is required
void clock.sleep(1, new Event("abort"));
// @ts-expect-error credential states are a closed union
state.transition("credential", "ready");
// @ts-expect-error trusted routing headers are readonly
context.trustedRoutingHeaders["x-route"] = "changed";
