import type { AptusConfig, ModelConfig, RouteConfig } from "../config/types.ts";
import type {
  AttemptObservation,
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
import type { TranslationCoordinator } from "../translation/contracts.ts";
import { type AttemptContext, classifyAbortReason, executeAttempt } from "./attempt.ts";
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
import { type RelayContext, relayComplete, relayStream, relayTranslatedComplete } from "./relay.ts";
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
import { executeTranslatedAttempt, executeTranslatedDryRun } from "./translated-attempt.ts";
import { executeTranslatedStreamAttempt } from "./translated-stream-attempt.ts";

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
  /** Optional cross-protocol translation coordinator. */
  readonly translation?: TranslationCoordinator;
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
  readonly translation?: TranslationCoordinator;
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
    translation: options.translation,
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

    /** Records one candidate skip in Trace and telemetry (shared by both execution paths). */
    const emitCandidateSkip = async (candidate: CandidateDescriptor, failure: NormalizedFailure): Promise<void> => {
      await request.trace.recordJson("candidate_skip", {
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        category: failure.category,
        capability: failure.capability ?? null,
      });
      deps.observer.candidateSkipped({
        aptusRequestId,
        endpointProtocol: request.protocol,
        canonicalPublicName: request.canonicalPublicName,
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        category: failure.category,
        capability: failure.capability,
      });
      deps.observer.observe({
        type: "candidate_skipped",
        aptusRequestId,
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        failure,
      });
    };

    /**
     * Gates a cross-protocol candidate: returns the capability failure that
     * blocks it (no translation bundle or streaming request), or the active
     * coordinator when the candidate may proceed to translation.
     *
     * A no-translation skip is a generic "no compatible provider" condition and
     * does not become the lastCandidateFailure (so a prior real failure or the
     * client-protocol generic surfaces as terminal). A stream skip names the
     * actual capability and does become the terminal when every candidate is
     * skipped.
     */
    const translationGate = (
      candidate: CandidateDescriptor,
    ):
      | { readonly kind: "blocked"; readonly failure: NormalizedFailure; readonly terminal: boolean }
      | { readonly kind: "proceed"; readonly translation: TranslationCoordinator } => {
      if (deps.translation === undefined) {
        return { kind: "blocked", failure: unsupportedCapabilityFailure(candidate.provider.protocol), terminal: false };
      }
      return { kind: "proceed", translation: deps.translation };
    };

    // ==========================================
    // DRY RUN PATH (zero dispatch, read-only key)
    // ==========================================
    if (deps.config.dryRun.enabled) {
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        if (candidate === undefined) continue;

        // Protocol preflight check / Translation branch
        if (candidate.provider.protocol !== request.protocol) {
          const gate = translationGate(candidate);
          if (gate.kind === "blocked") {
            await emitCandidateSkip(candidate, gate.failure);
            if (gate.terminal) lastCandidateFailure = gate.failure;
            continue;
          }
          const translation = gate.translation;

          await request.trace.recordJson("translation_ingress", {
            sourceProtocol: request.protocol,
            targetProtocol: candidate.provider.protocol,
            publicName: request.canonicalPublicName,
          });

          const dryRunOutcome = await executeTranslatedDryRun(
            candidate,
            request,
            {
              adapters: deps.adapters,
              dispatcher: deps.dispatcher,
              trace: request.trace,
              observer: deps.observer,
              clock,
              sleeper: deps.sleeper,
              deadlineMs,
              streamIdleMs,
              nextAttemptNumber: () => ++attemptNumber,
            },
            translation,
            deps.redactor,
          );

          if (dryRunOutcome.kind === "skipped") {
            if (dryRunOutcome.failure.category === "unsupported_capability") {
              await emitCandidateSkip(candidate, dryRunOutcome.failure);
              lastCandidateFailure = dryRunOutcome.failure;
              continue;
            }
            // A request-level translation failure (e.g. malformed payload) is
            // not a candidate incompatibility: no other candidate can serve it.
            return terminalFailure(dryRunOutcome.failure, candidate);
          }

          if (dryRunOutcome.kind === "key_unavailable") {
            lastCandidateFailure = dryRunOutcome.failure;
            if (await tryFallback(candidate, candidateIndex, dryRunOutcome.failure.category)) {
              continue;
            }
            return terminalFailure(dryRunOutcome.failure, candidate);
          }

          return {
            kind: "dry_run",
            status: 200,
            contentType: "application/vnd.aptus.dry-run+json",
            body: dryRunOutcome.result,
          };
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
      nextAttemptNumber: () => {
        const n = ++attemptNumber;
        request.coordinator.recordAttempt(n);
        return n;
      },
    };

    const handleCancellation = async (
      stream: boolean,
      targetProtocol?: Protocol,
      provider?: string,
    ): Promise<GatewayResult> => {
      const durationMs = clock.nowMonotonicMs() - started;
      const by = classifyAbortReason(request.signal) === "shutdown" ? "shutdown" : "client";
      await request.coordinator.finalize({
        terminal: { kind: "cancelled", by },
        outcomeCategory: "cancelled",
        status: 499,
        attempts: attemptNumber,
        stream,
        durationMs,
        targetProtocol,
        provider,
        canonicalPublicName: request.canonicalPublicName,
      });
      return { kind: "cancelled", by };
    };

    const handleResponseFailure = async (
      candidate: CandidateDescriptor,
      candidateIndex: number,
      candidateAttemptCount: number,
      response: { body: { cancel(): Promise<unknown> } },
      observation: AttemptObservation,
      attemptNumber: number,
      cooldownMs?: number,
    ): Promise<
      | "retry"
      | { readonly kind: "fallback"; readonly failure: NormalizedFailure }
      | { readonly kind: "terminal"; readonly failure: NormalizedFailure }
    > => {
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
          attemptNumber,
          provider: candidate.provider.name,
          category,
          delayMs,
        });
        deps.observer.retryScheduled({
          aptusRequestId,
          attemptNumber,
          provider: candidate.provider.name,
          targetProtocol: candidate.provider.protocol,
          category,
          delayMs,
        });
        deps.observer.observe({
          type: "retry_scheduled",
          aptusRequestId,
          attemptNumber,
          delayMs,
          category,
        });
        return "retry";
      }

      const failure = failureFromObservation(observation);
      if (await tryFallback(candidate, candidateIndex, category)) {
        await response.body.cancel().catch(() => undefined);
        return { kind: "fallback", failure };
      }
      await response.body.cancel().catch(() => undefined);
      return { kind: "terminal", failure };
    };

    candidateLoop: for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      if (candidate === undefined) continue; // Protocol preflight check / Translation branch
      if (candidate.provider.protocol !== request.protocol) {
        const gate = translationGate(candidate);
        if (gate.kind === "blocked") {
          await emitCandidateSkip(candidate, gate.failure);
          if (gate.terminal) lastCandidateFailure = gate.failure;
          continue;
        }
        const translation = gate.translation;

        await request.trace.recordJson("translation_ingress", {
          sourceProtocol: request.protocol,
          targetProtocol: candidate.provider.protocol,
          publicName: request.canonicalPublicName,
        });

        let candidateAttemptCount = 0;

        if (request.stream) {
          while (true) {
            const outcome = await executeTranslatedStreamAttempt(candidate, request, attemptContext, translation);

            if (outcome.kind === "cancelled") {
              return handleCancellation(true, candidate.provider.protocol, candidate.provider.name);
            }
            if (outcome.kind === "deadline_exceeded") {
              return terminalFailure(timeoutFailure(), candidate);
            }
            if (outcome.kind === "prepare_failed") {
              if (outcome.failure.category === "unsupported_capability") {
                await emitCandidateSkip(candidate, outcome.failure);
                lastCandidateFailure = outcome.failure;
                continue candidateLoop;
              }
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

            if (outcome.kind === "response") {
              candidateAttemptCount++;
              const decision = await handleResponseFailure(
                candidate,
                candidateIndex,
                candidateAttemptCount,
                outcome.response,
                outcome.observation,
                outcome.attemptNumber,
                outcome.cooldownMs,
              );
              if (decision === "retry") continue;
              lastCandidateFailure = decision.failure;
              if (decision.kind === "fallback") continue candidateLoop;
              return terminalFailure(decision.failure, candidate);
            }

            if (outcome.kind === "stream_ready") {
              return outcome.result;
            }
          }
        } else {
          while (true) {
            const outcome = await executeTranslatedAttempt(candidate, request, attemptContext, translation);

            if (outcome.kind === "cancelled") {
              return handleCancellation(false, candidate.provider.protocol, candidate.provider.name);
            }
            if (outcome.kind === "deadline_exceeded") {
              return terminalFailure(timeoutFailure(), candidate);
            }
            if (outcome.kind === "prepare_failed") {
              if (outcome.failure.category === "unsupported_capability") {
                await emitCandidateSkip(candidate, outcome.failure);
                lastCandidateFailure = outcome.failure;
                continue candidateLoop;
              }
              // A request-level translation failure (e.g. malformed payload) is
              // not a candidate incompatibility: no other candidate can serve it.
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

            if (outcome.kind === "response") {
              candidateAttemptCount++;
              const decision = await handleResponseFailure(
                candidate,
                candidateIndex,
                candidateAttemptCount,
                outcome.response,
                outcome.observation,
                outcome.attemptNumber,
                outcome.cooldownMs,
              );
              if (decision === "retry") continue;
              lastCandidateFailure = decision.failure;
              if (decision.kind === "fallback") continue candidateLoop;
              return terminalFailure(decision.failure, candidate);
            }

            if (outcome.kind === "translated_response") {
              return relayTranslatedComplete(
                outcome.response,
                outcome.body,
                outcome.outcome,
                relayContextFor(candidate, outcome.attemptNumber),
              );
            }
          }
        }
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
          return handleCancellation(request.stream, candidate.provider.protocol, candidate.provider.name);
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
            continue;
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
          if (request.signal.aborted) {
            const durationMs = clock.nowMonotonicMs() - started;
            const by = classifyAbortReason(request.signal) === "shutdown" ? "shutdown" : "client";
            await request.trace.recordJson("cancellation", { phase: "relay", by });
            deps.observer.cancelled({ aptusRequestId, phase: "relay", by });
            await request.coordinator.finalize({
              terminal: { kind: "cancelled", by },
              outcomeCategory: "cancelled",
              status: 499,
              attempts: attemptNumber,
              stream: request.stream,
              durationMs,
              targetProtocol: candidate.provider.protocol,
              provider: candidate.provider.name,
              canonicalPublicName: request.canonicalPublicName,
            });
            return { kind: "cancelled", by };
          }
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
