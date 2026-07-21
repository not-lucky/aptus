import { describe, expect, it, vi } from "vitest";
import type {
  GatewayContext,
  GatewayPlugin,
  HookName,
  HookResult,
} from "../../src/application/index.js";
import {
  PluginRegistrationError,
  PluginRegistry,
  type PluginRegistration,
} from "../../src/plugins/index.js";

const request = { model: "model-one" } as GatewayContext["request"];

function context(
  signal = new AbortController().signal,
  state = new Map<string, unknown>(),
): GatewayContext {
  return {
    request,
    requestId: "request-1",
    signal,
    state,
    getState<T>(key: string): T | undefined {
      return state.get(key) as T | undefined;
    },
    setState<T>(key: string, value: T): void {
      state.set(key, value);
    },
    execute<T>(command: {
      execute(signal: AbortSignal): Promise<T>;
    }): Promise<T> {
      return command.execute(signal);
    },
  };
}

function plugin(
  id: string,
  overrides: Partial<GatewayPlugin> = {},
): GatewayPlugin {
  return { id, version: "1.0.0", hooks: [], priority: 0, ...overrides };
}

function registration(
  pluginValue: GatewayPlugin,
  overrides: Partial<PluginRegistration> = {},
): PluginRegistration {
  return { plugin: pluginValue, enabled: true, ...overrides };
}

function messages(action: () => unknown): ReadonlyArray<string> {
  try {
    action();
    throw new Error("expected plugin registration failure");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PluginRegistrationError);
    return (error as PluginRegistrationError).issues.map(
      (issue) => issue.message,
    );
  }
}

type IngressMethod = NonNullable<GatewayPlugin["onIngressReceived"]>;

function ingress(
  implementation: (
    hookContext: GatewayContext,
    value: unknown,
  ) => HookResult<unknown> | Promise<HookResult<unknown>>,
): IngressMethod {
  return implementation as unknown as IngressMethod;
}

const authentication = registration(plugin("authentication"));

