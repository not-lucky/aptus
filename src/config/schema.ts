import { z } from "zod";

const NonEmpty = z.string().trim().min(1);
const Id = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const PositiveInt = z.number().int().positive();
const NonNegative = z.number().finite().nonnegative();
const Protocol = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "custom"]);
const Capability = NonEmpty;
const JsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([JsonPrimitive, z.array(JsonValue), z.record(z.string(), JsonValue)]));
const SecretRef = z.string().regex(/^(env|secretmanager|file):[^\s]+$/, "secretRef must name a resolver and reference");
const HeaderMap = z.record(z.string().regex(/^[A-Za-z0-9-]+$/), NonEmpty);

const Limits = z.object({ rpm: PositiveInt, tpm: PositiveInt, dailyTokens: PositiveInt, dailyCostUsd: NonNegative });
const Server = z.object({
  port: z.literal(11248),
  cors: z.object({ origins: z.array(z.string().url()).min(1) }),
  bodyTimeoutMs: PositiveInt,
  requestTimeoutMs: PositiveInt,
  streamIdleTimeoutMs: PositiveInt,
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  trace: z.object({ enabled: z.boolean(), destination: z.enum(["stdout", "file"]) }),
  metrics: z.object({ enabled: z.boolean(), path: z.literal("/metrics") }),
  health: z.object({ path: z.literal("/health"), upstreamCheck: z.boolean() }),
  defaultDryRun: z.boolean(),
}).superRefine((value, context) => {
  if (value.bodyTimeoutMs > value.requestTimeoutMs) {
    context.addIssue({ code: "custom", path: ["bodyTimeoutMs"], message: "body timeout cannot exceed request timeout" });
  }
  if (value.streamIdleTimeoutMs > value.requestTimeoutMs) {
    context.addIssue({ code: "custom", path: ["streamIdleTimeoutMs"], message: "stream idle timeout cannot exceed request timeout" });
  }
});
const Client = z.object({ id: Id, tokenHashRef: SecretRef, limits: Limits, allowedModelAliases: z.array(Id).min(1), dryRun: z.boolean().optional() });
const Credential = z.object({ id: Id, secretRef: SecretRef, weight: PositiveInt });
const Provider = z.object({
  id: Id,
  protocol: Protocol,
  baseUrl: z.string().url(),
  timeoutMs: PositiveInt,
  customHeaders: HeaderMap,
  credentials: z.array(Credential).min(1),
  credentialSelection: z.enum(["fill-first", "round-robin", "weighted-round-robin", "least-connections"]),
}).superRefine((value, context) => {
  if (new Set(value.credentials.map((credential) => credential.id)).size !== value.credentials.length) {
    context.addIssue({ code: "custom", path: ["credentials"], message: "duplicate credential ID" });
  }
});
const Prices = z.object({ input: NonNegative, output: NonNegative, cacheRead: NonNegative, cacheWrite: NonNegative });
const Target = z.object({ providerId: Id, physicalModel: NonEmpty, pricesPerMillionUsd: Prices, capabilities: z.array(Capability), contextTokens: PositiveInt, defaults: z.record(z.string(), JsonValue).optional() });
const Model = z.object({ alias: Id, targets: z.array(Target).min(1) }).superRefine((value, context) => {
  if (new Set(value.targets.map((target) => `${target.providerId}:${target.physicalModel}`)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "duplicate model target" });
  }
});
const Condition = z.object({ field: NonEmpty, equals: JsonValue.optional() });
const Candidate = z.object({ providerId: Id, modelAlias: Id, weight: PositiveInt });
const AttemptBudget = z.object({ maxAttempts: PositiveInt, maxLatencyMs: PositiveInt, maxCostUsd: NonNegative });
const StatusPolicy = z.object({ retryable: z.array(z.number().int().min(400).max(599)), nonRetryable: z.array(z.number().int().min(400).max(599)) }).superRefine((value, context) => {
  if (value.retryable.some((status) => value.nonRetryable.includes(status))) {
    context.addIssue({ code: "custom", message: "status cannot be both retryable and nonRetryable" });
  }
});
const Route = z.object({ id: Id, modelAliases: z.array(Id).min(1), orderedCandidates: z.array(Candidate).min(1), requiredCapabilities: z.array(Capability), conditions: z.array(Condition), fallbackGroups: z.array(Id), attemptBudget: AttemptBudget, statusPolicy: StatusPolicy });
const Plugin = z.object({ id: Id, version: z.string().regex(/^\d+\.\d+\.\d+$/), enabled: z.boolean(), hooks: z.array(z.enum(["onIngressReceived", "onCanonicalTranslate", "onRouteResolve", "beforeUpstreamDispatch", "onUpstreamResponse", "onStreamChunk", "onEgressTranslate", "onError"])), priority: z.number().int(), before: z.array(Id).optional(), after: z.array(Id).optional(), options: z.record(z.string(), JsonValue).optional() });

