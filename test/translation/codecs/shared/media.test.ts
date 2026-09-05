import assert from "node:assert/strict";
import { test } from "vitest";
import {
  inferExtensionMediaType,
  isBase64Valid,
  M_IMAGE_MEDIA_TYPES,
  parseDataUri,
  validateHttpsUrl,
} from "../../../../src/translation/codecs/shared/media.ts";

test("image media-type allowlist excludes SVG", () => {
  assert.equal(M_IMAGE_MEDIA_TYPES.has("image/svg+xml"), false);
});


test("validateHttpsUrl", () => {
  assert.equal(validateHttpsUrl("https://example.com/photo.jpg"), true);
  assert.equal(validateHttpsUrl("https://api.test.org/v1/image?w=100"), true);
  assert.equal(validateHttpsUrl("http://example.com/photo.jpg"), false);
  assert.equal(validateHttpsUrl("ftp://example.com/photo.jpg"), false);
  assert.equal(validateHttpsUrl("https://"), false);
  assert.equal(validateHttpsUrl("not-a-url"), false);
  assert.equal(validateHttpsUrl(null), false);
  assert.equal(validateHttpsUrl(123), false);
});

test("parseDataUri", () => {
  const parsed = parseDataUri("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
  assert.deepEqual(parsed, {
    mediaType: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUg==",
  });

  const parsedWithSpaces = parseDataUri("data:image/jpeg;base64, aGVsbG8= ");
  assert.deepEqual(parsedWithSpaces, {
    mediaType: "image/jpeg",
    base64: "aGVsbG8=",
  });

  assert.equal(parseDataUri("https://example.com"), undefined);
  assert.equal(parseDataUri("data:image/png;notbase64,123"), undefined);
  assert.equal(parseDataUri("data:;base64,123"), undefined);
  assert.equal(parseDataUri(null), undefined);
});

test("isBase64Valid", () => {
  // "hello" -> "aGVsbG8=" (5 bytes, 1 pad)
  assert.equal(isBase64Valid("aGVsbG8="), true);

  // "any carnal pleasure." -> "YW55IGNhcm5hbCBwbGVhc3VyZS4=" (20 bytes, 1 pad)
  assert.equal(isBase64Valid("YW55IGNhcm5hbCBwbGVhc3VyZS4="), true);

  // 2 padding characters: "aA==" (1 byte)
  assert.equal(isBase64Valid("aA=="), true);

  // Whitespace toleration
  assert.equal(isBase64Valid("aG Vsb G8=\n"), true);

  // Invalid base64
  assert.equal(isBase64Valid("not base64!@#"), false);
  assert.equal(isBase64Valid("abc"), false); // not multiple of 4
  assert.equal(isBase64Valid(null), false);
});

test("inferExtensionMediaType", () => {
  assert.deepEqual(inferExtensionMediaType("doc.pdf"), {
    mediaType: "application/pdf",
    kind: "bytes",
  });
  assert.deepEqual(inferExtensionMediaType("file.PDF"), {
    mediaType: "application/pdf",
    kind: "bytes",
  });
  assert.deepEqual(inferExtensionMediaType("notes.txt"), {
    mediaType: "text/plain",
    kind: "text",
  });
  assert.deepEqual(inferExtensionMediaType("DATA.TXT"), {
    mediaType: "text/plain",
    kind: "text",
  });
  assert.equal(inferExtensionMediaType("image.png"), undefined);
  assert.equal(inferExtensionMediaType("archive.zip"), undefined);
  assert.equal(inferExtensionMediaType("no_ext"), undefined);
  assert.equal(inferExtensionMediaType(undefined), undefined);
});
