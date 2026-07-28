import type { AptusConfig, ModelConfig, RouteConfig } from "../config/types.js";
import type {
  Gateway,
  GatewayRequest,
  GatewayResult,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  TraceRecorder,
} from "../domain/contracts.js";
import type { IrFailureCategory, NormalizedFailure, TraceTerminal } from "../domain/operations.js";
import type { GatewayObservability } from "../observability/lifecycle-observer.js";
import { type AttemptContext, executeAttempt } from "./attempt.js";
import { type CandidateDescriptor, type ProviderEntry, resolveCandidates } from "./candidates.js";
import {
  cancelledFailure,
  failureFromObservation,
  failureJson,
  internalFailure,
  interruptedFailure,
  notFoundFailure,
  timeoutFailure,
  unavailableFailure,
  unsupportedCapabilityFailure,
} from "./failures.js";
import { createKeyPool } from "./key-pool.js";
import { type RelayContext, readAll, relayComplete, relayStream } from "./relay.js";
import { authorizePublicName, createNameIndex, type NameIndex } from "./resolution.js";
import { shouldFallback, shouldRetry } from "./retry-policy.js";
import {
  type Clock,
  type RandomSource,
  type Sleeper,
  systemClock,
  systemRandomSource,
  systemSleeper,
} from "./timing.js";

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
}

/**
 * Creates the native request Gateway orchestrator.
 *
 * The Gateway owns request admission sequencing (ingress, authentication,
 * resolution), candidate iteration, and the retry/fallback policy loop.
 * Mechanical attempt execution lives in `attempt.ts`, response relay in
 * `relay.ts`, key health in `key-pool.ts`, and the pure retry/fallback
 * decisions in `retry-policy.ts`.
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
  };

  return { execute: (request) => runRequest(request, deps) };
}

/**
 * Executes the full native request sequence, finishing the Trace and the
 * `request_terminal` observation exactly once on every path.
 */
