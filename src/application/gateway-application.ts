import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
  RouteCandidate,
} from "../domain/index.js";
import {
  createGatewayError,
  isSafeCanonicalResponse,
  validateCanonicalRequest,
  validateRequestId,
} from "../domain/index.js";
import type {
  AdapterRegistry,
  GatewayApplication,
  GatewayAuthenticationCapability,
  GatewayContext,
  GatewayExchange,
  GatewayExchangeFactory,
  GatewayCommand,
  HookManager,
  HookName,
  HookResult,
  HookTimeoutConfiguration,
  ProviderFactory,
  RequestIdFactory,
} from "./index.js";
import type { RouteResolver } from "./routing.js";
import type { ClockPort, TracePort } from "../ports/infrastructure.js";
import type {
  DispatchCandidatePolicy,
  DispatchPolicyPort,
  DispatchPolicySnapshot,
} from "../ports/dispatch.js";
import type { CredentialStatePort } from "../ports/credentials.js";
import { classifyCredentialFailure } from "../ports/credentials.js";
import type { EgressValue, RawIngressInput, TranslationContext } from "../ports/translation.js";
import {
  BoundedCandidateIterator,
  DISPATCH_STATE_KEYS,
  DispatchBudgetLedger,
  DispatchBudgetStateError,
  composeProviderDispatch,
  type DispatchCostEstimate,
} from "./dispatch.js";

/** Required ports and policies composing the default gateway lifecycle. */
export interface GatewayApplicationDependencies {
  /** Adapter registry for ingress and egress protocol boundaries. */
  readonly adapters: AdapterRegistry;
  /** Ordered lifecycle hook manager. */
  readonly hooks: HookManager;
  /** Canonical route resolver. */
  readonly routes: RouteResolver;
  /** Provider dispatch factory. */
  readonly providers: ProviderFactory;
  /** Clock used for bounded hook races. */
  readonly clock: ClockPort;
  /** Request identity generator. */
  readonly requestIds: RequestIdFactory;
  /** Per-hook timeout and retry policies. */
  readonly hookTimeouts: HookTimeoutConfiguration;
  /** Safe authentication capability supplied by the outer application boundary. */
  readonly auth: GatewayAuthenticationCapability;
  /** Captured request-local dispatch policy source. */
  readonly dispatchPolicies: DispatchPolicyPort;
  /** Authoritative credential lifecycle state. */
  readonly credentials: CredentialStatePort;
  /** Already-redacted dispatch trace sink. */
  readonly trace: TracePort;
}

type StageResult<T> =
  | { readonly ok: true; readonly value: T; readonly context: GatewayContext }
  | { readonly ok: true; readonly shortCircuit: T; readonly context: GatewayContext }
  | { readonly ok: false; readonly error: GatewayError };
type RequestStage =
  "onIngressReceived" | "onCanonicalTranslate" | "beforeUpstreamDispatch";

const SAFE_FALLBACK_REQUEST_ID = "invalid-request-id";
const ALREADY_STARTED_CODE = "exchange_already_started";
const INVALID_EGRESS_CODE = "invalid_egress_state";

function isGatewayError(value: unknown): value is GatewayError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GatewayError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.status === "number" &&
    typeof candidate.requestId === "string"
  );
}

