import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../../src/bootstrap/run.ts";
import { formatStartupError } from "../../src/config/errors.ts";
import { loadConfig } from "../../src/config/load.ts";
import { completeYaml } from "../config/yaml.ts";
import { TEST_CLI_BUNDLE } from "./cli-bundle.ts";
import type { ThreeOriginHarness } from "./three-origin-harness.ts";

/**
 * One running Aptus CLI process with its parsed ready line.
 *
 * `stdout` is a live getter over the accumulated stdout+stderr buffer, so
 * post-startup structured log events (`aptus.request.cancelled`,
 * `aptus.shutdown.started`, `aptus.shutdown.completed`, …) are observable
 * after `startAptusCli` returns.
 */
export interface RunningCli {
  readonly child: ChildProcess;
  readonly clientPort: number;
  readonly operationsPort: number;
  readonly stdout: string;
  readonly traceRoot: string;
}

/**
 * Options for spawning the CLI against a generated config.
 */
export interface StartCliOptions {
  /** Tmp-directory and env-prefix tag for the spawned process (e.g. `"aptus-messages"`). */
  readonly casePrefix: string;
  /** Per-test case name appended to the tag. */
  readonly caseName: string;
  /** Exact-anchor replacements applied to the complete-sample YAML. */
  readonly replacements: Record<string, string>;
  /** Environment variable names the config interpolates; seeded with deterministic secrets. */
  readonly envNames: readonly string[];
  /** Value prefix for the seeded secrets. */
  readonly secretPrefix: string;
}

/**
 * Seeds deterministic secret values for the given env names (index-suffixed).
 *
 * The result is keyed by the exact env-name tuple, so lookups are type-checked.
 */
export function seededSecrets<const T extends readonly string[]>(
  caseName: string,
  envNames: T,
  secretPrefix: string,
): { readonly [K in T[number]]: string } {
  const env: Record<string, string> = {};
  let index = 0;
  for (const name of envNames) {
    env[name] = `${secretPrefix}-${caseName}-${index}`;
    index++;
  }
  return env as { [K in T[number]]: string };
}

/**
 * Builds the per-test tmp directory, config file, and seeded env shared by the
 * process and in-process CLI harnesses.
 */
function prepareAptusEnvironment(options: StartCliOptions): {
  dir: string;
  traceRoot: string;
  configPath: string;
  mergedEnv: NodeJS.ProcessEnv;
} {
  const dir = mkdtempSync(join(tmpdir(), `${options.casePrefix}-${options.caseName}-`));
  const traceRoot = join(dir, "traces");
  const env = seededSecrets(options.caseName, options.envNames, options.secretPrefix);

  writeFileSync(
    join(dir, "aptus.yaml"),
    completeYaml({
      "  port: 8080": "  port: 0",
      "  port: 9090": "  port: 0",
      "  root: ./traces": `  root: ${traceRoot}`,
      ...options.replacements,
    }),
    "utf8",
  );

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of options.envNames) delete mergedEnv[name];
  for (const [key, value] of Object.entries(env)) mergedEnv[key] = value;

  return { dir, traceRoot, configPath: join(dir, "aptus.yaml"), mergedEnv };
}

/**
 * Spawns the CLI with a generated config and waits for its ready line.
 *
 * The complete-sample YAML is always rewritten to free ports and a trace root
 * inside a fresh tmp directory; `replacements` adds case-specific anchors on
 * top. The child runs with only the seeded secrets (plus a clean copy of the
 * parent env) set; stdout and stderr are captured into `stdout` for ready-line
 * parsing and failure diagnostics.
 */
