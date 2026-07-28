import type { RoutingConstraints } from "../domain/index.js";
import { createGatewayError } from "../domain/index.js";
import type { RawHeaderValue } from "./translation.js";

/** Maximum accepted length of a trusted model alias or route identifier. */
export const MAX_TRUSTED_ROUTING_IDENTIFIER_LENGTH = 64;

/** Maximum accepted trusted per-request cost ceiling in US dollars. */
export const MAX_TRUSTED_ROUTING_COST_USD = 1_000_000;

/** Maximum accepted trusted per-request latency ceiling in milliseconds. */
export const MAX_TRUSTED_ROUTING_LATENCY_MS = 86_400_000;

/** Maximum number of capability field lines accepted before deduplication. */
export const MAX_TRUSTED_REQUIRED_CAPABILITIES = 32;

/** Maximum accepted length of one trusted required capability. */
export const MAX_TRUSTED_REQUIRED_CAPABILITY_LENGTH = 64;

/** Normalized lower-case names of the gateway routing headers this parser consumes. */
export const TRUSTED_ROUTING_HEADER_NAMES = Object.freeze({
  modelAlias: "x-gateway-model-alias",
  overrideRoute: "x-gateway-route",
  maxCostUsd: "x-gateway-max-cost-usd",
  maxLatencyMs: "x-gateway-max-latency-ms",
  dryRun: "x-gateway-dry-run",
  requiredCapability: "x-gateway-required-capability",
} as const);

/** Parsed, immutable trusted headers and their canonical routing projection. */
export interface ParsedTrustedRoutingHeaders {
  /** Canonical lower-case recognized headers, safe for translation context. */
  readonly headers: Readonly<Record<string, string>>;
  /** Routing values to merge after protocol JSON normalization. */
  readonly routing: Readonly<RoutingConstraints>;
}

/** Caller-attested input to trusted gateway routing-header parsing. */
export interface ParseTrustedRoutingHeadersInput {
  /** Explicit trust decision established outside client-controlled headers. */
  readonly trusted: boolean;
  /** Normalized ingress headers; only documented gateway routing names are read. */
  readonly headers: Readonly<Record<string, RawHeaderValue>>;
  /** Validated request identifier copied to any safe typed failure. */
  readonly requestId: string;
}

const EMPTY_OVERRIDES: Readonly<RoutingConstraints> = Object.freeze({});
const SAFE_ROUTING_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

function invalidHeaders(requestId: string): never {
  throw createGatewayError({
    category: "validation",
    code: "invalid_trusted_routing_headers",
    message: "Trusted routing headers failed validation.",
    requestId,
  });
}
function normalizedTrustedHeaders(
  headers: Readonly<Record<string, RawHeaderValue>>,
  requestId: string,
): Readonly<Record<string, RawHeaderValue>> {
  const normalized: Record<string, RawHeaderValue> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.modelAlias &&
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.overrideRoute &&
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.maxCostUsd &&
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.maxLatencyMs &&
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.dryRun &&
      lowerName !== TRUSTED_ROUTING_HEADER_NAMES.requiredCapability
    )
      continue;
    if (normalized[lowerName] !== undefined) return invalidHeaders(requestId);
    normalized[lowerName] = value;
  }
  return normalized;
}

function singleValue(
  headers: Readonly<Record<string, RawHeaderValue>>,
  name: string,
  requestId: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.includes("\n") || raw.includes("\r")) {
    return invalidHeaders(requestId);
  }
  return raw.trim();
}

function boundedIdentifier(
  value: string | undefined,
  requestId: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_TRUSTED_ROUTING_IDENTIFIER_LENGTH ||
    !SAFE_ROUTING_VALUE.test(value)
  ) {
    return invalidHeaders(requestId);
  }
  return value;
}

function boundedCost(
  value: string | undefined,
  requestId: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!NON_NEGATIVE_DECIMAL.test(value)) return invalidHeaders(requestId);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed > MAX_TRUSTED_ROUTING_COST_USD) {
    return invalidHeaders(requestId);
  }
  return parsed;
}

function boundedLatency(
  value: string | undefined,
  requestId: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!POSITIVE_INTEGER.test(value)) return invalidHeaders(requestId);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_TRUSTED_ROUTING_LATENCY_MS
  ) {
    return invalidHeaders(requestId);
  }
  return parsed;
}

function strictBoolean(
  value: string | undefined,
  requestId: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return invalidHeaders(requestId);
}

