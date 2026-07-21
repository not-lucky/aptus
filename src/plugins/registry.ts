import type {
  GatewayCommand,
  GatewayContext,
  GatewayPlugin,
  HookManager,
  HookName,
  HookResult,
} from "../application/index.js";
import {
  createGatewayError,
  type CanonicalChunk,
  type CanonicalRequest,
  type CanonicalResponse,
  type GatewayError,
  type RouteCandidate,
} from "../domain/index.js";

/** Failure handling for explicitly parallel, isolated observer hooks. */
export type ObserverFailurePolicy = "abort" | "isolate";

/**
 * One instantiated plugin plus lifecycle metadata owned by its registry.
 *
 * Observer hooks receive private structured clones and may only continue. A
 * closer must not call back into the registry; in particular, awaiting a
 * reentrant `close()` would deadlock on the closer that is currently running.
 */
export interface PluginResource {
  /** The instantiated plugin implementation. */
  readonly plugin: GatewayPlugin;
  /** Declared hooks that are read-only and eligible for parallel execution. */
  readonly parallelObserverHooks?: ReadonlyArray<HookName>;
  /** Releases this resource once when the owning registry closes. */
  readonly close?: () => void | Promise<void>;
}

/** A plugin resource and whether it belongs to the enabled registry snapshot. */
export interface PluginRegistration extends PluginResource {
  /** Whether this registration participates in validation, ordering, and execution. */
  readonly enabled: boolean;
}

/** Construction options for a plugin registry. */
export interface PluginRegistryOptions {
  /** Observer failures abort by default; `isolate` skips failed observers. */
  readonly observerFailurePolicy?: ObserverFailurePolicy;
}

/** One bounded, safe plugin registration diagnostic. */
export interface PluginRegistrationIssue {
  /** Validated plugin identity associated with the issue, when available. */
  readonly pluginId?: string;
  /** Fixed safe diagnostic text. */
  readonly message: string;
}

/** Aggregate validation failure produced before a registry snapshot is committed. */
export class PluginRegistrationError extends Error {
  /** Frozen safe diagnostics copied from the rejected snapshot. */
  readonly issues: ReadonlyArray<PluginRegistrationIssue>;

  /** Creates a fixed registration error with copied, frozen diagnostics. */
  constructor(issues: ReadonlyArray<PluginRegistrationIssue>) {
    super("plugin registration failed");
    this.name = "PluginRegistrationError";
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          ...(issue.pluginId !== undefined ? { pluginId: issue.pluginId } : {}),
          message: issue.message,
        }),
      ),
    );
  }
}

const HOOK_NAMES = Object.freeze([
  "onIngressReceived",
  "onCanonicalTranslate",
  "onRouteResolve",
  "beforeUpstreamDispatch",
  "onUpstreamResponse",
  "onStreamChunk",
  "onEgressTranslate",
  "onError",
] as const satisfies ReadonlyArray<HookName>);
const HOOK_NAME_SET: ReadonlySet<string> = new Set(HOOK_NAMES);
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CLOSED_ERROR = "plugin registry is closed";

type EgressHookValue = Parameters<
  NonNullable<GatewayPlugin["onEgressTranslate"]>
>[1];

interface InternalRegistration {
  readonly plugin: GatewayPlugin;
  readonly observerHooks: ReadonlySet<HookName>;
  readonly close?: () => void | Promise<void>;
}

interface RegistryState {
  readonly registrations: ReadonlyArray<InternalRegistration>;
  readonly ordered: Readonly<
    Record<HookName, ReadonlyArray<InternalRegistration>>
  >;
  readonly totalOrder: ReadonlyArray<InternalRegistration>;
}

interface IndexedIssue extends PluginRegistrationIssue {
  readonly order: number;
  readonly check: number;
}