interface PendingEgress {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

function safeError(
  requestId: string,
  code: string,
  message: string,
  category: GatewayError["category"],
  status: number,
  retryable: boolean,
  details?: Record<string, unknown>,
): GatewayError {
  return createGatewayError({
    category,
    code,
    message,
    status,
    retryable,
    requestId,
    ...(details === undefined ? {} : { details }),
  });
}

function normalizeFailure(value: unknown, requestId: string): GatewayError {
  if (isGatewayError(value)) return value;
  if (value instanceof DOMException && value.name === "AbortError") {
    return safeError(
      requestId,
      "request_cancelled",
      "request cancelled",
      "timeout",
      504,
      false,
    );
  }
  return safeError(
    requestId,
    "lifecycle_failed",
    "request lifecycle failed",
    "internal",
    500,
    false,
  );
}

function dispatchFailure(value: unknown, requestId: string): GatewayError {
  if (value instanceof DispatchBudgetStateError)
    return safeError(requestId, "dispatch_budget_failed", "dispatch budget failed", "internal", 500, false);
  if (value instanceof Error && value.name === "DispatchPolicyResolutionError")
    return safeError(requestId, "dispatch_policy_failed", "dispatch policy failed", "internal", 500, false);
  return normalizeFailure(value, requestId);
}

function syntheticRequest(requestId: string): CanonicalRequest {
  return {
    requestId,
    receivedAt: "1970-01-01T00:00:00Z",
    source: { adapter: "unknown", protocol: "custom", path: "" },
    model: "",
    messages: [],
    routing: {},
    stream: false,
  };
}

function isRequestStage(hook: HookName): hook is RequestStage {
  return (
    hook === "onIngressReceived" ||
    hook === "onCanonicalTranslate" ||
    hook === "beforeUpstreamDispatch"
  );
}
function isSuccessfulResponse(response: CanonicalResponse): boolean {
  return response.provider.upstreamStatus >= 200 &&
    response.provider.upstreamStatus <= 299 &&
    response.error === undefined &&
    !response.choices.some((choice) => choice.finishReason === "content_filter");
}

function responseMayAdvance(
  response: CanonicalResponse,
  policy: DispatchCandidatePolicy,
): boolean {
  const code = response.error?.code;
  if (code === "content_filter" || code === "context_overflow") return false;
  if (response.choices.some((choice) => choice.finishReason === "content_filter")) return false;
  const status = response.provider.upstreamStatus;
  if (status === 401 || status === 403) return true;
  if (status === 429 || status >= 500)
    return !policy.statusPolicy.nonRetryable.includes(status);
  return false;
}

function errorMayAdvance(error: GatewayError): boolean {
  return error.code === "upstream_dns" ||
    error.code === "upstream_connection" ||
    error.code === "upstream_timeout";
}

class DefaultGatewayExchange implements GatewayExchange {
  private readonly controller = new AbortController();
  private requestIdentity = SAFE_FALLBACK_REQUEST_ID;
  private readonly state = new Map<string, unknown>();
  private readonly commands: GatewayCommand[] = [];
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private context: GatewayContext;
  private readonly commitmentState = { committed: false };
  private readonly commitment = {
    isCommitted: (): boolean => this.commitmentState.committed,
  };
  private egressPrepared = false;
  private started = false;
  private finalized = false;
  private errorHandled = false;
  private canonicalReady = false;
  private pendingEgress: PendingEgress | undefined;
  private egressUsed = false;
  private egressFailure: GatewayError | undefined;
  private iterator: AsyncIterator<CanonicalChunk> | undefined;
  private iteratorClosed = false;
  private dispatchPolicySnapshot: DispatchPolicySnapshot | undefined;

  constructor(
    private readonly dependencies: GatewayApplicationDependencies,
    private readonly input: RawIngressInput,
  ) {
    this.context = this.makeContext(syntheticRequest(SAFE_FALLBACK_REQUEST_ID));
    const supplied = input.signal;
    if (supplied !== undefined) {
      const listener = (): void => this.controller.abort(supplied.reason);
      if (supplied.aborted) this.controller.abort(supplied.reason);
      else supplied.addEventListener("abort", listener, { once: true });
      this.cleanup.push(() => supplied.removeEventListener("abort", listener));
    }
  }
  handle(): Promise<CanonicalResponse | GatewayError> {
    if (!this.claim()) return Promise.resolve(this.alreadyStarted());
    return this.runHandle();
  }

  stream(): AsyncIterable<CanonicalChunk> {
    if (!this.claim()) return this.singleError(this.alreadyStarted());
    return this.runStream(true);
  }

  canonicalStream(): AsyncIterable<CanonicalChunk> {
    if (!this.claim()) return this.singleError(this.alreadyStarted());
    return this.runStream(false);
  }

  async runEgress(value: EgressValue): Promise<EgressValue | GatewayError> {
    if (
      this.finalized ||
      !this.canonicalReady ||
      this.egressUsed ||
      (this.pendingEgress === undefined && !this.canonicalReady)
    )
      return this.invalidEgress();
    if (this.controller.signal.aborted) {
      this.releasePendingEgress();
      return this.fail(
        normalizeFailure(this.controller.signal.reason, this.context.requestId),
      );
    }
    this.egressUsed = true;
    const result = await this.runStage(
      "onEgressTranslate",
      this.context,
      value,
    );
    const output = result.ok && "value" in result
      ? result.value
      : await this.fail(result.ok ? this.invalidEgress() : result.error);
    this.egressPrepared = result.ok && "value" in result;
    if (!result.ok) {
      this.releasePendingEgress();
      this.egressFailure = output as GatewayError;
    }
    return output;
  }

  commitEgress(): void {
    if (this.finalized || !this.egressPrepared) return;
    this.commitmentState.committed = true;
    this.egressPrepared = false;
    const pending = this.pendingEgress;
    this.pendingEgress = undefined;
    if (pending !== undefined && !pending.settled) {
      pending.settled = true;
      pending.resolve();
    }
  }
  /** Finalizes the exchange and releases request-owned resources. */
  async close(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.releasePendingEgress();
    await this.closeIterator();
    for (const command of [...this.commands].reverse()) {
      if (command.undo === undefined) continue;
      try {
        await command.undo();
      } catch {
        /* cleanup is best effort and never public */
      }
    }
    for (const action of this.cleanup.splice(0).reverse()) {
      try {
        await action();
      } catch {
        /* cleanup is best effort and never public */
      }
    }
  }

