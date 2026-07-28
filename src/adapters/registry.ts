import type {
  AdapterRegistry as ApplicationAdapterRegistry,
  ProtocolAdapterFactory,
} from "../application/index.js";
import type { GatewayError, ProtocolNamespace } from "../domain/index.js";
import { createGatewayError, validateRequestId } from "../domain/index.js";
import type {
  EgressTranslationAdapter,
  IngressTranslationAdapter,
} from "../ports/index.js";
import {
  createAnthropicMessagesTranslatorFamily,
  createOpenAiChatTranslatorFamily,
  createOpenAiResponsesTranslatorFamily,
} from "./translators/index.js";
import type {
  AnthropicMessagesTranslatorOptions,
  OpenAiChatTranslatorOptions,
  OpenAiResponsesTranslatorOptions,
} from "./translators/index.js";

const BUILT_IN_PROTOCOLS = Object.freeze([
  "anthropic-messages",
  "openai-chat",
  "openai-responses",
] as const);
const BUILT_IN_PROTOCOL_SET: Readonly<Record<string, true>> = Object.freeze({
  "openai-chat": true,
  "openai-responses": true,
  "anthropic-messages": true,
});
const OPERATIONAL_PATHS: Readonly<Record<string, true>> = Object.freeze({
  "/health": true,
  "/metrics": true,
});
const REGISTRY_REQUEST_ID = "adapter-registry";
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** One explicit protocol-to-factory registration consumed during startup. */
export interface ProtocolAdapterRegistration {
  /** Namespace that both adapters created by the factory must declare. */
  readonly protocol: ProtocolNamespace;
  /** Factory invoked exactly once for each side of this registration. */
  readonly factory: ProtocolAdapterFactory;
}

/** One bounded, safe diagnostic from rejected adapter registration. */
export interface AdapterRegistrationIssue {
  /** Validated protocol associated with the issue, when one is available. */
  readonly protocol?: ProtocolNamespace;
  /** Validated non-operational path associated with the issue, when available. */
  readonly path?: string;
  /** Fixed safe diagnostic text. */
  readonly message: string;
}

/** Aggregate startup failure thrown before any registry maps are published. */
export class AdapterRegistrationError extends Error {
  /** Deterministically sorted, frozen registration diagnostics. */
  readonly issues: ReadonlyArray<AdapterRegistrationIssue>;

  /** Copies safe diagnostics into an immutable startup error. */
  constructor(issues: ReadonlyArray<AdapterRegistrationIssue>) {
    super("adapter registration failed");
    this.name = "AdapterRegistrationError";
    this.issues = Object.freeze(
      [...issues]
        .sort(compareIssues)
        .map((issue) => Object.freeze({ ...issue })),
    );
    Object.freeze(this);
  }
}

/** Options shared by the three built-in stateless translator families. */
export interface BuiltInProtocolAdapterFactoryOptions {
  /** Injected RFC 3339 timestamp factory used by all built-in ingress adapters. */
  readonly now: () => string;
  /** OpenAI Chat-specific egress options. */
  readonly openAiChat?: Omit<OpenAiChatTranslatorOptions, "now">;
  /** OpenAI Responses-specific egress and stream options. */
  readonly openAiResponses?: Omit<OpenAiResponsesTranslatorOptions, "now">;
  /** Anthropic Messages-specific egress and stream options. */
  readonly anthropicMessages?: Omit<AnthropicMessagesTranslatorOptions, "now">;
}

interface AdapterPair {
  readonly ingress: IngressTranslationAdapter;
  readonly egress: EgressTranslationAdapter;
}

interface CandidatePair {
  readonly order: number;
  readonly protocol: ProtocolNamespace;
  readonly ingress?: unknown;
  readonly egress?: unknown;
}

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareIssues(
  left: AdapterRegistrationIssue,
  right: AdapterRegistrationIssue,
): number {
  return (
    compareCodeUnits(left.protocol ?? "", right.protocol ?? "") ||
    compareCodeUnits(left.path ?? "", right.path ?? "") ||
    compareCodeUnits(left.message, right.message)
  );
}

