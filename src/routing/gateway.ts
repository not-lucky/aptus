import type { AptusConfig, ModelConfig, RouteConfig } from "../config/types.ts";
import type {
  DryRunProviderRequest,
  DryRunResult,
  Gateway,
  GatewayRequest,
  GatewayResult,
  JsonObject,
  JsonValue,
  OwnedBody,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  TraceRecorder,
} from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import { createRedactor, type Redactor } from "../observability/trace/redaction.ts";
import { type AttemptContext, executeAttempt } from "./attempt.ts";
import { type CandidateDescriptor, type ProviderEntry, resolveCandidates } from "./candidates.ts";
import {
  failureFromObservation,
  interruptedFailure,
  statusFromCategory,
  timeoutFailure,
  unavailableFailure,
  unsupportedCapabilityFailure,
} from "./failures.ts";
import { createKeyPool } from "./key-pool.ts";
import { type RelayContext, relayComplete, relayStream } from "./relay.ts";
import { createNameIndex, type NameIndex } from "./resolution.ts";
import { shouldFallback, shouldRetry } from "./retry-policy.ts";
import { spoolResponseBody } from "./spool.ts";
import {
  type Clock,
  type RandomSource,
  type Sleeper,
  systemClock,
  systemRandomSource,
  systemSleeper,
} from "./timing.ts";

/**
 * Construction options for the Gateway composition seam.
 */
export interface GatewayOptions {
  /** Deep-frozen configuration snapshot. */
  readonly config: AptusConfig;
  /** SHA-256 config revision digest recorded in trace manifests. */
  readonly revision: string;
  /** Protocol adapters keyed by protocol. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Network dispatcher. */
  readonly dispatcher: ProviderDispatcher;
  /** Trace recorder (file or no-op). */
  readonly traceRecorder: TraceRecorder;
  /** Telemetry observer. */
  readonly observer: GatewayObservability;
  /** Optional monotonic and wall clock source. */
  readonly clock?: Clock;
  /** Optional abortable sleeper. */
  readonly sleeper?: Sleeper;
  /** Optional pseudo-random number generator. */
  readonly random?: RandomSource;
  /** Optional field-aware secret redactor. */
  readonly redactor?: Redactor;
}

/**
 * Gateway dependencies plus precomputed indexes and timing seams.
 */
interface RunDependencies {
  readonly config: AptusConfig;
  readonly revision: string;
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  readonly dispatcher: ProviderDispatcher;
  readonly traceRecorder: TraceRecorder;
  readonly observer: GatewayObservability;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly nameIndex: NameIndex;
  readonly modelsByName: ReadonlyMap<string, ModelConfig>;
  readonly routesByName: ReadonlyMap<string, RouteConfig>;
  readonly providers: ReadonlyMap<string, ProviderEntry>;
  readonly redactor: Redactor;
}

/**
 * Creates the native request Gateway orchestrator.
 *
 * @param options - Composition dependencies.
 * @returns A {@link Gateway} instance.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const clock = options.clock ?? systemClock;
  const sleeper = options.sleeper ?? systemSleeper;
  const random = options.random ?? systemRandomSource;
  const keyPoolConfig = options.config.routing.keyPool;

  const nameIndex = createNameIndex(options.config);
  const modelsByName = new Map(options.config.models.map((model) => [model.name, model]));
  const routesByName = new Map(options.config.routes.map((route) => [route.name, route]));
  const providers = new Map<string, ProviderEntry>(
    options.config.providers.map((provider) => [
      provider.name,
      {
        config: provider,
        pool: createKeyPool(provider.name, provider.keys, provider.keyStrategy, keyPoolConfig, random),
      },
    ]),
  );

  const secrets = new Set<string>();
  for (const client of options.config.auth.clientKeys) secrets.add(client.secret);
  for (const provider of options.config.providers) {
    for (const key of provider.keys) secrets.add(key.secret);
  }
  const redactor = options.redactor ?? createRedactor(secrets);

  const deps: RunDependencies = {
    config: options.config,
    revision: options.revision,
    adapters: options.adapters,
    dispatcher: options.dispatcher,
    traceRecorder: options.traceRecorder,
    observer: options.observer,
    clock,
    sleeper,
    nameIndex,
    modelsByName,
    routesByName,
    providers,
    redactor,
  };

  return { execute: (request) => runRequest(request, deps) };
}

/**
 * Executes the native request sequence or dry-run evaluation.
 */
