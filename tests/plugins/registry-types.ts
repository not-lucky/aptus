import type {
  GatewayContext,
  GatewayPlugin,
  HookManager,
  HookName,
  HookResult,
} from "../../src/application/index.js";
import {
  PluginRegistrationError,
  PluginRegistry,
  type ObserverFailurePolicy,
  type PluginRegistration,
  type PluginRegistrationIssue,
  type PluginRegistryOptions,
  type PluginResource,
} from "../../src/plugins/index.js";

const hooks = [
  "onIngressReceived",
  "onCanonicalTranslate",
  "onRouteResolve",
  "beforeUpstreamDispatch",
  "onUpstreamResponse",
  "onStreamChunk",
  "onEgressTranslate",
  "onError",
] as const satisfies ReadonlyArray<HookName>;

const results: ReadonlyArray<HookResult<string>> = [
  { kind: "continue" },
  { kind: "replace", value: "replacement" },
  { kind: "shortCircuit", value: "terminal" },
  {
    kind: "abort",
    error: {
      code: "fixed",
      message: "fixed",
      category: "internal",
      retryable: false,
      status: 500,
      requestId: "request-1",
    },
  },
];

const plugin: GatewayPlugin = {
  id: "authentication",
  version: "1.0.0",
  hooks: [],
  priority: 0,
};
const resource: PluginResource = { plugin, parallelObserverHooks: [] };
const registration: PluginRegistration = { ...resource, enabled: true };
const policy: ObserverFailurePolicy = "abort";
const options: PluginRegistryOptions = { observerFailurePolicy: policy };
const registry: HookManager = new PluginRegistry([registration], options);
const issue: PluginRegistrationIssue = {
  pluginId: plugin.id,
  message: "fixed",
};
const error = new PluginRegistrationError([issue]);

function exactManager(manager: HookManager, context: GatewayContext): void {
  manager.register(plugin);
  void manager.run("onIngressReceived", context, context.request);
  const ordered: ReadonlyArray<GatewayPlugin> =
    manager.ordered("onIngressReceived");
  const closed: Promise<void> = manager.close();
  void ordered;
  void closed;
}

void hooks;
void results;
void registry;
void error;
void exactManager;
