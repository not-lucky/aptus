import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AptusRequestId } from "../../src/domain/request-id.ts";
import { createFileTraceRecorder } from "../../src/observability/trace/file-recorder.ts";

const encoder = new TextEncoder();

test("openBytes creates .tmp file, appends chunks, and renames atomically on complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-trace-sink-"));
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set(["secret-token"]),
    onFailure: () => {},
    onDegrade: () => {},
    onRecover: () => {},
  });

  const session = await recorder.start({
    aptusRequestId: "11111111-1111-4111-8111-111111111111" as AptusRequestId,
    startedAtLocal: "2026-08-17T12-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });

  const sink = session.openBytes("provider_stream");
  await sink.append(encoder.encode('data: {"id":"1"}\n\n'));
  await sink.append(encoder.encode("data: [DONE]\n\n"));
  await sink.complete();

  await session.finish({ kind: "complete", status: 200 });

  const dir = join(root, "2026-08-17T12-00-00.000+0000_11111111-1111-4111-8111-111111111111");
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["000_manifest.json", "001_provider_stream.sse", "999_terminal.json"]);

  // Content matches exactly
  const streamContent = readFileSync(join(dir, "001_provider_stream.sse"), "utf8");
  assert.equal(streamContent, 'data: {"id":"1"}\n\ndata: [DONE]\n\n');
});

test("openBytes unlinks temporary file on discard", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-trace-discard-"));
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set(),
    onFailure: () => {},
    onDegrade: () => {},
    onRecover: () => {},
  });

  const session = await recorder.start({
    aptusRequestId: "22222222-2222-4222-8222-222222222222" as AptusRequestId,
    startedAtLocal: "2026-08-17T12-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });

  const sink = session.openBytes("provider_stream");
  await sink.append(encoder.encode("partial data"));
  await sink.discard();

  await session.finish({
    kind: "failed",
    failure: { category: "stream_interrupted", message: "aborted", retryable: false },
  });

  const dir = join(root, "2026-08-17T12-00-00.000+0000_22222222-2222-4222-8222-222222222222");
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["000_manifest.json", "999_terminal.json"]);
  // No leftover .tmp files
  assert.ok(!files.some((f) => f.includes(".tmp")));
});

test("serialized queue preserves strict execution order across interleaved writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aptus-trace-fifo-"));
  const recorder = createFileTraceRecorder({
    root,
    secrets: new Set(),
    onFailure: () => {},
    onDegrade: () => {},
    onRecover: () => {},
  });

  const session = await recorder.start({
    aptusRequestId: "33333333-3333-4333-8333-333333333333" as AptusRequestId,
    startedAtLocal: "2026-08-17T12-00-00.000+0000",
    configRevision: "sha256:abc",
    sourceProtocol: "openai-chat",
  });

  // Interleave asynchronous record calls without awaiting sequentially
  const p1 = session.recordJson("client_request", { step: 1 });
  const p2 = session.recordJson("mutation", { step: 2 });
  const p3 = session.recordJson("provider_response", { step: 3 });
  const p4 = session.finish({ kind: "complete", status: 200 });

  await Promise.all([p1, p2, p3, p4]);

  const dir = join(root, "2026-08-17T12-00-00.000+0000_33333333-3333-4333-8333-333333333333");
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [
    "000_manifest.json",
    "001_client_request.json",
    "002_mutation.json",
    "003_provider_response.json",
    "999_terminal.json",
  ]);
});
