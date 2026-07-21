import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  GatewayError,
  RouteCandidate,
} from "../domain/index.js";
import {
  createGatewayError,
  validateCanonicalRequest,
  validateRequestId,
} from "../domain/index.js";
import type {
  AdapterRegistry,
  GatewayApplication,
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
import type { ClockPort } from "../ports/infrastructure.js";
import type {
  EgressValue,
  RawIngressInput,
  TranslationContext,
} from "../ports/translation.js";

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
}

type StageResult<T> =
  | { readonly ok: true; readonly value: T; readonly context: GatewayContext }
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

class DefaultGatewayExchange implements GatewayExchange {
  private readonly controller = new AbortController();
  private requestIdentity = SAFE_FALLBACK_REQUEST_ID;
  private readonly state = new Map<string, unknown>();
  private readonly commands: GatewayCommand[] = [];
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private context: GatewayContext;
  private started = false;
  private finalized = false;
  private errorHandled = false;
  private canonicalReady = false;
  private pendingEgress: PendingEgress | undefined;
  private egressUsed = false;
  private egressFailure: GatewayError | undefined;
  private iterator: AsyncIterator<CanonicalChunk> | undefined;
  private iteratorClosed = false;

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
    if (this.controller.signal.aborted)
      return this.fail(
        normalizeFailure(this.controller.signal.reason, this.context.requestId),
      );
    this.egressUsed = true;
    const result = await this.runStage(
      "onEgressTranslate",
      this.context,
      value,
    );
    const output = result.ok ? result.value : await this.fail(result.error);
    const pending = this.pendingEgress;
    this.pendingEgress = undefined;
    if (pending !== undefined && !pending.settled) {
      pending.settled = true;
      pending.resolve();
    }
    if (!result.ok) this.egressFailure = output as GatewayError;
    return output;
  }

  async close(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const pending = this.pendingEgress;
    this.pendingEgress = undefined;
    if (pending !== undefined && !pending.settled) {
      pending.settled = true;
      pending.resolve();
    }
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
        error: normalizeFailure(
          this.controller.signal.reason,
          context.requestId,
        ),
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
    const next =
      result.kind === "continue" ? (result.value ?? input) : result.value;
    if (isRequestStage(hook)) {
      this.setContext(
        next as unknown as CanonicalRequest,
        context.selectedCandidate,
      );
    }
    return { ok: true, value: next, context: this.context };
  }

  private async fail(error: GatewayError): Promise<GatewayError> {
    if (this.errorHandled) return error;
    this.errorHandled = true;
    const result = await this.runStage("onError", this.context, error);
    if (!result.ok) return error;
    return result.value;
  }

  private async runHandle(): Promise<CanonicalResponse | GatewayError> {
    try {
      const requestIdResult = this.resolveRequestId();
      if (!requestIdResult.ok) return await this.fail(requestIdResult.error);
      const translationContext: TranslationContext = {
        requestId: requestIdResult.value,
        signal: this.controller.signal,
        trustedRoutingHeaders: {},
      };
      const adapter = this.dependencies.adapters.ingress(this.input.path);
      const translated = adapter.translate(this.input, translationContext);
      if (
        !validateCanonicalRequest(translated).valid ||
        translated.requestId !== requestIdResult.value ||
        translated.stream
      ) {
        return await this.fail(
          safeError(
            requestIdResult.value,
            "invalid_canonical_request",
            "invalid canonical request",
            "validation",
            400,
            false,
          ),
        );
      }
      this.setContext(translated);
      let stage = await this.runStage(
        "onIngressReceived",
        this.context,
        translated,
      );
      if (!stage.ok) return await this.fail(stage.error);
      stage = await this.runStage(
        "onCanonicalTranslate",
        stage.context,
        stage.value,
      );
      if (!stage.ok) return await this.fail(stage.error);
      const candidatesResult = await this.resolveRoutes(
        stage.context,
        stage.value,
      );
      if (!candidatesResult.ok) return await this.fail(candidatesResult.error);
      if (candidatesResult.value.length === 0)
        return await this.fail(
          safeError(
            this.context.requestId,
            "route_exhausted",
            "no eligible route candidate",
            "routing",
            503,
            true,
          ),
        );
      const candidate = candidatesResult.value[0];
      if (candidate === undefined)
        return await this.fail(
          safeError(
            this.context.requestId,
            "route_exhausted",
            "no eligible route candidate",
            "routing",
            503,
            true,
          ),
        );
      this.setContext(stage.value, candidate);
      stage = await this.runStage(
        "beforeUpstreamDispatch",
        this.context,
        stage.value,
      );
      if (!stage.ok) return await this.fail(stage.error);
      const response = await this.dependencies.providers
        .create(candidate.providerId)
        .dispatch(candidate, stage.value, this.controller.signal);
      this.setContext(stage.value, candidate);
      const responseStage = await this.runStage(
        "onUpstreamResponse",
        this.context,
        response,
      );
      if (!responseStage.ok) return await this.fail(responseStage.error);
      this.canonicalReady = true;
      return responseStage.value;
    } catch (error: unknown) {
      return await this.fail(normalizeFailure(error, this.context.requestId));
    }
  }

  private async resolveRoutes(
    context: GatewayContext,
    request: CanonicalRequest,
  ): Promise<StageResult<ReadonlyArray<RouteCandidate>>> {
    try {
      const candidates = await this.dependencies.routes.resolve(
        request,
        context,
      );
      return this.runStage("onRouteResolve", context, candidates);
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
      const adapter = this.dependencies.adapters.ingress(this.input.path);
      const translated = adapter.translate(this.input, translationContext);
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
      this.setContext(translated);
      let stage = await this.runStage(
        "onIngressReceived",
        this.context,
        translated,
      );
      if (!stage.ok) {
        yield { type: "error", error: await this.fail(stage.error) };
        return;
      }
      stage = await this.runStage(
        "onCanonicalTranslate",
        stage.context,
        stage.value,
      );
      if (!stage.ok) {
        yield { type: "error", error: await this.fail(stage.error) };
        return;
      }
      const candidatesResult = await this.resolveRoutes(
        stage.context,
        stage.value,
      );
      if (!candidatesResult.ok || candidatesResult.value.length === 0) {
        yield {
          type: "error",
          error: await this.fail(
            candidatesResult.ok
              ? safeError(
                  this.context.requestId,
                  "route_exhausted",
                  "no eligible route candidate",
                  "routing",
                  503,
                  true,
                )
              : candidatesResult.error,
          ),
        };
        return;
      }
      const candidate = candidatesResult.value[0];
      if (candidate === undefined) {
        yield {
          type: "error",
          error: await this.fail(
            safeError(
              this.context.requestId,
              "route_exhausted",
              "no eligible route candidate",
              "routing",
              503,
              true,
            ),
          ),
        };
        return;
      }
      this.setContext(stage.value, candidate);
      stage = await this.runStage(
        "beforeUpstreamDispatch",
        this.context,
        stage.value,
      );
      if (!stage.ok) {
        yield { type: "error", error: await this.fail(stage.error) };
        return;
      }
      const providerIterator = this.dependencies.providers
        .create(candidate.providerId)
        .stream(candidate, stage.value, this.controller.signal)
        [Symbol.asyncIterator]();
      this.iterator = providerIterator;
      this.cleanup.push(() => this.closeIterator());
      while (!this.controller.signal.aborted) {
        if (requireEgress && this.pendingEgress !== undefined)
          await this.pendingEgress.promise;
        if (this.egressFailure !== undefined) return;
        const next = await providerIterator.next();
        if (next.done) break;
        const chunkStage = await this.runStage(
          "onStreamChunk",
          this.context,
          next.value,
        );
        if (!chunkStage.ok) {
          if (this.controller.signal.aborted) return;
          yield { type: "error", error: await this.fail(chunkStage.error) };
          return;
        }
        this.canonicalReady = true;
        if (requireEgress) {
          const gate = Promise.withResolvers<void>();
          this.pendingEgress = {
            promise: gate.promise,
            resolve: gate.resolve,
            reject: gate.reject,
            settled: false,
          };
          this.egressUsed = false;
        }
        yield chunkStage.value;
      }
    } catch (error: unknown) {
      if (!this.controller.signal.aborted)
        yield {
          type: "error",
          error: await this.fail(
            normalizeFailure(error, this.context.requestId),
          ),
        };
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
