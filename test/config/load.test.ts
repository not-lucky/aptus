import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { formatStartupError, type StartupError } from "../../src/config/errors.js";
import { loadConfig } from "../../src/config/load.js";
import { completeYaml } from "./yaml.js";

/** Every environment variable referenced by the complete sample fixture. */
const FULL_ENV: Record<string, string> = {
  APTUS_CLIENT_PRIMARY: "client-primary-secret",
  APTUS_CLIENT_OPERATOR: "client-operator-secret",
  OPENAI_CHAT_KEY_A: "openai-chat-a-secret",
  OPENAI_CHAT_KEY_B: "openai-chat-b-secret",
  OPENAI_RESPONSES_KEY_A: "openai-responses-a-secret",
  ANTHROPIC_KEY_A: "anthropic-a-secret",
};

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes fixture-derived YAML into a per-test tmp dir with the Trace root redirected. */
function writeComplete(replacements: Record<string, string> = {}): { path: string; root: string } {
  const dir = tmpDir("aptus-load-");
  const root = join(dir, "traces");
  const text = completeYaml({ "  root: ./traces": `  root: ${root}`, ...replacements });
  const path = join(dir, "aptus.yaml");
  writeFileSync(path, text);
  return { path, root };
}

/** Writes raw YAML text into a per-test tmp dir. */
function writeText(text: string): string {
  const path = join(tmpDir("aptus-load-"), "aptus.yaml");
  writeFileSync(path, text);
  return path;
}

function errorLines(errors: readonly StartupError[]): string[] {
  return errors.map(formatStartupError);
}

async function loadComplete(
  replacements: Record<string, string> = {},
  env: Record<string, string> = FULL_ENV,
): Promise<ReturnType<typeof loadConfig>> {
  return loadConfig(writeComplete(replacements).path, env);
}

/** Minimal but valid YAML relying on every inner-field default. */
function minimalYaml(tracingBlock: string): string {
  return `auth:
  clientKeys:
    - name: minimal-client
      secret: \${APTUS_TEST_SECRET}
providers:
  - name: minimal-provider
    protocol: openai-chat
    baseUrl: https://api.example.com/v1
    keyStrategy: fill-first
    keys:
      - name: minimal-key
        secret: \${APTUS_TEST_SECRET}
        enabled: true
models:
  - name: minimal-model
    provider: minimal-provider
    upstreamModel: gpt-4o-mini
    catalog:
      openai:
        created: 1
        ownedBy: test
      anthropic:
        createdAt: "2026-01-01T00:00:00Z"
        displayName: Minimal Model
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null
routes: []
server: {}
operations: {}
routing:
  keyPool: {}
logging: {}
metrics: {}
dryRun: {}
${tracingBlock}
`;
}

const MINIMAL_ENV = { APTUS_TEST_SECRET: "minimal-secret" };

test("complete sample loads fully resolved, normalized, and frozen", async () => {
  const { path, root } = writeComplete();
  const result = await loadConfig(path, FULL_ENV);
  assert(result.ok);
  const { config, revision } = result.value;

  assert.match(revision, /^sha256:[0-9a-f]{64}$/);

  // Exactly one trailing slash is removed from the chat provider only.
  assert.equal(config.providers[0]?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers[1]?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers[2]?.baseUrl, "https://api.anthropic.com");

  // All six declared secrets resolve from the environment.
  assert.equal(config.providers[0]?.keys[0]?.secret, FULL_ENV.OPENAI_CHAT_KEY_A);
  assert.equal(config.providers[0]?.keys[1]?.secret, FULL_ENV.OPENAI_CHAT_KEY_B);
  assert.equal(config.providers[1]?.keys[0]?.secret, FULL_ENV.OPENAI_RESPONSES_KEY_A);
  assert.equal(config.providers[2]?.keys[0]?.secret, FULL_ENV.ANTHROPIC_KEY_A);
  assert.equal(config.auth.clientKeys[0]?.secret, FULL_ENV.APTUS_CLIENT_PRIMARY);
  assert.equal(config.auth.clientKeys[1]?.secret, FULL_ENV.APTUS_CLIENT_OPERATOR);

  // The snapshot and every nested object and array are deeply frozen.
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.server));
  assert.ok(Object.isFrozen(config.auth.clientKeys));
  assert.ok(Object.isFrozen(config.providers[0]?.keys));
  assert.throws(() => {
    (config.auth.clientKeys[0] as { name: string }).name = "mutated";
  }, TypeError);

  // The startup probe created the root and deleted its probe file.
  assert.ok(existsSync(root));
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".aptus-startup-probe-")),
    [],
  );
});

