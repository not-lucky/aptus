import type { CanonicalResponse, JsonValue } from "../domain/index.js";

/** Process-injected clock using Unix epoch milliseconds. */
export interface ClockPort {
  /** Returns Unix epoch time in milliseconds. */
  now(): number;
  /** Sleeps until delay or cancellation; cancellation must be observed. */
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

/** Transport capability independent of provider SDKs and wire DTOs. */
export interface ProviderTransportPort<
  TRequest = unknown,
  TResponse = unknown,
> {
  /** Sends one request while observing cancellation. */
  request(request: TRequest, signal: AbortSignal): Promise<TResponse>;
  /** Yields bounded byte chunks while observing cancellation. */
  stream(request: TRequest, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Resolves an opaque secret reference without exposing store implementation types. */
export interface SecretResolverPort {
  /** Resolves a reference while observing cancellation. */
  resolve(reference: string, signal: AbortSignal): Promise<string>;
}

/** Stores credential values behind an injected process/application lifetime. */
export interface CredentialStorePort<TCredential = unknown> {
  /** Returns a credential or undefined on a miss; observes cancellation. */
  get(
    credentialId: string,
    signal: AbortSignal,
  ): Promise<TCredential | undefined>;
  /** Replaces a credential while observing cancellation. */
  set(
    credentialId: string,
    credential: TCredential,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Exposes an already validated shallow readonly configuration snapshot. */
export interface RouteConfigPort<
  TSnapshot extends object = Readonly<Record<string, unknown>>,
> {
  /** Returns the current snapshot without mutating or reloading it. */
  snapshot(): Readonly<TSnapshot>;
}

/** Caches values behind an injected capability with cancellation-aware access. */
export interface CachePort<TValue = CanonicalResponse> {
  /** Returns a cached value or undefined on a miss. */
  get(key: string, signal: AbortSignal): Promise<TValue | undefined>;
  /** Stores a value while observing cancellation. */
  set(key: string, value: TValue, signal: AbortSignal): Promise<void>;
}

/** Reserves and releases a caller-defined rate-limit reservation. */
export interface RateLimitPort<TRequest = unknown, TReservation = unknown> {
  /** Reserves capacity while observing cancellation. */
  reserve(request: TRequest, signal: AbortSignal): Promise<TReservation>;
  /** Completes cleanup even when the request signal has already aborted. */
  release(reservation: TReservation): Promise<void>;
}

/** Minimal metrics sink with caller-supplied bounded labels. */
export interface MetricsPort {
  /** Increments a named counter. */
  incrementCounter(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>>,
  ): void;
  /** Records one histogram observation. */
  observeHistogram(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>>,
  ): void;
  /** Sets one gauge value. */
  setGauge(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>>,
  ): void;
}

/** Trace sink receiving records already redacted by its caller. */
export interface TracePort<
  TRecord extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  /** Records one caller-redacted trace entry. */
  record(record: TRecord): Promise<void>;
}

/** Logger sink receiving entries already redacted by its caller. */
export interface LoggerPort<
  TEntry extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  /** Logs one caller-redacted entry without inspecting request bodies. */
  log(entry: TEntry): Promise<void>;
}

/** Health capability returning a caller-defined snapshot. */
export interface HealthPort<TSnapshot = unknown> {
  /** Performs a cancellation-aware health check. */
  check(signal: AbortSignal): Promise<TSnapshot>;
}
