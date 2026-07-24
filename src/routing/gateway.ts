import type { AptusConfig, ModelConfig, ProviderConfig, RouteConfig } from "../config/types.js";
import type {
  AttemptObservation,
  Gateway,
  GatewayRequest,
  GatewayResult,
  JsonValue,
  KeyPool,
  NativeMutations,
  Protocol,
  ProtocolAdapter,
  ProviderDispatcher,
  ProviderResponse,
  TraceRecorder,
} from "../domain/contracts.js";
import type { IrFailureCategory, NormalizedFailure, TraceTerminal } from "../domain/operations.js";
import { createKeyPool } from "./key-pool.js";
import { authorizePublicName, createNameIndex, type NameIndex } from "./resolution.js";

const utf8Decoder = new TextDecoder();

/**
 * Structural telemetry seam used by the Gateway.
 *
 * Declared locally (never imported from `src/observability`) so that `routing`
 * has no runtime dependency on the observability module. The concrete observer
 * returned by `createLifecycleObserver` satisfies this shape structurally.
 */
export interface GatewayObservability {
  /** Request admitted: in-flight gauge + `aptus.request.ingress`. */
  requestIngress(fields: {
    aptusRequestId: string;
    endpointProtocol: Protocol;
    endpoint: string;
    stream: boolean;
  }): void;

  /** Request finished (any terminal outcome): in-flight gauge decrement. */
  requestTerminal(fields: { aptusRequestId: string; endpointProtocol: Protocol; stream: boolean }): void;

  /** `aptus.auth.result` log. */
  authResult(fields: { aptusRequestId: string; scheme: string; result: string }): void;

  /** `aptus.name.resolved` log. */
  nameResolved(fields: { aptusRequestId: string; canonicalPublicName: string; kind: string }): void;

  /** `aptus.candidate.skipped` log + `aptus_candidate_skips_total`. */
  candidateSkipped(fields: {
    aptusRequestId: string;
    endpointProtocol: Protocol;
    canonicalPublicName: string;
    candidateIndex: number;
    provider: string;
    targetProtocol: Protocol;
    category: IrFailureCategory;
    capability?: string;
  }): void;

  /** `aptus.key.selected` log. */
  keySelected(fields: {
    aptusRequestId: string;
    attemptNumber: number;
    provider: string;
    keyName: string;
    strategy: string;
  }): void;

  /** `aptus.attempt.started` log. */
  attemptStarted(fields: {
    aptusRequestId: string;
    attemptNumber: number;
    candidateIndex: number;
    provider: string;
    targetProtocol: Protocol;
    stream: boolean;
  }): void;

  /** `aptus.dispatch.completed` log + provider attempt counters. */
  attemptCompleted(fields: {
    aptusRequestId: string;
    attemptNumber: number;
    provider: string;
    targetProtocol: Protocol;
    status: number | undefined;
    attemptResult: AttemptObservation["result"];
    stream: boolean;
    durationMs: number;
  }): void;

  /** `aptus.response.first_byte` log. */
  firstByte(fields: { aptusRequestId: string; attemptNumber: number; durationMs: number }): void;

  /** `aptus.request.completed` log + duration and TTFF histograms. */
  completed(fields: {
    aptusRequestId: string;
    endpointProtocol: Protocol;
    targetProtocol: Protocol;
    provider: string;
    canonicalPublicName: string;
    outcomeCategory: "complete" | "failed" | "cancelled";
    status: number;
    attempts: number;
    stream: boolean;
    durationMs: number;
    firstByteMs?: number;
    usage?: JsonValue;
    estimatedCostUsd?: string;
  }): void;

  /** `aptus.request.cancelled` log. */
  cancelled(fields: { aptusRequestId: string; phase: string; by: string }): void;

  /** Sets `aptus_key_pool_available` for a provider pool. */
  setKeyPoolAvailable(provider: string, targetProtocol: Protocol, count: number): void;
}

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
  /** Telemetry observer (structural seam). */
  readonly observer: GatewayObservability;
}