function isProtocolNamespace(value: unknown): value is ProtocolNamespace {
  return typeof value === "string" && NAMESPACE_PATTERN.test(value);
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value[0] !== "/") {
    return false;
  }
  if (
    value.startsWith("//") ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some(
    (segment, index) => index > 0 && (segment === "." || segment === ".."),
  );
}

function isIngressShape(value: unknown): value is IngressTranslationAdapter {
  if (typeof value !== "object" || value === null) return false;
  try {
    const candidate = value as Partial<IngressTranslationAdapter>;
    return (
      typeof candidate.protocol === "string" &&
      typeof candidate.canTranslate === "function" &&
      typeof candidate.translate === "function" &&
      typeof candidate.paths === "object" &&
      candidate.paths !== null &&
      typeof candidate.paths.has === "function" &&
      typeof candidate.paths[Symbol.iterator] === "function"
    );
  } catch {
    return false;
  }
}

function isEgressShape(value: unknown): value is EgressTranslationAdapter {
  if (typeof value !== "object" || value === null) return false;
  try {
    const candidate = value as Partial<EgressTranslationAdapter>;
    return (
      typeof candidate.protocol === "string" &&
      typeof candidate.encodeResponse === "function" &&
      typeof candidate.encodeChunk === "function" &&
      typeof candidate.encodeError === "function"
    );
  } catch {
    return false;
  }
}

function registrationIssue(
  message: string,
  protocol?: ProtocolNamespace,
  path?: string,
): AdapterRegistrationIssue {
  return {
    message,
    ...(protocol === undefined ? {} : { protocol }),
    ...(path === undefined ? {} : { path }),
  };
}

function lookupFailure(
  category: "validation" | "internal",
  code: string,
  message: string,
  status: number,
  requestId = REGISTRY_REQUEST_ID,
): GatewayError {
  return createGatewayError({
    category,
    code,
    message,
    status,
    retryable: false,
    requestId,
  });
}

class BuiltInProtocolAdapterFactory implements ProtocolAdapterFactory {
  /** Immutable construction options shared by lazily created families. */
  readonly #options: BuiltInProtocolAdapterFactoryOptions;
  /** One cached family per requested built-in namespace. */
  readonly #families = new Map<ProtocolNamespace, AdapterPair>();

  /** Retains an immutable copy of caller-owned factory options. */
  constructor(options: BuiltInProtocolAdapterFactoryOptions) {
    this.#options = Object.freeze({
      ...options,
      ...(options.openAiChat === undefined
        ? {}
        : { openAiChat: Object.freeze({ ...options.openAiChat }) }),
      ...(options.openAiResponses === undefined
        ? {}
        : { openAiResponses: Object.freeze({ ...options.openAiResponses }) }),
      ...(options.anthropicMessages === undefined
        ? {}
        : {
            anthropicMessages: Object.freeze({ ...options.anthropicMessages }),
          }),
    });
  }

  /** Returns the sole ingress instance created for a built-in namespace. */
  createIngress(protocol: ProtocolNamespace): IngressTranslationAdapter {
    return this.#family(protocol).ingress;
  }

  /** Returns the sole egress instance created for a built-in namespace. */
  createEgress(protocol: ProtocolNamespace): EgressTranslationAdapter {
    return this.#family(protocol).egress;
  }

  /** Creates and caches one translator family without copying route constants. */
  #family(protocol: ProtocolNamespace): AdapterPair {
    const existing = this.#families.get(protocol);
    if (existing !== undefined) return existing;
    let family: AdapterPair;
    switch (protocol) {
      case "openai-chat":
        family = createOpenAiChatTranslatorFamily({
          now: this.#options.now,
          ...this.#options.openAiChat,
        });
        break;
      case "openai-responses":
        family = createOpenAiResponsesTranslatorFamily({
          now: this.#options.now,
          ...this.#options.openAiResponses,
        });
        break;
      case "anthropic-messages":
        family = createAnthropicMessagesTranslatorFamily({
          now: this.#options.now,
          ...this.#options.anthropicMessages,
        });
        break;
      default:
        throw lookupFailure(
          "internal",
          "adapter_protocol_not_registered",
          "No built-in adapter is registered for the protocol.",
          500,
        );
    }
    this.#families.set(protocol, family);
    return family;
  }
}