async function runRequest(request: GatewayRequest, deps: RunDependencies): Promise<GatewayResult> {
  const clock = deps.clock;
  const started = clock.nowMonotonicMs();
  const deadlineMs = started + deps.config.server.requestDeadlineMs;
  const streamIdleMs = deps.config.server.streamIdleMs;
  const aptusRequestId = request.aptusRequestId;

  let attemptNumber = 0;

  // A terminal fact is built here but finalized by HTTP after the client write,
  // so duration and first-byte timing reflect actual delivery rather than the
  // moment the Gateway discovered the outcome.
  const terminalFailure = (failure: NormalizedFailure, candidate?: CandidateDescriptor): GatewayResult => {
    const status = statusFromCategory(failure.category, request.protocol);
    const fact = {
      terminal: { kind: "failed" as const, failure },
      outcomeCategory: "failed" as const,
      status,
      attempts: attemptNumber,
      stream: request.stream,
      targetProtocol: candidate?.provider.protocol,
      provider: candidate?.provider.name,
      canonicalPublicName: request.canonicalPublicName,
    };
    return {
      kind: "failure",
      failure,
      finalize: async (durationMs: number) => {
        await request.coordinator.finalize({ ...fact, durationMs });
      },
    };
  };

  const internalFault = (): GatewayResult => {
    const fact = {
      terminal: { kind: "incomplete" as const, reason: "internal_fault" as const },
      outcomeCategory: "failed" as const,
      status: 500,
      attempts: attemptNumber,
      stream: request.stream,
      canonicalPublicName: request.canonicalPublicName,
    };
    return {
      kind: "internal_fault",
      finalize: async (durationMs: number) => {
        await request.coordinator.finalize({ ...fact, durationMs });
      },
    };
  };

  try {
    const candidates = resolveCandidates(request.canonicalPublicName, {
      modelsByName: deps.modelsByName,
      routesByName: deps.routesByName,
      providers: deps.providers,
    });

    let lastCandidateFailure: NormalizedFailure | undefined;

    const emitFallback = async (
      from: CandidateDescriptor,
      to: CandidateDescriptor,
      category: IrFailureCategory,
    ): Promise<void> => {
      await request.trace.recordJson("fallback", {
        fromCandidateIndex: from.index,
        toCandidateIndex: to.index,
        category,
      });
      deps.observer.fallbackSelected({
        aptusRequestId,
        endpointProtocol: request.protocol,
        targetProtocol: from.provider.protocol,
        publicName: request.canonicalPublicName,
        fromCandidateIndex: from.index,
        toCandidateIndex: to.index,
        category,
      });
      deps.observer.observe({
        type: "fallback_selected",
        aptusRequestId,
        fromCandidateIndex: from.index,
        toCandidateIndex: to.index,
        category,
      });
    };

    /** True (after emitting the transition) when policy allows moving to the next candidate. */
    const tryFallback = async (
      candidate: CandidateDescriptor,
      candidateIndex: number,
      category: IrFailureCategory,
    ): Promise<boolean> => {
      const allowed = shouldFallback({
        category,
        beforeClientBytes: true,
        hasNextCandidate: candidateIndex < candidates.length - 1,
        fallbackOn: candidate.fallbackOn,
      });
      if (!allowed) return false;
      const next = candidates[candidateIndex + 1];
      if (next !== undefined) await emitFallback(candidate, next, category);
      return true;
    };

    // ==========================================
    // DRY RUN PATH (zero dispatch, read-only key)
    // ==========================================
    if (deps.config.dryRun.enabled) {
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        if (candidate === undefined) continue;

        // Protocol preflight check
        if (candidate.provider.protocol !== request.protocol) {
          const skip = unsupportedCapabilityFailure(candidate.provider.protocol);
          await request.trace.recordJson("candidate_skip", {
            candidateIndex: candidate.index,
            provider: candidate.provider.name,
            targetProtocol: candidate.provider.protocol,
            category: skip.category,
            capability: skip.capability ?? null,
          });
          deps.observer.candidateSkipped({
            aptusRequestId,
            endpointProtocol: request.protocol,
            canonicalPublicName: request.canonicalPublicName,
            candidateIndex: candidate.index,
            provider: candidate.provider.name,
            targetProtocol: candidate.provider.protocol,
            category: skip.category,
            capability: skip.capability,
          });
          deps.observer.observe({
            type: "candidate_skipped",
            aptusRequestId,
            candidateIndex: candidate.index,
            provider: candidate.provider.name,
            targetProtocol: candidate.provider.protocol,
            failure: skip,
          });
          continue;
        }

        await request.trace.recordJson("preflight", {
          ok: true,
          provider: candidate.provider.name,
          protocol: candidate.provider.protocol,
        });

        // Key preview (non-mutating)
        const preview = candidate.pool.preview();
        if (preview === undefined) {
          const failure = unavailableFailure();
          lastCandidateFailure = failure;
          if (await tryFallback(candidate, candidateIndex, failure.category)) {
            continue;
          }
          return terminalFailure(failure, candidate);
        }

        await request.trace.recordJson("key_selection", {
          provider: candidate.provider.name,
          keyName: preview.keyName,
          strategy: candidate.provider.keyStrategy,
        });

        // Native preparation
        const adapter = deps.adapters[request.protocol];
        const prepareResult = adapter.prepareNative({
          baseUrl: candidate.provider.baseUrl,
          protocol: candidate.provider.protocol,
          clientHeaders: request.headers,
          clientBody: request.body,
          mutations: candidate.mutations,
          upstreamModel: candidate.model.upstreamModel,
          providerSecret: preview.secret,
          providerHeaders: candidate.provider.headers,
          deadlineMs,
          streamIdleMs,
        });

        if (!prepareResult.ok) {
          return terminalFailure(prepareResult.error, candidate);
        }

        const prepared = prepareResult.value;
        await request.trace.recordJson("mutation", { mutations: prepared.mutations });

        // Redact outbound request headers and body for preview inspection
        const redactedHeaders = deps.redactor.redactHeaders(prepared.headers);
        const parsedBody = JSON.parse(new TextDecoder().decode(prepared.body)) as JsonObject;
        const redactedBody = deps.redactor.redactJson(parsedBody) as JsonObject;

        const dryRunProviderRequest: DryRunProviderRequest = {
          method: "POST",
          url: prepared.url,
          headers: redactedHeaders,
          body: redactedBody,
        };

        await request.trace.recordJson("provider_request", dryRunProviderRequest as unknown as JsonValue);

        const dryRunResult: DryRunResult = {
          dryRun: true,
          aptusRequestId,
          sourceProtocol: request.protocol,
          targetProtocol: candidate.provider.protocol,
          publicName: request.canonicalPublicName,
          candidate: {
            provider: candidate.provider.name,
            model: candidate.model.upstreamModel,
            key: preview.keyName,
          },
          mutations: prepared.mutations,
          preflight: { ok: true },
          providerRequest: dryRunProviderRequest,
        };

        return {
          kind: "dry_run",
          status: 200,
          contentType: "application/vnd.aptus.dry-run+json",
          body: dryRunResult,
        };
      }

      return terminalFailure(lastCandidateFailure ?? unsupportedCapabilityFailure(request.protocol));
    }

    // ==========================================
    // NORMAL DISPATCH PATH
    // ==========================================
    const relayContextFor = (candidate: CandidateDescriptor, attempts: number): RelayContext => ({
      aptusRequestId,
      started,
      endpointProtocol: request.protocol,
      canonicalName: request.canonicalPublicName,
      providerName: candidate.provider.name,
      targetProtocol: candidate.provider.protocol,
      attemptCount: attempts,
      trace: request.trace,
      coordinator: request.coordinator,
      observer: deps.observer,
      requestSignal: request.signal,
      clock,
      pricing: candidate.model.pricing,
    });

    const attemptContext: AttemptContext = {
      adapters: deps.adapters,
      dispatcher: deps.dispatcher,
      trace: request.trace,
      observer: deps.observer,
      clock,
      sleeper: deps.sleeper,
      deadlineMs,
      streamIdleMs,
      nextAttemptNumber: () => ++attemptNumber,
    };

    candidateLoop: for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      if (candidate === undefined) continue;

      // Protocol preflight check
      if (candidate.provider.protocol !== request.protocol) {
        const skip = unsupportedCapabilityFailure(candidate.provider.protocol);
        await request.trace.recordJson("candidate_skip", {
          candidateIndex: candidate.index,
          provider: candidate.provider.name,
          targetProtocol: candidate.provider.protocol,
          category: skip.category,
          capability: skip.capability ?? null,
        });
        deps.observer.candidateSkipped({
          aptusRequestId,
          endpointProtocol: request.protocol,
          canonicalPublicName: request.canonicalPublicName,
          candidateIndex: candidate.index,
          provider: candidate.provider.name,
          targetProtocol: candidate.provider.protocol,
          category: skip.category,
          capability: skip.capability,
        });
        deps.observer.observe({
          type: "candidate_skipped",
          aptusRequestId,
          candidateIndex: candidate.index,
          provider: candidate.provider.name,
          targetProtocol: candidate.provider.protocol,
          failure: skip,
        });
        continue;
      }

      await request.trace.recordJson("preflight", {
        ok: true,
        provider: candidate.provider.name,
        protocol: candidate.provider.protocol,
      });

      let candidateAttemptCount = 0;

      while (true) {
        const outcome = await executeAttempt(candidate, request, attemptContext);

        if (outcome.kind === "cancelled") {
          const durationMs = clock.nowMonotonicMs() - started;
          await request.coordinator.finalize({
            terminal: { kind: "cancelled", by: "client" },
            outcomeCategory: "cancelled",
            status: 499,
            attempts: attemptNumber,
            stream: request.stream,
            durationMs,
            canonicalPublicName: request.canonicalPublicName,
          });
          return { kind: "failure", failure: timeoutFailure() };
        }
        if (outcome.kind === "deadline_exceeded") {
          return terminalFailure(timeoutFailure(), candidate);
        }
        if (outcome.kind === "prepare_failed") {
          return terminalFailure(outcome.failure, candidate);
        }
        if (outcome.kind === "key_unavailable" || outcome.kind === "dispatch_failed") {
          const failure = outcome.kind === "key_unavailable" ? unavailableFailure() : outcome.failure;
          lastCandidateFailure = failure;
          if (await tryFallback(candidate, candidateIndex, failure.category)) {
            continue candidateLoop;
          }
          return terminalFailure(failure, candidate);
        }

        // Response head arrived
        candidateAttemptCount++;
        const { response, observation, cooldownMs } = outcome;

        if (observation.result === "success" && outcome.streamRequested) {
          return relayStream(response, relayContextFor(candidate, outcome.attemptNumber));
        }

        if (observation.result !== "success") {
          const category = observation.result as IrFailureCategory;
          const canRetry = shouldRetry({
            status: observation.status,
            category,
            beforeClientBytes: observation.beforeClientBytes,
            candidateAttemptCount,
            retryOn: candidate.retryOn,
          });

          if (canRetry) {
            await response.body.cancel().catch(() => undefined);
            const delayMs = cooldownMs ?? 0;
            await request.trace.recordJson("retry", {
              attemptNumber: outcome.attemptNumber,
              provider: candidate.provider.name,
              category,
              delayMs,
            });
            deps.observer.retryScheduled({
              aptusRequestId,
              attemptNumber: outcome.attemptNumber,
              provider: candidate.provider.name,
              targetProtocol: candidate.provider.protocol,
              category,
              delayMs,
            });
            deps.observer.observe({
              type: "retry_scheduled",
              aptusRequestId,
              attemptNumber: outcome.attemptNumber,
              delayMs,
              category,
            });
            continue; // Retry with key rotation
          }

          lastCandidateFailure = failureFromObservation(observation);
          if (await tryFallback(candidate, candidateIndex, category)) {
            await response.body.cancel().catch(() => undefined);
            continue candidateLoop;
          }
        }

        // Read full body for relay
        let body: OwnedBody;
        try {
          body = await spoolResponseBody(response.body);
        } catch {
          if (observation.result === "success") {
            const failure = interruptedFailure();
            lastCandidateFailure = failure;
            if (await tryFallback(candidate, candidateIndex, failure.category)) {
              continue candidateLoop;
            }
            return terminalFailure(failure, candidate);
          }
          return terminalFailure(interruptedFailure(), candidate);
        }

        return relayComplete(response, body, observation, relayContextFor(candidate, outcome.attemptNumber));
      }
    }

    return terminalFailure(lastCandidateFailure ?? unsupportedCapabilityFailure(request.protocol));
  } catch {
    return internalFault();
  }
}