test("minimal YAML applies all documented defaults", async () => {
  const root = join(tmpDir("aptus-minimal-"), "traces");
  const path = writeText(
    minimalYaml(`tracing:
  root: ${root}
  retention: {}
`),
  );
  const result = await loadConfig(path, MINIMAL_ENV);
  assert(result.ok);
  const config = result.value.config;

  assert.equal(config.tracing.enabled, true);
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 8080);
  assert.equal(config.server.bodyLimitBytes, 33_554_432);
  assert.equal(config.server.maxInFlight, 1000);
  assert.equal(config.server.requestDeadlineMs, 600_000);
  assert.equal(config.server.streamIdleMs, 60_000);
  assert.equal(config.server.shutdownDrainMs, 30_000);
  assert.deepEqual(config.server.trustedProxyCidrs, []);
  assert.equal(config.operations.host, "127.0.0.1");
  assert.equal(config.operations.port, 9090);
  assert.deepEqual(config.providers[0]?.headers, {});
  assert.deepEqual(config.models[0]?.aliases, []);
  assert.equal(config.models[0]?.pricing, null);
  assert.deepEqual(config.routing.keyPool.failureCooldownMs, [250, 1000]);
  assert.equal(config.routing.keyPool.rateLimitFallbackMs, 1000);
  assert.equal(config.routing.keyPool.maxRetryAfterMs, 30_000);
  assert.equal(config.routing.keyPool.jitterRatio, 0.25);
  assert.equal(config.tracing.retention.maxAgeMs, 604_800_000);
  assert.equal(config.tracing.retention.maxBytes, 1_073_741_824);
  assert.equal(config.tracing.retention.cleanupIntervalMs, 3_600_000);
  assert.equal(config.logging.level, "info");
  assert.equal(config.dryRun.enabled, false);
});

test("logging.level warning loads; warn rejects with CONFIG_SCHEMA", async () => {
  const okResult = await loadComplete({ "  level: info": "  level: warning" });
  assert(okResult.ok);
  assert.equal(okResult.value.config.logging.level, "warning");

  const badResult = await loadComplete({ "  level: info": "  level: warn" });
  assert(!badResult.ok);
  assert.deepEqual(errorLines(badResult.error), [
    'CONFIG_SCHEMA /logging/level must be one of "debug", "info", "warning", "error"',
  ]);
});

test("baseUrl: one trailing slash removed, legal forms unchanged", async () => {
  const slash = await loadComplete({
    "    baseUrl: https://api.openai.com/v1/": "    baseUrl: https://api.openai.com/v1",
  });
  assert(slash.ok);
  assert.equal(slash.value.config.providers[0]?.baseUrl, "https://api.openai.com/v1");

  const origin = await loadComplete({
    "    baseUrl: https://api.openai.com/v1/": "    baseUrl: https://api.openai.com",
  });
  assert(origin.ok);
  assert.equal(origin.value.config.providers[0]?.baseUrl, "https://api.openai.com");
});

const URL_CASES: Array<[string, string, string]> = [
  [
    "https://api.openai.com/",
    "CONFIG_PROVIDER_URL_PATH_EMPTY",
    "provider baseUrl must keep a non-empty path after removing one trailing slash",
  ],
  ["https://api.openai.com/v1/?key=1", "CONFIG_PROVIDER_URL_QUERY", "provider baseUrl must not contain a query"],
  ["https://api.openai.com/v1/#frag", "CONFIG_PROVIDER_URL_FRAGMENT", "provider baseUrl must not contain a fragment"],
  [
    "https://user:pass@api.openai.com/v1/",
    "CONFIG_PROVIDER_URL_CREDENTIALS",
    "provider baseUrl must not contain user credentials",
  ],
  ["ftp://api.openai.com/v1/", "CONFIG_PROVIDER_URL_SCHEME", "provider baseUrl must use http or https"],
];