export async function startAptusCli(options: StartCliOptions): Promise<RunningCli> {
  const { dir, traceRoot, mergedEnv } = prepareAptusEnvironment(options);

  const child = spawn(process.execPath, [TEST_CLI_BUNDLE, "--config", join(dir, "aptus.yaml")], {
    cwd: dir,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  await waitFor(() => /^aptus ready: /m.test(output), `ready line. Output: ${output}`, child);
  const match = /aptus ready: operations http:\/\/[^:]+:(\d+), client http:\/\/[^:]+:(\d+)/.exec(output);
  assert.ok(match, `ready line parsed: ${output}`);

  return {
    child,
    clientPort: Number(match[2]),
    operationsPort: Number(match[1]),
    // Live getter: post-startup output accumulates into the same buffer.
    get stdout() {
      return output;
    },
    traceRoot,
  };
}

/**
 * One in-process Aptus runtime (no subprocess) with its bound ports.
 *
 * Used by behavioral tests that only need a running app to send HTTP at — the
 * app boots via `loadConfig` + `startRuntime` inside the test worker instead of
 * spawning the bundled CLI, removing the per-test process boot cost.
 */
export interface RunningInProcessAptus {
  readonly clientPort: number;
  readonly operationsPort: number;
  readonly traceRoot: string;
  /** Tears down listeners, the dispatcher, and the retention scheduler. */
  stop(): Promise<void>;
}

/**
 * Boots Aptus in-process with a generated config and returns its bound ports.
 *
 * Mirrors {@link startAptusCli} but uses the exported composition root directly,
 * so each test avoids a ~170ms Node subprocess boot plus spawn overhead.
 */
export async function startAptusInProcess(options: StartCliOptions): Promise<RunningInProcessAptus> {
  const { traceRoot, configPath, mergedEnv } = prepareAptusEnvironment(options);

  const loaded = await loadConfig(configPath, mergedEnv);
  if (!loaded.ok) {
    throw new Error(`in-process config load failed: ${loaded.error.map(formatStartupError).join("; ")}`);
  }
  const runtime = await startRuntime(loaded.value.config, loaded.value.revision, { logSink: () => {} });
  if (!runtime.ok) {
    throw new Error(`in-process runtime start failed: ${runtime.error.map(formatStartupError).join("; ")}`);
  }

  const { client, operations, shutdown } = runtime.value;
  return {
    clientPort: client.port,
    operationsPort: operations.port,
    traceRoot,
    stop: async () => {
      // Force-close any lingering in-flight requests so teardown never waits for the drain window.
      const runPromise = shutdown.run();
      shutdown.abort();
      await runPromise;
    },
  };
}

/**
 * Waits for a child process to exit and returns its exit code and signal.
 *
 * @param child - The child process to await.
 * @returns Exit code and signal (signal is `null` for a clean `process.exit`).
 */
export async function waitForExit(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  return { code, signal };
}

/**
 * Options for spawning the CLI against all three origins of a three-origin harness.
 */
export interface StartThreeOriginCliOptions {
  /** Tmp-directory and env-prefix tag for the spawned process. */
  readonly casePrefix: string;
  /** Per-test case name appended to the tag. */
  readonly caseName: string;
  /** Environment variable names the config interpolates; seeded with deterministic secrets. */
  readonly envNames: readonly string[];
  /** Value prefix for the seeded secrets. */
  readonly secretPrefix: string;
  /** Extra exact-anchor replacements layered on top of the three base URLs. */
  readonly replacements?: Record<string, string>;
}

/**
 * Spawns the CLI with the Chat, Responses, and Messages origins wired to the
 * three loopback providers of a {@link ThreeOriginHarness}.
 *
 * The base-URL anchors must be replaced in order: the Chat anchor (with a
 * trailing slash) first, so the bare Responses anchor matches exactly once
 * afterwards.
 */
export function startThreeOriginCli(
  harness: ThreeOriginHarness,
  options: StartThreeOriginCliOptions,
): Promise<RunningCli> {
  return startAptusCli({
    casePrefix: options.casePrefix,
    caseName: options.caseName,
    envNames: options.envNames,
    secretPrefix: options.secretPrefix,
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      ...options.replacements,
    },
  });
}

/**
 * In-process counterpart of {@link startThreeOriginCli}.
 */
export function startThreeOriginInProcess(
  harness: ThreeOriginHarness,
  options: StartThreeOriginCliOptions,
): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: options.casePrefix,
    caseName: options.caseName,
    envNames: options.envNames,
    secretPrefix: options.secretPrefix,
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${harness.chatOrigin.baseUrl}`,
      "    baseUrl: https://api.openai.com/v1": `    baseUrl: ${harness.responsesOrigin.baseUrl}`,
      "    baseUrl: https://api.anthropic.com": `    baseUrl: ${harness.messagesOrigin.baseUrl}`,
      ...options.replacements,
    },
  });
}

/**
 * Polls a condition until it holds, failing when the child exits or 20s pass.
 *
 * The condition may be async (e.g. an HTTP probe); each iteration awaits it.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    const childExited = child !== undefined && child.exitCode !== null;
    if (Date.now() > deadline || childExited) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Lists the trace files of the first (newest) trace directory.
 */
export function traceFiles(traceRoot: string): string[] {
  const dir = readdirSync(traceRoot).find((name) => !name.startsWith("."));
  if (dir === undefined) return [];
  return readdirSync(join(traceRoot, dir)).sort();
}

/**
 * Posts a JSON request with one auth header to the client ingress.
 */
export async function postJson(
  port: number,
  path: string,
  auth: { readonly name: string; readonly value: string },
  body: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [auth.name]: auth.value },
    body,
  });
}
