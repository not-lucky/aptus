import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { completeYaml } from "./yaml.js";

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "src", "bootstrap", "cli.ts");
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

/** Per-case seeded secrets, passed via the merged env. */
function seededEnv(caseName: string, omit: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < ENV_NAMES.length; index++) {
    const name = ENV_NAMES[index]!;
    if (!omit.includes(name)) env[name] = `aptus-test-secret-${caseName}-${index}`;
  }
  return env;
}

function mergedEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ENV_NAMES) delete merged[name];
  for (const [key, value] of Object.entries(env)) merged[key] = value;
  return merged;
}

function stripDepWarnings(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\(node:\d+\) \[DEP0205\]/.test(line) && !/^\(Use .*trace-deprecation/.test(line))
    .join("\n")
    .trim();
}

interface CliResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function spawnCli(args: readonly string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--disable-warning=DEP0205", TSX_CLI, CLI, ...args], {
      cwd,
      env: mergedEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectResult);
    child.on("exit", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function assertNoSecretLeak(result: CliResult, secrets: Iterable<string>): void {
  for (const secret of secrets) {
    assert.ok(!result.stdout.includes(secret), `secret leaked to stdout: ${secret}`);
    assert.ok(!result.stderr.includes(secret), `secret leaked to stderr: ${secret}`);
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "0.0.0.0", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function assertConnectionRefused(port: number): Promise<void> {
  return new Promise((resolveResult, rejectResult) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResult(new Error(`port ${port} did not refuse within 2s`));
    }, 2000);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolveResult();
      else rejectResult(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      rejectResult(new Error(`port ${port} unexpectedly accepted a connection`));
    });
  });
}

/**
 * The six exact invalid examples pinned by docs/configuration.md. Each must
 * exit 78 with exactly one sorted stderr line and no stdout.
 */
const INVALID_CASES: Array<{
  name: string;
  replacements: Record<string, string>;
  omitEnv?: readonly string[];
  expected: string;
}> = [
  {
    name: "missing-env-secret",
    replacements: {},
    omitEnv: ["OPENAI_CHAT_KEY_A"],
    expected:
      "CONFIG_SECRET_MISSING /providers/0/keys/0/secret environment variable OPENAI_CHAT_KEY_A is absent or empty",
  },
  {
    name: "interpolation-forbidden",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": "    baseUrl: https://api.openai.com:${PORT}/v1/",
    },
    expected:
      "CONFIG_INTERPOLATION_FORBIDDEN /providers/0/baseUrl environment interpolation is allowed only in declared secret fields",
  },
  {
    name: "public-name-duplicate",
    replacements: { "    aliases: [production-chat]": "    aliases: [chat-default, production-chat]" },
    expected: "CONFIG_PUBLIC_NAME_DUPLICATE /routes/0/aliases/0 public name or alias chat-default is already declared",
  },
  {
    name: "reference-not-canonical",
    replacements: { "    candidates: [gpt-main, claude-main]": "    candidates: [chat-default, claude-main]" },
    expected:
      "CONFIG_REFERENCE_NOT_CANONICAL /routes/0/candidates/0 route candidates must reference canonical model names",
  },
  {
    name: "provider-url-query",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": "    baseUrl: https://api.openai.com/v1/?key=1",
    },
    expected: "CONFIG_PROVIDER_URL_QUERY /providers/0/baseUrl provider baseUrl must not contain a query",
  },
  {
    name: "provider-secret-duplicate",
    replacements: { "        secret: ${OPENAI_CHAT_KEY_B}": "        secret: ${OPENAI_CHAT_KEY_A}" },
    expected:
      "CONFIG_PROVIDER_SECRET_DUPLICATE /providers/0/keys/1/secret provider key secret duplicates another secret in this key pool",
  },
];

for (const fixture of INVALID_CASES) {
  test.concurrent(`process: exact invalid example ${fixture.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "aptus-process-invalid-"));
    writeFileSync(join(dir, "aptus.yaml"), completeYaml(fixture.replacements));
    const env = seededEnv(fixture.name, fixture.omitEnv);
    const result = await spawnCli(["--config", join(dir, "aptus.yaml")], env, dir);

    assert.equal(result.code, 78);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.trim(), "");
    assert.equal(stripDepWarnings(result.stderr), fixture.expected);
    assertNoSecretLeak(result, Object.values(env));
  });
}

test.concurrent("process: Zod multi-error fixture exits before binding either port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aptus-process-multi-"));
  const clientPort = await freePort();
  const operationsPort = await freePort();
  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPort}`,
      "  port: 9090": `  port: ${operationsPort}`,
      "metrics:\n  enabled: true\n": "",
      "routing:\n  keyPool:\n    failureCooldownMs: [250, 1000]\n    rateLimitFallbackMs: 1000\n    maxRetryAfterMs: 30000\n    jitterRatio: 0.25\n":
        "",
      "dryRun:\n  enabled: false\n": "dryRun:\n  enabled: false\nbogus: 1\n",
    }),
  );
  const env = seededEnv("zod-multi");
  const result = await spawnCli(["--config", join(dir, "aptus.yaml")], env, dir);

  assert.equal(result.code, 78);
  assert.equal(
    stripDepWarnings(result.stderr),
    [
      'CONFIG_SCHEMA /bogus unknown key "bogus"',
      "CONFIG_SCHEMA /metrics expected object, received undefined",
      "CONFIG_SCHEMA /routing expected object, received undefined",
    ].join("\n"),
  );
  assertNoSecretLeak(result, Object.values(env));

  // Config errors precede any bind: both configured ports refuse.
  await assertConnectionRefused(clientPort);
  await assertConnectionRefused(operationsPort);
});

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