/**
 * Registry that validates an entire startup snapshot before publishing private
 * path and protocol maps. Factories are never retained or invoked by lookups.
 */
export class AtomicAdapterRegistry implements ApplicationAdapterRegistry {
  /** Validated ingress adapters indexed solely from each adapter's paths. */
  readonly #ingressByPath: ReadonlyMap<string, IngressTranslationAdapter>;
  /** Validated egress adapters indexed by their registration protocol. */
  readonly #egressByProtocol: ReadonlyMap<
    ProtocolNamespace,
    EgressTranslationAdapter
  >;

  /** Constructs one all-or-nothing adapter snapshot from explicit registrations. */
  constructor(registrations: ReadonlyArray<ProtocolAdapterRegistration>) {
    const issues: AdapterRegistrationIssue[] = [];
    const candidates: CandidatePair[] = [];
    const protocolCounts = new Map<ProtocolNamespace, number>();

    if (!Array.isArray(registrations)) {
      throw new AdapterRegistrationError([
        registrationIssue("invalid adapter registration list"),
      ]);
    }

    for (let order = 0; order < registrations.length; order += 1) {
      const raw: unknown = registrations[order];
      if (typeof raw !== "object" || raw === null) {
        issues.push(registrationIssue("invalid adapter registration"));
        continue;
      }
      let protocolValue: unknown;
      let factoryValue: unknown;
      try {
        const registration = raw as Partial<ProtocolAdapterRegistration>;
        protocolValue = registration.protocol;
        factoryValue = registration.factory;
      } catch {
        issues.push(registrationIssue("invalid adapter registration"));
        continue;
      }
      if (!isProtocolNamespace(protocolValue)) {
        issues.push(registrationIssue("invalid protocol namespace"));
        continue;
      }
      const protocol = protocolValue;
      protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
      if (
        BUILT_IN_PROTOCOL_SET[protocol] === true &&
        !(factoryValue instanceof BuiltInProtocolAdapterFactory)
      ) {
        issues.push(
          registrationIssue(
            "built-in protocol namespace requires the built-in adapter factory",
            protocol,
          ),
        );
      }
      if (
        typeof factoryValue !== "object" ||
        factoryValue === null ||
        typeof (factoryValue as Partial<ProtocolAdapterFactory>)
          .createIngress !== "function" ||
        typeof (factoryValue as Partial<ProtocolAdapterFactory>)
          .createEgress !== "function"
      ) {
        issues.push(registrationIssue("invalid adapter factory", protocol));
        continue;
      }
      const factory = factoryValue as ProtocolAdapterFactory;
      let ingress: unknown;
      let egress: unknown;
      try {
        ingress = factory.createIngress(protocol);
      } catch {
        issues.push(
          registrationIssue("ingress adapter factory failed", protocol),
        );
      }
      try {
        egress = factory.createEgress(protocol);
      } catch {
        issues.push(
          registrationIssue("egress adapter factory failed", protocol),
        );
      }
      candidates.push({ order, protocol, ingress, egress });
    }

    for (const [protocol, count] of protocolCounts) {
      if (count > 1) {
        issues.push(
          registrationIssue("duplicate protocol namespace", protocol),
        );
      }
    }

    const ingressByPath = new Map<string, IngressTranslationAdapter>();
    const pathOwners = new Map<string, ProtocolNamespace>();
    const egressByProtocol = new Map<
      ProtocolNamespace,
      EgressTranslationAdapter
    >();

    for (const candidate of candidates.sort(
      (left, right) => left.order - right.order,
    )) {
      const ingressValid = isIngressShape(candidate.ingress);
      const egressValid = isEgressShape(candidate.egress);
      if (!ingressValid) {
        issues.push(
          registrationIssue("invalid ingress adapter", candidate.protocol),
        );
      }
      if (!egressValid) {
        issues.push(
          registrationIssue("invalid egress adapter", candidate.protocol),
        );
      }
      if (ingressValid && candidate.ingress.protocol !== candidate.protocol) {
        issues.push(
          registrationIssue(
            "ingress adapter protocol does not match registration",
            candidate.protocol,
          ),
        );
      }
      if (egressValid && candidate.egress.protocol !== candidate.protocol) {
        issues.push(
          registrationIssue(
            "egress adapter protocol does not match registration",
            candidate.protocol,
          ),
        );
      }
      if (
        ingressValid &&
        egressValid &&
        candidate.ingress.protocol !== candidate.egress.protocol
      ) {
        issues.push(
          registrationIssue(
            "ingress and egress adapter protocols do not agree",
            candidate.protocol,
          ),
        );
      }

      if (egressValid && candidate.egress.protocol === candidate.protocol) {
        egressByProtocol.set(candidate.protocol, candidate.egress);
      }
      if (!ingressValid) continue;

      let paths: unknown[];
      try {
        paths = [...candidate.ingress.paths];
      } catch {
        issues.push(
          registrationIssue(
            "invalid ingress adapter paths",
            candidate.protocol,
          ),
        );
        continue;
      }
      if (paths.length === 0) {
        issues.push(
          registrationIssue("ingress adapter has no paths", candidate.protocol),
        );
      }
      for (const pathValue of paths) {
        if (!validPath(pathValue)) {
          issues.push(
            registrationIssue("invalid ingress path", candidate.protocol),
          );
          continue;
        }
        const path = pathValue;
        if (OPERATIONAL_PATHS[path] === true) {
          issues.push(
            registrationIssue(
              "operational path cannot be registered",
              candidate.protocol,
              path,
            ),
          );
          continue;
        }
        const owner = pathOwners.get(path);
        if (owner !== undefined) {
          issues.push(
            registrationIssue(
              "duplicate ingress path",
              candidate.protocol,
              path,
            ),
          );
          continue;
        }
        pathOwners.set(path, candidate.protocol);
        if (candidate.ingress.protocol === candidate.protocol) {
          ingressByPath.set(path, candidate.ingress);
        }
      }
    }

    if (issues.length > 0) throw new AdapterRegistrationError(issues);
    this.#ingressByPath = ingressByPath;
    this.#egressByProtocol = egressByProtocol;
    Object.freeze(this);
  }

