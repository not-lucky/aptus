import assert from "node:assert/strict";
import { test } from "vitest";
import { MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { postJson, seededSecrets, startThreeOriginInProcess } from "../helpers/cli-process.ts";
import { createThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "APTUS_CLIENT_RESTRICTED",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-catalog");

/**
 * Adds a third client key with an empty allow-list (empty authorized catalog).
 * The `${...}` env references are literal YAML interpolation, not template
 * substitution, so the snippet is built with string concatenation.
 */
const RESTRICTED_CLIENT_SNIPPET =
  "      secret: ${APTUS_CLIENT_OPERATOR}\n" +
  "    - name: restricted-client\n" +
  "      secret: ${APTUS_CLIENT_RESTRICTED}\n" +
  "      allow: []\n";

test.concurrent("process: Bearer and x-api-key catalogs are served locally with zero provider dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("populated");
  const cli = await startThreeOriginInProcess(harness, {
    casePrefix: "aptus-catalog",
    caseName: "populated",
    envNames: ENV_NAMES,
    secretPrefix: "aptus-catalog",
    replacements: {
      "      secret: ${APTUS_CLIENT_OPERATOR}": RESTRICTED_CLIENT_SNIPPET,
    },
  });
  try {
    // OpenAI Bearer envelope on both alias paths.
    for (const path of ["/models", "/v1/models"]) {
      const response = await fetch(`http://127.0.0.1:${cli.clientPort}${path}`, {
        headers: { authorization: `Bearer ${env.APTUS_CLIENT_PRIMARY}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
      assert.equal(body.object, "list");
      assert.deepEqual(
        body.data.map((entry) => entry.id),
        ["claude-main", "gpt-main", "reliable-chat"],
      );
    }

    // Anthropic x-api-key envelope on both alias paths.
    for (const path of ["/models", "/v1/models"]) {
      const response = await fetch(`http://127.0.0.1:${cli.clientPort}${path}`, {
        headers: { "x-api-key": env.APTUS_CLIENT_PRIMARY },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: Array<{ id: string; type: string; display_name: string }>;
        has_more: boolean;
      };
      assert.equal(body.has_more, false);
      assert.deepEqual(
        body.data.map((entry) => entry.id),
        ["claude-main", "gpt-main", "reliable-chat"],
      );
      assert.ok(body.data.every((entry) => entry.type === "model"));
      assert.ok(body.data.every((entry) => typeof entry.display_name === "string"));
    }

    // Catalogs are local: no provider was ever contacted.
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});

test.concurrent("process: restricted allow:[] client gets an empty catalog and 404 on create with zero dispatch", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("empty");
  const cli = await startThreeOriginInProcess(harness, {
    casePrefix: "aptus-catalog",
    caseName: "empty",
    envNames: ENV_NAMES,
    secretPrefix: "aptus-catalog",
    replacements: {
      "      secret: ${APTUS_CLIENT_OPERATOR}": RESTRICTED_CLIENT_SNIPPET,
    },
  });
  try {
    const restricted = `Bearer ${env.APTUS_CLIENT_RESTRICTED}`;

    // Empty authorized catalog on both alias paths.
    for (const path of ["/models", "/v1/models"]) {
      const response = await fetch(`http://127.0.0.1:${cli.clientPort}${path}`, {
        headers: { authorization: restricted },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: unknown[] };
      assert.deepEqual(body.data, []);
    }

    // A create with an empty allow-list resolves to not_found (404).
    const create = await postJson(
      cli.clientPort,
      "/chat/completions",
      { name: "authorization", value: restricted },
      JSON.stringify(MINIMAL_CHAT_REQUEST),
    );
    assert.equal(create.status, 404);
    const errorBody = (await create.json()) as { error?: { type?: string } };
    assert.equal(errorBody.error?.type, "not_found_error");

    // The x-api-key path behaves identically for the restricted client.
    const messagesCreate = await postJson(
      cli.clientPort,
      "/v1/messages",
      { name: "x-api-key", value: env.APTUS_CLIENT_RESTRICTED },
      JSON.stringify({ model: "claude-main", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(messagesCreate.status, 404);

    // Zero provider dispatch for the empty catalog and both rejected creates.
    assert.equal(harness.chatOrigin.dispatchCount(), 0);
    assert.equal(harness.responsesOrigin.dispatchCount(), 0);
    assert.equal(harness.messagesOrigin.dispatchCount(), 0);
  } finally {
    await harness.closeAll();
    await cli.stop();
  }
});
