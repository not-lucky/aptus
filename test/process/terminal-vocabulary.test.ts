import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { type ChatOrigin, createChatOrigin } from "../helpers/chat-origin.ts";
import {
  postJson,
  type RunningInProcessAptus,
  seededSecrets,
  startAptusInProcess,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";

/**
 * Process-level pins for the terminal-outcome vocabulary's admission paths.
 *
 * These exercise the real HTTP ingress and the terminal coordinator together for the
 * pre-gateway rejection endings that the vocabulary centralizes: an unresolvable model
 * name (`not_found` → 404) and an unusable model field (`invalid_request` → 400). They
 * complement the vocabulary unit tests (`test/routing/terminal-outcome.test.ts`) and the
 * coordinator functional tests by asserting what the client and the trace directory
 * observably contain after each rejection: the encoded HTTP status, a committed
 * `999_terminal.json` with the derived `failed` terminal, and zero provider dispatch.
 */

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-terminal-vocabulary");

const bearer = (secret: string): { name: string; value: string } => ({
  name: "authorization",
  value: `Bearer ${secret}`,
});

function startCli(origin: ChatOrigin, caseName: string): Promise<RunningInProcessAptus> {
  return startAptusInProcess({
    casePrefix: "aptus-terminal-vocabulary",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-terminal-vocabulary",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${origin.baseUrl}`,
    },
  });
}

/** The newest non-dot trace directory under the trace root. */
function traceDir(cli: RunningInProcessAptus): string {
  const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
  assert.ok(dir, "no trace directory committed");
  return join(cli.traceRoot, dir);
}

/** Reads the newest trace directory's terminal file. */
function terminalJson(cli: RunningInProcessAptus): { kind: string; failure?: { category: string } } {
  const dir = traceDir(cli);
  const names = readdirSync(dir);
  assert.ok(names.includes("999_terminal.json"), `missing 999_terminal.json in ${names.join(",")}`);
  return JSON.parse(readFileSync(join(dir, "999_terminal.json"), "utf8")) as {
    kind: string;
    failure?: { category: string };
  };
}

/** Sends a Chat create request and asserts the admission rejection outcome end to end. */
async function assertAdmissionRejection(
  origin: ChatOrigin,
  caseName: string,
  body: Record<string, unknown>,
  expectedStatus: number,
  expectedCategory: string,
): Promise<void> {
  const env = seededEnv(caseName);
  const cli = await startCli(origin, caseName);
  try {
    const response = await postJson(
      cli.clientPort,
      "/v1/chat/completions",
      bearer(env.APTUS_CLIENT_PRIMARY),
      JSON.stringify(body),
    );
    assert.equal(response.status, expectedStatus);
    assert.match(response.headers.get("x-aptus-request-id") ?? "", /^[0-9a-f-]{36}$/i);

    // The vocabulary's failed terminal is committed even though dispatch never began:
    // admission rejects before any candidate is selected.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write");
    const terminal = terminalJson(cli);
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.failure?.category, expectedCategory);

    // Rejections never contact the provider origin.
    assert.equal(origin.dispatchCount(), 0);
  } finally {
    await cli.stop();
  }
}

test.concurrent("process: unresolvable model name is rejected as a 404 failed terminal with zero dispatch", async () => {
  const origin = await createChatOrigin();
  try {
    await assertAdmissionRejection(
      origin,
      "model-not-found",
      { ...MINIMAL_CHAT_REQUEST, model: "no-such-model" },
      404,
      "not_found",
    );
  } finally {
    await origin.close();
  }
});

test.concurrent("process: unusable model field is rejected as a 400 invalid_request terminal with zero dispatch", async () => {
  const origin = await createChatOrigin();
  try {
    await assertAdmissionRejection(
      origin,
      "model-invalid",
      { ...MINIMAL_CHAT_REQUEST, model: "" },
      400,
      "invalid_request",
    );
  } finally {
    await origin.close();
  }
});