test.concurrent("process: complete sample boots, probes, reports readiness, exits 0 on SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aptus-process-boot-"));
  const clientPort = await freePort();
  const operationsPort = await freePort();
  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPort}`,
      "  port: 9090": `  port: ${operationsPort}`,
    }),
  );
  const env = seededEnv("boot");
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", join(dir, "aptus.yaml")],
    { cwd: dir, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  // The client listener binds the configured server.host (0.0.0.0 by default).
  const readyRegex = /^aptus ready: operations http:\/\/[^ ]+, client http:\/\/[^ ]+$/m;
  try {
    await waitFor(() => readyRegex.test(stdout), "ready line");
    assert.doesNotMatch(stdout + stderr, /aptus-test-secret-/);

    // The startup probe ran in the config-relative Trace root and cleaned up.
    assert.ok(existsSync(join(dir, "traces")));
    assert.deepEqual(
      readdirSync(join(dir, "traces")).filter((name) => name.startsWith(".aptus-startup-probe-")),
      [],
    );

    let body:
      | { status: string; configRevision: unknown; traceReady: unknown; enabledProviderCount: unknown }
      | undefined;
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${operationsPort}/health/ready`);
        if (response.ok) {
          body = (await response.json()) as typeof body;
          return true;
        }
      } catch {
        // Not listening yet.
      }
      return false;
    }, "health/ready ok");

    assert.ok(body, "health/ready body missing");
    assert.equal(body.status, "ok");
    assert.match(String(body.configRevision), /^sha256:[0-9a-f]{64}$/);
    assert.equal(body.traceReady, true);
    assert.equal(body.enabledProviderCount, 3);

    // Verify /health/live returns 200 ok
    const liveRes = await fetch(`http://127.0.0.1:${operationsPort}/health/live`);
    assert.equal(liveRes.status, 200);
    const liveBody = (await liveRes.json()) as { status: string };
    assert.equal(liveBody.status, "ok");

    child.kill("SIGTERM");
    const exit = await exited;
    assert.equal(exit.code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(exit.signal, null);
  } catch (error) {
    throw new Error(`${String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`, { cause: error });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  assertNoSecretLeak({ stdout, stderr, code: null, signal: null }, Object.values(env));
});

