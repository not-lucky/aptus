import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AptusRequestId } from "../../src/domain/request-id.js";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.js";
import { createNoopTraceRecorder } from "../../src/observability/trace/noop-recorder.js";

const encoder = new TextEncoder();

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("file recorder writes manifest, ordered stages, exact bytes, and one terminal", async () => {
  const root = tmpRoot("aptus-trace-");
  let failures = 0;
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set(["secret-value", "client-secret"]),
    onFailure: () => {
      failures++;
    },
    onRecover: () => undefined,
  });

  const session = await recorder.start({
    aptusRequestId: "req-1" as AptusRequestId,
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session.recordJson("client_request", {
    headers: { authorization: "Bearer secret-value", "x-custom": "keep" },
    body: { model: "gpt-main", token: "secret-value", ok: "yes" },
  });
  await session.recordBytes("provider_stream", encoder.encode("data: [DONE]\n\n"));
  await session.recordJson("provider_response", { id: "x", secret: "client-secret" });
  await session.finish({ kind: "complete", status: 200 });

  const dir = join(root, "2026-08-15T00-00-00.000+0000_req-1");
  assert.ok(existsSync(dir));
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, [
    "000_manifest.json",
    "001_client_request.json",
    "002_provider_stream.sse",
    "003_provider_response.json",
    "999_terminal.json",
  ]);
  assert.equal(failures, 0);

  // No temporary files remain after atomic rename.
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp")),
    [],
  );

  // Manifest fields are exact and immutable.
  const manifest = JSON.parse(readFileSync(join(dir, "000_manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.aptusRequestId, "req-1");
  assert.equal(manifest.sourceProtocol, "openai-chat");
  assert.equal(manifest.configRevision, "sha256:abc");
  assert.equal(manifest.redaction, "credentials-and-resolved-secrets");
  assert.equal(manifest.payloadProtection, "filesystem-permissions-only");
  assert.match(String(manifest.startedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // Redaction: credential header values and exact secrets are replaced; raw bytes are untouched.
  const clientRequest = JSON.parse(readFileSync(join(dir, "001_client_request.json"), "utf8")) as {
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  assert.equal(clientRequest.headers.authorization, "[REDACTED]");
  assert.equal(clientRequest.headers["x-custom"], "keep");
  assert.equal(clientRequest.body.token, "[REDACTED]");
  assert.equal(clientRequest.body.ok, "yes");
  assert.equal(clientRequest.body.model, "gpt-main");
  assert.equal(readFileSync(join(dir, "002_provider_stream.sse"), "utf8"), "data: [DONE]\n\n");
  const providerResponse = JSON.parse(readFileSync(join(dir, "003_provider_response.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(providerResponse.secret, "[REDACTED]");
  assert.equal(providerResponse.id, "x");

  const terminal = JSON.parse(readFileSync(join(dir, "999_terminal.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(terminal, { kind: "complete", status: 200 });

  // File and directory permissions are owner-only on POSIX.
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const name of names) {
      assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
    }
  }
});

test("file recorder records a non-JSON response as .bin bytes", async () => {
  const root = tmpRoot("aptus-trace-bin-");
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set<string>(),
    onFailure: () => undefined,
    onRecover: () => undefined,
  });
  const session = await recorder.start({
    aptusRequestId: "req-2" as AptusRequestId,
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session.recordBytes("provider_response", encoder.encode("\x00\x01\x02"));
  await session.finish({ kind: "failed", failure: { category: "provider", message: "x", retryable: false } });

  const dir = join(root, "2026-08-15T00-00-00.000+0000_req-2");
  assert.deepEqual(readdirSync(dir).sort(), ["000_manifest.json", "001_provider_response.bin", "999_terminal.json"]);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, "001_provider_response.bin"))), Uint8Array.from([0, 1, 2]));
});

test("no-op recorder resolves without creating any directory", async () => {
  const root = tmpRoot("aptus-trace-noop-");
  const recorder = createNoopTraceRecorder();
  const session = await recorder.start({
    aptusRequestId: "req-3" as AptusRequestId,
    startedAtLocal: "2026-08-15T00-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });
  await session.recordJson("client_request", { ok: true });
  await session.recordBytes("provider_stream", encoder.encode("x"));
  await session.finish({ kind: "complete", status: 200 });
  assert.equal(existsSync(join(root, "2026-08-15T00-00-00.000+0000_req-3")), false);
});