  private releasePendingEgress(): void {
    this.egressPrepared = false;
    this.egressUsed = false;
    const pending = this.pendingEgress;
    this.pendingEgress = undefined;
    if (pending !== undefined && !pending.settled) {
      pending.settled = true;
      pending.resolve();
    }
  }

  private claim(): boolean {
    if (this.started || this.finalized) return false;
    this.started = true;
    return true;
  }

  private alreadyStarted(): GatewayError {
    return safeError(
      this.context.requestId,
      ALREADY_STARTED_CODE,
      "exchange already started",
      "internal",
      500,
      false,
    );
  }

  private invalidEgress(): GatewayError {
    return safeError(
      this.context.requestId,
      INVALID_EGRESS_CODE,
      "invalid egress state",
      "internal",
      500,
      false,
    );
  }

  private singleError(error: GatewayError): AsyncIterable<CanonicalChunk> {
    return (async function* (): AsyncGenerator<CanonicalChunk> {
      yield { type: "error", error };
    })();
  }

  private makeContext(
    request: CanonicalRequest,
    selectedCandidate?: RouteCandidate,
  ): GatewayContext {
    return {
      request,
      requestId: this.requestIdentity,
      signal: this.controller.signal,
      commitment: this.commitment,
      ...(this.input.authorization === undefined
        ? {}
        : { authorization: this.input.authorization }),
      auth: this.dependencies.auth,
      state: this.state,
      getState: <T>(key: string): T | undefined =>
        this.state.get(key) as T | undefined,
      setState: <T>(key: string, value: T): void => {
        this.state.set(key, value);
      },
      execute: async <T>(command: GatewayCommand<T>): Promise<T> => {
        const value = await command.execute(this.controller.signal);
        if (command.undo !== undefined) this.commands.push(command);
        return value;
      },
      ...(selectedCandidate === undefined ? {} : { selectedCandidate }),
    };
  }