for (const [replacement, code, message] of URL_CASES) {
  test(`baseUrl: ${code}`, async () => {
    const result = await loadComplete({
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${replacement}`,
    });
    assert(!result.ok);
    assert.deepEqual(errorLines(result.error), [`${code} /providers/0/baseUrl ${message}`]);
  });
}

test("secrets: literal secret value rejects", async () => {
  const result = await loadComplete({
    "      secret: ${APTUS_CLIENT_PRIMARY}": "      secret: literal-secret",
  });
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), [
    "CONFIG_SECRET_LITERAL /auth/clientKeys/0/secret secret must be an exact ${ENV_NAME} environment reference",
  ]);
});

test("secrets: invalid reference name rejects", async () => {
  const result = await loadComplete({
    "        secret: ${OPENAI_CHAT_KEY_B}": "        secret: ${1BAD}",
  });
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), [
    "CONFIG_SECRET_REFERENCE_INVALID /providers/0/keys/1/secret secret environment reference name is invalid",
  ]);
});

test("secrets: unset and empty env values reject with the exact pinned line", async () => {
  const unsetEnv = { ...FULL_ENV };
  delete unsetEnv.OPENAI_CHAT_KEY_B;
  const unset = await loadConfig(writeComplete().path, unsetEnv);
  assert(!unset.ok);
  assert.deepEqual(errorLines(unset.error), [
    "CONFIG_SECRET_MISSING /providers/0/keys/1/secret environment variable OPENAI_CHAT_KEY_B is absent or empty",
  ]);

  const empty = await loadConfig(writeComplete().path, { ...FULL_ENV, OPENAI_CHAT_KEY_B: "" });
  assert(!empty.ok);
  assert.deepEqual(errorLines(empty.error), [
    "CONFIG_SECRET_MISSING /providers/0/keys/1/secret environment variable OPENAI_CHAT_KEY_B is absent or empty",
  ]);
});

test("secrets: interpolation in baseUrl matches the exact pinned line", async () => {
  const result = await loadComplete({
    "    baseUrl: https://api.openai.com/v1/": "    baseUrl: https://api.openai.com:${PORT}/v1/",
  });
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), [
    "CONFIG_INTERPOLATION_FORBIDDEN /providers/0/baseUrl environment interpolation is allowed only in declared secret fields",
  ]);
});

const INTERPOLATION_CASES: Array<[string, string]> = [
  ["      openai-organization: org_example", "      openai-organization: org_${ORG}"],
  ["    upstreamModel: gpt-5.4", "    upstreamModel: gpt-${VERSION}"],
  ["    defaults:\n      temperature: 0.2", "    defaults:\n      temperature: 0.2\n      apiKey: ${KEY}"],
  [
    "    defaults:\n      temperature: 0.2\n    extraBody: {}",
    "    defaults:\n      temperature: 0.2\n    extraBody:\n      topic: ${TOPIC}",
  ],
];

for (const [anchor, replacement] of INTERPOLATION_CASES) {
  test(`secrets: interpolation inside non-secret string at ${JSON.stringify(anchor)}`, async () => {
    const result = await loadComplete({ [anchor]: replacement });
    assert(!result.ok);
    const interpolationLines = errorLines(result.error).filter((line) =>
      line.startsWith("CONFIG_INTERPOLATION_FORBIDDEN "),
    );
    assert.equal(interpolationLines.length, 1, errorLines(result.error).join("\n"));
  });
}

test("revision: depends on reference names, never on resolved secret values", async () => {
  const dir = tmpDir("aptus-revision-");
  const root = join(dir, "traces");
  const basePath = join(dir, "aptus.yaml");
  writeFileSync(basePath, completeYaml({ "  root: ./traces": `  root: ${root}` }));

  // Identical YAML with different resolved secret values must hash identically.
  const first = await loadConfig(basePath, FULL_ENV);
  const rotated = await loadConfig(basePath, { ...FULL_ENV, OPENAI_CHAT_KEY_A: "rotated-secret" });
  assert(first.ok);
  assert(rotated.ok);
  assert.equal(first.value.revision, rotated.value.revision);

  // A different reference *name* at the same path changes the redacted config.
  const renamedEnv = { ...FULL_ENV, OPENAI_CHAT_KEY_C: "renamed-secret" };
  const renamedPath = join(dir, "renamed.yaml");
  writeFileSync(
    renamedPath,
    completeYaml({
      "  root: ./traces": `  root: ${root}`,
      "        secret: ${OPENAI_CHAT_KEY_A}": "        secret: ${OPENAI_CHAT_KEY_C}",
    }),
  );
  const renamed = await loadConfig(renamedPath, renamedEnv);
  assert(renamed.ok);
  assert.notEqual(renamed.value.revision, first.value.revision);

  for (const revision of [first.value.revision, rotated.value.revision, renamed.value.revision]) {
    assert.ok(!revision.includes(FULL_ENV.OPENAI_CHAT_KEY_A!), revision);
    assert.ok(!revision.includes("rotated-secret"), revision);
    assert.ok(!revision.includes("renamed-secret"), revision);
  }
});

const CROSS_REFERENCE_CASES: Array<{
  name: string;
  replacements: Record<string, string>;
  expected: string | string[];
}> = [
  {
    name: "duplicate provider name",
    replacements: { "  - name: openai-responses-primary": "  - name: openai-chat-primary" },
    expected: "CONFIG_PROVIDER_NAME_DUPLICATE /providers/1/name provider name openai-chat-primary is already declared",
  },
  {
    name: "duplicate key name in one pool",
    replacements: { "      - name: openai-chat-b": "      - name: openai-chat-a" },
    expected:
      "CONFIG_PROVIDER_KEY_NAME_DUPLICATE /providers/0/keys/1/name provider key name openai-chat-a duplicates another key name in this key pool",
  },
  {
    name: "duplicate resolved secret in one pool",
    replacements: { "        secret: ${OPENAI_CHAT_KEY_B}": "        secret: ${OPENAI_CHAT_KEY_A}" },
    expected:
      "CONFIG_PROVIDER_SECRET_DUPLICATE /providers/0/keys/1/secret provider key secret duplicates another secret in this key pool",
  },
  {
    name: "route name equals model name",
    replacements: { "  - name: reliable-chat": "  - name: gpt-main" },
    expected: [
      "CONFIG_CLIENT_ALLOW_UNKNOWN /auth/clientKeys/0/allow/2 client allow entry must reference a public model or route name",
      "CONFIG_PUBLIC_NAME_DUPLICATE /routes/0/name public name or alias gpt-main is already declared",
    ],
  },
  {
    name: "route alias duplicates a model alias (pinned line)",
    replacements: { "    aliases: [production-chat]": "    aliases: [chat-default, production-chat]" },
    expected: "CONFIG_PUBLIC_NAME_DUPLICATE /routes/0/aliases/0 public name or alias chat-default is already declared",
  },
  {
    name: "model alias equals route name",
    replacements: { "    aliases: [messages-default]": "    aliases: [reliable-chat]" },
    expected: "CONFIG_PUBLIC_NAME_DUPLICATE /routes/0/name public name or alias reliable-chat is already declared",
  },
  {
    name: "candidate references an alias (pinned line)",
    replacements: { "    candidates: [gpt-main, claude-main]": "    candidates: [chat-default, claude-main]" },
    expected:
      "CONFIG_REFERENCE_NOT_CANONICAL /routes/0/candidates/0 route candidates must reference canonical model names",
  },
  {
    name: "candidate references an unknown name",
    replacements: { "    candidates: [gpt-main, claude-main]": "    candidates: [gpt-main, missing-model]" },
    expected:
      "CONFIG_REFERENCE_NOT_CANONICAL /routes/0/candidates/1 route candidates must reference canonical model names",
  },
  {
    name: "duplicate candidate in one route",
    replacements: { "    candidates: [gpt-main, claude-main]": "    candidates: [gpt-main, gpt-main]" },
    expected:
      "CONFIG_ROUTE_CANDIDATE_DUPLICATE /routes/0/candidates/1 route candidate duplicates another candidate in this route",
  },
  {
    name: "unknown client allow entry",
    replacements: {
      "      allow: [gpt-main, claude-main, reliable-chat]": "      allow: [gpt-main, claude-main, missing-name]",
    },
    expected:
      "CONFIG_CLIENT_ALLOW_UNKNOWN /auth/clientKeys/0/allow/2 client allow entry must reference a public model or route name",
  },
  {
    name: "duplicate retryOn categories",
    replacements: { "    retryOn: [rate_limit, unavailable, provider]": "    retryOn: [rate_limit, rate_limit]" },
    expected: "CONFIG_RETRY_ON_DUPLICATE /routes/0/retryOn/1 retryOn categories must not repeat",
  },
  {
    name: "duplicate fallbackOn categories",
    replacements: {
      "    fallbackOn: [rate_limit, unavailable, provider, timeout]": "    fallbackOn: [timeout, timeout]",
    },
    expected: "CONFIG_FALLBACK_ON_DUPLICATE /routes/0/fallbackOn/1 fallbackOn categories must not repeat",
  },
];

for (const fixture of CROSS_REFERENCE_CASES) {
  test(`cross-reference: ${fixture.name}`, async () => {
    const result = await loadComplete(fixture.replacements);
    assert(!result.ok);
    assert.deepEqual(
      errorLines(result.error),
      typeof fixture.expected === "string" ? [fixture.expected] : fixture.expected,
    );
  });
}

const FORBIDDEN_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key",
  "set-cookie",
];

for (const header of FORBIDDEN_HEADERS) {
  test(`cross-reference: forbidden provider header ${header}`, async () => {
    const result = await loadComplete({
      "      openai-organization: org_example": `      ${header}: value`,
    });
    assert(!result.ok);
    assert.deepEqual(errorLines(result.error), [
      `CONFIG_PROVIDER_HEADER_FORBIDDEN /providers/0/headers/${header} provider header ${header} is forbidden`,
    ]);
  });
}

test("cross-reference: same resolved secret in different pools is legal", async () => {
  const result = await loadComplete({
    "        secret: ${OPENAI_RESPONSES_KEY_A}": "        secret: ${OPENAI_CHAT_KEY_A}",
  });
  assert(result.ok);
});

test("multi-error Zod stage: bogus key plus removed metrics and routing", async () => {
  const result = await loadComplete({
    "metrics:\n  enabled: true\n": "",
    "routing:\n  keyPool:\n    failureCooldownMs: [250, 1000]\n    rateLimitFallbackMs: 1000\n    maxRetryAfterMs: 30000\n    jitterRatio: 0.25\n":
      "",
    "dryRun:\n  enabled: false\n": "dryRun:\n  enabled: false\nbogus: 1\n",
  });
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), [
    'CONFIG_SCHEMA /bogus unknown key "bogus"',
    "CONFIG_SCHEMA /metrics expected object, received undefined",
    "CONFIG_SCHEMA /routing expected object, received undefined",
  ]);
});

test("multi-error secret stage: literal, invalid reference, and missing secret sorted", async () => {
  const env = { ...FULL_ENV };
  delete env.OPENAI_CHAT_KEY_B;
  const result = await loadComplete(
    {
      "      secret: ${APTUS_CLIENT_PRIMARY}": "      secret: literal-secret",
      "        secret: ${OPENAI_CHAT_KEY_A}": "        secret: ${1BAD}",
    },
    env,
  );
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), [
    "CONFIG_SECRET_LITERAL /auth/clientKeys/0/secret secret must be an exact ${ENV_NAME} environment reference",
    "CONFIG_SECRET_REFERENCE_INVALID /providers/0/keys/0/secret secret environment reference name is invalid",
    "CONFIG_SECRET_MISSING /providers/0/keys/1/secret environment variable OPENAI_CHAT_KEY_B is absent or empty",
  ]);
});

test("multi-error YAML stage: duplicate key, merge key, alias, non-string key, custom tag", async () => {
  const path = writeText(`root:
  - &shared
    name: a
  - *shared
  <<: { extra: 1 }
  ? 42
  : value
  tagged: !custom
    value: 1
  duplicate: 1
  duplicate: 2
`);
  const result = await loadConfig(path, {});
  assert(!result.ok);
  const lines = errorLines(result.error);
  assert.ok(lines.length >= 5, lines.join("\n"));
  for (const line of lines) {
    assert.ok(line.startsWith("CONFIG_YAML_"), line);
  }
  // The non-string key sits at the top-level mapping (empty pointer), and
  // yaml's core schema also reports it as a parse error.
  assert.ok(lines.includes("CONFIG_YAML_NON_STRING_KEY  YAML mapping keys must be strings"), lines.join("\n"));
  assert.ok(lines.includes("CONFIG_YAML_MERGE_KEY /<< YAML merge keys are not allowed"), lines.join("\n"));
  assert.ok(lines.includes("CONFIG_YAML_ALIAS /root/1 YAML aliases are not allowed"), lines.join("\n"));
  // Duplicate keys, merge keys, non-string keys, and unknown tags each surface
  // as parser diagnostics at their source offsets in addition to the
  // structural violations.
  const parseLines = lines.filter((line) => line.startsWith("CONFIG_YAML_PARSE "));
  assert.ok(parseLines.length >= 1, lines.join("\n"));
});

test("YAML violations: document count, parse, merge key, non-string key, custom tag, alias", async () => {
  const twoDocs = await loadConfig(writeText("a: 1\n---\nb: 2\n"), {});
  assert(!twoDocs.ok);
  assert.deepEqual(errorLines(twoDocs.error), [
    "CONFIG_YAML_DOCUMENT_COUNT  config must contain exactly one YAML document",
  ]);

  const emptyFile = await loadConfig(writeText(""), {});
  assert(!emptyFile.ok);
  assert.deepEqual(errorLines(emptyFile.error), [
    "CONFIG_YAML_DOCUMENT_COUNT  config must contain exactly one YAML document",
  ]);

  const dupKey = await loadConfig(writeText("server:\n  port: 1\n  port: 2\n"), {});
  assert(!dupKey.ok);
  assert.ok(errorLines(dupKey.error).some((line) => line.startsWith("CONFIG_YAML_PARSE ")));

  const mergeKey = await loadConfig(writeText("server:\n  <<: { host: x }\n"), {});
  assert(!mergeKey.ok);
  assert.ok(errorLines(mergeKey.error).includes("CONFIG_YAML_MERGE_KEY /server/<< YAML merge keys are not allowed"));

  const numericKey = await loadConfig(writeText("server:\n  ? 8080\n  : value\n"), {});
  assert(!numericKey.ok);
  assert.ok(
    errorLines(numericKey.error).includes("CONFIG_YAML_NON_STRING_KEY /server YAML mapping keys must be strings"),
  );

  const customTag = await loadConfig(writeText("server:\n  port: !custom 8080\n"), {});
  assert(!customTag.ok);
  assert.ok(
    errorLines(customTag.error).includes("CONFIG_YAML_CUSTOM_TAG /server/port YAML custom tags are not allowed"),
  );

  const alias = await loadConfig(writeText("server:\n  host: &h 127.0.0.1\n  port: 8080\nother: *h\n"), {});
  assert(!alias.ok);
  assert.ok(errorLines(alias.error).includes("CONFIG_YAML_ALIAS /other YAML aliases are not allowed"));
});

test("probe: disabled tracing skips the probe and creates no directory", async () => {
  const neverRoot = join(tmpDir("aptus-probe-disabled-"), "never");
  const path = writeText(
    minimalYaml(`tracing:
  enabled: false
  root: ${neverRoot}
  retention: {}
`),
  );
  const result = await loadConfig(path, MINIMAL_ENV);
  assert(result.ok);
  assert.equal(existsSync(neverRoot), false);
});

test("probe: root at an existing file rejects with CONFIG_TRACE_PROBE", async () => {
  const blocker = join(tmpDir("aptus-probe-file-"), "blocker");
  writeFileSync(blocker, "occupied\n");
  const result = await loadComplete({ "  root: ./traces": `  root: ${blocker}` });
  assert(!result.ok);
  assert.deepEqual(errorLines(result.error), ["CONFIG_TRACE_PROBE /tracing/root trace startup probe failed: EEXIST"]);
});
