/**
 * @fileoverview
 * Per-candidate attempt loop execution and retry/fallback policy evaluation.
 *
 * Implements the core attempt loop driving a single candidate: dispatches attempts via a
 * {@link CandidateStrategy}, processes terminal conditions (cancellations, deadlines, preparation
 * faults, key unavailability), evaluates same-candidate retries and route fallbacks, and executes
 * response spooling and relay handoffs.
 */

import type { AttemptObservation, GatewayRequest, GatewayResult, OwnedBody, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";
import type { LifecycleObserver } from "../observability/lifecycle-observer.ts";
import { type AttemptContext, type AttemptOutcome, classifyAbortReason } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import type { DryRunOutcome } from "./dry-run.ts";
import { failureFromObservation, interruptedFailure, timeoutFailure, unavailableFailure } from "./failures.ts";
import { type RelayContext, relayComplete, relayStream, relayTranslatedComplete } from "./relay.ts";
import { shouldRetry } from "./retry-policy.ts";
import { spoolResponseBody } from "./spool.ts";
import { finalizeTerminal } from "./terminal-outcome.ts";
import type { Clock } from "./timing.ts";
import type { TranslatedAttemptOutcome } from "./translated-attempt.ts";
import type { TranslatedStreamAttemptOutcome } from "./translated-stream-attempt.ts";

/** Normalized attempt outcome across native, translated complete, translated streaming, and dry-run paths. */
export type RunnerAttemptOutcome =
  | AttemptOutcome
  | TranslatedAttemptOutcome
  | TranslatedStreamAttemptOutcome
  | DryRunOutcome;

/**
 * Strategy contract providing per-path attempt execution mechanics.
 */
export interface CandidateStrategy {
  /** Strategy discriminator indicating the execution mode. */
  readonly kind: "native" | "translated-complete" | "translated-stream" | "dry-run";
  /** Executes the next attempt iteration. */
  execute(): Promise<RunnerAttemptOutcome>;
}

/**
 * Policy dependencies and lifecycle callbacks supplied by the gateway orchestrator.
 */
export interface RunnerShared {
  /** Active inbound gateway request. */
  readonly request: GatewayRequest;
  /** Telemetry observer for lifecycle logging and metrics. */
  readonly observer: LifecycleObserver;
  /** Monotonic and wall clock source. */
  readonly clock: Clock;
  /** Monotonic millisecond timestamp when request processing started. */
  readonly started: number;
  /** Factory creating relay context for a given candidate and attempt count. */
  readonly relayContextFor: (candidate: CandidateDescriptor, attempts: number) => RelayContext;
  /** Helper constructing a terminal failure result. */
  readonly terminalFailure: (failure: NormalizedFailure, candidate?: CandidateDescriptor) => GatewayResult;
  /** Handler finalizing a cancelled request and emitting cancellation telemetry. */
  readonly handleCancellation: (
    stream: boolean,
    targetProtocol?: Protocol,
    provider?: string,
  ) => Promise<GatewayResult>;
  /** Emits skip telemetry and trace stages when a candidate is bypassed. */
  readonly emitCandidateSkip: (candidate: CandidateDescriptor, failure: NormalizedFailure) => Promise<void>;
  /** Evaluates fallback policy and emits fallback telemetry if permitted. */
  readonly tryFallback: (
    candidate: CandidateDescriptor,
    candidateIndex: number,
    category: IrFailureCategory,
  ) => Promise<boolean>;
}

/** Result of executing a candidate loop: either a terminal gateway result or a fallback instruction. */
export type RunnerResult =
  | { readonly kind: "returned"; readonly result: GatewayResult }
  | { readonly kind: "nextCandidate"; readonly failure: NormalizedFailure };

export type { AttemptContext };

/**
 * Executes the attempt loop for a candidate until a response relays, a terminal failure occurs, or fallback is triggered.
 *
 * @param candidate - Selected candidate descriptor.
 * @param candidateIndex - Zero-based index of the candidate in the route sequence.
 * @param shared - Gateway-provided policy dependencies and callbacks.
 * @param strategy - Per-path attempt strategy instance.
 * @returns Final gateway result or request to advance to the next candidate.
 */
export async function runCandidate(
  candidate: CandidateDescriptor,
  candidateIndex: number,
  shared: RunnerShared,
  strategy: CandidateStrategy,
): Promise<RunnerResult> {
  let candidateAttemptCount = 0;

  while (true) {
    const outcome = await strategy.execute();

    if (outcome.kind === "dry_run") {
      return {
        kind: "returned",
        result: {
          kind: "dry_run",
          status: 200,
          contentType: "application/vnd.aptus.dry-run+json",
          body: outcome.result,
        },
      };
    }
    if (outcome.kind === "cancelled") {
      const stream = strategy.kind === "native" ? shared.request.stream : strategy.kind === "translated-stream";
      return {
        kind: "returned",
        result: await shared.handleCancellation(stream, candidate.provider.protocol, candidate.provider.name),
      };
    }
    if (outcome.kind === "deadline_exceeded") {
      return { kind: "returned", result: shared.terminalFailure(timeoutFailure(), candidate) };
    }
    if (outcome.kind === "prepare_failed") {
      if (outcome.failure.category === "unsupported_capability") {
        await shared.emitCandidateSkip(candidate, outcome.failure);
        return { kind: "nextCandidate", failure: outcome.failure };
      }
      return { kind: "returned", result: shared.terminalFailure(outcome.failure, candidate) };
    }
    if (outcome.kind === "key_unavailable" || outcome.kind === "dispatch_failed") {
      const failure = outcome.kind === "key_unavailable" ? unavailableFailure() : outcome.failure;
      if (await shared.tryFallback(candidate, candidateIndex, failure.category)) {
        return { kind: "nextCandidate", failure };
      }
      return { kind: "returned", result: shared.terminalFailure(failure, candidate) };
    }

    if (outcome.kind === "response") {
      candidateAttemptCount++;
      const streamRequested = "streamRequested" in outcome && outcome.streamRequested === true;
      if (outcome.observation.result === "success" && streamRequested) {
        return {
          kind: "returned",
          result: relayStream(outcome.response, shared.relayContextFor(candidate, outcome.attemptNumber)),
        };
      }

      if (outcome.observation.result !== "success") {
        const decision = await handleResponseFailure(
          shared,
          candidate,
          candidateIndex,
          candidateAttemptCount,
          outcome.response,
          outcome.observation,
          outcome.attemptNumber,
          outcome.cooldownMs,
          strategy.kind !== "native",
        );
        if (decision === "retry") continue;
        if (decision.kind === "fallback") return { kind: "nextCandidate", failure: decision.failure };
        if (strategy.kind !== "native") {
          return { kind: "returned", result: shared.terminalFailure(decision.failure, candidate) };
        }
      }

      let body: OwnedBody;
      try {
        body = await spoolResponseBody(outcome.response.body);
      } catch {
        if (shared.request.signal.aborted) {
          const durationMs = shared.clock.nowMonotonicMs() - shared.started;
          const by = classifyAbortReason(shared.request.signal) === "shutdown" ? "shutdown" : "client";
          await shared.request.trace.recordJson("cancellation", { phase: "relay", by });
          shared.observer.observe({
            type: "cancelled",
            aptusRequestId: shared.request.aptusRequestId,
            phase: "relay",
            by,
          });
          await finalizeTerminal(
            shared.request.coordinator,
            {
              attempts: outcome.attemptNumber,
              stream: shared.request.stream,
              clientProtocol: shared.request.protocol,
              targetProtocol: candidate.provider.protocol,
              provider: candidate.provider.name,
              canonicalPublicName: shared.request.canonicalPublicName,
            },
            { kind: "cancelled", by },
            durationMs,
          );
          return { kind: "returned", result: { kind: "cancelled", by } };
        }
        if (outcome.observation.result === "success") {
          const failure = interruptedFailure();
          if (await shared.tryFallback(candidate, candidateIndex, failure.category)) {
            return { kind: "nextCandidate", failure };
          }
          return { kind: "returned", result: shared.terminalFailure(failure, candidate) };
        }
        return { kind: "returned", result: shared.terminalFailure(interruptedFailure(), candidate) };
      }

      return {
        kind: "returned",
        result: await relayComplete(
          outcome.response,
          body,
          outcome.observation,
          shared.relayContextFor(candidate, outcome.attemptNumber),
        ),
      };
    }

    if (outcome.kind === "translated_response") {
      return {
        kind: "returned",
        result: await relayTranslatedComplete(
          outcome.response,
          outcome.body,
          outcome.outcome,
          shared.relayContextFor(candidate, outcome.attemptNumber),
        ),
      };
    }

    return { kind: "returned", result: outcome.result };
  }
}

/**
 * Evaluates retry and fallback policies following an unsuccessful provider attempt response.
 *
 * @param shared - Gateway-owned policy dependencies.
 * @param candidate - Candidate descriptor attempted.
 * @param candidateIndex - Candidate position in route order.
 * @param candidateAttemptCount - Attempts made on this candidate so far.
 * @param response - Response object carrying readable body stream.
 * @param observation - Attempt result observation.
 * @param attemptNumber - Global attempt count.
 * @param cooldownMs - Optional cooldown scheduled for the key.
 * @param cancelTerminalBody - Whether to cancel the response body when terminal.
 * @returns Decision indicating retry, fallback, or terminal failure.
 */
async function handleResponseFailure(
  shared: RunnerShared,
  candidate: CandidateDescriptor,
  candidateIndex: number,
  candidateAttemptCount: number,
  response: { body: { cancel(): Promise<unknown> } },
  observation: AttemptObservation,
  attemptNumber: number,
  cooldownMs?: number,
  cancelTerminalBody = true,
): Promise<
  | "retry"
  | { readonly kind: "fallback"; readonly failure: NormalizedFailure }
  | { readonly kind: "terminal"; readonly failure: NormalizedFailure }
> {
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
    await shared.request.trace.recordJson("retry", {
      attemptNumber,
      provider: candidate.provider.name,
      category,
      delayMs,
    });
    shared.observer.observe({
      type: "retry_scheduled",
      aptusRequestId: shared.request.aptusRequestId,
      attemptNumber,
      provider: candidate.provider.name,
      targetProtocol: candidate.provider.protocol,
      category,
      delayMs,
    });
    return "retry";
  }

  const failure = failureFromObservation(observation);
  if (await shared.tryFallback(candidate, candidateIndex, category)) {
    await response.body.cancel().catch(() => undefined);
    return { kind: "fallback", failure };
  }
  if (cancelTerminalBody) await response.body.cancel().catch(() => undefined);
  return { kind: "terminal", failure };
}