  private setContext(
    request: CanonicalRequest,
    selectedCandidate?: RouteCandidate,
  ): void {
    this.context = this.makeContext(request, selectedCandidate);
  }
  private async runStage<T>(
    hook: HookName,
    context: GatewayContext,
    input: T,
  ): Promise<StageResult<T>> {
    if (this.controller.signal.aborted)
      return {
        ok: false,
        error: normalizeFailure(this.controller.signal.reason, context.requestId),
      };
    const configuration = this.dependencies.hookTimeouts[hook];
    const timerController = new AbortController();
    const timeoutError = safeError(
      context.requestId,
      "hook_timeout",
      "lifecycle hook timed out",
      "timeout",
      504,
      configuration.retryable,
      { hook },
    );
    let hookPromise: Promise<HookResult<T>>;
    try {
      hookPromise = this.dependencies.hooks.run(hook, context, input);
    } catch (error: unknown) {
      return { ok: false, error: normalizeFailure(error, context.requestId) };
    }
    const timer = this.dependencies.clock
      .sleep(configuration.timeoutMs, timerController.signal)
      .then(() => ({ kind: "timeout" as const }));
    const settled = hookPromise.then(
      (value) => ({ kind: "hook" as const, value }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    const winner = await Promise.race([settled, timer]);
    if (winner.kind === "timeout") {
      timerController.abort();
      this.controller.abort(timeoutError);
      void hookPromise.catch(() => undefined);
      return { ok: false, error: timeoutError };
    }
    timerController.abort();
    if (winner.kind === "failure")
      return {
        ok: false,
        error: normalizeFailure(winner.error, context.requestId),
      };
    const result = winner.value;
    if (result.kind === "abort") return { ok: false, error: result.error };
    if (result.kind === "shortCircuit")
      return { ok: true, shortCircuit: result.value, context };
    let value: T = input;
    if (result.kind === "replace") value = result.value;
    else if (result.value !== undefined) value = result.value;
    if (isRequestStage(hook))
      this.setContext(value as CanonicalRequest, context.selectedCandidate);
    return { ok: true, value, context: this.context };
  }

  private cachedResponse(): CanonicalResponse | GatewayError {
    const value = this.context.getState<CanonicalResponse>("cache-lookup:response");
    if (!isSafeCanonicalResponse(value, this.context.requestId))
      return safeError(
        this.context.requestId,
        "invalid_short_circuit",
        "invalid lifecycle short circuit",
        "internal",
        500,
        false,
      );
    this.canonicalReady = true;
    return value;
  }

  private async fail(error: GatewayError): Promise<GatewayError> {
    if (this.errorHandled) return error;
    this.errorHandled = true;
    const result = await this.runStage("onError", this.context, error);
    if (!result.ok) return error;
    return "value" in result ? result.value : error;
  }

  private async *cachedChunks(
    response: CanonicalResponse,
    requireEgress: boolean,
  ): AsyncGenerator<CanonicalChunk> {
    const chunks: CanonicalChunk[] = [];
    let sequenceNumber = 0;
    chunks.push({
      type: "response_start",
      responseId: response.responseId,
      model: response.model,
      createdAt: response.createdAt,
      sequenceNumber: sequenceNumber++,
    });
    for (const choice of response.choices) {
      for (const [outputIndex, block] of choice.output.entries()) {
        const address = { choiceIndex: choice.index, outputIndex };
        chunks.push({
          type: "content_block_start",
          address,
          block: {
            type: block.type,
            ...(block.id === undefined ? {} : { id: block.id }),
            ...("name" in block && block.name !== undefined ? { name: block.name } : {}),
            ...("toolKind" in block && block.toolKind !== undefined
              ? { toolKind: block.toolKind }
              : {}),
            ...("serverName" in block && block.serverName !== undefined
              ? { serverName: block.serverName }
              : {}),
          },
          sequenceNumber: sequenceNumber++,
        });
        switch (block.type) {
          case "text":
            chunks.push({ type: "text_delta", address, text: block.text, sequenceNumber: sequenceNumber++ });
            for (const citation of block.citations ?? [])
              chunks.push({ type: "citation_added", address, citation, sequenceNumber: sequenceNumber++ });
            break;
          case "refusal":
            chunks.push({ type: "refusal_delta", address, text: block.refusal, sequenceNumber: sequenceNumber++ });
            break;
          case "reasoning":
            chunks.push({
              type: "reasoning_delta",
              address,
              ...(block.text === undefined ? {} : { text: block.text }),
              ...(block.signature === undefined ? {} : { signatureDelta: block.signature }),
              ...(block.redactedData === undefined ? {} : { redactedDataDelta: block.redactedData }),
              ...(block.encryptedContent === undefined ? {} : { encryptedContentDelta: block.encryptedContent }),
              sequenceNumber: sequenceNumber++,
            });
            break;
          case "audio_base64":
            chunks.push({ type: "audio_delta", address, audioBase64: block.data, sequenceNumber: sequenceNumber++ });
            break;
          case "audio_output":
            chunks.push({
              type: "audio_delta",
              address,
              ...(block.data === undefined ? {} : { audioBase64: block.data }),
              ...(block.transcript === undefined ? {} : { transcriptDelta: block.transcript }),
              sequenceNumber: sequenceNumber++,
            });
            break;
          case "tool_call":
            chunks.push({
              type: "tool_call_delta",
              address,
              id: block.toolCallId,
              name: block.name,
              argumentsDelta: block.argumentsJson,
              sequenceNumber: sequenceNumber++,
            });
            break;
          case "server_tool_call":
            chunks.push({
              type: "tool_call_delta",
              address,
              id: block.toolCallId,
              ...(block.name === undefined ? {} : { name: block.name }),
              ...(block.argumentsJson === undefined ? {} : { argumentsDelta: block.argumentsJson }),
              sequenceNumber: sequenceNumber++,
            });
            break;
          default:
            break;
        }
        chunks.push({
          type: "content_block_stop",
          address,
          block,
          sequenceNumber: sequenceNumber++,
        });
      }
      chunks.push({
        type: "choice_end",
        choiceIndex: choice.index,
        finishReason: choice.finishReason,
        ...(choice.stopSequence === undefined ? {} : { stopSequence: choice.stopSequence }),
        sequenceNumber: sequenceNumber++,
      });
    }
    chunks.push({ type: "usage", usage: response.usage, cost: response.cost, sequenceNumber: sequenceNumber++ });
    chunks.push({ type: "response_end", status: response.status, sequenceNumber });
    for (const chunk of chunks) {
      if (requireEgress && this.pendingEgress !== undefined)
        await this.pendingEgress.promise;
      if (this.egressFailure !== undefined) return;
      const result = await this.runStage("onStreamChunk", this.context, chunk);
      if (!result.ok) {
        yield { type: "error", error: await this.fail(result.error) };
        return;
      }
      if (!("value" in result)) {
        yield { type: "error", error: await this.fail(this.invalidEgress()) };
        return;
      }
      this.canonicalReady = true;
      if (requireEgress) {
        const gate = Promise.withResolvers<void>();
        this.pendingEgress = { promise: gate.promise, resolve: gate.resolve, reject: gate.reject, settled: false };
        this.egressUsed = false;
        this.egressPrepared = false;
      }
      else if (!this.commitmentState.committed) this.commitmentState.committed = true;
      yield result.value;
    }
  }

  private async runHandle(): Promise<CanonicalResponse | GatewayError> {
    try {
      const requestIdResult = this.resolveRequestId();
      if (!requestIdResult.ok) return await this.fail(requestIdResult.error);
      const translationContext: TranslationContext = { requestId: requestIdResult.value, signal: this.controller.signal, trustedRoutingHeaders: {} };
      const translated = this.dependencies.adapters.ingress(this.input.path).translate(this.input, translationContext);
      if (!validateCanonicalRequest(translated).valid || translated.requestId !== requestIdResult.value || translated.stream)
        return await this.fail(safeError(requestIdResult.value, "invalid_canonical_request", "invalid canonical request", "validation", 400, false));
      this.dispatchPolicySnapshot = this.dependencies.dispatchPolicies.snapshot();
      this.setContext(translated);
      let stage = await this.runStage("onIngressReceived", this.context, translated);
      if (!stage.ok) return await this.fail(stage.error);
      if ("shortCircuit" in stage) { const cached = this.cachedResponse(); return isGatewayError(cached) ? await this.fail(cached) : cached; }
      const effectiveDryRun = stage.value.routing.dryRun === true || this.context.getState<boolean>(DISPATCH_STATE_KEYS.dryRun) === true || this.dispatchPolicySnapshot.defaultDryRun;
      const canonicalRequest: CanonicalRequest = effectiveDryRun ? Object.freeze({ ...stage.value, routing: Object.freeze({ ...stage.value.routing, dryRun: true }) }) : stage.value;
      this.context.setState(DISPATCH_STATE_KEYS.dryRun, effectiveDryRun);
      this.setContext(canonicalRequest);
      stage = await this.runStage("onCanonicalTranslate", this.context, canonicalRequest);
      if (!stage.ok) return await this.fail(stage.error);
      if ("shortCircuit" in stage) { const cached = this.cachedResponse(); return isGatewayError(cached) ? await this.fail(cached) : cached; }
      const postCanonicalRequest = stage.value;
      const routes = await this.resolveRoutes(stage.context, postCanonicalRequest);
      if (!routes.ok) return await this.fail(routes.error);
      if (!("value" in routes) || routes.value.resolved.length === 0 || routes.value.attempts.length === 0)
        return await this.fail(safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true));
      const root = routes.value.resolved[0];
      if (root === undefined) return await this.fail(safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true));
      const rootPolicy = this.dispatchPolicySnapshot.resolve(root);
      const ledger = new DispatchBudgetLedger(rootPolicy.attemptBudget, this.dependencies.clock, this.controller.signal, this.commitment);
      let minimumContextTokens = 0;
      for await (const candidate of new BoundedCandidateIterator(routes.value.attempts, rootPolicy.attemptBudget.maxAttempts, this.controller.signal)) {
        const policy = this.dispatchPolicySnapshot.resolve(candidate);
        if (policy.contextTokens <= minimumContextTokens || ledger.blockReason(candidate) !== undefined || !this.dependencies.credentials.eligible(candidate.credentialId)) continue;
        this.setContext(postCanonicalRequest, candidate);
        const before = await this.runStage("beforeUpstreamDispatch", this.context, postCanonicalRequest);
        if (!before.ok) return await this.fail(before.error);
        if ("shortCircuit" in before) { const cached = this.cachedResponse(); return isGatewayError(cached) ? await this.fail(cached) : cached; }
        const estimate = this.context.getState<DispatchCostEstimate>(DISPATCH_STATE_KEYS.costEstimate);
        if (estimate === undefined || !Number.isFinite(estimate.cost.totalUsd) || estimate.cost.totalUsd < 0)
          return await this.fail(safeError(this.context.requestId, "cost_estimate_failed", "cost estimate failed", "internal", 500, false));
        if (effectiveDryRun) {
          const dryRun: CanonicalResponse = { requestId: postCanonicalRequest.requestId, responseId: `${postCanonicalRequest.requestId}-dry-run`, createdAt: postCanonicalRequest.receivedAt, model: postCanonicalRequest.model, status: "completed", choices: [{ index: 0, output: [], finishReason: "stop" }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: estimate.cost, provider: { providerId: candidate.providerId, credentialId: "dry-run", physicalModel: candidate.physicalModel, responseHeaders: {}, upstreamStatus: 200 }, extensions: { custom: { dryRun: true, routeId: candidate.routeId, providerId: candidate.providerId, physicalModel: candidate.physicalModel, estimatedTokens: estimate.usage.totalTokens, estimatedCostUsd: estimate.cost.totalUsd, actualCostUsd: 0 } } };
          this.canonicalReady = true;
          void this.dependencies.trace.record({ schema: "aptus.dispatch.trace", version: 1, event: "dry_run", requestId: postCanonicalRequest.requestId, routeId: candidate.routeId, providerId: candidate.providerId, physicalModel: candidate.physicalModel }).catch(() => undefined);
          return dryRun;
        }
        try {
          const dispatch = composeProviderDispatch(this.dependencies.providers.create(candidate.providerId), { candidate, policy, requestId: this.context.requestId, commitment: this.commitment, ledger, clock: this.dependencies.clock, credentials: this.dependencies.credentials, trace: this.dependencies.trace });
          const response = await dispatch.dispatch(candidate, before.value, this.controller.signal);
          if (!isSafeCanonicalResponse(response, this.context.requestId)) return await this.fail(safeError(this.context.requestId, "invalid_upstream_response", "upstream returned an invalid canonical response", "upstream", 502, false));
          const responseStage = await this.runStage("onUpstreamResponse", this.context, response);
          if (!responseStage.ok) return await this.fail(responseStage.error);
          if (!("value" in responseStage)) return await this.fail(this.invalidEgress());
          if (isSuccessfulResponse(responseStage.value)) { this.state.set(DISPATCH_STATE_KEYS.attempts, ledger.attempts()); this.canonicalReady = true; return responseStage.value; }
          if (responseStage.value.error?.code === "context_overflow") { minimumContextTokens = policy.contextTokens; continue; }
          if (!responseMayAdvance(responseStage.value, policy)) { this.canonicalReady = true; return responseStage.value; }
        } catch (value: unknown) {
          const failure = dispatchFailure(value, this.context.requestId);
          if (!errorMayAdvance(failure)) return await this.fail(failure);
          try { this.dependencies.credentials.failure(candidate.credentialId, classifyCredentialFailure(failure)); this.context.setState(DISPATCH_STATE_KEYS.credentialOutcomeHandled, `${candidate.routeId}\u0000${candidate.providerId}\u0000${candidate.credentialId}\u0000${candidate.physicalModel}`); }
          catch { return await this.fail(safeError(this.context.requestId, "credential_policy_failed", "credential policy failed", "internal", 500, false)); }
        }
      }
      this.state.set(DISPATCH_STATE_KEYS.attempts, ledger.attempts());
      return await this.fail(safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true));
    } catch (error: unknown) { return await this.fail(dispatchFailure(error, this.context.requestId)); }
  }