/**
 * One resolved candidate (a model and its provider) in route order.
 */
interface CandidateDescriptor {
  readonly index: number;
  readonly model: ModelConfig;
  readonly provider: ProviderConfig;
  readonly mutations: NativeMutations;
}

/**
 * Creates the native request Gateway orchestrator.
 *
 * The Gateway owns routing, key acquisition, mutation (via adapters), dispatch,
 * response relay, and the complete Trace/observability lifecycle. It imports
 * only `domain` contracts and config *types*; every concrete dependency is
 * injected by `src/bootstrap`.
 *
 * @param options - Composition dependencies.
 * @returns A {@link Gateway} instance.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const nameIndex = createNameIndex(options.config);
  const modelsByName = new Map(options.config.models.map((model) => [model.name, model]));
  const routesByName = new Map(options.config.routes.map((route) => [route.name, route]));
  const providersByName = new Map(options.config.providers.map((provider) => [provider.name, provider]));
  const keyPools = new Map<string, KeyPool>(
    options.config.providers.map((provider) => [
      provider.name,
      createKeyPool(provider.name, provider.keys, provider.keyStrategy),
    ]),
  );

  return {
    execute(request) {
      return runRequest(request, {
        config: options.config,
        revision: options.revision,
        adapters: options.adapters,
        dispatcher: options.dispatcher,
        traceRecorder: options.traceRecorder,
        observer: options.observer,
        nameIndex,
        modelsByName,
        routesByName,
        providersByName,
        keyPools,
      });
    },
  };
}

/**
 * Gateway dependencies plus precomputed indexes.
 */
interface RunDependencies {
  readonly config: AptusConfig;
  readonly revision: string;
  readonly adapters: Readonly<Record<Protocol, ProtocolAdapter>>;
  readonly dispatcher: ProviderDispatcher;
  readonly traceRecorder: TraceRecorder;
  readonly observer: GatewayObservability;
  readonly nameIndex: NameIndex;
  readonly modelsByName: ReadonlyMap<string, ModelConfig>;
  readonly routesByName: ReadonlyMap<string, RouteConfig>;
  readonly providersByName: ReadonlyMap<string, ProviderConfig>;
  readonly keyPools: ReadonlyMap<string, KeyPool>;
}

/**
 * Executes the full native request sequence, finishing the Trace and the
 * `request_terminal` observation exactly once on every path.
 */
