import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import { createSseDecoder, createSseEncoder, type SseFrame } from "../../src/translation/sse.ts";

const encoder = new TextEncoder();

test.concurrent("sse encoder: canonical wire format serializes all fields", () => {
  const encoderInstance = createSseEncoder();
  const frame: SseFrame = {
    event: "response.output_text.delta",
    id: "evt_123",
    retryMs: 5000,
    data: '{"type":"delta","text":"hello"}\n{"extra":true}',
  };

  const bytes = encoderInstance.encode(frame);
  const text = new TextDecoder().decode(bytes);

  assert.equal(
    text,
    "event: response.output_text.delta\n" +
      "id: evt_123\n" +
      "retry: 5000\n" +
      'data: {"type":"delta","text":"hello"}\n' +
      'data: {"extra":true}\n\n',
  );
});

test.concurrent("sse decoder: basic decoding with LF and CRLF", () => {
  const decoder = createSseDecoder();
  const rawLf = "event: custom\ndata: first line\ndata: second line\nid: 1\nretry: 3000\n\n";
  const resultsLf = decoder.push(encoder.encode(rawLf));
  assert.equal(resultsLf.length, 1);
  assert.equal(resultsLf[0]?.kind, "frame");
  if (resultsLf[0]?.kind === "frame") {
    assert.deepEqual(resultsLf[0].frame, {
      event: "custom",
      data: "first line\nsecond line",
      id: "1",
      retryMs: 3000,
    });
  }

  const rawCrlf = "event: crlf_evt\r\ndata: line one\r\n\r\n";
  const resultsCrlf = decoder.push(encoder.encode(rawCrlf));
  assert.equal(resultsCrlf.length, 1);
  assert.equal(resultsCrlf[0]?.kind, "frame");
  if (resultsCrlf[0]?.kind === "frame") {
    assert.deepEqual(resultsCrlf[0].frame, {
      event: "crlf_evt",
      data: "line one",
    });
  }

  const finish = decoder.finish();
  assert.deepEqual(finish, []);
});

test.concurrent("sse decoder: strips leading UTF-8 BOM", () => {
  const decoder = createSseDecoder();
  const raw = "\uFEFFdata: hello\n\n";
  const results = decoder.push(encoder.encode(raw));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.kind, "frame");
  if (results[0]?.kind === "frame") {
    assert.equal(results[0].frame.data, "hello");
  }
});

test.concurrent("sse decoder: parses comments preserving order", () => {
  const decoder = createSseDecoder();
  const raw = ": comment 1\nevent: test\n: comment 2\ndata: payload\n\n: comment 3\n";
  const results = decoder.push(encoder.encode(raw));

  assert.equal(results.length, 4);
  assert.equal(results[0]?.kind, "comment");
  if (results[0]?.kind === "comment") {
    assert.equal(results[0].text, "comment 1");
  }
  assert.equal(results[1]?.kind, "comment");
  if (results[1]?.kind === "comment") {
    assert.equal(results[1].text, "comment 2");
  }
  assert.equal(results[2]?.kind, "frame");
  if (results[2]?.kind === "frame") {
    assert.deepEqual(results[2].frame, {
      event: "test",
      data: "payload",
    });
  }
  assert.equal(results[3]?.kind, "comment");
  if (results[3]?.kind === "comment") {
    assert.equal(results[3].text, "comment 3");
  }
});