  private async resolveRoutes(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<StageResult<{ readonly resolved: ReadonlyArray<RouteCandidate>; readonly attempts: ReadonlyArray<RouteCandidate> }>> {
    try {
      const resolved = Object.freeze([...(await this.dependencies.routes.resolve(request, context))]);
      const transformed = await this.runStage("onRouteResolve", context, resolved);
      if (!transformed.ok) return transformed;
      if ("shortCircuit" in transformed) return { ok: true, shortCircuit: { resolved, attempts: transformed.shortCircuit }, context: transformed.context };
      return { ok: true, value: { resolved, attempts: Object.freeze([...transformed.value]) }, context: transformed.context };
    } catch (error: unknown) {
      return { ok: false, error: normalizeFailure(error, context.requestId) };
    }
  }

  private resolveRequestId():
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly error: GatewayError } {
    let requestId: unknown;
    try {
      requestId = this.input.requestId ?? this.dependencies.requestIds();
    } catch {
      return {
        ok: false,
        error: safeError(
          SAFE_FALLBACK_REQUEST_ID,
          "invalid_request_id",
          "invalid request ID",
          "validation",
          400,
          false,
        ),
      };
    }
    if (!validateRequestId(requestId).valid) {
      const errorId =
        typeof requestId === "string" ? requestId : SAFE_FALLBACK_REQUEST_ID;
      return {
        ok: false,
        error: safeError(
          errorId,
          "invalid_request_id",
          "invalid request ID",
          "validation",
          400,
          false,
        ),
      };
    }
    this.requestIdentity = requestId as string;
    return { ok: true, value: this.requestIdentity };
  }