async function runRequest(request: GatewayRequest, deps: RunDependencies): Promise<GatewayResult> {
  const started = performance.now();
  const deadlineMs = started + deps.config.server.requestDeadlineMs;
  const streamIdleMs = deps.config.server.streamIdleMs;
  const streamRequested = request.body.stream === true;
  const aptusRequestId = request.aptusRequestId;

  const trace = await deps.traceRecorder.start({
    aptusRequestId,
    startedAtLocal: formatTraceDirectoryTimestamp(new Date()),
    configRevision: deps.revision,
    sourceProtocol: request.protocol,
  });

  let attemptCount = 0;
  let terminalFired = false;
  let canonicalName: string | undefined;

  // Fires the terminal trace + request_terminal observation exactly once.
  const finish = async (terminal: TraceTerminal): Promise<void> => {
    if (terminalFired) return;
    terminalFired = true;
    await trace.finish(terminal);
    deps.observer.requestTerminal({ aptusRequestId, endpointProtocol: request.protocol, stream: streamRequested });
  };

  try {
    // 1. Ingress + client request trace stage.
    deps.observer.requestIngress({
      aptusRequestId,
      endpointProtocol: request.protocol,
      endpoint: endpointLabel(request.endpoint),
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
      await finish({ kind: "failed", failure: publicName.error });
      return { kind: "failure", failure: publicName.error };
    }
    canonicalName = authorizePublicName(deps.nameIndex, request.clientKeyName, publicName.value);
    if (canonicalName === undefined) {
      const failure = notFoundFailure();
      await trace.recordJson("resolution", { requested: publicName.value });
      await finish({ kind: "failed", failure });
      return { kind: "failure", failure };
    }
    const resolutionKind = deps.modelsByName.has(canonicalName) ? "model" : "route";
    await trace.recordJson("resolution", {
      publicName: publicName.value,
      canonicalPublicName: canonicalName,
      kind: resolutionKind,
    });
    deps.observer.nameResolved({ aptusRequestId, canonicalPublicName: canonicalName, kind: resolutionKind });

    const candidates = resolveCandidates(canonicalName, deps);

    // 4. Iterate ordered candidates.
    for (const candidate of candidates) {
      if (request.signal.aborted) {
        await trace.recordJson("cancellation", { phase: "routing", by: "client" });
        deps.observer.cancelled({ aptusRequestId, phase: "routing", by: "client" });
        await finish({ kind: "cancelled", by: "client" });
        return { kind: "failure", failure: cancelledFailure() };
      }

      // 4a. Protocol-match preflight (mismatch ⇒ zero-dispatch skip).
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
        continue;
      }
      await trace.recordJson("preflight", {
        ok: true,
        provider: candidate.provider.name,
        protocol: candidate.provider.protocol,
      });

      // 4b. Key acquisition.
      const pool = deps.keyPools.get(candidate.provider.name);
      const enabledCount = candidate.provider.keys.filter((key) => key.enabled).length;
      deps.observer.setKeyPoolAvailable(candidate.provider.name, candidate.provider.protocol, enabledCount);
      const acquired = pool === undefined ? { kind: "unavailable" as const } : pool.acquire(performance.now());
      await trace.recordJson("key_selection", {
        provider: candidate.provider.name,
        strategy: candidate.provider.keyStrategy,
        keyName: acquired.kind === "acquired" ? acquired.lease.keyName : null,
      });
      if (acquired.kind !== "acquired") {
        const failure = unavailableFailure();
        await finish({ kind: "failed", failure });
        return { kind: "failure", failure };
      }
      deps.observer.keySelected({
        aptusRequestId,
        attemptNumber: attemptCount + 1,
        provider: candidate.provider.name,
        keyName: acquired.lease.keyName,
        strategy: candidate.provider.keyStrategy,
      });

      // 4c. Prepare the native provider request.
      const preparedResult = deps.adapters[request.protocol].prepareNative({
        protocol: request.protocol,
        baseUrl: candidate.provider.baseUrl,
        upstreamModel: candidate.model.upstreamModel,
        clientBody: request.body,
        clientHeaders: request.headers,
        providerHeaders: candidate.provider.headers,
        providerSecret: acquired.lease.secret,
        mutations: candidate.mutations,
        deadlineMs,
        streamIdleMs,
      });
      if (!preparedResult.ok) {
        await trace.recordJson("mutation", { failure: failureJson(preparedResult.error) });
        await finish({ kind: "failed", failure: preparedResult.error });
        return { kind: "failure", failure: preparedResult.error };
      }
      const prepared = { ...preparedResult.value, provider: candidate.provider.name };
      await trace.recordJson("mutation", {
        defaults: candidate.mutations.defaults,
        extraBody: candidate.mutations.extraBody,
        overrides: candidate.mutations.overrides,
        upstreamModel: candidate.model.upstreamModel,
      });
      await trace.recordJson("provider_request", {
        provider: prepared.provider,
        protocol: prepared.protocol,
        url: prepared.url,
        headers: prepared.headers,
        body: parseJsonBytes(prepared.body),
      });

      // 4d. Dispatch.
      attemptCount++;
      deps.observer.attemptStarted({
        aptusRequestId,
        attemptNumber: attemptCount,
        candidateIndex: candidate.index,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        stream: prepared.stream,
      });

      const dispatchStarted = performance.now();
      let response: ProviderResponse;
      try {
        response = await deps.dispatcher.dispatch(prepared, request.signal);
      } catch (error) {
        if (request.signal.aborted) {
          await trace.recordJson("cancellation", { phase: "dispatch", by: "client" });
          deps.observer.cancelled({ aptusRequestId, phase: "dispatch", by: "client" });
          await finish({ kind: "cancelled", by: "client" });
          return { kind: "failure", failure: cancelledFailure() };
        }
        const failure = dispatchFailure(error);
        await finish({ kind: "failed", failure });
        return { kind: "failure", failure };
      }

      const dispatchDurationMs = performance.now() - dispatchStarted;
      await trace.recordJson("provider_response_head", {
        status: response.status,
        headers: response.headers,
        finalUrl: response.finalUrl,
      });
      const observation = deps.adapters[request.protocol].classify(response);
      deps.observer.attemptCompleted({
        aptusRequestId,
        attemptNumber: attemptCount,
        provider: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        status: observation.status,
        attemptResult: observation.result,
        stream: prepared.stream,
        durationMs: dispatchDurationMs,
      });
      pool?.observe(acquired.lease, observation, performance.now());

      // 4e. Relay success or native-passthrough the terminal non-2xx body.
      return relayResponse(response, observation, {
        aptusRequestId,
        started,
        streamRequested: prepared.stream,
        endpointProtocol: request.protocol,
        canonicalName,
        providerName: candidate.provider.name,
        targetProtocol: candidate.provider.protocol,
        attemptCount,
        trace,
        finish,
        observer: deps.observer,
        requestSignal: request.signal,
      });
    }

    // No candidate was compatible.
    const failure = unsupportedCapabilityFailure(request.protocol);
    await finish({ kind: "failed", failure });
    return { kind: "failure", failure };
  } catch {
    const failure = internalFailure();
    await finish({ kind: "failed", failure });
    return { kind: "failure", failure };
  }
}

