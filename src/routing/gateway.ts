/**
 * @fileoverview
 * Routing gateway composition root and candidate orchestration engine.
 *
 * Implements the {@link Gateway} contract via {@link createGateway}: builds immutable candidate,
 * provider, and route indexes from configuration, manages key pool instances, and executes requests.
 * Evaluates candidates in route order across dry-run previews, native attempts, and cross-protocol
 * translated attempts with automatic retries and fallback progression.
 */

import type { AptusConfig, ModelConfig, RouteConfig } from "../config/types.ts";
import type {
  Gateway,
  GatewayRequest,
  GatewayResult,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  TraceRecorder,
} from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import { createRedactor, type Redactor } from "../observability/trace/redaction.ts";
import type { TranslationCoordinator } from "../translation/contracts.ts";
import { type AttemptContext, classifyAbortReason, executeAttempt } from "./attempt.ts";
import { type RunnerShared, runCandidate } from "./candidate-runner.ts";
import { type CandidateDescriptor, type ProviderEntry, resolveCandidates } from "./candidates.ts";
import { executeNativeDryRun, executeTranslatedDryRun } from "./dry-run.ts";
import { unsupportedCapabilityFailure } from "./failures.ts";
import { createKeyPool } from "./key-pool.ts";
import type { RelayContext } from "./relay.ts";
import { createNameIndex, type NameIndex } from "./resolution.ts";
import { shouldFallback } from "./retry-policy.ts";
import { buildTerminalFact, finalizeTerminal } from "./terminal-outcome.ts";
import {
  type Clock,
  type RandomSource,
  type Sleeper,
  systemClock,
  systemRandomSource,
  systemSleeper,
} from "./timing.ts";
import { executeTranslatedAttempt } from "./translated-attempt.ts";
import { executeTranslatedStreamAttempt } from "./translated-stream-attempt.ts";

/**
 * Options for constructing the gateway orchestrator instance.
 */
export interface GatewayOptions {
  /** Gateway configuration snapshot. */
  readonly config: AptusConfig;
  /** SHA-256 digest of configuration revision. */
  readonly revision: string;
  /** Protocol adapters keyed by protocol identifier. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Network dispatcher executing provider HTTP requests. */
  readonly dispatcher: ProviderDispatcher;
  /** Trace recorder opening per-request trace sessions. */
  readonly traceRecorder: TraceRecorder;
  /** Telemetry observer tracking request lifecycle events. */
  readonly observer: LifecycleObserver;
  /** Monotonic and wall clock source (defaults to `systemClock`). */
  readonly clock?: Clock;
  /** Abortable sleeper timer (defaults to `systemSleeper`). */
  readonly sleeper?: Sleeper;
  /** Pseudo-random number generator for jitter (defaults to `systemRandomSource`). */
  readonly random?: RandomSource;
  /** Redactor for stripping secrets from trace logs (defaults to auto-discovered secrets). */
  readonly redactor?: Redactor;
  /** Optional cross-protocol translation coordinator. */
  readonly translation?: TranslationCoordinator;
}

/** Resolved gateway dependencies and precomputed configuration indexes. */
interface RunDependencies {
  /** Gateway configuration snapshot. */
  readonly config: AptusConfig;
  /** SHA-256 digest of configuration revision. */
  readonly revision: string;
  /** Protocol adapters keyed by protocol identifier. */
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  /** Network dispatcher executing provider HTTP requests. */
  readonly dispatcher: ProviderDispatcher;
  /** Trace recorder opening per-request trace sessions. */
  readonly traceRecorder: TraceRecorder;
  /** Telemetry observer tracking request lifecycle events. */
  readonly observer: LifecycleObserver;
  /** Monotonic and wall clock source. */
  readonly clock: Clock;
  /** Abortable sleeper timer. */
  readonly sleeper: Sleeper;
  /** Precomputed model/route name and authorization index. */
  readonly nameIndex: NameIndex;
  /** Precomputed map of configured models by name. */
  readonly modelsByName: ReadonlyMap<string, ModelConfig>;
  /** Precomputed map of configured routes by name. */
  readonly routesByName: ReadonlyMap<string, RouteConfig>;
  /** Precomputed map of providers and their key pools. */
  readonly providers: ReadonlyMap<string, ProviderEntry>;
  /** Redactor for stripping secrets from trace logs. */
  readonly redactor: Redactor;
  /** Optional cross-protocol translation coordinator. */
  readonly translation?: TranslationCoordinator;
}

/**
 * Creates the routing gateway orchestrator implementing the {@link Gateway} contract.
 *
 * Precomputes lookup indexes, initializes provider key pools, builds credential redactors,
 * and wires candidate dispatch loops for incoming requests.
 *
 * @param options - Gateway composition dependencies and configuration.
 * @returns Gateway instance with an `execute` entry point.
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
 * Executes a single request through candidate resolution, retries, and fallback progression.
 *
 * @param request - Admitted gateway request.
 * @param deps - Resolved gateway dependencies and precomputed indexes.
 * @returns Gateway result for HTTP response relay.
 */
