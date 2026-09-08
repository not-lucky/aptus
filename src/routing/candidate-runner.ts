import type { AttemptObservation, GatewayRequest, GatewayResult, OwnedBody, Protocol } from "../domain/contracts.ts";
import type { IrFailureCategory, NormalizedFailure } from "../domain/operations.ts";
import type { GatewayObservability } from "../observability/lifecycle-observer.ts";
import { type AttemptContext, type AttemptOutcome, classifyAbortReason } from "./attempt.ts";
import type { CandidateDescriptor } from "./candidates.ts";
import { failureFromObservation, interruptedFailure, timeoutFailure, unavailableFailure } from "./failures.ts";
import { type RelayContext, relayComplete, relayStream, relayTranslatedComplete } from "./relay.ts";
import { shouldRetry } from "./retry-policy.ts";
import { spoolResponseBody } from "./spool.ts";
import type { Clock } from "./timing.ts";
import type { TranslatedAttemptOutcome } from "./translated-attempt.ts";
import type { TranslatedStreamAttemptOutcome } from "./translated-stream-attempt.ts";

/**
 * Normalized attempt outcome across the three execution paths.
 *
 * Native, translated-complete, and translated-stream outcomes share the
 * `cancelled | deadline_exceeded | prepare_failed | key_unavailable |
 * dispatch_failed | response` prefix and differ only on success
 * (`response+streamRequested` vs `translated_response` vs `stream_ready`).
 */
export type RunnerAttemptOutcome = AttemptOutcome | TranslatedAttemptOutcome | TranslatedStreamAttemptOutcome;

/**
 * Per-path mechanics adapter. Policy lives in {@link runCandidate};
 * each strategy only produces the next attempt outcome.
 */
export interface CandidateStrategy {
  readonly kind: "native" | "translated-complete" | "translated-stream";
  execute(): Promise<RunnerAttemptOutcome>;
}

/**
 * Policy dependencies supplied by the Gateway. The Gateway keeps outer
 * iteration, dry-run, and the translation gate; the runner owns the outcome
 * switch, retry, fallback, and terminal wiring.
 */
export interface RunnerShared {
  readonly request: GatewayRequest;
  readonly observer: GatewayObservability;
  readonly clock: Clock;
  readonly started: number;
  readonly relayContextFor: (candidate: CandidateDescriptor, attempts: number) => RelayContext;
  readonly terminalFailure: (failure: NormalizedFailure, candidate?: CandidateDescriptor) => GatewayResult;
  readonly handleCancellation: (
    stream: boolean,
    targetProtocol?: Protocol,
    provider?: string,
  ) => Promise<GatewayResult>;
  readonly emitCandidateSkip: (candidate: CandidateDescriptor, failure: NormalizedFailure) => Promise<void>;
  readonly tryFallback: (
    candidate: CandidateDescriptor,
    candidateIndex: number,
    category: IrFailureCategory,
  ) => Promise<boolean>;
}

/**
 * Result of running one candidate to a policy decision.
 */
export type RunnerResult =
  | { readonly kind: "returned"; readonly result: GatewayResult }
  | { readonly kind: "nextCandidate"; readonly failure: NormalizedFailure };

export type { AttemptContext };

/**
 * Runs one candidate's attempt loop to a policy decision.
 *
 * Single owner of the outcome switch — cancelled, deadline, prepare-failed,
 * key-unavailable, response, success — with retry/fallback/terminal wiring.
 * Success mechanics stay per-path via the strategy kind and relay helpers.
 *
 * @param candidate - The candidate being attempted.
 * @param candidateIndex - Index in route order for fallback emission.
 * @param shared - Gateway-owned policy dependencies.
 * @param strategy - Per-path attempt producer.
 * @returns Either a terminal GatewayResult or a request to advance candidates.
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
          // Native terminal falls through to spool + relay, so the body
          // must stay readable; translated terminals never relay the body.
          strategy.kind !== "native",
        );
        if (decision === "retry") continue;
        if (decision.kind === "fallback") return { kind: "nextCandidate", failure: decision.failure };
        if (strategy.kind !== "native") {
          return { kind: "returned", result: shared.terminalFailure(decision.failure, candidate) };
        }
        // Native terminal: fall through to spool + relayComplete so the
        // upstream error body relays unchanged (terminal recorded on delivery).
      }

      // Success complete, or native non-success with no retry/fallback:
      // spool the full body, then relay.
      let body: OwnedBody;
      try {
        body = await spoolResponseBody(outcome.response.body);
      } catch {
        if (shared.request.signal.aborted) {
          const durationMs = shared.clock.nowMonotonicMs() - shared.started;
          const by = classifyAbortReason(shared.request.signal) === "shutdown" ? "shutdown" : "client";
          await shared.request.trace.recordJson("cancellation", { phase: "relay", by });
          shared.observer.cancelled({ aptusRequestId: shared.request.aptusRequestId, phase: "relay", by });
          await shared.request.coordinator.finalize({
            terminal: { kind: "cancelled", by },
            outcomeCategory: "cancelled",
            status: 499,
            attempts: outcome.attemptNumber,
            stream: shared.request.stream,
            durationMs,
            targetProtocol: candidate.provider.protocol,
            provider: candidate.provider.name,
            canonicalPublicName: shared.request.canonicalPublicName,
          });
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
 * Shared response-failure policy: same-candidate retry, else fallback, else
 * terminal. Previously duplicated between the translated loops (helper) and
 * the native loop (inlined copy).
 *
 * @param cancelTerminalBody - Cancel the body on the terminal path. False for
 * native terminals, which fall through to spool + relay and must keep the
 * body readable; true for translated terminals, which never relay the body.
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
    shared.observer.retryScheduled({
      aptusRequestId: shared.request.aptusRequestId,
      attemptNumber,
      provider: candidate.provider.name,
      targetProtocol: candidate.provider.protocol,
      category,
      delayMs,
    });
    shared.observer.observe({
      type: "retry_scheduled",
      aptusRequestId: shared.request.aptusRequestId,
      attemptNumber,
      delayMs,
      category,
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