/**
 * Context shared between `relayResponse` and its stream wrapper.
 */
interface RelayContext {
  readonly aptusRequestId: string;
  readonly started: number;
  readonly streamRequested: boolean;
  readonly endpointProtocol: Protocol;
  readonly canonicalName: string;
  readonly providerName: string;
  readonly targetProtocol: Protocol;
  readonly attemptCount: number;
  readonly trace: Awaited<ReturnType<TraceRecorder["start"]>>;
  readonly finish: (terminal: TraceTerminal) => Promise<void>;
  readonly observer: GatewayObservability;
  readonly requestSignal: AbortSignal;
}

/**
 * Relays a complete (non-stream) or streaming response to HTTP, recording the
 * terminal Trace and telemetry exactly once.
 */
async function relayResponse(
  response: ProviderResponse,
  observation: AttemptObservation,
  context: RelayContext,
): Promise<GatewayResult> {
  const success = observation.result === "success";

  // Streaming success relays the body directly; everything else is completed now.
  if (success && context.streamRequested) {
    return relayStream(response, context);
  }

  const body = await readAll(response.body);
  const contentType = response.headers["content-type"] ?? "";
  const isJson = contentType.includes("json");

  if (isJson) {
    const parsed = parseJsonBytes(body);
    await context.trace.recordJson("provider_response", parsed);
    await context.trace.recordJson("client_response", parsed);
  } else {
    await context.trace.recordBytes("provider_response", body);
    await context.trace.recordBytes("client_response", body);
  }

  const firstByteMs = performance.now() - context.started;
  if (success) {
    await context.finish({ kind: "complete", status: response.status });
    context.observer.completed({
      aptusRequestId: context.aptusRequestId,
      endpointProtocol: context.endpointProtocol,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
      outcomeCategory: "complete",
      status: response.status,
      attempts: context.attemptCount,
      stream: false,
      durationMs: firstByteMs,
      firstByteMs,
    });
  } else {
    // Terminal non-2xx: relay the provider body unchanged, but record a failed terminal.
    const failure = failureFromObservation(observation);
    await context.finish({ kind: "failed", failure });
    context.observer.completed({
      aptusRequestId: context.aptusRequestId,
      endpointProtocol: context.endpointProtocol,
      targetProtocol: context.targetProtocol,
      provider: context.providerName,
      canonicalPublicName: context.canonicalName,
      outcomeCategory: "failed",
      status: response.status,
      attempts: context.attemptCount,
      stream: false,
      durationMs: firstByteMs,
      firstByteMs,
    });
  }

  return { kind: "complete", status: response.status, headers: response.headers, body };
}