/** Structural, secret-reference-only validation boundary for gateway configuration. */
export const GatewayConfigSchema = z.object({ server: Server, clients: z.array(Client).min(1), providers: z.array(Provider).min(1), models: z.array(Model).min(1), routes: z.array(Route).min(1), plugins: z.array(Plugin) }).superRefine((value, context) => {
  const unique = (values: string[], path: string): void => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [path], message: `duplicate ${path} ID` });
  };
  unique(value.clients.map((client) => client.id), "clients");
  unique(value.providers.map((provider) => provider.id), "providers");
  unique(value.models.map((model) => model.alias), "models");
  unique(value.routes.map((route) => route.id), "routes");
  unique(value.plugins.map((plugin) => plugin.id), "plugins");

  const providerIds = new Set(value.providers.map((provider) => provider.id));
  const modelAliases = new Set(value.models.map((model) => model.alias));
  const routeIds = new Set(value.routes.map((route) => route.id));
  const pluginIds = new Set(value.plugins.map((plugin) => plugin.id));
  value.clients.forEach((client, clientIndex) => client.allowedModelAliases.forEach((alias) => {
    if (!modelAliases.has(alias)) context.addIssue({ code: "custom", path: ["clients", clientIndex, "allowedModelAliases"], message: `unknown model alias ${alias}` });
  }));
  value.models.forEach((model, modelIndex) => model.targets.forEach((target) => {
    if (!providerIds.has(target.providerId)) context.addIssue({ code: "custom", path: ["models", modelIndex, "targets"], message: `unknown provider ${target.providerId}` });
  }));
  value.routes.forEach((route, routeIndex) => {
    route.modelAliases.forEach((alias) => {
      if (!modelAliases.has(alias)) context.addIssue({ code: "custom", path: ["routes", routeIndex], message: `unknown model alias ${alias}` });
    });
    route.orderedCandidates.forEach((candidate, candidateIndex) => {
      if (!providerIds.has(candidate.providerId)) context.addIssue({ code: "custom", path: ["routes", routeIndex, "orderedCandidates", candidateIndex, "providerId"], message: `unknown provider ${candidate.providerId}` });
      if (!modelAliases.has(candidate.modelAlias)) context.addIssue({ code: "custom", path: ["routes", routeIndex, "orderedCandidates", candidateIndex, "modelAlias"], message: `unknown candidate model ${candidate.modelAlias}` });
      if (!route.modelAliases.includes(candidate.modelAlias)) context.addIssue({ code: "custom", path: ["routes", routeIndex, "orderedCandidates", candidateIndex, "modelAlias"], message: `candidate model ${candidate.modelAlias} is not enabled by route` });
      const model = value.models.find((item) => item.alias === candidate.modelAlias);
      if (model && !model.targets.some((target) => target.providerId === candidate.providerId)) context.addIssue({ code: "custom", path: ["routes", routeIndex, "orderedCandidates", candidateIndex], message: `candidate ${candidate.providerId}/${candidate.modelAlias} must match an actual model target` });
    });
    route.fallbackGroups.forEach((group) => {
      if (!routeIds.has(group)) context.addIssue({ code: "custom", path: ["routes", routeIndex, "fallbackGroups"], message: `unknown fallback route ${group}` });
    });
  });
  value.plugins.forEach((plugin, pluginIndex) => [...(plugin.before ?? []), ...(plugin.after ?? [])].forEach((dependency) => {
    if (!pluginIds.has(dependency)) context.addIssue({ code: "custom", path: ["plugins", pluginIndex], message: `unknown plugin dependency ${dependency}` });
    if (dependency === plugin.id) context.addIssue({ code: "custom", path: ["plugins", pluginIndex], message: "plugin cannot depend on itself" });
  }));
  const orderingEdges = new Map(value.plugins.map((plugin) => [plugin.id, [] as string[]]));
  value.plugins.forEach((plugin) => {
    for (const dependency of plugin.before ?? []) if (pluginIds.has(dependency)) orderingEdges.get(plugin.id)?.push(dependency);
    for (const dependency of plugin.after ?? []) if (pluginIds.has(dependency)) orderingEdges.get(dependency)?.push(plugin.id);
  });
  orderingEdges.forEach((edges) => edges.sort());
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      context.addIssue({ code: "custom", path: ["plugins"], message: `plugin dependency cycle: ${[...path, id].join(" -> ")}` });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of orderingEdges.get(id) ?? []) visit(next, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  [...pluginIds].sort().forEach((id) => visit(id, []));
  if (!new Set(value.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)).has("authentication")) {
    context.addIssue({ code: "custom", path: ["plugins"], message: "authentication plugin must be enabled" });
  }
});

/** Inferred validated gateway configuration containing references, never resolved secret values. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
