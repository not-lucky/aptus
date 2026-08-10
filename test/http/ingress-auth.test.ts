import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import type { ClientKeyConfig, SecretString } from "../../src/config/types.ts";
import { authenticateClient } from "../../src/http/auth.ts";
import { admitJsonObject, filterClientHeaders, parseDuplicateFreeJson } from "../../src/http/ingress.ts";

const keys: readonly ClientKeyConfig[] = [{ name: "client", secret: "client-secret" as SecretString }];

test.concurrent("authenticateClient accepts only the endpoint credential scheme", () => {
  assert.deepEqual(authenticateClient({ authorization: "Bearer client-secret" }, keys, "openai-create"), {
    name: "client",
    kind: "bearer",
  });
  assert.deepEqual(authenticateClient({ "x-api-key": "client-secret" }, keys, "messages-create"), {
    name: "client",
    kind: "api-key",
  });
  assert.equal(authenticateClient({ "x-api-key": "client-secret" }, keys, "openai-create"), undefined);
  assert.equal(authenticateClient({ authorization: "Bearer client-secret" }, keys, "messages-create"), undefined);
});

test.concurrent("authenticateClient rejects missing malformed combined and repeated credentials", () => {
  assert.equal(authenticateClient({}, keys, "catalog"), undefined);
  assert.equal(authenticateClient({ authorization: "Basic client-secret" }, keys, "catalog"), undefined);
  assert.equal(
    authenticateClient({ authorization: "Bearer client-secret", "x-api-key": "client-secret" }, keys, "catalog"),
    undefined,
  );
  assert.equal(
    authenticateClient({ authorization: "Bearer client-secret" }, keys, "catalog", [
      "authorization",
      "Bearer client-secret",
      "authorization",
      "Bearer client-secret",
    ]),
    undefined,
  );
});

test.concurrent("duplicate-aware JSON parser accepts escaped strings and rejects duplicate keys everywhere", () => {
  for (const source of ['{"value":"\\\\"}', '{"value":"\\\\\\\\"}', '{"value":"a\\"b"}']) {
    const result = parseDuplicateFreeJson(source);
    assert.equal(result.ok, true, source);
  }
  for (const source of ['{"a":1,"a":2}', '{"nested":{"a":1,"a":2}}', '{"items":[{"a":1,"a":2}]}']) {
    const result = parseDuplicateFreeJson(source);
    assert.equal(result.ok, false, source);
  }
  assert.equal(parseDuplicateFreeJson('{"a":1} {}').ok, false);
});

test.concurrent("duplicate-aware JSON parser accepts only JSON whitespace and valid Unicode escapes", () => {
  assert.equal(parseDuplicateFreeJson('\t\r\n {"value":1} \r\n').ok, true);
  for (const source of ['{"value":1}\v', '{"value":"\\uD800"}', '{"value":"\\uDC00"}', '{"value":"\\uD800\\u0041"}']) {
    assert.equal(parseDuplicateFreeJson(source).ok, false, source);
  }
  for (const source of [
    '{"value":x1}',
    '{"value":-x1}',
    '{"value":.1}',
    '{"value":+1}',
    '{"value":1e}',
    '{"value":1.}',
    '{"value":01}',
    '{"value":1x}',
  ]) {
    assert.equal(parseDuplicateFreeJson(source).ok, false, source);
  }
  for (const source of ['{"value":truex}', '{"value":false1}', '{"value":nullz}']) {
    assert.equal(parseDuplicateFreeJson(source).ok, false, source);
  }
  const escapedDuplicate = parseDuplicateFreeJson('{"a":1,"\\u0061":2}');
  assert.equal(escapedDuplicate.ok, false);
});

test.concurrent("forwarding headers survive only for trusted proxy CIDRs", () => {
  const headers = { "x-forwarded-for": "198.51.100.7", forwarded: "for=198.51.100.7", accept: "application/json" };
  assert.deepEqual(filterClientHeaders(headers, "10.2.3.4", ["10.0.0.0/8"]), headers);
  assert.deepEqual(filterClientHeaders(headers, "192.0.2.4", ["10.0.0.0/8"]), { accept: "application/json" });
});

test.concurrent("raw admission enforces JSON content, body size, and root objects", async () => {
  const accepted = await admit({ "content-type": "application/json" }, Buffer.from('{"value":1}'), 32);
  assert.equal(accepted.ok, true);
  const quotedCharset = await admit(
    { "content-type": 'application/json; charset="utf-8"' },
    Buffer.from('{"value":1}'),
    32,
  );
  assert.equal(quotedCharset.ok, true);
  const upperQuotedCharset = await admit(
    { "content-type": 'application/json; charset="UTF-8"' },
    Buffer.from('{"value":1}'),
    32,
  );
  assert.equal(upperQuotedCharset.ok, true);
  const array = await admit({ "content-type": "application/json" }, Buffer.from("[]"), 32);
  assert.equal(array.ok, false);
  const encoded = await admit(
    { "content-type": "application/json", "content-encoding": "gzip" },
    Buffer.from("{}"),
    32,
  );
  assert.equal(encoded.ok, false);
  const tooLarge = await admit({ "content-type": "application/json" }, Buffer.from('{"value":12345}'), 4);
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.failure.category, "payload_too_large");
});

test.concurrent("peer forwarding headers strictly reject IPv6 peers without IPv6 CIDR parsing", () => {
  const headers = { "x-forwarded-for": "198.51.100.7", forwarded: "for=198.51.100.7", accept: "application/json" };
  assert.deepEqual(filterClientHeaders(headers, "::ffff:10.2.3.4", ["10.0.0.0/8"]), { accept: "application/json" });
  assert.deepEqual(filterClientHeaders(headers, "::1", ["127.0.0.1/32"]), { accept: "application/json" });
});

test.concurrent("raw admission rejects invalid UTF-8 and rejects client aborts after readable bytes", async () => {
  const invalidUtf8 = await admit({ "content-type": "application/json" }, Buffer.from([0xc3, 0x28]), 32);
  assert.equal(invalidUtf8.ok, false);

  const request = new PassThrough() as PassThrough & { headers: Record<string, string> };
  request.headers = { "content-type": "application/json" };
  const admission = admitJsonObject(request as never, 32);
  request.write('{"value":');
  request.destroy();
  const result = await admission;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.category, "invalid_request");
});
test.concurrent("raw admission converts stream errors to deterministic invalid requests", async () => {
  const request = new PassThrough() as PassThrough & { headers: Record<string, string> };
  request.headers = { "content-type": "application/json" };
  const result = admitJsonObject(request as never, 32);
  request.destroy(new Error("client disconnected"));
  const admission = await result;
  assert.equal(admission.ok, false);
  if (!admission.ok) assert.equal(admission.failure.category, "invalid_request");
});

async function admit(headers: Record<string, string>, body: Buffer, limit: number) {
  const request = new PassThrough() as PassThrough & { headers: Record<string, string> };
  request.headers = headers;
  request.end(body);
  return admitJsonObject(request as never, limit);
}