/**
 * Wraps a streaming provider body for relay, buffering bytes for the `.sse`
 * Trace files and finishing the Trace/telemetry exactly once at end/error/cancel.
 */
function relayStream(response: ProviderResponse, context: RelayContext): GatewayResult {
  const reader = response.body.getReader();
  const buffered: Uint8Array[] = [];
  let firstByteMs: number | undefined;
  let streamTerminalDone = false;

  const finishStream = async (terminal: TraceTerminal, outcome: "complete" | "failed" | "cancelled"): Promise<void> => {
    if (streamTerminalDone) return;
    streamTerminalDone = true;
    // Write identical provider/client stream bytes, then the terminal marker.
    const bytes = concat(buffered);
    if (outcome !== "cancelled") {
      await context.trace.recordBytes("provider_stream", bytes);
      await context.trace.recordBytes("client_stream", bytes);
    }
    if (outcome === "complete") {
      await context.finish({ kind: "complete", status: response.status });
      context.observer.completed({
        aptusRequestId: context.aptusRequestId,
        endpointProtocol: context.endpointProtocol,
        targetProtocol: context.targetProtocol,
        provider: context.providerName,
        canonicalPublicName: context.canonicalName,
        outcomeCategory: "complete",
        status: response.status,
        attempts: context.attemptCount,
        stream: true,
        durationMs: performance.now() - context.started,
        firstByteMs: firstByteMs ?? performance.now() - context.started,
      });
    } else if (outcome === "failed") {
      await context.finish(terminal);
      context.observer.completed({
        aptusRequestId: context.aptusRequestId,
        endpointProtocol: context.endpointProtocol,
        targetProtocol: context.targetProtocol,
        provider: context.providerName,
        canonicalPublicName: context.canonicalName,
        outcomeCategory: "failed",
        status: response.status,
        attempts: context.attemptCount,
        stream: true,
        durationMs: performance.now() - context.started,
        firstByteMs: firstByteMs ?? performance.now() - context.started,
      });
    } else {
      await context.finish(terminal);
      context.observer.cancelled({ aptusRequestId: context.aptusRequestId, phase: "stream", by: "client" });
    }
  };

  return {
    kind: "stream",
    status: response.status,
    headers: response.headers,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (firstByteMs === undefined) {
            firstByteMs = performance.now() - context.started;
            context.observer.firstByte({
              aptusRequestId: context.aptusRequestId,
              attemptNumber: context.attemptCount,
              durationMs: firstByteMs,
            });
          }
          if (chunk.done) {
            await finishStream({ kind: "complete", status: response.status }, "complete");
            controller.close();
            return;
          }
          buffered.push(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (context.requestSignal.aborted) {
            await finishStream({ kind: "cancelled", by: "client" }, "cancelled");
          } else {
            await finishStream({ kind: "failed", failure: streamFailure(error) }, "failed");
          }
          controller.error(error);
        }
      },
      cancel() {
        void reader.cancel();
        void finishStream({ kind: "cancelled", by: "client" }, "cancelled");
      },
    }),
  };
}

/**
 * Resolves a canonical public name into an ordered list of candidate descriptors.
 */