describe("PluginRegistry validation and ordering", () => {
  it("rejects malformed metadata and never requires incidental property access", () => {
    expect(messages(() => new PluginRegistry([null as never]))).toEqual([
      "invalid plugin registration",
      "authentication plugin must be enabled",
    ]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(
              plugin("bad-plugin", { version: "one", priority: Number.NaN }),
            ),
            registration(plugin("bad-plugin")),
          ]),
      ),
    ).toEqual([
      "duplicate plugin ID bad-plugin",
      "invalid plugin version",
      "plugin priority must be a finite integer",
    ]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(
              plugin("invalid-plugin", {
                hooks: ["missing" as HookName],
                before: ["UPPER"],
              }),
            ),
          ]),
      ),
    ).toEqual(["unknown plugin hook", "invalid plugin dependency ID"]);
  });

  it("validates enabled closure, hook methods, observer declarations, and authentication", () => {
    expect(messages(() => new PluginRegistry([]))).toEqual([
      "authentication plugin must be enabled",
    ]);
    expect(
      messages(
        () => new PluginRegistry([{ ...authentication, enabled: false }]),
      ),
    ).toEqual(["authentication plugin must be enabled"]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(
              plugin("ordered-plugin", { after: ["missing-plugin"] }),
            ),
          ]),
      ),
    ).toEqual(["unknown plugin dependency missing-plugin"]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            {
              ...registration(
                plugin("ordered-plugin", { after: ["disabled-plugin"] }),
              ),
              enabled: true,
            },
            { ...registration(plugin("disabled-plugin")), enabled: false },
          ]),
      ),
    ).toEqual(["enabled plugin dependency disabled-plugin is disabled"]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(plugin("self-plugin", { before: ["self-plugin"] })),
          ]),
      ),
    ).toEqual(["plugin cannot depend on itself"]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(
              plugin("missing-method", { hooks: ["onIngressReceived"] }),
            ),
          ]),
      ),
    ).toEqual(["declared hook onIngressReceived has no method"]);
    expect(
      messages(
        () =>
          new PluginRegistry([
            authentication,
            registration(plugin("observer-plugin"), {
              parallelObserverHooks: ["onIngressReceived"],
            }),
          ]),
      ),
    ).toEqual(["parallel observer hook onIngressReceived must be declared"]);
  });

  it("reports one deterministic lexical cycle", () => {
    const cyclic = [
      authentication,
      registration(plugin("cycle-charlie", { before: ["cycle-alpha"] })),
      registration(plugin("cycle-alpha", { before: ["cycle-bravo"] })),
      registration(plugin("cycle-bravo", { before: ["cycle-charlie"] })),
    ];
    expect(messages(() => new PluginRegistry(cyclic))).toEqual([
      "plugin dependency cycle: cycle-alpha -> cycle-bravo -> cycle-charlie -> cycle-alpha",
    ]);
  });

  it("uses complete-graph reachability and subscriber-only priority ties", () => {
    const hook = "onIngressReceived";
    const noop = ingress(() => ({ kind: "continue" }));
    const snapshot = [
      registration(
        plugin("last-plugin", {
          hooks: [hook],
          priority: -100,
          after: ["bridge-plugin"],
          onIngressReceived: noop,
        }),
      ),
      registration(
        plugin("tie-zulu", {
          hooks: [hook],
          priority: 5,
          onIngressReceived: noop,
        }),
      ),
      authentication,
      registration(
        plugin("first-plugin", {
          hooks: [hook],
          priority: 100,
          before: ["bridge-plugin"],
          onIngressReceived: noop,
        }),
      ),
      registration(plugin("bridge-plugin", { priority: -1000 })),
      registration(
        plugin("tie-alpha", {
          hooks: [hook],
          priority: 5,
          onIngressReceived: noop,
        }),
      ),
      registration(
        plugin("priority-plugin", {
          hooks: [hook],
          priority: 1,
          onIngressReceived: noop,
        }),
      ),
      registration(
        plugin("undeclared-method", {
          priority: -2000,
          onIngressReceived: noop,
        }),
      ),
    ];
    const reversed = [...snapshot].reverse();
    const expected = [
      "priority-plugin",
      "tie-alpha",
      "tie-zulu",
      "first-plugin",
      "last-plugin",
    ];
    expect(
      new PluginRegistry(snapshot).ordered(hook).map(({ id }) => id),
    ).toEqual(expected);
    expect(
      new PluginRegistry(reversed).ordered(hook).map(({ id }) => id),
    ).toEqual(expected);
  });

  it("keeps the prior snapshot when incremental registration fails", () => {
    const registry = new PluginRegistry([authentication]);
    expect(() =>
      registry.register(plugin("bad-plugin", { after: ["missing-plugin"] })),
    ).toThrow(PluginRegistrationError);
    expect(registry.ordered("onIngressReceived")).toEqual([]);
    registry.register(
      plugin("valid-plugin", {
        hooks: ["onIngressReceived"],
        onIngressReceived: ingress(() => ({ kind: "continue" })),
      }),
    );
    expect(registry.ordered("onIngressReceived").map(({ id }) => id)).toEqual([
      "valid-plugin",
    ]);
  });
});