test.concurrent("process: config path resolution precedence (--config > APTUS_CONFIG > ./aptus.yaml)", async () => {
  const env = seededEnv("path-res");

  // 1. --config wins over APTUS_CONFIG
  const dirA = mkdtempSync(join(tmpdir(), "aptus-process-path-a-"));
  const clientPortA = await freePort();
  const operationsPortA = await freePort();
  const configA = join(dirA, "custom.yaml");
  writeFileSync(
    configA,
    completeYaml({
      "  port: 8080": `  port: ${clientPortA}`,
      "  port: 9090": `  port: ${operationsPortA}`,
    }),
  );
  const childA = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", configA],
    { cwd: dirA, env: mergedEnv({ ...env, APTUS_CONFIG: "/nonexistent/aptus.yaml" }), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdoutA = "";
  childA.stdout?.on("data", (chunk: Buffer) => { stdoutA += chunk.toString(); });
  const exitedA = once(childA, "exit").then(([code, signal]) => ({ code, signal }));
  try {
    await waitFor(() => /^aptus ready: /m.test(stdoutA), "ready line A");
    childA.kill("SIGTERM");
    const exitA = await exitedA;
    assert.equal(exitA.code, 0);
  } finally {
    if (childA.exitCode === null && childA.signalCode === null) childA.kill("SIGKILL");
  }

  // 2. APTUS_CONFIG is used when --config is omitted
  const dirB = mkdtempSync(join(tmpdir(), "aptus-process-path-b-"));
  const clientPortB = await freePort();
  const operationsPortB = await freePort();
  const configB = join(dirB, "env.yaml");
  writeFileSync(
    configB,
    completeYaml({
      "  port: 8080": `  port: ${clientPortB}`,
      "  port: 9090": `  port: ${operationsPortB}`,
    }),
  );
  const childB = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI],
    { cwd: dirB, env: mergedEnv({ ...env, APTUS_CONFIG: configB }), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdoutB = "";
  childB.stdout?.on("data", (chunk: Buffer) => { stdoutB += chunk.toString(); });
  const exitedB = once(childB, "exit").then(([code, signal]) => ({ code, signal }));
  try {
    await waitFor(() => /^aptus ready: /m.test(stdoutB), "ready line B");
    childB.kill("SIGTERM");
    const exitB = await exitedB;
    assert.equal(exitB.code, 0);
  } finally {
    if (childB.exitCode === null && childB.signalCode === null) childB.kill("SIGKILL");
  }

  // 3. Default ./aptus.yaml in working directory
  const dirC = mkdtempSync(join(tmpdir(), "aptus-process-path-c-"));
  const clientPortC = await freePort();
  const operationsPortC = await freePort();
  writeFileSync(
    join(dirC, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPortC}`,
      "  port: 9090": `  port: ${operationsPortC}`,
    }),
  );
  const childC = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI],
    { cwd: dirC, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdoutC = "";
  childC.stdout?.on("data", (chunk: Buffer) => { stdoutC += chunk.toString(); });
  const exitedC = once(childC, "exit").then(([code, signal]) => ({ code, signal }));
  try {
    await waitFor(() => /^aptus ready: /m.test(stdoutC), "ready line C");
    childC.kill("SIGTERM");
    const exitC = await exitedC;
    assert.equal(exitC.code, 0);
  } finally {
    if (childC.exitCode === null && childC.signalCode === null) childC.kill("SIGKILL");
  }

  // 4. Missing config file anywhere exits 78 with read error
  const dirD = mkdtempSync(join(tmpdir(), "aptus-process-path-d-"));
  const resultD = await spawnCli([], env, dirD);
  assert.equal(resultD.code, 78);
  assert.match(stripDepWarnings(resultD.stderr), /^CONFIG_FILE_READ  cannot read config file/);
});

test.concurrent("process: boots and exits 0 gracefully on SIGINT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aptus-process-sigint-"));
  const clientPort = await freePort();
  const operationsPort = await freePort();
  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPort}`,
      "  port: 9090": `  port: ${operationsPort}`,
    }),
  );
  const env = seededEnv("sigint");
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", join(dir, "aptus.yaml")],
    { cwd: dir, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  try {
    await waitFor(() => /^aptus ready: /m.test(stdout), "ready line");
    child.kill("SIGINT");
    const exit = await exited;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test.concurrent("process: shutdown drain with held request updates readiness to 503 degraded and completes on socket close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aptus-process-drain-"));
  const clientPort = await freePort();
  const operationsPort = await freePort();
  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPort}`,
      "  port: 9090": `  port: ${operationsPort}`,
      "  shutdownDrainMs: 30000": "  shutdownDrainMs: 2000",
    }),
  );
  const env = seededEnv("drain");
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", join(dir, "aptus.yaml")],
    { cwd: dir, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  let socket: net.Socket | undefined;
  try {
    await waitFor(() => /^aptus ready: /m.test(stdout), "ready line");

    // Hold a partial HTTP request on client port
    socket = net.connect(clientPort, "127.0.0.1", () => {
      socket?.write(
        'POST /v1/chat/completions HTTP/1.1\r\nHost: aptus-test\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"partial',
      );
    });

    child.kill("SIGTERM");

    // During drain, /health/ready returns 503 degraded while /health/live remains 200 ok
    await waitFor(async () => {
      try {
        const readyRes = await fetch(`http://127.0.0.1:${operationsPort}/health/ready`);
        if (readyRes.status === 503) {
          const body = (await readyRes.json()) as { status: string };
          return body.status === "degraded";
        }
      } catch {}
      return false;
    }, "drain ready 503 degraded");

    const liveRes = await fetch(`http://127.0.0.1:${operationsPort}/health/live`);
    assert.equal(liveRes.status, 200);

    // Destroying socket lets the drain finish and process exit 0
    socket.destroy();
    const exit = await exited;
    assert.equal(exit.code, 0);
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test.concurrent("process: second signal during shutdown drain aborts wait immediately and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aptus-process-abort-"));
  const clientPort = await freePort();
  const operationsPort = await freePort();
  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": `  port: ${clientPort}`,
      "  port: 9090": `  port: ${operationsPort}`,
      "  shutdownDrainMs: 30000": "  shutdownDrainMs: 10000",
    }),
  );
  const env = seededEnv("abort");
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", TSX_CLI, CLI, "--config", join(dir, "aptus.yaml")],
    { cwd: dir, env: mergedEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  let socket: net.Socket | undefined;
  try {
    await waitFor(() => /^aptus ready: /m.test(stdout), "ready line");

    socket = net.connect(clientPort, "127.0.0.1", () => {
      socket?.write(
        'POST /v1/chat/completions HTTP/1.1\r\nHost: aptus-test\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"partial',
      );
    });

    child.kill("SIGTERM");

    await waitFor(async () => {
      try {
        const readyRes = await fetch(`http://127.0.0.1:${operationsPort}/health/ready`);
        return readyRes.status === 503;
      } catch {}
      return false;
    }, "drain started");

    // Second signal interrupts drain wait
    child.kill("SIGINT");
    const exit = await exited;
    assert.equal(exit.code, 0);
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