function resolveCandidates(canonicalName: string, deps: RunDependencies): readonly CandidateDescriptor[] {
  const model = deps.modelsByName.get(canonicalName);
  if (model !== undefined) {
    const provider = deps.providersByName.get(model.provider);
    if (provider === undefined) return [];
    return [{ index: 0, model, provider, mutations: mutationsOf(model) }];
  }
  const route = deps.routesByName.get(canonicalName);
  if (route === undefined) return [];
  const candidates: CandidateDescriptor[] = [];
  route.candidates.forEach((modelName, index) => {
    const candidateModel = deps.modelsByName.get(modelName);
    const provider = candidateModel === undefined ? undefined : deps.providersByName.get(candidateModel.provider);
    if (candidateModel !== undefined && provider !== undefined) {
      candidates.push({ index, model: candidateModel, provider, mutations: mutationsOf(candidateModel) });
    }
  });
  return candidates;
}

function mutationsOf(model: ModelConfig): NativeMutations {
  return { defaults: model.defaults, extraBody: model.extraBody, overrides: model.overrides };
}

/**
 * Reads a response body stream fully into a single byte buffer.
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return concat(chunks);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Parses UTF-8 JSON bytes into a JSON value (falling back to `null`).
 */
function parseJsonBytes(bytes: Uint8Array): JsonValue {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Maps a dispatch failure to a normalized failure category.
 */
function dispatchFailure(error: unknown): NormalizedFailure {
  const kind = (error as { dispatchErrorKind?: unknown }).dispatchErrorKind;
  if (kind === "timeout") {
    return { category: "timeout", message: "provider request timed out", retryable: false };
  }
  return { category: "provider", message: "provider request failed", retryable: false };
}

/**
 * Maps a typed stream error to a normalized failure category.
 */
function streamFailure(error: unknown): NormalizedFailure {
  const kind = (error as { streamErrorKind?: unknown }).streamErrorKind;
  if (kind === "idle_timeout" || kind === "deadline") {
    return { category: "timeout", message: "provider stream timed out", retryable: false };
  }
  return { category: "stream_interrupted", message: "provider stream was interrupted", retryable: false };
}

/**
 * Maps a non-2xx attempt observation to a normalized failure.
 */
function failureFromObservation(observation: AttemptObservation): NormalizedFailure {
  const category: IrFailureCategory =
    observation.result === "success" || observation.result === "client_cancelled" ? "provider" : observation.result;
  return {
    category,
    message: "upstream provider request failed",
    retryable: false,
    ...(observation.retryDelayMs === undefined
      ? {}
      : { retryAfterSeconds: Math.ceil(observation.retryDelayMs / 1000) }),
  };
}

/**
 * Projects a normalized failure into a plain JSON value for the Trace stage.
 */
function failureJson(failure: NormalizedFailure): JsonValue {
  const out: Record<string, JsonValue> = {
    category: failure.category,
    message: failure.message,
    retryable: failure.retryable,
  };
  if (failure.code !== undefined) out.code = failure.code;
  if (failure.capability !== undefined) out.capability = failure.capability;
  if (failure.retryAfterSeconds !== undefined) out.retryAfterSeconds = failure.retryAfterSeconds;
  return out;
}

function notFoundFailure(): NormalizedFailure {
  return { category: "not_found", message: "model not found", retryable: false };
}

function unavailableFailure(): NormalizedFailure {
  return { category: "unavailable", message: "no provider key available", retryable: false };
}

function unsupportedCapabilityFailure(targetProtocol: Protocol): NormalizedFailure {
  return {
    category: "unsupported_capability",
    message: "no compatible provider candidate",
    capability: targetProtocol,
    retryable: false,
  };
}

function cancelledFailure(): NormalizedFailure {
  return { category: "provider", message: "request cancelled", retryable: false };
}

function internalFailure(): NormalizedFailure {
  return { category: "provider", message: "internal gateway error", retryable: false };
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
