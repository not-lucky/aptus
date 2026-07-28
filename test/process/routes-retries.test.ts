import assert from "node:assert/strict";
import { test } from "vitest";
import { postJson, seededSecrets, startAptusCli, stopCli, type RunningCli } from "../helpers/cli-process.js";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.js";
import { createProviderOrigin, type ProviderOrigin } from "../helpers/provider-origin.js";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_CHAT_KEY_C",
  "OPENAI_RESPONSES_KEY_A",
  "BACKUP_CHAT_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string): Record<string, string> => seededSecrets(caseName, ENV_NAMES, "aptus-route-secret");

const BACKUP_PROVIDER_SNIPPET = `  - name: backup-chat-provider
    protocol: openai-chat
    baseUrl: BACKUP_CHAT_BASE_URL
    headers: {}
    keyStrategy: fill-first
    keys:
      - name: backup-key-1
        secret: \${BACKUP_CHAT_KEY_A}
        enabled: true

`;

const BACKUP_MODEL_SNIPPET = `  - name: gpt-backup
    aliases: []
    provider: backup-chat-provider
    upstreamModel: gpt-5.4-backup
    defaults: {}
    extraBody: {}
    overrides: {}
    catalog:
      openai:
        created: 1775606400
        ownedBy: openai
      anthropic:
        createdAt: "2026-04-08T00:00:00Z"
        displayName: Backup GPT
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null
    pricing: null

`;

const KEY_C_SNIPPET = `\n      - name: openai-chat-c\n        secret: \${OPENAI_CHAT_KEY_C}\n        enabled: true`;

/**
 * Route-and-retry fixtures: backup provider/model snippets, a fill-first
 * primary, and a 30s deadline. Case-specific anchors arrive via `overrides`.
 */
function routeReplacements(
  primary: ProviderOrigin,
  backup: ProviderOrigin,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "  requestDeadlineMs: 600000": "  requestDeadlineMs: 30000",
    "    baseUrl: https://api.openai.com/v1/": `    baseUrl: ${primary.baseUrl}/`,
    "    keyStrategy: round-robin": "    keyStrategy: fill-first",
    "providers:\n": `providers:\n${BACKUP_PROVIDER_SNIPPET.replace("BACKUP_CHAT_BASE_URL", backup.baseUrl)}`,
    "models:\n": `models:\n${BACKUP_MODEL_SNIPPET}`,
    ...overrides,
  };
}

function startRoutesCli(
  primary: ProviderOrigin,
  backup: ProviderOrigin,
  caseName: string,
  overrides: Record<string, string> = {},
): Promise<RunningCli> {
  return startAptusCli({
    casePrefix: "aptus-routes",
    caseName,
    envNames: ENV_NAMES,
    secretPrefix: "aptus-route-secret",
    replacements: routeReplacements(primary, backup, overrides),
  });
}

/** Route fixture defaults: primary + backup candidates, three primary keys. */
const THREE_KEY_ROUTE = {
  "      allow: [gpt-main, claude-main, reliable-chat]":
    "      allow: [gpt-main, claude-main, reliable-chat, gpt-backup]",
  "      - name: openai-chat-b\n        secret: ${OPENAI_CHAT_KEY_B}\n        enabled: true":
    "      - name: openai-chat-b\n        secret: ${OPENAI_CHAT_KEY_B}\n        enabled: true" + KEY_C_SNIPPET,
  "    candidates: [gpt-main, claude-main]": "    candidates: [gpt-main, gpt-backup, claude-main]",
};