  private async *runStream(
    requireEgress: boolean,
  ): AsyncGenerator<CanonicalChunk> {
    try {
      const requestIdResult = this.resolveRequestId();
      if (!requestIdResult.ok) {
        yield { type: "error", error: await this.fail(requestIdResult.error) };
        return;
      }
      const translationContext: TranslationContext = {
        requestId: requestIdResult.value,
        signal: this.controller.signal,
        trustedRoutingHeaders: {},
      };
      const translated = this.dependencies.adapters
        .ingress(this.input.path)
        .translate(this.input, translationContext);
      if (
        !validateCanonicalRequest(translated).valid ||
        translated.requestId !== requestIdResult.value ||
        !translated.stream
      ) {
        yield {
          type: "error",
          error: await this.fail(
            safeError(
              requestIdResult.value,
              "invalid_canonical_request",
              "invalid canonical request",
              "validation",
              400,
              false,
            ),
          ),
        };
        return;
      }
      this.dispatchPolicySnapshot = this.dependencies.dispatchPolicies.snapshot();
      this.setContext(translated);
      let stage = await this.runStage("onIngressReceived", this.context, translated);
      if (!stage.ok) { yield { type: "error", error: await this.fail(stage.error) }; return; }
      if ("shortCircuit" in stage) {
        const cached = this.cachedResponse();
        if (isGatewayError(cached)) { yield { type: "error", error: await this.fail(cached) }; return; }
        yield* this.cachedChunks(cached, requireEgress);
        return;
      }
      const effectiveDryRun = stage.value.routing.dryRun === true || this.context.getState<boolean>(DISPATCH_STATE_KEYS.dryRun) === true || this.dispatchPolicySnapshot.defaultDryRun;
      const canonicalRequest: CanonicalRequest = effectiveDryRun ? Object.freeze({ ...stage.value, routing: Object.freeze({ ...stage.value.routing, dryRun: true }) }) : stage.value;
      this.context.setState(DISPATCH_STATE_KEYS.dryRun, effectiveDryRun);
      this.setContext(canonicalRequest);
      stage = await this.runStage("onCanonicalTranslate", this.context, canonicalRequest);
      if (!stage.ok) { yield { type: "error", error: await this.fail(stage.error) }; return; }
      if ("shortCircuit" in stage) {
        const cached = this.cachedResponse();
        if (isGatewayError(cached)) { yield { type: "error", error: await this.fail(cached) }; return; }
        yield* this.cachedChunks(cached, requireEgress);
        return;
      }
      const postCanonicalRequest = stage.value;
      const candidatesResult = await this.resolveRoutes(stage.context, postCanonicalRequest);
      if (!candidatesResult.ok || !("value" in candidatesResult) || candidatesResult.value.attempts.length === 0) {
        yield {
          type: "error",
          error: await this.fail(
            candidatesResult.ok
              ? safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true)
              : candidatesResult.error,
          ),
        };
        return;
      }
      const root = candidatesResult.value.resolved[0];
      if (root === undefined) { yield { type: "error", error: await this.fail(safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true)) }; return; }
      const snapshot = this.dispatchPolicySnapshot;
      if (snapshot === undefined) { yield { type: "error", error: await this.fail(safeError(this.context.requestId, "dispatch_policy_failed", "dispatch policy failed", "internal", 500, false)) }; return; }
      const rootPolicy = snapshot.resolve(root);
      const ledger = new DispatchBudgetLedger(rootPolicy.attemptBudget, this.dependencies.clock, this.controller.signal, this.commitment);
      let yielded = false;
      for await (const candidate of new BoundedCandidateIterator(candidatesResult.value.attempts, rootPolicy.attemptBudget.maxAttempts, this.controller.signal)) {
        if (this.commitment.isCommitted() && !yielded) break;
        const policy = snapshot.resolve(candidate);
        if (ledger.blockReason(candidate) !== undefined || !this.dependencies.credentials.eligible(candidate.credentialId)) continue;
        this.setContext(postCanonicalRequest, candidate);
        const before = await this.runStage("beforeUpstreamDispatch", this.context, postCanonicalRequest);
        if (!before.ok) { yield { type: "error", error: await this.fail(before.error) }; return; }
        if ("shortCircuit" in before) {
          const cached = this.cachedResponse();
          if (isGatewayError(cached)) yield { type: "error", error: await this.fail(cached) };
          else yield* this.cachedChunks(cached, requireEgress);
          return;
        }
        const estimate = this.context.getState<DispatchCostEstimate>(DISPATCH_STATE_KEYS.costEstimate);
        if (estimate === undefined || !Number.isFinite(estimate.cost.totalUsd) || estimate.cost.totalUsd < 0) { yield { type: "error", error: await this.fail(safeError(this.context.requestId, "cost_estimate_failed", "cost estimate failed", "internal", 500, false)) }; return; }
        if (effectiveDryRun) {
          const dryRun: CanonicalResponse = { requestId: postCanonicalRequest.requestId, responseId: `${postCanonicalRequest.requestId}-dry-run`, createdAt: postCanonicalRequest.receivedAt, model: postCanonicalRequest.model, status: "completed", choices: [{ index: 0, output: [], finishReason: "stop" }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: estimate.cost, provider: { providerId: candidate.providerId, credentialId: "dry-run", physicalModel: candidate.physicalModel, responseHeaders: {}, upstreamStatus: 200 }, extensions: { custom: { dryRun: true, routeId: candidate.routeId, providerId: candidate.providerId, physicalModel: candidate.physicalModel, estimatedTokens: estimate.usage.totalTokens, estimatedCostUsd: estimate.cost.totalUsd, actualCostUsd: 0 } } };
          yield* this.cachedChunks(dryRun, requireEgress);
          return;
        }
        try {
          const provider = composeProviderDispatch(this.dependencies.providers.create(candidate.providerId), { candidate, policy, requestId: this.context.requestId, commitment: this.commitment, ledger, clock: this.dependencies.clock, credentials: this.dependencies.credentials, trace: this.dependencies.trace });
          const providerIterator = provider.stream(candidate, before.value, this.controller.signal)[Symbol.asyncIterator]();
          this.iterator = providerIterator;
          this.iteratorClosed = false;
          let candidateYielded = false;
          while (!this.controller.signal.aborted) {
            if (requireEgress && this.pendingEgress !== undefined) await this.pendingEgress.promise;
            if (this.egressFailure !== undefined) return;
            const next = await providerIterator.next();
            if (next.done || next.value === undefined) break;
            const chunkStage = await this.runStage("onStreamChunk", this.context, next.value);
            if (!chunkStage.ok) { if (!this.controller.signal.aborted) yield { type: "error", error: await this.fail(chunkStage.error) }; return; }
            if (!("value" in chunkStage)) { yield { type: "error", error: await this.fail(this.invalidEgress()) }; return; }
            candidateYielded = true;
            yielded = true;
            this.canonicalReady = true;
            if (requireEgress) { const gate = Promise.withResolvers<void>(); this.pendingEgress = { promise: gate.promise, resolve: gate.resolve, reject: gate.reject, settled: false }; this.egressUsed = false; this.egressPrepared = false; }
            else if (!this.commitmentState.committed) this.commitmentState.committed = true;
            yield chunkStage.value;
          }
          await this.closeIterator();
          if (candidateYielded) { this.dependencies.credentials.success(candidate.credentialId); return; }
          throw safeError(this.context.requestId, "upstream_empty_stream", "upstream stream ended without a response", "upstream", 502, true);
        } catch (value: unknown) {
          await this.closeIterator();
          const failure = dispatchFailure(value, this.context.requestId);
          if (this.commitment.isCommitted() || yielded || !errorMayAdvance(failure)) { yield { type: "error", error: await this.fail(failure) }; return; }
          try { this.dependencies.credentials.failure(candidate.credentialId, classifyCredentialFailure(failure)); } catch { yield { type: "error", error: await this.fail(safeError(this.context.requestId, "credential_policy_failed", "credential policy failed", "internal", 500, false)) }; return; }
        }
      }
      yield { type: "error", error: await this.fail(safeError(this.context.requestId, "route_exhausted", "no eligible route candidate", "routing", 503, true)) };
      return;
    } catch (error: unknown) {
      if (!this.controller.signal.aborted)
        yield { type: "error", error: await this.fail(normalizeFailure(error, this.context.requestId)) };
    } finally {
      await this.close();
    }
  }

  private async closeIterator(): Promise<void> {
    if (this.iteratorClosed || this.iterator === undefined) return;
    this.iteratorClosed = true;
    try {
      await this.iterator.return?.();
    } catch {
      /* never expose iterator cleanup failures */
    }
  }
}
/** Default request-scoped application lifecycle implementation. */
export class DefaultGatewayApplication
  implements GatewayApplication, GatewayExchangeFactory
{
  constructor(private readonly dependencies: GatewayApplicationDependencies) {}

  open(input: RawIngressInput): GatewayExchange {
    return new DefaultGatewayExchange(this.dependencies, input);
  }

  async handle(
    input: RawIngressInput,
  ): Promise<CanonicalResponse | GatewayError> {
    const exchange = this.open(input);
    try {
      return await exchange.handle();
    } finally {
      await exchange.close();
    }
  }

  stream(input: RawIngressInput): AsyncIterable<CanonicalChunk> {
    const exchange = this.open(input) as DefaultGatewayExchange;
    return (async function* (): AsyncGenerator<CanonicalChunk> {
      try {
        yield* exchange.canonicalStream();
      } finally {
        await exchange.close();
      }
    })();
  }
}
