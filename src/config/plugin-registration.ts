import type { RouteConfigPort } from "../ports/index.js";
import {
  PluginRegistrationError,
  PluginRegistry,
  type PluginRegistrationIssue,
  type PluginRegistryOptions,
  type PluginResource,
} from "../plugins/index.js";
import type { GatewayConfig } from "./schema.js";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

function normalized(
  values: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  return [...new Set(values ?? [])].sort();
}

function sameValues(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Matches one immutable validated configuration snapshot to instantiated plugin
 * resources and constructs the enabled registry atomically. Configuration
 * options are intentionally not retained by the registry.
 */
export function createConfiguredPluginRegistry(
  configuration: RouteConfigPort<GatewayConfig>,
  resources: ReadonlyArray<PluginResource>,
  options?: PluginRegistryOptions,
): PluginRegistry {
  const config = configuration.snapshot();
  const issues: PluginRegistrationIssue[] = [];
  const configured = new Map(
    config.plugins.map((plugin) => [plugin.id, plugin]),
  );
  const validResources = new Map<string, PluginResource>();
  const counts = new Map<string, number>();

  if (!Array.isArray(resources)) {
    throw new PluginRegistrationError([
      { message: "invalid plugin registration" },
    ]);
  }
  for (const resource of resources as ReadonlyArray<unknown>) {
    if (resource === null || typeof resource !== "object") {
      issues.push({ message: "invalid plugin registration" });
      continue;
    }
    const candidate = resource as Partial<PluginResource>;
    const id = candidate.plugin?.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      issues.push({ message: "invalid plugin ID" });
      continue;
    }
    const configuredPlugin = configured.get(id);
    if (configuredPlugin !== undefined && !configuredPlugin.enabled) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!validResources.has(id))
      validResources.set(id, resource as PluginResource);
  }

  for (const id of [...counts.keys()].sort()) {
    const count = counts.get(id) ?? 0;
    if (count > 1)
      issues.push({
        pluginId: id,
        message: `duplicate plugin implementation ${id}`,
      });
    if (!configured.has(id))
      issues.push({
        pluginId: id,
        message: `unconfigured plugin implementation ${id}`,
      });
  }

  const registrations = [];
  for (const pluginConfig of [...config.plugins]
    .filter((plugin) => plugin.enabled)
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
    const resource = validResources.get(pluginConfig.id);
    if (resource === undefined) {
      issues.push({
        pluginId: pluginConfig.id,
        message: `missing plugin implementation ${pluginConfig.id}`,
      });
      continue;
    }
    const plugin = resource.plugin;
    const metadataMatches =
      plugin.id === pluginConfig.id &&
      plugin.version === pluginConfig.version &&
      Number.isFinite(plugin.priority) &&
      Number.isInteger(plugin.priority) &&
      plugin.priority === pluginConfig.priority &&
      sameValues(normalized(plugin.hooks), normalized(pluginConfig.hooks)) &&
      sameValues(normalized(plugin.before), normalized(pluginConfig.before)) &&
      sameValues(normalized(plugin.after), normalized(pluginConfig.after));
    if (!metadataMatches) {
      issues.push({
        pluginId: pluginConfig.id,
        message: `plugin metadata does not match configuration ${pluginConfig.id}`,
      });
      continue;
    }
    registrations.push({
      plugin,
      enabled: true,
      ...(resource.parallelObserverHooks !== undefined
        ? { parallelObserverHooks: resource.parallelObserverHooks }
        : {}),
      ...(resource.close !== undefined ? { close: resource.close } : {}),
    });
  }

  if (issues.length > 0) throw new PluginRegistrationError(issues);
  return options === undefined
    ? new PluginRegistry(registrations)
    : new PluginRegistry(registrations, options);
}
