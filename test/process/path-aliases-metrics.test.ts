import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPLETE_CHAT_BYTES, MINIMAL_CHAT_REQUEST } from "../helpers/chat-fixtures.ts";
import { postJson, seededSecrets, startThreeOriginCli, waitFor } from "../helpers/cli-process.ts";
import { COMPLETE_MESSAGES_BYTES, MINIMAL_MESSAGES_REQUEST } from "../helpers/messages-fixtures.ts";
import { COMPLETE_RESPONSES_BYTES, MINIMAL_RESPONSES_REQUEST } from "../helpers/responses-fixtures.ts";
import { createThreeOriginHarness } from "../helpers/three-origin-harness.ts";

const ENV_NAMES = [
  "APTUS_CLIENT_PRIMARY",
  "APTUS_CLIENT_OPERATOR",
  "OPENAI_CHAT_KEY_A",
  "OPENAI_CHAT_KEY_B",
  "OPENAI_RESPONSES_KEY_A",
  "ANTHROPIC_KEY_A",
] as const;

const seededEnv = (caseName: string) => seededSecrets(caseName, ENV_NAMES, "aptus-aliases");

const RESPONSES_MODEL_SNIPPET = `  - name: responses-main
    aliases: [responses-default]
    provider: openai-responses-primary
    upstreamModel: gpt-5.4
    defaults:
      temperature: 0.2
    extraBody: {}
    overrides: {}
    catalog:
      openai:
        created: 1775606400
        ownedBy: openai
      anthropic:
        createdAt: "2026-04-08T00:00:00Z"
        displayName: Responses Main through Aptus
        capabilities: null
        maxInputTokens: null
        maxOutputTokens: null
    pricing: null
`;

test.concurrent("process: both path aliases per protocol aggregate into one endpoint metric label", async () => {
  const harness = await createThreeOriginHarness();
  const env = seededEnv("aliases");
  const cli = await startThreeOriginCli(harness, {
    casePrefix: "aptus-aliases",
    caseName: "aliases",
    envNames: ENV_NAMES,
    secretPrefix: "aptus-aliases",
    replacements: {
      "      allow: [gpt-main, claude-main, reliable-chat]":
        "      allow: [gpt-main, claude-main, reliable-chat, responses-main]",
      "models:\n": `models:\n${RESPONSES_MODEL_SNIPPET}`,
    },
  });
  try {
    const bearer = { name: "authorization", value: `Bearer ${env.APTUS_CLIENT_PRIMARY}` };
    const apiKey = { name: "x-api-key", value: env.APTUS_CLIENT_PRIMARY };

    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    harness.chatOrigin.enqueue({ status: 200, body: COMPLETE_CHAT_BYTES });
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    harness.responsesOrigin.enqueue({ status: 200, body: COMPLETE_RESPONSES_BYTES });
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });
    harness.messagesOrigin.enqueue({ status: 200, body: COMPLETE_MESSAGES_BYTES });

    // Both alias paths per protocol.
    const chatA = await postJson(cli.clientPort, "/chat/completions", bearer, JSON.stringify(MINIMAL_CHAT_REQUEST));
    const chatB = await postJson(cli.clientPort, "/v1/chat/completions", bearer, JSON.stringify(MINIMAL_CHAT_REQUEST));
    const responsesA = await postJson(cli.clientPort, "/responses", bearer, JSON.stringify(MINIMAL_RESPONSES_REQUEST));
    const responsesB = await postJson(
      cli.clientPort,
      "/v1/responses",
      bearer,
      JSON.stringify(MINIMAL_RESPONSES_REQUEST),
    );
    const messagesA = await postJson(cli.clientPort, "/messages", apiKey, JSON.stringify(MINIMAL_MESSAGES_REQUEST));
    const messagesB = await postJson(cli.clientPort, "/v1/messages", apiKey, JSON.stringify(MINIMAL_MESSAGES_REQUEST));

    for (const response of [chatA, chatB, responsesA, responsesB, messagesA, messagesB]) {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }

    // Exactly one endpoint series per protocol, counting both aliases. Wait for
    // the final counts (not merely three series) so a request whose metric is
    // still being recorded cannot race ahead of the assertions below.
    const endpointSeries = [
      /aptus_http_requests_total\{endpoint_protocol="openai-chat",endpoint="chat_completions",outcome_category="complete",stream="false"\} 2/,
      /aptus_http_requests_total\{endpoint_protocol="openai-responses",endpoint="responses",outcome_category="complete",stream="false"\} 2/,
      /aptus_http_requests_total\{endpoint_protocol="anthropic-messages",endpoint="messages",outcome_category="complete",stream="false"\} 2/,
    ];
    let text = "";
    await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${cli.operationsPort}/metrics`);
        text = await response.text();
        return endpointSeries.every((pattern) => pattern.test(text));
      },
      "three endpoint series with complete counts",
      cli.child,
    );
    const series = text.split("\n").filter((line) => line.startsWith("aptus_http_requests_total"));
    assert.equal(series.length, 3, `expected exactly 3 endpoint series:\n${series.join("\n")}`);
    assert.match(text, endpointSeries[0]!);
    assert.match(text, endpointSeries[1]!);
    assert.match(text, endpointSeries[2]!);

    // Both aliases dispatched to the same origin per protocol.
    assert.equal(harness.chatOrigin.dispatchCount(), 2);
    assert.equal(harness.responsesOrigin.dispatchCount(), 2);
    assert.equal(harness.messagesOrigin.dispatchCount(), 2);
  } finally {
    await harness.closeAll();
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
  }
});
