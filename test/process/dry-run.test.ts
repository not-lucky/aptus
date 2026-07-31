import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { createChatOrigin, type ChatOrigin } from "../helpers/chat-origin.ts";
import {
  postJson,
  type RunningCli,
  seededSecrets,
  startAptusCli,
  traceFiles,
  waitFor,
} from "../helpers/cli-process.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-dry-run");

function startCli(origin: ChatOrigin, caseName: string): Promise<RunningCli> {
  return startAptusCli({
    casePrefix: "aptus-dry-run",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-dry-run",
    replacements: {
      "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${origin.baseUrl}`,
      "dryRun:\n  enabled: false": "dryRun:\n  enabled: true",
    },
  });
}

test.concurrent("process: dry run with stream:true returns vendor JSON and zero dispatch", async () => {
  const origin = await createChatOrigin();
  const env = seededEnv("stream");
  const cli = await startCli(origin, "stream");
  try {
    const response = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      JSON.stringify({ ...MINIMAL_CHAT_REQUEST, stream: true }),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/vnd\.aptus\.dry-run\+json/);

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.dryRun, true);
    assert.equal(body.sourceProtocol, "openai-chat");
    assert.equal(body.targetProtocol, "openai-chat");
    assert.equal(body.publicName, "gpt-main");
    assert.equal(body.stream, undefined, "DryRunResult has no stream field");

    const candidate = body.candidate as Record<string, unknown>;
    assert.equal(candidate.provider, "openai-chat-primary");
    assert.equal(candidate.model, "gpt-5.4");
    assert.equal(candidate.key, "openai-chat-a", "candidate.key is the configured key name");

    const mutations = body.mutations as string[];
    assert.ok(mutations.includes("/model"));
    assert.ok(mutations.includes("/temperature"));
    assert.ok(mutations.includes("/store"));

    assert.deepEqual(body.preflight, { ok: true });

    const providerRequest = body.providerRequest as Record<string, unknown>;
    assert.equal(providerRequest.method, "POST");
    assert.equal(providerRequest.url, `${origin.baseUrl}/chat/completions`);
    assert.equal((providerRequest.headers as Record<string, string>).authorization, "[REDACTED]");

    // Zero provider dispatch: the origin never received a request.
    assert.equal(origin.dispatchCount(), 0);

    // Trace terminal records the dry-run outcome.
    await waitFor(() => traceFiles(cli.traceRoot).includes("999_terminal.json"), "terminal trace write", cli.child);
    const dir = readdirSync(cli.traceRoot).find((name) => !name.startsWith("."));
    assert.ok(dir);
    const terminal = JSON.parse(readFileSync(join(cli.traceRoot, dir, "999_terminal.json"), "utf8")) as {
      kind: string;
    };
    assert.equal(terminal.kind, "dry_run");

    // The accepted-request counter records `complete` with the dry-run `stream: false`,
    // while the in-flight gauge balances the admitted `stream: true` increment.
    const metrics = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
    const text = await metrics.text();
    assert.match(
      text,
      /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="complete",stream="false"\} 1/,
    );
    assert.match(text, /aptus_in_flight_requests\{endpoint_protocol="openai-chat",stream="true"\} 0/);
  } finally {
    await origin.close();
    cli.child.kill("SIGKILL");
  }
});