  /** Resolves a registered path or throws a safe typed 404 gateway error. */
  ingress(path: string, requestId?: string): IngressTranslationAdapter {
    const adapter = this.#ingressByPath.get(path);
    if (adapter !== undefined) return adapter;
    const safeRequestId = validateRequestId(requestId).valid
      ? (requestId as string)
      : "invalid-request-id";
    throw lookupFailure(
      "validation",
      "unknown_path",
      "Unknown translation path.",
      404,
      safeRequestId,
    );
  }

  /** Resolves a registered protocol or throws a safe typed internal error. */
  egress(
    protocol: ProtocolNamespace,
    requestId?: string,
  ): EgressTranslationAdapter {
    const adapter = this.#egressByProtocol.get(protocol);
    if (adapter !== undefined) return adapter;
    const safeRequestId = validateRequestId(requestId).valid
      ? (requestId as string)
      : "invalid-request-id";
    throw lookupFailure(
      "internal",
      "adapter_protocol_not_registered",
      "No egress adapter is registered for the protocol.",
      500,
      safeRequestId,
    );
  }
}

/**
 * Creates the built-in protocol factory. Each requested family is instantiated
 * at most once and its ingress paths remain the sole route authority.
 */
export function createBuiltInProtocolAdapterFactory(
  options: BuiltInProtocolAdapterFactoryOptions,
): ProtocolAdapterFactory {
  return new BuiltInProtocolAdapterFactory(options);
}
/** Startup target that records successful atomic adapter registration. */
export interface AdapterRegistrationReadiness {
  /** Transitions adapter readiness after registration succeeds. */
  setAdaptersRegistered(registered: boolean): void;
}

/**
 * Constructs the complete registry before publishing adapter readiness.
 * Registration failures leave the supplied readiness target untouched.
 */
export function registerProtocolAdapters(
  registrations: ReadonlyArray<ProtocolAdapterRegistration>,
  readiness: AdapterRegistrationReadiness,
): AtomicAdapterRegistry {
  const registry = new AtomicAdapterRegistry(registrations);
  readiness.setAdaptersRegistered(true);
  return registry;
}