function capabilityValues(
  headers: Readonly<Record<string, RawHeaderValue>>,
  requestId: string,
): readonly string[] | undefined {
  const raw = headers[TRUSTED_ROUTING_HEADER_NAMES.requiredCapability];
  if (raw === undefined) return undefined;
  const fieldLines = typeof raw === "string" ? [raw] : raw;
  const values = fieldLines.flatMap((fieldLine) => fieldLine.split("\n"));
  if (
    values.length === 0 ||
    values.length > MAX_TRUSTED_REQUIRED_CAPABILITIES
  ) {
    return invalidHeaders(requestId);
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const fieldValue of values) {
    if (fieldValue.includes("\r")) return invalidHeaders(requestId);
    const value = fieldValue.trim();
    if (
      value.length === 0 ||
      value.length > MAX_TRUSTED_REQUIRED_CAPABILITY_LENGTH ||
      !SAFE_ROUTING_VALUE.test(value)
    ) {
      return invalidHeaders(requestId);
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return Object.freeze(unique);
}

/**
 * Parses bounded routing overrides only after the caller explicitly establishes
 * ingress-proxy trust. Untrusted input is ignored without inspecting headers.
 * Recognized trusted values are validated completely before any result is
 * published; malformed input throws a body-free validation `GatewayError`.
 */
export function parseTrustedRoutingHeaders(
  input: ParseTrustedRoutingHeadersInput,
): ParsedTrustedRoutingHeaders {
  if (!input.trusted) {
    return Object.freeze({
      headers: Object.freeze({}),
      routing: EMPTY_OVERRIDES,
    });
  }
  const normalized = normalizedTrustedHeaders(input.headers, input.requestId);

  const modelAlias = boundedIdentifier(
    singleValue(
      normalized,
      TRUSTED_ROUTING_HEADER_NAMES.modelAlias,
      input.requestId,
    ),
    input.requestId,
  );
  const overrideRoute = boundedIdentifier(
    singleValue(
      normalized,
      TRUSTED_ROUTING_HEADER_NAMES.overrideRoute,
      input.requestId,
    ),
    input.requestId,
  );
  const maxCostUsd = boundedCost(
    singleValue(
      normalized,
      TRUSTED_ROUTING_HEADER_NAMES.maxCostUsd,
      input.requestId,
    ),
    input.requestId,
  );
  const maxLatencyMs = boundedLatency(
    singleValue(
      normalized,
      TRUSTED_ROUTING_HEADER_NAMES.maxLatencyMs,
      input.requestId,
    ),
    input.requestId,
  );
  const dryRun = strictBoolean(
    singleValue(
      normalized,
      TRUSTED_ROUTING_HEADER_NAMES.dryRun,
      input.requestId,
    ),
    input.requestId,
  );
  const requiredCapabilities = capabilityValues(normalized, input.requestId);
  const headers: Record<string, string> = {};
  if (modelAlias !== undefined)
    headers[TRUSTED_ROUTING_HEADER_NAMES.modelAlias] = modelAlias;
  if (overrideRoute !== undefined)
    headers[TRUSTED_ROUTING_HEADER_NAMES.overrideRoute] = overrideRoute;
  if (maxCostUsd !== undefined)
    headers[TRUSTED_ROUTING_HEADER_NAMES.maxCostUsd] = String(maxCostUsd);
  if (maxLatencyMs !== undefined)
    headers[TRUSTED_ROUTING_HEADER_NAMES.maxLatencyMs] = String(maxLatencyMs);
  if (dryRun !== undefined)
    headers[TRUSTED_ROUTING_HEADER_NAMES.dryRun] = String(dryRun);
  if (requiredCapabilities !== undefined) {
    headers[TRUSTED_ROUTING_HEADER_NAMES.requiredCapability] =
      requiredCapabilities.join("\n");
  }

  return Object.freeze({
    headers: Object.freeze(headers),
    routing: Object.freeze({
      ...(modelAlias === undefined ? {} : { modelAlias }),
      ...(overrideRoute === undefined ? {} : { overrideRoute }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      ...(maxLatencyMs === undefined ? {} : { maxLatencyMs }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    }),
  });
}

/**
 * Returns an immutable routing snapshot with trusted values taking precedence
 * over already-normalized JSON routing, without mutating either input.
 */
export function mergeTrustedRoutingOverrides(
  routing: Readonly<RoutingConstraints>,
  overrides: Readonly<RoutingConstraints>,
): Readonly<RoutingConstraints> {
  const requiredCapabilities =
    overrides.requiredCapabilities ?? routing.requiredCapabilities;
  const preferredProviders = routing.preferredProviders;
  const excludedProviders = routing.excludedProviders;
  return Object.freeze({
    ...routing,
    ...overrides,
    ...(requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: Object.freeze([...requiredCapabilities]) }),
    ...(preferredProviders === undefined
      ? {}
      : { preferredProviders: Object.freeze([...preferredProviders]) }),
    ...(excludedProviders === undefined
      ? {}
      : { excludedProviders: Object.freeze([...excludedProviders]) }),
  });
}