async function runRequest(request: GatewayRequest, deps: RunDependencies): Promise<GatewayResult> {
  const clock = deps.clock;
  const started = clock.nowMonotonicMs();
  const deadlineMs = started + deps.config.server.requestDeadlineMs;
  const streamIdleMs = deps.config.server.streamIdleMs;
  const streamRequested = request.body.stream === true;
  const aptusRequestId = request.aptusRequestId;

  const trace = await deps.traceRecorder.start({
    aptusRequestId,
    startedAtLocal: formatTraceDirectoryTimestamp(clock.nowWall()),
    configRevision: deps.revision,
    sourceProtocol: request.protocol,
  });

  let attemptNumber = 0;
  let terminalFired = false;

  // Fires the terminal trace + request_terminal observation exactly once.
  const finish = async (terminal: TraceTerminal): Promise<void> => {
    if (terminalFired) return;
    terminalFired = true;
    await trace.finish(terminal);
    deps.observer.requestTerminal({ aptusRequestId, endpointProtocol: request.protocol, stream: streamRequested });
    deps.observer.observe({
      type: "request_terminal",
      aptusRequestId,
      result: terminal.kind === "incomplete" ? "failed" : terminal.kind,
    });
  };

  const terminalFailure = async (failure: NormalizedFailure): Promise<GatewayResult> => {
    await finish({ kind: "failed", failure });
    return { kind: "failure", failure };
  };

  try {
    // 1. Ingress + client request trace stage.
    deps.observer.requestIngress({
      aptusRequestId,
      endpointProtocol: request.protocol,
      endpoint: endpointLabel(request.endpoint),
      stream: streamRequested,
    });
    deps.observer.observe({
      type: "request_ingress",
      aptusRequestId,
      sourceProtocol: request.protocol,
      stream: streamRequested,
    });
    await trace.recordJson("client_request", { headers: request.headers, body: request.body });

    // 2. Authentication (scheme derived from protocol; the secret was stripped at ingress).
    const scheme = request.protocol === "anthropic-messages" ? "x-api-key" : "Bearer";
    await trace.recordJson("authentication", { scheme, clientKeyName: request.clientKeyName });
    deps.observer.authResult({ aptusRequestId, scheme, result: "ok" });

    // 3. Read public model + resolve + authorize.
    const publicName = deps.adapters[request.protocol].readPublicModel(request.body);
    if (!publicName.ok) {
      await trace.recordJson("resolution", { failure: failureJson(publicName.error) });
      return terminalFailure(publicName.error);
    }
    const canonicalName = authorizePublicName(deps.nameIndex, request.clientKeyName, publicName.value);
    if (canonicalName === undefined) {
      const failure = notFoundFailure();
      await trace.recordJson("resolution", { requested: publicName.value });
      return terminalFailure(failure);
    }
    const resolutionKind = deps.modelsByName.has(canonicalName) ? "model" : "route";
    await trace.recordJson("resolution", {
      publicName: publicName.value,
      canonicalPublicName: canonicalName,
      kind: resolutionKind,
    });
    deps.observer.nameResolved({ aptusRequestId, canonicalPublicName: canonicalName, kind: resolutionKind });

    const candidates = resolveCandidates(canonicalName, {
      modelsByName: deps.modelsByName,
      routesByName: deps.routesByName,
      providers: deps.providers,
    });

    // The failure that ended the most recent dispatched (or key-exhausted)
    // candidate. When the loop ends without a relay — the last fallback target
    // was preflight-skipped — this is the terminal, never a synthetic stand-in.
    let lastCandidateFailure: NormalizedFailure | undefined;

    const emitFallback = async (
      from: CandidateDescriptor,
      to: CandidateDescriptor,
      category: IrFailureCategory,
    ): Promise<void> => {
      await trace.recordJson("fallback", { fromCandidateIndex: from.index, toCandidateIndex: to.index, category });
      deps.observer.fallbackSelected({
        aptusRequestId,
        endpointProtocol: request.protocol,
        targetProtocol: from.provider.protocol,
        publicName: canonicalName,
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

    const relayContextFor = (candidate: CandidateDescriptor, attempts: number): RelayContext => ({
      aptusRequestId,
      started,
      endpointProtocol: request.protocol,
      canonicalName,
      providerName: candidate.provider.name,
      targetProtocol: candidate.provider.protocol,
      attemptCount: attempts,
      trace,
      finish,
      observer: deps.observer,
      requestSignal: request.signal,
      clock,
    });

    const attemptContext: AttemptContext = {
      adapters: deps.adapters,
      dispatcher: deps.dispatcher,
      trace,
      observer: deps.observer,
      clock,
      sleeper: deps.sleeper,
      deadlineMs,
      streamIdleMs,
      nextAttemptNumber: () => ++attemptNumber,
    };

    // 4. Iterate ordered candidates.
    candidateLoop: for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      if (candidate === undefined) continue;

      // 4a. Protocol-match preflight (mismatch => zero-dispatch skip).
      if (candidate.provider.protocol !== request.protocol) {
        const skip = unsupportedCapabilityFailure(candidate.provider.protocol);
        await trace.recordJson("candidate_skip", {
          candidateIndex: candidate.index,
          provider: candidate.provider.name,
          targetProtocol: candidate.provider.protocol,
          category: skip.category,
          capability: skip.capability ?? null,
        });
        deps.observer.candidateSkipped({
          aptusRequestId,
          endpointProtocol: request.protocol,
          canonicalPublicName: canonicalName,
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

      await trace.recordJson("preflight", {
        ok: true,
        provider: candidate.provider.name,
        protocol: candidate.provider.protocol,
      });

      // 4b. Candidate attempt loop (same-candidate retry up to the cap).
      let candidateAttemptCount = 0;

      while (true) {
        const outcome = await executeAttempt(candidate, request, attemptContext);

        if (outcome.kind === "cancelled") {
          await finish({ kind: "cancelled", by: "client" });
          return { kind: "failure", failure: cancelledFailure() };
        }
        if (outcome.kind === "deadline_exceeded") {
          return terminalFailure(timeoutFailure());
        }
        if (outcome.kind === "prepare_failed") {
          return terminalFailure(outcome.failure);
        }
        if (outcome.kind === "key_unavailable" || outcome.kind === "dispatch_failed") {
          const failure = outcome.kind === "key_unavailable" ? unavailableFailure() : outcome.failure;
          lastCandidateFailure = failure;
          if (await tryFallback(candidate, candidateIndex, failure.category)) continue candidateLoop;
          return terminalFailure(failure);
        }

        // 4c. A response head arrived: this attempt owns the response.
        candidateAttemptCount++;
        const { response, observation, cooldownMs } = outcome;

        if (observation.result === "success" && outcome.streamRequested) {
          return relayStream(response, relayContextFor(candidate, outcome.attemptNumber));
        }

        // A non-2xx head is decided from the head alone (ADR 0004: "explicit
        // pre-body" status), before any body byte is read. A body that later
        // truncates must not reclassify an already retryable/fallbackable head.
        if (observation.result !== "success") {
          // classify() never returns "success"/"client_cancelled" for a non-2xx head.
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
            // The exact scheduled cooldown (base + jitter) is owned by the Key Pool
            // and returned from `observe`, so the trace/log never recompute it.
            const delayMs = cooldownMs ?? 0;
            await trace.recordJson("retry", {
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
            continue; // Retry with key rotation before any wait.
          }

          lastCandidateFailure = failureFromObservation(observation);
          if (await tryFallback(candidate, candidateIndex, category)) {
            await response.body.cancel().catch(() => undefined);
            continue candidateLoop;
          }
        }

        // Terminal for this request: read the full body, then relay it. A 2xx
        // body that interrupts can still fall back by policy (no client bytes
        // yet); a non-2xx head has already exhausted retry and fallback above,
        // so its interrupted body terminates as `stream_interrupted`.
        let body: Uint8Array;
        try {
          body = await readAll(response.body);
        } catch {
          if (observation.result === "success") {
            const failure = interruptedFailure();
            lastCandidateFailure = failure;
            if (await tryFallback(candidate, candidateIndex, failure.category)) continue candidateLoop;
            return terminalFailure(failure);
          }
          return terminalFailure(interruptedFailure());
        }

        return relayComplete(response, body, observation, relayContextFor(candidate, outcome.attemptNumber));
      }
    }

    // No candidate succeeded. Zero dispatches means every candidate was
    // skipped preflight; otherwise surface the failure that actually ended
    // the last dispatched or key-exhausted candidate.
    return terminalFailure(lastCandidateFailure ?? unsupportedCapabilityFailure(request.protocol));
  } catch {
    return terminalFailure(internalFailure());
  }
}

/**
 * Maps a canonical endpoint path to its metrics label.
 */
function endpointLabel(endpoint: GatewayRequest["endpoint"]): string {
  switch (endpoint) {
    case "/chat/completions":
      return "chat_completions";
    case "/responses":
      return "responses";
    case "/messages":
      return "messages";
  }
}

/**
 * Formats a local timestamp into the trace directory prefix:
 * `YYYY-MM-DDTHH-mm-ss.SSS±HHMM` (colons are avoided for filesystem safety).
 */
function formatTraceDirectoryTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}