interface CandidateRegistration {
  readonly inputIndex: number;
  readonly pluginId: string;
  readonly plugin: GatewayPlugin;
  readonly observerHooks: ReadonlySet<HookName>;
  readonly close?: () => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHookName(value: unknown): value is HookName {
  return typeof value === "string" && HOOK_NAME_SET.has(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function addIssue(
  issues: IndexedIssue[],
  order: number,
  check: number,
  message: string,
  pluginId?: string,
): void {
  issues.push({
    order,
    check,
    message,
    ...(pluginId !== undefined ? { pluginId } : {}),
  });
}

function sortedIssues(
  issues: ReadonlyArray<IndexedIssue>,
): ReadonlyArray<PluginRegistrationIssue> {
  return [...issues]
    .sort((left, right) => left.order - right.order || left.check - right.check)
    .map(({ pluginId, message }) =>
      Object.freeze({
        ...(pluginId !== undefined ? { pluginId } : {}),
        message,
      }),
    );
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function getPluginMethod(
  plugin: Record<string, unknown>,
  hook: HookName,
): unknown {
  return plugin[hook];
}

function validateSnapshot(input: unknown): RegistryState {
  const issues: IndexedIssue[] = [];
  if (!Array.isArray(input)) {
    throw new PluginRegistrationError([
      { message: "invalid plugin registration" },
    ]);
  }

  const validIdCounts = new Map<string, number>();
  for (const registration of input) {
    if (!isRecord(registration) || !isRecord(registration["plugin"])) continue;
    const id = registration["plugin"]["id"];
    if (isValidId(id)) validIdCounts.set(id, (validIdCounts.get(id) ?? 0) + 1);
  }
  const orderedValidIds = [...validIdCounts.keys()].sort();
  const idOrder = new Map(orderedValidIds.map((id, index) => [id, index]));
  const malformedBase = orderedValidIds.length;
  const duplicateReported = new Set<string>();
  const allIds = new Map<
    string,
    { readonly enabled: boolean; readonly inputIndex: number }
  >();
  const candidates: CandidateRegistration[] = [];

  input.forEach((rawRegistration, inputIndex) => {
    if (
      !isRecord(rawRegistration) ||
      typeof rawRegistration["enabled"] !== "boolean" ||
      !isRecord(rawRegistration["plugin"])
    ) {
      addIssue(
        issues,
        malformedBase + inputIndex,
        0,
        "invalid plugin registration",
      );
      return;
    }
    const rawPlugin = rawRegistration["plugin"];
    const rawId = rawPlugin["id"];
    if (!isValidId(rawId)) {
      addIssue(issues, malformedBase + inputIndex, 1, "invalid plugin ID");
      return;
    }
    const order = idOrder.get(rawId) ?? malformedBase + inputIndex;
    if ((validIdCounts.get(rawId) ?? 0) > 1 && !duplicateReported.has(rawId)) {
      duplicateReported.add(rawId);
      addIssue(issues, order, 1, `duplicate plugin ID ${rawId}`, rawId);
    }
    if (!allIds.has(rawId))
      allIds.set(rawId, { enabled: rawRegistration["enabled"], inputIndex });
    if (!rawRegistration["enabled"]) return;

    if (
      typeof rawPlugin["version"] !== "string" ||
      !VERSION_PATTERN.test(rawPlugin["version"])
    ) {
      addIssue(issues, order, 2, "invalid plugin version", rawId);
    }
    if (
      typeof rawPlugin["priority"] !== "number" ||
      !Number.isFinite(rawPlugin["priority"]) ||
      !Number.isInteger(rawPlugin["priority"])
    ) {
      addIssue(
        issues,
        order,
        3,
        "plugin priority must be a finite integer",
        rawId,
      );
    }

    const rawHooks = asArray(rawPlugin["hooks"]);
    const hooks = new Set<HookName>();
    if (rawHooks === undefined) {
      addIssue(issues, order, 4, "unknown plugin hook", rawId);
    } else {
      for (const hook of rawHooks) {
        if (isHookName(hook)) hooks.add(hook);
        else addIssue(issues, order, 4, "unknown plugin hook", rawId);
      }
    }

    const dependencies: Array<{ readonly id: string; readonly check: number }> =
      [];
    for (const [field, check] of [
      ["before", 5],
      ["after", 5],
    ] as const) {
      const rawDependencies = rawPlugin[field];
      if (rawDependencies === undefined) continue;
      const values = asArray(rawDependencies);
      if (values === undefined) {
        addIssue(issues, order, check, "invalid plugin dependency ID", rawId);
        continue;
      }
      for (const dependency of values) {
        if (isValidId(dependency)) dependencies.push({ id: dependency, check });
        else
          addIssue(issues, order, check, "invalid plugin dependency ID", rawId);
      }
    }

    for (const hook of hooks) {
      if (typeof getPluginMethod(rawPlugin, hook) !== "function") {
        addIssue(
          issues,
          order,
          9,
          `declared hook ${hook} has no method`,
          rawId,
        );
      }
    }

    const observerHooks = new Set<HookName>();
    const rawObservers = rawRegistration["parallelObserverHooks"];
    if (rawObservers !== undefined) {
      const values = asArray(rawObservers);
      if (values === undefined) {
        addIssue(issues, order, 10, "invalid plugin registration", rawId);
      } else {
        for (const hook of values) {
          if (!isHookName(hook))
            addIssue(issues, order, 10, "invalid plugin registration", rawId);
          else if (!hooks.has(hook))
            addIssue(
              issues,
              order,
              10,
              `parallel observer hook ${hook} must be declared`,
              rawId,
            );
          else observerHooks.add(hook);
        }
      }
    }
    const close = rawRegistration["close"];
    if (close !== undefined && typeof close !== "function") {
      addIssue(issues, order, 0, "invalid plugin registration", rawId);
    }

    candidates.push({
      inputIndex,
      pluginId: rawId,
      plugin: rawPlugin as unknown as GatewayPlugin,
      observerHooks,
      ...(typeof close === "function"
        ? { close: close as () => void | Promise<void> }
        : {}),
    });

    for (const dependency of dependencies) {
      if (dependency.id === rawId)
        addIssue(issues, order, 7, "plugin cannot depend on itself", rawId);
    }
  });

  for (const candidate of candidates) {
    const order =
      idOrder.get(candidate.pluginId) ?? malformedBase + candidate.inputIndex;
    const pluginRecord = candidate.plugin as unknown as Record<string, unknown>;
    for (const field of ["before", "after"] as const) {
      const dependencies = asArray(pluginRecord[field]);
      if (dependencies === undefined) continue;
      for (const rawDependency of dependencies) {
        if (!isValidId(rawDependency) || rawDependency === candidate.pluginId)
          continue;
        const dependency = allIds.get(rawDependency);
        if (dependency === undefined) {
          addIssue(
            issues,
            order,
            6,
            `unknown plugin dependency ${rawDependency}`,
            candidate.pluginId,
          );
        } else if (!dependency.enabled) {
          addIssue(
            issues,
            order,
            8,
            `enabled plugin dependency ${rawDependency} is disabled`,
            candidate.pluginId,
          );
        }
      }
    }
  }

  if (
    !candidates.some((candidate) => candidate.pluginId === "authentication")
  ) {
    addIssue(
      issues,
      malformedBase + input.length,
      11,
      "authentication plugin must be enabled",
    );
  }
  if (issues.length > 0)
    throw new PluginRegistrationError(sortedIssues(issues));

  const registrations = Object.freeze(
    candidates.map((candidate) =>
      Object.freeze({
        plugin: candidate.plugin,
        observerHooks: candidate.observerHooks,
        ...(candidate.close !== undefined ? { close: candidate.close } : {}),
      }),
    ),
  );
  return buildState(registrations);
}

function dependencyGraph(
  registrations: ReadonlyArray<InternalRegistration>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const ids = new Set(
    registrations.map((registration) => registration.plugin.id),
  );
  const edges = new Map(
    registrations.map((registration) => [
      registration.plugin.id,
      new Set<string>(),
    ]),
  );
  for (const { plugin } of registrations) {
    for (const dependency of plugin.before ?? [])
      if (ids.has(dependency)) edges.get(plugin.id)?.add(dependency);
    for (const dependency of plugin.after ?? [])
      if (ids.has(dependency)) edges.get(dependency)?.add(plugin.id);
  }
  return new Map(
    [...edges].map(([id, outgoing]) => [
      id,
      Object.freeze([...outgoing].sort()),
    ]),
  );
}

function firstCycle(
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  let cycle: ReadonlyArray<string> | undefined;
  const visit = (id: string): void => {
    if (cycle !== undefined || visited.has(id)) return;
    const pathIndex = path.indexOf(id);
    if (visiting.has(id) && pathIndex >= 0) {
      cycle = [...path.slice(pathIndex), id];
      return;
    }
    visiting.add(id);
    path.push(id);
    for (const next of graph.get(id) ?? []) visit(next);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...graph.keys()].sort()) visit(id);
  return cycle;
}

function compareReady(
  registrations: ReadonlyMap<string, InternalRegistration>,
  left: string,
  right: string,
): number {
  const leftPriority = registrations.get(left)?.plugin.priority ?? 0;
  const rightPriority = registrations.get(right)?.plugin.priority ?? 0;
  return (
    leftPriority - rightPriority || (left < right ? -1 : left > right ? 1 : 0)
  );
}

function topologicalOrder(
  nodes: ReadonlySet<string>,
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
  registrations: ReadonlyMap<string, InternalRegistration>,
): ReadonlyArray<InternalRegistration> {
  const indegree = new Map([...nodes].map((id) => [id, 0]));
  for (const id of nodes) {
    for (const next of graph.get(id) ?? [])
      if (nodes.has(next)) indegree.set(next, (indegree.get(next) ?? 0) + 1);
  }
  const ready = [...nodes]
    .filter((id) => indegree.get(id) === 0)
    .sort((left, right) => compareReady(registrations, left, right));
  const result: InternalRegistration[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const registration = registrations.get(id);
    if (registration !== undefined) result.push(registration);
    for (const next of graph.get(id) ?? []) {
      if (!nodes.has(next)) continue;
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((left, right) => compareReady(registrations, left, right));
      }
    }
  }
  return Object.freeze(result);
}

function reaches(
  source: string,
  target: string,
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): boolean {
  const pending = [...(graph.get(source) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

function buildState(
  registrations: ReadonlyArray<InternalRegistration>,
): RegistryState {
  const graph = dependencyGraph(registrations);
  const cycle = firstCycle(graph);
  if (cycle !== undefined) {
    const first = cycle[0];
    throw new PluginRegistrationError([
      {
        ...(first !== undefined ? { pluginId: first } : {}),
        message: `plugin dependency cycle: ${cycle.join(" -> ")}`,
      },
    ]);
  }
  const byId = new Map(
    registrations.map((registration) => [registration.plugin.id, registration]),
  );
  const allIds = new Set(byId.keys());
  const totalOrder = topologicalOrder(allIds, graph, byId);
  const orderedEntries = HOOK_NAMES.map((hook) => {
    const subscribers = new Set(
      registrations
        .filter((registration) => registration.plugin.hooks.includes(hook))
        .map((registration) => registration.plugin.id),
    );
    const hookGraph = new Map<string, ReadonlyArray<string>>();
    for (const source of subscribers) {
      hookGraph.set(
        source,
        Object.freeze(
          [...subscribers]
            .filter(
              (target) => source !== target && reaches(source, target, graph),
            )
            .sort(),
        ),
      );
    }
    return [hook, topologicalOrder(subscribers, hookGraph, byId)] as const;
  });
  return Object.freeze({
    registrations: Object.freeze([...registrations]),
    ordered: Object.freeze(
      Object.fromEntries(orderedEntries) as Record<
        HookName,
        ReadonlyArray<InternalRegistration>
      >,
    ),
    totalOrder,
  });
}

function isGatewayError(value: unknown): value is GatewayError {
  if (!isRecord(value)) return false;
  return (
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    typeof value["category"] === "string" &&
    typeof value["retryable"] === "boolean" &&
    typeof value["status"] === "number" &&
    typeof value["requestId"] === "string"
  );
}

function isHookResult(value: unknown): value is HookResult<unknown> {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "continue":
      return true;
    case "replace":
    case "shortCircuit":
      return Object.hasOwn(value, "value");
    case "abort":
      return isGatewayError(value["error"]);
    default:
      return false;
  }
}

function invokeHook(
  plugin: GatewayPlugin,
  hook: HookName,
  context: GatewayContext,
  value: unknown,
): HookResult<unknown> | Promise<HookResult<unknown>> {
  switch (hook) {
    case "onIngressReceived":
      return plugin.onIngressReceived!(context, value as CanonicalRequest);
    case "onCanonicalTranslate":
      return plugin.onCanonicalTranslate!(context, value as CanonicalRequest);
    case "onRouteResolve":
      return plugin.onRouteResolve!(
        context,
        value as ReadonlyArray<RouteCandidate>,
      );
    case "beforeUpstreamDispatch":
      return plugin.beforeUpstreamDispatch!(context, value as CanonicalRequest);
    case "onUpstreamResponse":
      return plugin.onUpstreamResponse!(context, value as CanonicalResponse);
    case "onStreamChunk":
      return plugin.onStreamChunk!(context, value as CanonicalChunk);
    case "onEgressTranslate":
      return plugin.onEgressTranslate!(context, value as EgressHookValue);
    case "onError":
      return plugin.onError!(context, value as GatewayError);
  }
}

function settleWithAbort<T>(
  signal: AbortSignal,
  operation: Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    action();
  };
  const onAbort = (): void => finish(() => reject(signal.reason));
  signal.addEventListener("abort", onAbort, { once: true });
  operation.then(
    (value) => finish(() => resolve(value)),
    (error: unknown) => finish(() => reject(error)),
  );
  return promise;
}

function isolatedContext(context: GatewayContext): GatewayContext {
  const state = structuredClone(context.state);
  const selectedCandidate =
    context.selectedCandidate === undefined
      ? undefined
      : structuredClone(context.selectedCandidate);
  return {
    request: structuredClone(context.request),
    requestId: context.requestId,
    signal: context.signal,
    state,
    getState<T>(key: string): T | undefined {
      return state.get(key) as T | undefined;
    },
    setState<T>(key: string, value: T): void {
      state.set(key, value);
    },
    execute<T>(command: GatewayCommand<T>): Promise<T> {
      return context.execute(command);
    },
    ...(selectedCandidate !== undefined ? { selectedCandidate } : {}),
  };
}

function pluginFailure(pluginId: string, requestId: string): HookResult<never> {
  return {
    kind: "abort",
    error: createGatewayError({
      category: "internal",
      code: "plugin_hook_failed",
      message: "plugin hook failed",
      requestId,
      details: { pluginId },
    }),
  };
}

function observerFailure(
  pluginId: string,
  requestId: string,
): HookResult<never> {
  return {
    kind: "abort",
    error: createGatewayError({
      category: "internal",
      code: "plugin_observer_failed",
      message: "plugin observer failed",
      requestId,
      details: { pluginId },
    }),
  };
}

/**
 * Validates, deterministically orders, executes, and closes one plugin snapshot.
 * Construction and incremental registration commit atomically; no global
 * registry is retained or exported.
 */
export class PluginRegistry implements HookManager {
  private state: RegistryState;
  private readonly observerFailurePolicy: ObserverFailurePolicy;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  /** Builds an enabled snapshot, failing closed before any state is committed. */
  constructor(
    registrations: ReadonlyArray<PluginRegistration>,
    options: PluginRegistryOptions = {},
  ) {
    const policy = isRecord(options)
      ? options["observerFailurePolicy"]
      : undefined;
    if (policy !== undefined && policy !== "abort" && policy !== "isolate") {
      throw new PluginRegistrationError([
        { message: "invalid plugin registration" },
      ]);
    }
    this.observerFailurePolicy = policy ?? "abort";
    this.state = validateSnapshot(registrations);
  }

  /** Atomically adds one enabled sequential plugin without manager-owned resources. */
  register(plugin: GatewayPlugin): void {
    this.assertOpen();
    const registrations: PluginRegistration[] = this.state.registrations.map(
      (registration) => ({
        plugin: registration.plugin,
        enabled: true,
        ...(registration.observerHooks.size > 0
          ? { parallelObserverHooks: [...registration.observerHooks] }
          : {}),
        ...(registration.close !== undefined
          ? { close: registration.close }
          : {}),
      }),
    );
    registrations.push({ plugin, enabled: true });
    this.state = validateSnapshot(registrations);
  }

  async run<T>(
    hook: HookName,
    context: GatewayContext,
    value: T,
  ): Promise<HookResult<T>> {
    this.assertOpen();
    if (!isHookName(hook)) throw new Error("unknown plugin hook");
    context.signal.throwIfAborted();
    const ordered = this.state.ordered[hook];
    let current: unknown = value;
    let currentContext = context;
    let index = 0;
    while (index < ordered.length) {
      const registration = ordered[index];
      if (registration === undefined) break;
      if (registration.observerHooks.has(hook)) {
        const batch: InternalRegistration[] = [];
        while (index < ordered.length) {
          const candidate = ordered[index];
          if (candidate === undefined || !candidate.observerHooks.has(hook))
            break;
          batch.push(candidate);
          index += 1;
        }
        const operations = batch.map((observer) => {
          try {
            const privateValue = structuredClone(current);
            const privateContext = isolatedContext(currentContext);
            privateContext.signal.throwIfAborted();
            return Promise.resolve(
              invokeHook(observer.plugin, hook, privateContext, privateValue),
            );
          } catch (error: unknown) {
            return Promise.reject(error);
          }
        });
        const settlements = await settleWithAbort(
          currentContext.signal,
          Promise.allSettled(operations),
        );
        for (
          let batchIndex = 0;
          batchIndex < settlements.length;
          batchIndex += 1
        ) {
          const settlement = settlements[batchIndex];
          const observer = batch[batchIndex];
          const valid =
            settlement?.status === "fulfilled" &&
            isHookResult(settlement.value) &&
            settlement.value.kind === "continue";
          if (
            !valid &&
            this.observerFailurePolicy === "abort" &&
            observer !== undefined
          ) {
            return observerFailure(
              observer.plugin.id,
              currentContext.requestId,
            ) as HookResult<T>;
          }
        }
        continue;
      }

      try {
        currentContext.signal.throwIfAborted();
        const result = await settleWithAbort(
          currentContext.signal,
          Promise.resolve(
            invokeHook(registration.plugin, hook, currentContext, current),
          ),
        );
        if (!isHookResult(result))
          return pluginFailure(
            registration.plugin.id,
            currentContext.requestId,
          ) as HookResult<T>;
        switch (result.kind) {
          case "continue":
            break;
          case "replace":
            current = result.value;
            if (
              hook === "onIngressReceived" ||
              hook === "onCanonicalTranslate" ||
              hook === "beforeUpstreamDispatch"
            ) {
              currentContext = {
                ...currentContext,
                request: result.value as GatewayContext["request"],
              };
            }
            break;
          case "shortCircuit":
          case "abort":
            return result as HookResult<T>;
        }
      } catch (error: unknown) {
        if (currentContext.signal.aborted) throw currentContext.signal.reason;
        return pluginFailure(
          registration.plugin.id,
          currentContext.requestId,
        ) as HookResult<T>;
      }
      index += 1;
    }
    return { kind: "continue", value: current as T };
  }

  /** Returns the frozen deterministic subscriber order for one hook. */
  ordered(hook: HookName): ReadonlyArray<GatewayPlugin> {
    this.assertOpen();
    if (!isHookName(hook)) throw new Error("unknown plugin hook");
    return Object.freeze(
      this.state.ordered[hook].map((registration) => registration.plugin),
    );
  }

  /**
   * Closes owned resources once, sequentially, in reverse total dependency
   * order; repeated and concurrent calls return the same promise by identity.
   */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const deferred = Promise.withResolvers<void>();
    this.closePromise = deferred.promise;
    void this.performClose(deferred.resolve, deferred.reject);
    return deferred.promise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(CLOSED_ERROR);
  }

  private async performClose(
    resolveClose: () => void,
    rejectClose: (error: unknown) => void,
  ): Promise<void> {
    const failures: Error[] = [];
    for (const registration of [...this.state.totalOrder].reverse()) {
      if (registration.close === undefined) continue;
      try {
        await registration.close();
      } catch {
        failures.push(
          new Error(`plugin close failed: ${registration.plugin.id}`),
        );
      }
    }
    if (failures.length > 0)
      rejectClose(new AggregateError(failures, "plugin registry close failed"));
    else resolveClose();
  }
}
