import { describe, expect, it } from "vitest";
import {
  AdapterRegistrationError,
  AtomicAdapterRegistry,
  createBuiltInProtocolAdapterFactory,
  registerProtocolAdapters,
} from "../../src/adapters/index.js";
import type { ProtocolAdapterFactory } from "../../src/application/index.js";
import type { ProtocolNamespace } from "../../src/domain/index.js";
import type {
  EgressTranslationAdapter,
  IngressTranslationAdapter,
} from "../../src/ports/index.js";

const NOW = "2026-07-22T00:00:00.000Z";

function builtIns(): AtomicAdapterRegistry {
  const factory = createBuiltInProtocolAdapterFactory({ now: () => NOW });
  return new AtomicAdapterRegistry([
    { protocol: "openai-chat", factory },
    { protocol: "openai-responses", factory },
    { protocol: "anthropic-messages", factory },
  ]);
}

function customFactory(
  protocol: ProtocolNamespace,
  paths: ReadonlySet<string>,
): ProtocolAdapterFactory {
  const ingress: IngressTranslationAdapter = {
    protocol,
    paths,
    canTranslate: (path) => paths.has(path),
    translate: () => {
      throw new Error("not exercised");
    },
  };
  const egress: EgressTranslationAdapter = {
    protocol,
    encodeResponse: () => ({}),
    encodeChunk: () => "",
    encodeError: () => ({}),
  };
  return { createIngress: () => ingress, createEgress: () => egress };
}

function registrationFailure(call: () => unknown): AdapterRegistrationError {
  try {
    call();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AdapterRegistrationError);
    return error as AdapterRegistrationError;
  }
  throw new Error("Expected adapter registration to fail.");
}

describe("atomic adapter registry", () => {
  it.each([
    ["/chat/completions", "openai-chat"],
    ["/v1/chat/completions", "openai-chat"],
    ["/responses", "openai-responses"],
    ["/v1/responses", "openai-responses"],
    ["/messages", "anthropic-messages"],
    ["/v1/messages", "anthropic-messages"],
  ] as const)(
    "resolves %s to %s from adapter-owned paths",
    (path, protocol) => {
      const registry = builtIns();
      expect(registry.ingress(path).protocol).toBe(protocol);
      expect(registry.egress(protocol).protocol).toBe(protocol);
    },
  );

  it.each(["/health", "/metrics", "/unknown"])(
    "keeps %s outside translation routes",
    (path) => {
      let failure: unknown;
      try {
        builtIns().ingress(path, "registry-request");
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "unknown_path",
        category: "validation",
        status: 404,
        requestId: "registry-request",
      });
      expect(JSON.stringify(failure)).not.toMatch(/authorization|secret|body/i);
    },
  );

  it("rejects duplicate protocols and paths deterministically", () => {
    const duplicateProtocol = registrationFailure(
      () =>
        new AtomicAdapterRegistry([
          {
            protocol: "custom-a",
            factory: customFactory("custom-a", new Set(["/a"])),
          },
          {
            protocol: "custom-a",
            factory: customFactory("custom-a", new Set(["/b"])),
          },
        ]),
    );
    expect(duplicateProtocol.issues).toContainEqual({
      protocol: "custom-a",
      message: "duplicate protocol namespace",
    });

    const duplicatePath = registrationFailure(
      () =>
        new AtomicAdapterRegistry([
          {
            protocol: "custom-b",
            factory: customFactory("custom-b", new Set(["/same"])),
          },
          {
            protocol: "custom-c",
            factory: customFactory("custom-c", new Set(["/same"])),
          },
        ]),
    );
    expect(duplicatePath.issues).toContainEqual({
      protocol: "custom-c",
      path: "/same",
      message: "duplicate ingress path",
    });
    expect(Object.isFrozen(duplicatePath.issues)).toBe(true);
  });

  it("rejects built-in namespace collisions, mismatches, and operational paths atomically", () => {
    const issues = registrationFailure(
      () =>
        new AtomicAdapterRegistry([
          {
            protocol: "openai-chat",
            factory: customFactory("openai-chat", new Set(["/shadow"])),
          },
          {
            protocol: "custom-d",
            factory: customFactory("custom-e", new Set(["/health"])),
          },
        ]),
    ).issues;
    expect(issues).toContainEqual({
      protocol: "openai-chat",
      message:
        "built-in protocol namespace requires the built-in adapter factory",
    });
    expect(issues).toContainEqual({
      protocol: "custom-d",
      message: "ingress adapter protocol does not match registration",
    });
    expect(issues).toContainEqual({
      protocol: "custom-d",
      path: "/health",
      message: "operational path cannot be registered",
    });
  });
  it("publishes readiness only after complete registration succeeds", () => {
    const transitions: boolean[] = [];
    const readiness = {
      setAdaptersRegistered: (registered: boolean) =>
        transitions.push(registered),
    };
    const factory = createBuiltInProtocolAdapterFactory({ now: () => NOW });
    expect(
      registerProtocolAdapters(
        [{ protocol: "openai-chat", factory }],
        readiness,
      ).ingress("/chat/completions").protocol,
    ).toBe("openai-chat");
    expect(transitions).toEqual([true]);

    expect(() =>
      registerProtocolAdapters(
        [
          {
            protocol: "custom-f",
            factory: customFactory("custom-f", new Set(["/metrics"])),
          },
        ],
        readiness,
      ),
    ).toThrow(AdapterRegistrationError);
    expect(transitions).toEqual([true]);
  });
});