test.concurrent("sse decoder: arbitrary byte chunk segmentation (property test)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          event: fc.option(fc.stringMatching(/^[a-zA-Z0-9_.-]+$/), { nil: undefined }),
          data: fc.string({ minLength: 1 }),
          id: fc.option(fc.stringMatching(/^[a-zA-Z0-9_.-]+$/), { nil: undefined }),
          retryMs: fc.option(fc.nat({ max: 60000 }), { nil: undefined }),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 100 }),
      (frames, chunkSizes) => {
        const sseEncoder = createSseEncoder();
        const fullBytesList: Uint8Array[] = [];
        for (const frame of frames) {
          fullBytesList.push(sseEncoder.encode(frame));
        }

        const totalLength = fullBytesList.reduce((sum, b) => sum + b.length, 0);
        const concatenated = new Uint8Array(totalLength);
        let offset = 0;
        for (const b of fullBytesList) {
          concatenated.set(b, offset);
          offset += b.length;
        }

        // Split into chunks according to chunkSizes
        const chunks: Uint8Array[] = [];
        let cursor = 0;
        let sizeIdx = 0;
        while (cursor < concatenated.length) {
          const sz = chunkSizes[sizeIdx % chunkSizes.length]!;
          sizeIdx++;
          const slice = concatenated.subarray(cursor, Math.min(concatenated.length, cursor + sz));
          chunks.push(slice);
          cursor += slice.length;
        }

        // Feed to decoder
        const decoder = createSseDecoder();
        const decodedFrames: SseFrame[] = [];
        for (const chunk of chunks) {
          const res = decoder.push(chunk);
          for (const r of res) {
            if (r.kind === "frame") {
              decodedFrames.push(r.frame);
            } else if (r.kind === "failure") {
              assert.fail(`Decoder failed unexpectedly: ${r.failure.message}`);
            }
          }
        }
        const finishRes = decoder.finish();
        for (const r of finishRes) {
          if (r.kind === "frame") {
            decodedFrames.push(r.frame);
          } else if (r.kind === "failure") {
            assert.fail(`Finish failed unexpectedly: ${r.failure.message}`);
          }
        }

        assert.equal(decodedFrames.length, frames.length);
        for (let i = 0; i < frames.length; i++) {
          const expected = frames[i]!;
          const actual = decodedFrames[i]!;
          assert.equal(actual.event, expected.event);
          assert.equal(actual.id, expected.id);
          assert.equal(actual.retryMs, expected.retryMs);
          assert.equal(actual.data, expected.data);
        }
      },
    ),
    { numRuns: 50 },
  );
});

test.concurrent("sse decoder: rejects duplicate singleton fields", () => {
  const dec1 = createSseDecoder();
  const res1 = dec1.push(encoder.encode("event: first\nevent: second\ndata: hi\n\n"));
  assert.equal(res1.length, 1);
  assert.equal(res1[0]?.kind, "failure");

  const dec2 = createSseDecoder();
  const res2 = dec2.push(encoder.encode("id: 1\nid: 2\ndata: hi\n\n"));
  assert.equal(res2.length, 1);
  assert.equal(res2[0]?.kind, "failure");

  const dec3 = createSseDecoder();
  const res3 = dec3.push(encoder.encode("retry: 100\nretry: 200\ndata: hi\n\n"));
  assert.equal(res3.length, 1);
  assert.equal(res3[0]?.kind, "failure");
});

test.concurrent("sse decoder: rejects unknown fields", () => {
  const decoder = createSseDecoder();
  const res = decoder.push(encoder.encode("foo: bar\ndata: hi\n\n"));
  assert.equal(res.length, 1);
  assert.equal(res[0]?.kind, "failure");
});

test.concurrent("sse decoder: rejects NUL in id", () => {
  const decoder = createSseDecoder();
  const res = decoder.push(encoder.encode("id: a\0b\ndata: hi\n\n"));
  assert.equal(res.length, 1);
  assert.equal(res[0]?.kind, "failure");
});

test.concurrent("sse decoder: rejects invalid retry values", () => {
  const decoder = createSseDecoder();
  const res = decoder.push(encoder.encode("retry: invalid\ndata: hi\n\n"));
  assert.equal(res.length, 1);
  assert.equal(res[0]?.kind, "failure");
});

test.concurrent("sse decoder: enforces maxEventBytes bound", () => {
  const decoder = createSseDecoder({ maxEventBytes: 20 });
  const chunk1 = encoder.encode("data: 1234567890\n");
  const res1 = decoder.push(chunk1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0]?.kind, "need_more");

  const chunk2 = encoder.encode("data: 1234567890extra\n\n");
  const res2 = decoder.push(chunk2);
  assert.equal(res2.length, 1);
  assert.equal(res2[0]?.kind, "failure");
});

test.concurrent("sse decoder: fails on incomplete line or unclosed event at EOF", () => {
  const dec1 = createSseDecoder();
  dec1.push(encoder.encode("data: unfinished line"));
  const finish1 = dec1.finish();
  assert.equal(finish1.length, 1);
  assert.equal(finish1[0]?.kind, "failure");
  if (finish1[0]?.kind === "failure") {
    assert.equal(finish1[0].failure.category, "stream_interrupted");
  }

  const dec2 = createSseDecoder();
  dec2.push(encoder.encode("data: completed line\n"));
  const finish2 = dec2.finish();
  assert.equal(finish2.length, 1);
  assert.equal(finish2[0]?.kind, "failure");
  if (finish2[0]?.kind === "failure") {
    assert.equal(finish2[0].failure.category, "stream_interrupted");
  }
});