async function runRequest(request: GatewayRequest, deps: RunDependencies): Promise<GatewayResult> {
  const clock = deps.clock;
  const started = clock.nowMonotonicMs();
  const deadlineMs = started + deps.config.server.requestDeadlineMs;
  const streamIdleMs = deps.config.server.streamIdleMs;
  const aptusRequestId = request.aptusRequestId;

  let attemptNumber = 0;

  // Terminal facts are derived through the shared outcome vocabulary but finalized by
  // HTTP only after the client write, so each result carries a deferred finalize seam.
  const terminalFailure = (failure: NormalizedFailure, candidate?: CandidateDescriptor): GatewayResult => {
    const fact = buildTerminalFact(
      {
        attempts: attemptNumber,
        stream: request.stream,
        clientProtocol: request.protocol,
        targetProtocol: candidate?.provider.protocol,
        provider: candidate?.provider.name,
        canonicalPublicName: request.canonicalPublicName,
      },
      { kind: "failed", failure },
    );
    return {
      kind: "failure",
      failure,
      finalize: async (durationMs: number) => {
        await request.coordinator.finalize({ ...fact, durationMs });
      },
    };
  };

  const internalFault = (): GatewayResult => {
    const fact = buildTerminalFact(
      {
        attempts: attemptNumber,
        stream: request.stream,
        clientProtocol: request.protocol,
        canonicalPublicName: request.canonicalPublicName,
      },
      { kind: "fault" },
    );
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
      deps.observer.observe({
        type: "fallback_selected",
        aptusRequestId,
        endpointProtocol: request.protocol,
        targetProtocol: from.provider.protocol,
        publicName: request.canonicalPublicName,
        fromCandidateIndex: from.index,
        toCandidateIndex: to.index,
        category,
      });
    };

    /** True when policy allows moving to the next candidate. */
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

    /** Records candidate skip in trace and telemetry. */
    const emitCandidateSkip = async (candidate: CandidateDescriptor, failure: NormalizedFailure): Promise<void> => {
      await request.trace.recordJson("candidate_skip", {
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        category: failure.category,
        capability: failure.capability ?? null,
      });
      deps.observer.observe({
        type: "candidate_skipped",
        aptusRequestId,
        endpointProtocol: request.protocol,
        canonicalPublicName: request.canonicalPublicName,
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        category: failure.category,
        capability: failure.capability,
      });
    };

    /** Gates a cross-protocol candidate, checking coordinator availability. */
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
    // CANDIDATE SWEEP — one engine drives dispatch and dry-run preview modes
    // (native / translated-complete / translated-stream, plus the dry-run
    // strategies when config.dryRun.enabled, all through runCandidate)
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
      await finalizeTerminal(
        request.coordinator,
        {
          attempts: attemptNumber,
          stream,
          clientProtocol: request.protocol,
          targetProtocol,
          provider,
          canonicalPublicName: request.canonicalPublicName,
        },
        { kind: "cancelled", by },
        durationMs,
      );
      return { kind: "cancelled", by };
    };

    const runnerShared: RunnerShared = {
      request,
      observer: deps.observer,
      clock,
      started,
      relayContextFor,
      terminalFailure,
      handleCancellation,
      emitCandidateSkip,
      tryFallback,
    };

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

        if (deps.config.dryRun.enabled) {
          const dryRunResult = await runCandidate(candidate, candidateIndex, runnerShared, {
            kind: "dry-run",
            execute: () => executeTranslatedDryRun(candidate, request, attemptContext, translation, deps.redactor),
          });
          if (dryRunResult.kind === "returned") return dryRunResult.result;
          lastCandidateFailure = dryRunResult.failure;
          continue;
        }

        const translatedResult = await runCandidate(
          candidate,
          candidateIndex,
          runnerShared,
          request.stream
            ? {
                kind: "translated-stream",
                execute: () => executeTranslatedStreamAttempt(candidate, request, attemptContext, translation),
              }
            : {
                kind: "translated-complete",
                execute: () => executeTranslatedAttempt(candidate, request, attemptContext, translation),
              },
        );
        if (translatedResult.kind === "returned") return translatedResult.result;
        lastCandidateFailure = translatedResult.failure;
        continue;
      }

      await request.trace.recordJson("preflight", {
        ok: true,
        provider: candidate.provider.name,
        protocol: candidate.provider.protocol,
      });

      if (deps.config.dryRun.enabled) {
        const dryRunResult = await runCandidate(candidate, candidateIndex, runnerShared, {
          kind: "dry-run",
          execute: () => executeNativeDryRun(candidate, request, attemptContext, deps.redactor),
        });
        if (dryRunResult.kind === "returned") return dryRunResult.result;
        lastCandidateFailure = dryRunResult.failure;
        continue;
      }

      const nativeResult = await runCandidate(candidate, candidateIndex, runnerShared, {
        kind: "native",
        execute: () => executeAttempt(candidate, request, attemptContext),
      });
      if (nativeResult.kind === "returned") return nativeResult.result;
      lastCandidateFailure = nativeResult.failure;
    }

    return terminalFailure(lastCandidateFailure ?? unsupportedCapabilityFailure(request.protocol));
  } catch {
    return internalFault();
  }
}