describe("PluginRegistry execution", () => {
  it("reduces replace and continue while ignoring continue values", async () => {
    const registry = new PluginRegistry([
      authentication,
      registration(
        plugin("replace-plugin", {
          hooks: ["onIngressReceived"],
          priority: 1,
          onIngressReceived: ingress((_context, value) => ({
            kind: "replace",
            value: `${value}-changed`,
          })),
        }),
      ),
      registration(
        plugin("continue-plugin", {
          hooks: ["onIngressReceived"],
          priority: 2,
          onIngressReceived: ingress(() => ({
            kind: "continue",
            value: "ignored",
          })),
        }),
      ),
    ]);
    await expect(
      registry.run("onIngressReceived", context(), "initial"),
    ).resolves.toEqual({ kind: "continue", value: "initial-changed" });
  });
  it("passes replaced request snapshots to later plugins", async () => {
    const replacement = { ...request, model: "replaced" };
    const observed: GatewayContext[] = [];
    const original = {
      ...context(),
      selectedCandidate: {
        routeId: "route",
        providerId: "provider",
        credentialId: "credential",
        physicalModel: "model",
        capabilities: new Set<string>(),
        estimatedCostUsd: 0,
      },
    };
    const registry = new PluginRegistry([
      authentication,
      registration(
        plugin("replace-request", {
          hooks: ["onIngressReceived"],
          priority: 1,
          onIngressReceived: ingress(() => ({
            kind: "replace",
            value: replacement,
          })),
        }),
      ),
      registration(
        plugin("observe-request", {
          hooks: ["onIngressReceived"],
          priority: 2,
          onIngressReceived: ingress((hookContext, value) => {
            observed.push(hookContext);
            return { kind: "continue", value };
          }),
        }),
      ),
    ]);
    await expect(
      registry.run("onIngressReceived", original, request),
    ).resolves.toMatchObject({ kind: "continue", value: replacement });
    expect(observed[0]?.request).toBe(replacement);
    expect(observed[0]?.requestId).toBe(original.requestId);
    expect(observed[0]?.signal).toBe(original.signal);
    expect(observed[0]?.selectedCandidate).toBe(original.selectedCandidate);
    expect(observed[0]?.state).toBe(original.state);
    expect(observed[0]?.execute).toBe(original.execute);
  });

  it("converts malformed and rejected hooks to safe aborts and stops terminal chains", async () => {
    const later = vi.fn(() => ({ kind: "continue" }) as const);
    for (const implementation of [
      ingress(() => ({ wrong: "shape" }) as never),
      ingress(() => Promise.reject(new Error("secret rejection"))),
    ]) {
      const registry = new PluginRegistry([
        authentication,
        registration(
          plugin("failed-plugin", {
            hooks: ["onIngressReceived"],
            priority: 1,
            onIngressReceived: implementation,
          }),
        ),
        registration(
          plugin("later-plugin", {
            hooks: ["onIngressReceived"],
            priority: 2,
            onIngressReceived: ingress(later),
          }),
        ),
      ]);
      const result = await registry.run(
        "onIngressReceived",
        context(),
        "initial",
      );
      expect(result).toMatchObject({
        kind: "abort",
        error: {
          code: "plugin_hook_failed",
          message: "plugin hook failed",
          requestId: "request-1",
          details: { pluginId: "failed-plugin" },
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret rejection");
      expect(later).not.toHaveBeenCalled();
    }

    const shortCircuit = new PluginRegistry([
      authentication,
      registration(
        plugin("terminal-plugin", {
          hooks: ["onIngressReceived"],
          onIngressReceived: ingress(() => ({
            kind: "shortCircuit",
            value: "terminal",
          })),
        }),
      ),
    ]);
    await expect(
      shortCircuit.run("onIngressReceived", context(), "initial"),
    ).resolves.toEqual({ kind: "shortCircuit", value: "terminal" });
  });

  it("checks already-aborted signals and abandons pending hooks immediately", async () => {
    const called = vi.fn();
    const already = new AbortController();
    const alreadyReason = new Error("already cancelled");
    already.abort(alreadyReason);
    const registry = new PluginRegistry([
      authentication,
      registration(
        plugin("pending-plugin", {
          hooks: ["onIngressReceived"],
          onIngressReceived: ingress(() => {
            called();
            return deferred.promise;
          }),
        }),
      ),
    ]);
    await expect(
      registry.run("onIngressReceived", context(already.signal), "initial"),
    ).rejects.toBe(alreadyReason);
    expect(called).not.toHaveBeenCalled();

    const pending = new AbortController();
    const deferred = Promise.withResolvers<HookResult<string>>();
    const running = registry.run(
      "onIngressReceived",
      context(pending.signal),
      "initial",
    );
    await Promise.resolve();
    const pendingReason = new Error("pending cancelled");
    pending.abort(pendingReason);
    await expect(running).rejects.toBe(pendingReason);
    deferred.reject(new Error("late secret rejection"));
    await Promise.resolve();
  });

  it("overlaps consecutive observers and isolates values and request-local state", async () => {
    let reached = 0;
    const barrier = Promise.withResolvers<void>();
    const observer = (id: string) =>
      registration(
        plugin(id, {
          hooks: ["onIngressReceived"],
          onIngressReceived: ingress(async (hookContext, value) => {
            reached += 1;
            hookContext.setState(`${id}:key`, "private");
            if (
              value !== null &&
              typeof value === "object" &&
              "marker" in value
            )
              value.marker = id;
            await barrier.promise;
            return { kind: "continue" };
          }),
        }),
        { parallelObserverHooks: ["onIngressReceived"] },
      );
    const observedState: unknown[] = [];
    const registry = new PluginRegistry([
      authentication,
      observer("observer-one"),
      observer("observer-two"),
      registration(
        plugin("mutator-plugin", {
          hooks: ["onIngressReceived"],
          priority: 1,
          onIngressReceived: ingress((hookContext, value) => {
            observedState.push(
              hookContext.getState("observer-one:key"),
              hookContext.getState("observer-two:key"),
            );
            return { kind: "continue", value };
          }),
        }),
      ),
    ]);
    const liveValue = { marker: "live" };
    const running = registry.run("onIngressReceived", context(), liveValue);
    await vi.waitFor(() => expect(reached).toBe(2));
    barrier.resolve();
    await expect(running).resolves.toEqual({
      kind: "continue",
      value: liveValue,
    });
    expect(liveValue).toEqual({ marker: "live" });
    expect(observedState).toEqual([undefined, undefined]);
  });

  it.each(["isolate", "abort"] as const)(
    "applies the %s observer failure policy",
    async (policy) => {
      const mutator = vi.fn(
        () => ({ kind: "replace", value: "changed" }) as const,
      );
      const registry = new PluginRegistry(
        [
          authentication,
          registration(
            plugin("observer-plugin", {
              hooks: ["onIngressReceived"],
              onIngressReceived: ingress(() => ({
                kind: "replace",
                value: "illegal",
              })),
            }),
            { parallelObserverHooks: ["onIngressReceived"] },
          ),
          registration(
            plugin("mutator-plugin", {
              hooks: ["onIngressReceived"],
              priority: 1,
              onIngressReceived: ingress(mutator),
            }),
          ),
        ],
        { observerFailurePolicy: policy },
      );
      const result = await registry.run(
        "onIngressReceived",
        context(),
        "initial",
      );
      if (policy === "isolate") {
        expect(result).toEqual({ kind: "continue", value: "changed" });
        expect(mutator).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({
          kind: "abort",
          error: {
            code: "plugin_observer_failed",
            message: "plugin observer failed",
            details: { pluginId: "observer-plugin" },
          },
        });
        expect(mutator).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps request maps and explicit plugin namespaces separate", async () => {
    const reader = registration(
      plugin("state-plugin", {
        hooks: ["onIngressReceived"],
        onIngressReceived: ingress((hookContext) => ({
          kind: "replace",
          value: String(hookContext.getState("state-plugin:key")),
        })),
      }),
    );
    const registry = new PluginRegistry([authentication, reader]);
    const first = new Map<string, unknown>([
      ["state-plugin:key", "first"],
      ["other-plugin:key", "other"],
    ]);
    const second = new Map<string, unknown>([["state-plugin:key", "second"]]);
    await expect(
      registry.run(
        "onIngressReceived",
        context(new AbortController().signal, first),
        "initial",
      ),
    ).resolves.toEqual({ kind: "continue", value: "first" });
    await expect(
      registry.run(
        "onIngressReceived",
        context(new AbortController().signal, second),
        "initial",
      ),
    ).resolves.toEqual({ kind: "continue", value: "second" });
    expect(first.get("other-plugin:key")).toBe("other");
  });
});

describe("PluginRegistry close", () => {
  it("closes once in reverse total order, continues after failures, and fails closed", async () => {
    const events: string[] = [];
    const registry = new PluginRegistry([
      registration(plugin("dependent-plugin", { after: ["authentication"] }), {
        close: () => {
          events.push("dependent-plugin");
        },
      }),
      registration(plugin("authentication"), {
        close: () => {
          events.push("authentication");
          throw new Error("secret close failure");
        },
      }),
      registration(plugin("last-plugin", { after: ["dependent-plugin"] }), {
        close: () => {
          events.push("last-plugin");
        },
      }),
    ]);
    const first = registry.close();
    const second = registry.close();
    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({
      message: "plugin registry close failed",
      errors: [
        expect.objectContaining({
          message: "plugin close failed: authentication",
        }),
      ],
    });
    expect(events).toEqual([
      "last-plugin",
      "dependent-plugin",
      "authentication",
    ]);
    expect(registry.close()).toBe(first);
    expect(() => registry.ordered("onIngressReceived")).toThrow(
      "plugin registry is closed",
    );
    expect(() => registry.register(plugin("later-plugin"))).toThrow(
      "plugin registry is closed",
    );
    await expect(
      registry.run("onIngressReceived", context(), "initial"),
    ).rejects.toThrow("plugin registry is closed");
  });
});