function chatRequest(port: number, caseName: string, model = "reliable-chat", stream = false): Promise<Response> {
  const env = seededEnv(caseName);
  return postJson(
    port,
    "/v1/chat/completions",
    { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
    JSON.stringify({ ...MINIMAL_CHAT_REQUEST, model, stream }),
  );
}

test("process: two 429s with three keys rotate keys before wait and succeed on third attempt", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "two-429-rotate";
    const cli = await startRoutesCli(primary, backup, caseName, THREE_KEY_ROUTE);
    try {
      primary.enqueue({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: JSON.stringify({ error: { message: "rate limit 1" } }),
      });
      primary.enqueue({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: JSON.stringify({ error: { message: "rate limit 2" } }),
      });
      primary.enqueue({
        status: 200,
        headers: { "content-type": "application/json" },
        body: COMPLETE_CHAT_BYTES,
      });

      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 200);
      const resBody = (await res.json()) as { id?: string };
      assert.equal(resBody.id, "chatcmpl-abc123");
      assert.equal(primary.dispatchCount(), 3);
      assert.equal(backup.dispatchCount(), 0);

      // Verify keys rotated across the 3 attempts (primary-a, primary-b, primary-c)
      const reqs = primary.requests();
      assert.equal(
        reqs[0]?.headers.find(([h]) => h.toLowerCase() === "authorization")?.[1],
        "Bearer aptus-route-secret-two-429-rotate-2",
      );
      assert.equal(
        reqs[1]?.headers.find(([h]) => h.toLowerCase() === "authorization")?.[1],
        "Bearer aptus-route-secret-two-429-rotate-3",
      );
      assert.equal(
        reqs[2]?.headers.find(([h]) => h.toLowerCase() === "authorization")?.[1],
        "Bearer aptus-route-secret-two-429-rotate-4",
      );
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: 503 retries exhausted on primary origin falls back to backup origin", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "fallback-503";
    const cli = await startRoutesCli(primary, backup, caseName, THREE_KEY_ROUTE);
    try {
      // Primary origin returns 503 three times (exhausting 1 initial attempt + 2 retries)
      primary.enqueue({ status: 503, headers: { "content-type": "application/json" }, body: '{"error":"503-1"}' });
      primary.enqueue({ status: 503, headers: { "content-type": "application/json" }, body: '{"error":"503-2"}' });
      primary.enqueue({ status: 503, headers: { "content-type": "application/json" }, body: '{"error":"503-3"}' });

      // Backup origin returns 200
      backup.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: COMPLETE_CHAT_BYTES });

      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 200);
      assert.equal(primary.dispatchCount(), 3);
      assert.equal(backup.dispatchCount(), 1);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: pre-header disconnect falls back to backup origin", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "pre-header-fallback";
    const cli = await startRoutesCli(primary, backup, caseName, THREE_KEY_ROUTE);
    try {
      // Primary origin abruptly disconnects before sending response head
      primary.enqueue({ status: 0, mode: "pre-header-disconnect" });
      // Backup origin responds with 200
      backup.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: COMPLETE_CHAT_BYTES });

      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 200);
      assert.equal(primary.dispatchCount(), 1);
      assert.equal(backup.dispatchCount(), 1);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: protocol-mismatch-only route returns 400 with zero origin dispatches", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "mismatch-only";
    const cli = await startRoutesCli(primary, backup, caseName, {
      "    candidates: [gpt-main, claude-main]": "    candidates: [claude-main]",
    });
    try {
      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: { type?: string } };
      assert.equal(body.error?.type, "invalid_request_error");
      // Every candidate was preflight-skipped: neither origin was contacted.
      assert.equal(primary.dispatchCount(), 0);
      assert.equal(backup.dispatchCount(), 0);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: stalled response head times out with no retry and a 504 terminal", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "dispatch-timeout";
    const cli = await startRoutesCli(primary, backup, caseName, {
      "    candidates: [gpt-main, claude-main]": "    candidates: [gpt-main]",
      "  requestDeadlineMs: 600000": "  requestDeadlineMs: 300",
    });
    try {
      // The origin accepts the request but never sends a head within the deadline.
      primary.enqueue({ status: 200, mode: "held-open", headDelayMs: 5000 });

      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 504);
      // Timeouts never retry the same candidate and no later candidate exists.
      assert.equal(primary.dispatchCount(), 1);
      assert.equal(backup.dispatchCount(), 0);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: retry wait past the request deadline expires with a 504 and no extra dispatch", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "deadline-expiry";
    const cli = await startRoutesCli(primary, backup, caseName, {
      "    candidates: [gpt-main, claude-main]": "    candidates: [gpt-main]",
      "  requestDeadlineMs: 600000": "  requestDeadlineMs: 1000",
      // A single primary key so the 429 cooldown forces a wait.
      "      - name: openai-chat-b\n        secret: ${OPENAI_CHAT_KEY_B}\n        enabled: true\n": "",
    });
    try {
      // The observed Retry-After (30s) exceeds the whole 1s request deadline.
      primary.enqueue({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
        body: '{"error":"rate limited"}',
      });

      const res = await chatRequest(cli.clientPort, caseName);
      assert.equal(res.status, 504);
      assert.equal(primary.dispatchCount(), 1);
      assert.equal(backup.dispatchCount(), 0);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});

test("process: post-header disconnect on a stream cannot fall back after client bytes", async () => {
  const primary = await createProviderOrigin({ basePath: "/v1" });
  const backup = await createProviderOrigin({ basePath: "/v1" });

  try {
    const caseName = "post-header-disconnect";
    const cli = await startRoutesCli(primary, backup, caseName, THREE_KEY_ROUTE);
    try {
      // The origin sends a 200 head plus one stream chunk, then destroys the socket.
      // The delayed empty segment lets the head and chunk flush before the destroy.
      primary.enqueue({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        mode: "post-header-disconnect",
        segments: [{ bytes: "data: partial\n\n" }, { bytes: "", delayMs: 50 }],
      });
      backup.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: COMPLETE_CHAT_BYTES });

      const res = await chatRequest(cli.clientPort, caseName, "reliable-chat", true);
      assert.equal(res.status, 200);
      // The client stream terminates abruptly: no fallback dispatch may follow.
      await assert.rejects(res.arrayBuffer());
      assert.equal(primary.dispatchCount(), 1);
      assert.equal(backup.dispatchCount(), 0);
    } finally {
      await stopCli(cli);
    }
  } finally {
    await Promise.all([primary.close(), backup.close()]);
  }
});
