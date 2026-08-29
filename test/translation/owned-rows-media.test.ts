/**
 * Owned media and citations capability rows (Task 16):
 * - image-url
 * - image-inline-bytes
 * - image-detail-auto-low-high
 * - image-detail-original
 * - provider-image-id
 * - document-url
 * - document-inline-bytes
 * - document-inline-text
 * - gateway-file-reference
 * - provider-file-id
 * - document-context-title
 * - url-citation-source
 * - file-document-citation-source
 * - citation-output-span
 * - citation-document-location
 * - citation-stream-timing
 * - citation-stream-event
 * - audio-input
 * - audio-output
 * - audio-streaming
 * - audio-continuation-id
 * - tool-result-multipart
 * - request-body-size-limit
 *
 * Covers six-direction matrix coverage, binary preservation, sidecar isolation,
 * locator reconstruction safety, streaming events, and size limits.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatClientStreamEncoder } from "../../src/translation/codecs/chat/stream.ts";
import {
  MessagesClientStreamEncoder,
  MessagesProviderStreamDecoder,
} from "../../src/translation/codecs/messages/stream.ts";
import {
  ResponsesClientStreamEncoder,
  ResponsesProviderStreamDecoder,
} from "../../src/translation/codecs/responses/stream.ts";
import type { Direction } from "../../src/translation/contracts.ts";
import { createDefaultTranslationCoordinator } from "../../src/translation/index.ts";
import type { IrRequest, JsonObject, JsonValue } from "../../src/translation/ir.ts";
import { preflightRequest } from "../../src/translation/preflight.ts";
import { validateIrRequest } from "../../src/translation/validate.ts";
import { ALL_DIRECTIONS, translateRequest } from "./owned-rows-helpers.ts";

function coordinator() {
  return createDefaultTranslationCoordinator();
}

const SAMPLE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SAMPLE_PDF_B64 = "JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iag==";
// Request-side locator citation: legitimately lacks file_id (response-only field).
const CHAR_CITATION = { type: "char_location", cited_text: "x", document_index: 0 };

// =====================================================================
// 1. Image Rows
// =====================================================================

test.concurrent("row image-url: 6-direction matrix coverage and https validation", () => {
  const coord = coordinator();
  const validUrl = "https://example.com/photo.png";

  // C source
  const cBody = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: validUrl } },
        ],
      },
    ],
  };

  // C->R (T1)
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cBody as never);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; image_url?: string }> }>;
    const imgPart = input[0]?.content.find((p) => p.type === "input_image");
    assert.equal(imgPart?.image_url, validUrl);
  }

  // C->M (T1)
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cBody as never);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const messages = cToM.value.body.messages as Array<{
      content: Array<{ type: string; source?: { type: string; url?: string } }>;
    }>;
    const imgBlock = messages[0]?.content.find((b) => b.type === "image");
    assert.equal(imgBlock?.source?.type, "url");
    assert.equal(imgBlock?.source?.url, validUrl);
  }

  // R source
  const rBody = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look" },
          { type: "input_image", image_url: validUrl },
        ],
      },
    ],
  };

  // R->C (T1)
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rBody as never);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const msgs = rToC.value.body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    const imgPart = msgs[0]?.content.find((p) => p.type === "image_url");
    assert.equal(imgPart?.image_url?.url, validUrl);
  }

  // R->M (T1)
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", rBody as never);
  assert.equal(rToM.ok, true);

  // M source
  const mBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image", source: { type: "url", url: validUrl } },
        ],
      },
    ],
  };

  // M->C (T1)
  const mToC = translateRequest(coord, "anthropic-messages", "openai-chat", mBody as never);
  assert.equal(mToC.ok, true);

  // M->R (T1)
  const mToR = translateRequest(coord, "anthropic-messages", "openai-responses", mBody as never);
  assert.equal(mToR.ok, true);

  // Ingress HTTPS validation: HTTP URL fails closed with invalid_request
  const invalidHttp = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://insecure.org/pic.jpg" } }] }],
  };
  const badRes = translateRequest(coord, "openai-chat", "openai-responses", invalidHttp);
  assert.equal(badRes.ok, false);
  if (!badRes.ok) {
    assert.equal(badRes.error.category, "invalid_request");
  }
});

test.concurrent("row image-inline-bytes: data URI conversion and M media_type subset", () => {
  const coord = coordinator();
  const dataUri = `data:image/png;base64,${SAMPLE_PNG_B64}`;

  // C data URI -> R (preserves data URI)
  const cBody = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }] }],
  };
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; image_url?: string }> }>;
    assert.equal(input[0]?.content[0]?.image_url, dataUri);
  }

  // C data URI -> M (converts to base64 block)
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const messages = cToM.value.body.messages as Array<{
      content: Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }>;
    }>;
    assert.equal(messages[0]?.content[0]?.source?.type, "base64");
    assert.equal(messages[0]?.content[0]?.source?.media_type, "image/png");
    assert.equal(messages[0]?.content[0]?.source?.data, SAMPLE_PNG_B64);
  }

  // Unsupported image type targeting M (e.g. image/bmp) fails preflight with image-inline-bytes
  const bmpUri = `data:image/bmp;base64,${SAMPLE_PNG_B64}`;
  const bmpBody = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: bmpUri } }] }],
  };
  const bmpToM = translateRequest(coord, "openai-chat", "anthropic-messages", bmpBody);
  assert.equal(bmpToM.ok, false);
  if (!bmpToM.ok) {
    assert.equal(bmpToM.error.capability, "image-inline-bytes");
  }

  // BMP C↔R passes through (T1)
  const bmpToR = translateRequest(coord, "openai-chat", "openai-responses", bmpBody);
  assert.equal(bmpToR.ok, true);
});

test.concurrent("closed-world media decode: M image media types and Chat image_url shape", () => {
  const coord = coordinator();

  // M pins its inline image media types to jpeg/png/gif/webp at decode; an
  // out-of-schema type (e.g. SVG) rejects with invalid_request in every
  // direction instead of passing through the closed-world ingress.
  const mSvgBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: SAMPLE_PNG_B64 } }],
      },
    ],
  };
  for (const target of ["openai-chat", "openai-responses"] as const) {
    const res = translateRequest(coord, "anthropic-messages", target, mSvgBody as never);
    assert.equal(res.ok, false, `svg -> ${target}`);
    if (!res.ok) {
      assert.equal(res.error.category, "invalid_request", `svg -> ${target}`);
    }
  }

  // Chat pins image_url to the {url, detail?} object form; the bare-string
  // spelling belongs to Responses and rejects at Chat ingress.
  const cStringImageUrl = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://example.com/photo.png" }] }],
  };
  const stringToR = translateRequest(coord, "openai-chat", "openai-responses", cStringImageUrl);
  assert.equal(stringToR.ok, false);
  if (!stringToR.ok) {
    assert.equal(stringToR.error.category, "invalid_request");
  }
});

test.concurrent("row image-detail-auto-low-high: detail preserved C↔R, rejected into M", () => {
  const coord = coordinator();
  const cBody = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/pic.jpg", detail: "low" } }],
      },
    ],
  };

  // C->R (T1)
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; detail?: string }> }>;
    assert.equal(input[0]?.content[0]?.detail, "low");
  }

  // C->M (T3): rejected with image-detail-auto-low-high
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "image-detail-auto-low-high");
  }
});

test.concurrent("row image-detail-original: detail 'original' rejected at decode in all directions", () => {
  const coord = coordinator();
  const rBody = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://example.com/pic.jpg", detail: "original" }],
      },
    ],
  };

  for (const [, dst] of ALL_DIRECTIONS) {
    const res = translateRequest(coord, "openai-responses", dst, rBody);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.capability, "image-detail-original");
    }
  }
});

test.concurrent("row provider-image-id: image file_id passes C↔R via sidecar, rejects into M", () => {
  const coord = coordinator();
  const rBody = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", file_id: "img_abc123", detail: "high" }],
      },
    ],
  };

  // R->C: admitted, emits file part with file_id
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rBody);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const msgs = rToC.value.body.messages as Array<{ content: Array<{ type: string; file?: { file_id: string } }> }>;
    assert.equal(msgs[0]?.content[0]?.type, "file");
    assert.equal(msgs[0]?.content[0]?.file?.file_id, "img_abc123");
  }

  // R->M: rejected with provider-image-id
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", rBody);
  assert.equal(rToM.ok, false);
  if (!rToM.ok) {
    assert.equal(rToM.error.capability, "provider-image-id");
  }
});

// =====================================================================
// 2. Document Rows
// =====================================================================

test.concurrent("row document-url: document by URL admitted R↔M, rejected into C", () => {
  const coord = coordinator();
  const rDocUrl = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file_url: "https://example.com/spec.pdf", filename: "spec.pdf" }],
      },
    ],
  };

  // R->M (T1): admitted
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", rDocUrl);
  assert.equal(rToM.ok, true);
  if (rToM.ok) {
    const messages = rToM.value.body.messages as Array<{
      content: Array<{ type: string; source?: { type: string; url?: string }; title?: string }>;
    }>;
    assert.equal(messages[0]?.content[0]?.type, "document");
    assert.equal(messages[0]?.content[0]?.source?.type, "url");
    assert.equal(messages[0]?.content[0]?.source?.url, "https://example.com/spec.pdf");
    assert.equal(messages[0]?.content[0]?.title, "spec.pdf");
  }

  // R->C (T3): rejected with document-url
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rDocUrl);
  assert.equal(rToC.ok, false);
  if (!rToC.ok) {
    assert.equal(rToC.error.capability, "document-url");
  }
});

test.concurrent("row document-inline-bytes: PDF bytes admitted C↔R↔M, non-PDF rejected into M", () => {
  const coord = coordinator();

  // C source with .pdf
  const cPdf = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { file_data: SAMPLE_PDF_B64, filename: "contract.pdf" } }],
      },
    ],
  };

  // C->R (T1): emits input_file with file_data and filename
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cPdf);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; file_data?: string; filename?: string }> }>;
    assert.equal(input[0]?.content[0]?.type, "input_file");
    assert.equal(input[0]?.content[0]?.file_data, SAMPLE_PDF_B64);
    assert.equal(input[0]?.content[0]?.filename, "contract.pdf");
  }

  // C->M (T2): emits document block with application/pdf
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cPdf);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const messages = cToM.value.body.messages as Array<{
      content: Array<{ type: string; source?: { type: string; media_type?: string; data?: string }; title?: string }>;
    }>;
    assert.equal(messages[0]?.content[0]?.type, "document");
    assert.equal(messages[0]?.content[0]?.source?.media_type, "application/pdf");
    assert.equal(messages[0]?.content[0]?.source?.data, SAMPLE_PDF_B64);
    assert.equal(messages[0]?.content[0]?.title, "contract.pdf");
  }

  // Non-PDF filename extension (e.g. .zip or .docx) fails decode with document-inline-bytes
  // when targeting Messages, but succeeds when targeting Responses (T1 C<->R).
  const cArchive = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { file_data: SAMPLE_PDF_B64, filename: "data.csv" } }],
      },
    ],
  };
  const toRRes = translateRequest(coord, "openai-chat", "openai-responses", cArchive);
  assert.equal(toRRes.ok, true, "C<->R admits non-PDF document bytes as T1");
  if (toRRes.ok) {
    const body = toRRes.value.body as { input: Array<{ content: Array<{ type: string; filename?: string }> }> };
    assert.equal(body.input[0]?.content[0]?.type, "input_file");
    assert.equal(body.input[0]?.content[0]?.filename, "data.csv");
  }

  const toMRes = translateRequest(coord, "openai-chat", "anthropic-messages", cArchive);
  assert.equal(toMRes.ok, false, "Targeting Messages requires application/pdf");
  if (!toMRes.ok) {
    assert.equal(toMRes.error.capability, "document-inline-bytes");
  }

  // Bytes documents preserve file_data verbatim, so invalid base64 rejects in
  // every direction via IR validation instead of dispatching a broken payload.
  const cInvalidB64 = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { file_data: "not base64!!", filename: "contract.pdf" } }],
      },
    ],
  };
  for (const [src, dst] of ALL_DIRECTIONS) {
    if (src !== "openai-chat") continue;
    const res = translateRequest(coord, src, dst, cInvalidB64);
    assert.equal(res.ok, false, `${src}->${dst}`);
    if (!res.ok) {
      assert.equal(res.error.category, "invalid_request", `${src}->${dst}`);
    }
  }
});

test.concurrent("row document-inline-text: text documents admitted R↔M, rejected into C", () => {
  const coord = coordinator();
  const textContent = "Title: Report\nData: 123";
  const b64Text = Buffer.from(textContent, "utf8").toString("base64");

  // R source with .txt
  const rTxt = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file_data: b64Text, filename: "report.txt" }],
      },
    ],
  };

  // R->M (T2): emits text document block
  const rToM = translateRequest(coord, "openai-responses", "anthropic-messages", rTxt);
  assert.equal(rToM.ok, true);
  if (rToM.ok) {
    const messages = rToM.value.body.messages as Array<{
      content: Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }>;
    }>;
    assert.equal(messages[0]?.content[0]?.type, "document");
    assert.equal(messages[0]?.content[0]?.source?.type, "text");
    assert.equal(messages[0]?.content[0]?.source?.data, textContent);
  }

  // R->C (T3): rejected with document-inline-text
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rTxt);
  assert.equal(rToC.ok, false);
  if (!rToC.ok) {
    assert.equal(rToC.error.capability, "document-inline-text");
  }

  // R text decode fails closed: invalid base64 rejects with invalid_request
  // instead of silently decoding to replacement-garbled text.
  const rInvalidB64 = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file_data: "not base64!!", filename: "report.txt" }],
      },
    ],
  };
  const rInvalidB64ToM = translateRequest(coord, "openai-responses", "anthropic-messages", rInvalidB64);
  assert.equal(rInvalidB64ToM.ok, false);
  if (!rInvalidB64ToM.ok) {
    assert.equal(rInvalidB64ToM.error.category, "invalid_request");
  }

  // R text decode fails closed: non-UTF-8 bytes cannot become a UTF-8 text
  // document source, so they reject instead of being replacement-charged.
  const rNonUtf8 = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_file", file_data: Buffer.from([0xff, 0xfe]).toString("base64"), filename: "report.txt" },
        ],
      },
    ],
  };
  const rNonUtf8ToM = translateRequest(coord, "openai-responses", "anthropic-messages", rNonUtf8);
  assert.equal(rNonUtf8ToM.ok, false);
  if (!rNonUtf8ToM.ok) {
    assert.equal(rNonUtf8ToM.error.category, "invalid_request");
  }

  // C file parts are bytes parts: a C .txt file_data crosses to R with the
  // payload byte-verbatim (non-canonical base64 and whitespace included), and
  // into M it rejects as non-PDF inline bytes (document-inline-bytes).
  const cTxt = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { file_data: "aG Vsb G8=\n", filename: "notes.txt" } }],
      },
    ],
  };
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cTxt);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; file_data?: string }> }>;
    assert.equal(input[0]?.content[0]?.type, "input_file");
    assert.equal(input[0]?.content[0]?.file_data, "aG Vsb G8=\n");
  }
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cTxt);
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "document-inline-bytes");
  }
});

test.concurrent("row gateway-file-reference: fails closed across all directions", () => {
  const ir: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "document",
            documentId: "d1",
            source: { type: "gateway_file", fileId: "gw_123" },
          },
        ],
      },
    ],
  };

  for (const [src, dst] of ALL_DIRECTIONS) {
    const res = preflightRequest(ir, `${src}->${dst}` as Direction);
    assert.equal(res.ok, false, `${src}->${dst}`);
    if (!res.ok) {
      assert.equal(res.error.capability, "gateway-file-reference");
    }
  }
});

test.concurrent("row provider-file-id: file_id passes C↔R via sidecar, rejects into M", () => {
  const coord = coordinator();
  const cBody = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file_999", filename: "doc.pdf" } }] }],
  };

  // C->R (T1): passes through
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cBody);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; file_id?: string; filename?: string }> }>;
    assert.equal(input[0]?.content[0]?.type, "input_file");
    assert.equal(input[0]?.content[0]?.file_id, "file_999");
    assert.equal(input[0]?.content[0]?.filename, "doc.pdf");
  }

  // C->M (T3): rejects with provider-file-id
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cBody);
  assert.equal(cToM.ok, false);
  if (!cToM.ok) {
    assert.equal(cToM.error.capability, "provider-file-id");
  }
});

test.concurrent("row document-context-title: title preserved, M context rejected", () => {
  const coord = coordinator();

  // M document with context rejects with document-context-title
  const mWithContext = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            context: "Financial results 2025",
            source: { type: "text", media_type: "text/plain", data: "Revenue: 100" },
          },
        ],
      },
    ],
  };

  const res = translateRequest(coord, "anthropic-messages", "openai-responses", mWithContext);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "document-context-title");
  }
});

// =====================================================================
// 3. Citations and Audio Rows
// =====================================================================

test.concurrent("rows url-citation-source and citation-output-span: outcome citations fail closed safely", () => {
  const coord = coordinator();

  // Responses outcome with url_citation annotation
  const rOutcome = {
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "According to Wikipedia...",
            annotations: [
              {
                type: "url_citation",
                url: "https://en.wikipedia.org/wiki/Earth",
                title: "Earth",
                start_index: 0,
                end_index: 24,
              },
            ],
          },
        ],
      },
    ],
  };

  // R outcome translated for Chat client: rejects with url-citation-source
  const resToChat = coord.translateCompleteOutcome({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    status: 200,
    headers: {},
    body: rOutcome,
    logicalModel: "logical-key",
  });
  assert.equal(resToChat.ok, false);
  if (!resToChat.ok) {
    assert.equal(resToChat.error.capability, "url-citation-source");
  }

  // Outcome with citation targeting Responses client: rejects with citation-output-span
  const mOutcome = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Fact checked",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Source",
            cited_text: "Fact checked",
          },
        ],
      },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };

  const resToResponses = coord.translateCompleteOutcome({
    sourceProtocol: "openai-responses",
    targetProtocol: "anthropic-messages",
    status: 200,
    headers: {},
    body: mOutcome,
    logicalModel: "logical-key",
  });
  assert.equal(resToResponses.ok, false);
  if (!resToResponses.ok) {
    assert.equal(resToResponses.error.capability, "citation-output-span");
  }
});

test.concurrent("row citation-stream-event: Chat stream encoder rejects citation events", () => {
  const encoder = new ChatClientStreamEncoder(
    { responseId: "r1", model: "m1", createPartId: () => "p1" },
    {},
  );
  const res = encoder.encode({
    type: "citation",
    responseId: "r1",
    partId: "p1",
    citation: { source: { type: "url", url: "https://example.com" } },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.capability, "citation-stream-event");
  }
});

test.concurrent("audio rows: exact capability attribution on ingress", () => {
  const coord = coordinator();

  // audio-input on user input_audio part
  const cAudioInput = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "abc", format: "wav" } }] }],
  };
  const resInput = translateRequest(coord, "openai-chat", "openai-responses", cAudioInput);
  assert.equal(resInput.ok, false);
  if (!resInput.ok) {
    assert.equal(resInput.error.capability, "audio-input");
  }

  // audio-output on non-stream audio request param
  const cAudioOutput = {
    model: "wire-model",
    messages: [{ role: "user", content: "hi" }],
    audio: { voice: "alloy", format: "wav" },
  };
  const resOutput = translateRequest(coord, "openai-chat", "openai-responses", cAudioOutput);
  assert.equal(resOutput.ok, false);
  if (!resOutput.ok) {
    assert.equal(resOutput.error.capability, "audio-output");
  }

  // audio-streaming on streaming audio request param
  const cAudioStream = {
    model: "wire-model",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    audio: { voice: "alloy", format: "wav" },
  };
  const resStream = coord.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    sourceBody: cAudioStream,
    logicalModel: "logical-key",
    targetModel: "upstream-target",
  });
  assert.equal(resStream.ok, false);
  if (!resStream.ok) {
    assert.equal(resStream.error.capability, "audio-streaming");
  }

  // audio-continuation-id on assistant message audio
  const cAudioCont = {
    model: "wire-model",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", audio: { id: "audio_123" } },
    ],
  };
  const resCont = translateRequest(coord, "openai-chat", "openai-responses", cAudioCont as never);
  assert.equal(resCont.ok, false);
  if (!resCont.ok) {
    assert.equal(resCont.error.capability, "audio-continuation-id");
  }

  // Responses ingress audio attribution parity:
  // 1. input_audio item in Responses input
  const rAudioInput = {
    model: "wire-model",
    input: [{ type: "input_audio", audio: "data" }],
  };
  const rResInput = translateRequest(coord, "openai-responses", "openai-chat", rAudioInput as never);
  assert.equal(rResInput.ok, false);
  if (!rResInput.ok) {
    assert.equal(rResInput.error.capability, "audio-input");
  }

  // 2. input_audio content part in user message
  const rAudioPart = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_audio", audio: "data" }],
      },
    ],
  };
  const rResPart = translateRequest(coord, "openai-responses", "openai-chat", rAudioPart as never);
  assert.equal(rResPart.ok, false);
  if (!rResPart.ok) {
    assert.equal(rResPart.error.capability, "audio-input");
  }

  // 3. audio parameter on non-streaming Responses request -> audio-output
  const rAudioOutput = {
    model: "wire-model",
    input: "hi",
    modalities: ["text", "audio"],
  };
  const rResOutput = translateRequest(coord, "openai-responses", "openai-chat", rAudioOutput as never);
  assert.equal(rResOutput.ok, false);
  if (!rResOutput.ok) {
    assert.equal(rResOutput.error.capability, "audio-output");
  }

  // 4. audio parameter on streaming Responses request -> audio-streaming
  const rAudioStream = {
    model: "wire-model",
    stream: true,
    input: "hi",
    audio: { format: "wav" },
  };
  const rResStream = translateRequest(coord, "openai-responses", "openai-chat", rAudioStream as never);
  assert.equal(rResStream.ok, false);
  if (!rResStream.ok) {
    assert.equal(rResStream.error.capability, "audio-streaming");
  }
});

test.concurrent("providerFileRef splicing: preserves exact wire slot order of interleaved text, files, and images", () => {
  const coord = coordinator();
  // Wire parts: 0: text, 1: file_id, 2: image_url, 3: file_id, 4: text
  const cInterleaved = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Start" },
          { type: "file", file: { file_id: "fid_first", filename: "first.pdf" } },
          { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
          { type: "file", file: { file_id: "fid_second", filename: "second.pdf" } },
          { type: "text", text: "End" },
        ],
      },
    ],
  };

  // C->R: should reconstruct exact 5 parts in original order
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cInterleaved as never);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{
      content: Array<{ type: string; text?: string; file_id?: string; image_url?: string }>;
    }>;
    const content = input[0]?.content;
    assert.equal(content?.length, 5);
    assert.equal(content?.[0]?.type, "input_text");
    assert.equal(content?.[0]?.text, "Start");
    assert.equal(content?.[1]?.type, "input_file");
    assert.equal(content?.[1]?.file_id, "fid_first");
    assert.equal(content?.[2]?.type, "input_image");
    assert.equal(content?.[2]?.image_url, "https://example.com/pic.png");
    assert.equal(content?.[3]?.type, "input_file");
    assert.equal(content?.[3]?.file_id, "fid_second");
    assert.equal(content?.[4]?.type, "input_text");
    assert.equal(content?.[4]?.text, "End");
  }

  // R source with 5 interleaved parts -> C
  const rInterleaved = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Alpha" },
          { type: "input_file", file_id: "r_fid_1" },
          { type: "input_image", image_url: "https://example.com/icon.png" },
          { type: "input_file", file_id: "r_fid_2" },
          { type: "input_text", text: "Omega" },
        ],
      },
    ],
  };
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rInterleaved as never);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const msgs = rToC.value.body.messages as Array<{
      content: Array<{ type: string; text?: string; file?: { file_id: string }; image_url?: { url: string } }>;
    }>;
    const parts = msgs[0]?.content;
    assert.equal(parts?.length, 5);
    assert.equal(parts?.[0]?.type, "text");
    assert.equal(parts?.[0]?.text, "Alpha");
    assert.equal(parts?.[1]?.type, "file");
    assert.equal(parts?.[1]?.file?.file_id, "r_fid_1");
    assert.equal(parts?.[2]?.type, "image_url");
    assert.equal(parts?.[2]?.image_url?.url, "https://example.com/icon.png");
    assert.equal(parts?.[3]?.type, "file");
    assert.equal(parts?.[3]?.file?.file_id, "r_fid_2");
    assert.equal(parts?.[4]?.type, "text");
    assert.equal(parts?.[4]?.text, "Omega");
  }
});

test.concurrent("all-ref user message: valid with matching sidecar ref, rejected without ref", () => {
  const coord = coordinator();
  // C user message with only a provider file reference (empty IR content)
  const cAllRef = {
    model: "wire-model",
    messages: [{ role: "user", content: [{ type: "file", file: { file_id: "standalone_ref" } }] }],
  };
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cAllRef as never);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; file_id?: string }> }>;
    assert.equal(input[0]?.content.length, 1);
    assert.equal(input[0]?.content[0]?.type, "input_file");
    assert.equal(input[0]?.content[0]?.file_id, "standalone_ref");
  }

  // Synthetic IR validation: empty user message content with matching ref passes; without ref fails
  const irWithRef: IrRequest = {
    model: "logical-key",
    delivery: "complete",
    items: [{ type: "message", role: "user", content: [] as never }],
  };
  const validRes = validateIrRequest(irWithRef, {
    providerFileRefs: [{ itemIndex: 0, partIndex: 0, mediaKind: "document", fileId: "ref_1" }],
  });
  assert.equal(validRes.ok, true);

  const invalidRes = validateIrRequest(irWithRef, { providerFileRefs: [] });
  assert.equal(invalidRes.ok, false);
  if (!invalidRes.ok) {
    assert.equal(invalidRes.error.category, "invalid_request");
  }
});

test.concurrent("filename identity: filename-less documents emit no filename on any wire", () => {
  const coord = coordinator();
  // M PDF document without title -> C file part without filename
  const mPdfNoTitle = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: SAMPLE_PDF_B64 } }],
      },
    ],
  };
  const mToC = translateRequest(coord, "anthropic-messages", "openai-chat", mPdfNoTitle as never);
  assert.equal(mToC.ok, true);
  if (mToC.ok) {
    const msgs = mToC.value.body.messages as Array<{ content: Array<{ type: string; file?: Record<string, unknown> }> }>;
    const file = msgs[0]?.content[0]?.file;
    assert.ok(file !== undefined);
    assert.equal(msgs[0]?.content[0]?.type, "file");
    assert.equal("filename" in file, false);
  }

  // M text document without title targeting Responses -> R input_file without filename
  const mTxtNoTitle = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "Notes" } }],
      },
    ],
  };
  const mToR = translateRequest(coord, "anthropic-messages", "openai-responses", mTxtNoTitle as never);
  assert.equal(mToR.ok, true);
  if (mToR.ok) {
    const input = mToR.value.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const part = input[0]?.content[0];
    assert.ok(part !== undefined);
    assert.equal(part.type, "input_file");
    assert.equal("filename" in part, false);
  }

  // R filename-less input_file bytes -> C file part without a synthesized name
  // (arbitrary bytes must not be mislabeled as a PDF).
  const rBytesNoFilename = {
    model: "wire-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file_data: SAMPLE_PDF_B64 }],
      },
    ],
  };
  const rToC = translateRequest(coord, "openai-responses", "openai-chat", rBytesNoFilename);
  assert.equal(rToC.ok, true);
  if (rToC.ok) {
    const msgs = rToC.value.body.messages as Array<{ content: Array<{ type: string; file?: Record<string, unknown> }> }>;
    const file = msgs[0]?.content[0]?.file;
    assert.ok(file !== undefined);
    assert.equal(msgs[0]?.content[0]?.type, "file");
    assert.equal("filename" in file, false);
  }
});

test.concurrent("stream citation decoders and encoders: Responses and Messages stream citation flow", () => {
  // 1. ResponsesProviderStreamDecoder receives url_citation annotation event
  const respDecoder = new ResponsesProviderStreamDecoder({
    responseId: "resp_s1",
    model: "logical-key",
    createPartId: () => "part_text_1",
  });
  // Open part with output_text.delta
  const deltaEvents = respDecoder.push({
    event: "response.output_text.delta",
    data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }),
  });
  assert.equal(deltaEvents.ok, true);

  // Feed url citation annotation
  const annotEvents = respDecoder.push({
    event: "response.output_text.annotation.added",
    data: JSON.stringify({
      type: "response.output_text.annotation.added",
      annotation: { type: "url_citation", url: "https://example.org", title: "Example" },
    }),
  });
  assert.equal(annotEvents.ok, true);
  if (annotEvents.ok) {
    assert.equal(annotEvents.value.length, 1);
    const citEvt = annotEvents.value[0];
    assert.equal(citEvt?.type, "citation");
    if (citEvt?.type === "citation") {
      assert.equal(citEvt.citation.source.type, "url");
      assert.equal(citEvt.partId, "part_text_1");
    }
  }

  // 2. ResponsesClientStreamEncoder rejects citation event with citation-output-span
  const respEncoder = new ResponsesClientStreamEncoder(
    { responseId: "resp_s1", model: "logical-key", createPartId: () => "p1" },
  );
  const respEncRes = respEncoder.encode({
    type: "citation",
    responseId: "resp_s1",
    partId: "p1",
    citation: { source: { type: "url", url: "https://example.org" } },
  });
  assert.equal(respEncRes.ok, false);
  if (!respEncRes.ok) {
    assert.equal(respEncRes.error.capability, "citation-output-span");
  }

  // 3. MessagesProviderStreamDecoder receives citations_delta
  const msgDecoder = new MessagesProviderStreamDecoder({
    responseId: "msg_s1",
    model: "logical-key",
    createPartId: () => "part_msg_1",
  });
  msgDecoder.push({
    event: "content_block_start",
    data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  });
  const msgDeltaRes = msgDecoder.push({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "citations_delta",
        citation: { type: "web_search_result_location", url: "https://anthropic.com", title: "Anthropic" },
      },
    }),
  });
  assert.equal(msgDeltaRes.ok, true);
  if (msgDeltaRes.ok) {
    assert.equal(msgDeltaRes.value.length, 1);
    assert.equal(msgDeltaRes.value[0]?.type, "citation");
  }

  // 4. MessagesClientStreamEncoder rejects citation with url-citation-source or citation-document-location
  const msgEncoder = new MessagesClientStreamEncoder(
    { responseId: "msg_s1", model: "logical-key", createPartId: () => "p1" },
  );
  const urlCitRes = msgEncoder.encode({
    type: "citation",
    responseId: "msg_s1",
    partId: "p1",
    citation: { source: { type: "url", url: "https://example.org" } },
  });
  assert.equal(urlCitRes.ok, false);
  if (!urlCitRes.ok) {
    assert.equal(urlCitRes.error.capability, "url-citation-source");
  }

  const fileCitRes = msgEncoder.encode({
    type: "citation",
    responseId: "msg_s1",
    partId: "p1",
    citation: { source: { type: "input_document", documentId: "doc_1" } },
  });
  assert.equal(fileCitRes.ok, false);
  if (!fileCitRes.ok) {
    assert.equal(fileCitRes.error.capability, "citation-document-location");
  }
});

test.concurrent("worked example: citation fail-closed locator reconstruction and outcome preflight", () => {
  const coord = coordinator();
  // Responses outcome with file citation annotation
  const rOutcome = {
    id: "resp_cite",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Quoted from document",
            annotations: [{ type: "file_citation", file_id: "file_cited_1", filename: "report.pdf" }],
          },
        ],
      },
    ],
  };

  // Responses outcome with provider file citation annotation fails closed with
  // file-document-citation-source (provider file IDs are not gateway files and
  // cannot be translated without locator reconstruction)
  const mClientOutcome = coord.translateCompleteOutcome({
    sourceProtocol: "anthropic-messages",
    targetProtocol: "openai-responses",
    status: 200,
    headers: {},
    body: rOutcome,
    logicalModel: "logical-key",
  });
  assert.equal(mClientOutcome.ok, false);
  if (!mClientOutcome.ok) {
    assert.equal(mClientOutcome.error.capability, "file-document-citation-source");
  }
});

test.concurrent("outcome citations never drop: unparseable M citations fail closed", () => {
  const coord = coordinator();
  const mOutcomeWith = (citations: JsonValue): JsonObject => ({
    type: "message",
    id: "msg_cite",
    role: "assistant",
    content: [{ type: "text", text: "Cited claim", citations }],
    stop_reason: "end_turn",
  });

  // In translateCompleteOutcome the target protocol is the provider whose
  // outcome is decoded and the source protocol is the receiving client.
  const translateOutcome = (citations: JsonValue) =>
    coord.translateCompleteOutcome({
      sourceProtocol: "openai-chat",
      targetProtocol: "anthropic-messages",
      status: 200,
      headers: {},
      body: mOutcomeWith(citations),
      logicalModel: "logical-key",
    });

  // Unknown citation type terminates with url-citation-source instead of
  // translating a success that silently omits the citation.
  const unknownType = translateOutcome([{ type: "mystery_location", cited_text: "x" }]);
  assert.equal(unknownType.ok, false);
  if (!unknownType.ok) {
    assert.equal(unknownType.error.category, "unsupported_capability");
    assert.equal(unknownType.error.capability, "url-citation-source");
  }

  // web_search_result_location without a url cannot become a citation source.
  const urlLessSearch = translateOutcome([{ type: "web_search_result_location", cited_text: "x" }]);
  assert.equal(urlLessSearch.ok, false);
  if (!urlLessSearch.ok) {
    assert.equal(urlLessSearch.error.capability, "url-citation-source");
  }

  // A non-object citation entry is structurally malformed (invalid_request).
  const nonObject = translateOutcome(["not-a-citation"]);
  assert.equal(nonObject.ok, false);
  if (!nonObject.ok) {
    assert.equal(nonObject.error.category, "invalid_request");
  }

  // A response-side locator without file_id is out of schema and fails closed
  // with citation-document-location; no document identity is fabricated.
  const locatorNoFileId = translateOutcome([{ type: "char_location", cited_text: "x", document_index: 2 }]);
  assert.equal(locatorNoFileId.ok, false);
  if (!locatorNoFileId.ok) {
    assert.equal(locatorNoFileId.error.capability, "citation-document-location");
  }
});

test.concurrent("outcome citations never drop: unparseable R annotations fail closed, stream parity holds", () => {
  const coord = coordinator();
  const rOutcomeWith = (annotations: JsonValue): JsonObject => ({
    id: "resp_cite",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Cited claim", annotations }],
      },
    ],
  });

  const expectUrlCitationFailure = (annotations: JsonValue, label: string) => {
    const res = coord.translateCompleteOutcome({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "openai-responses",
      status: 200,
      headers: {},
      body: rOutcomeWith(annotations),
      logicalModel: "logical-key",
    });
    assert.equal(res.ok, false, label);
    if (!res.ok) {
      assert.equal(res.error.category, "unsupported_capability", label);
      assert.equal(res.error.capability, "url-citation-source", label);
    }
  };

  // url_citation without a url, file_citation without file_id, and unknown
  // annotation types all fail closed exactly like the stream decoder.
  expectUrlCitationFailure([{ type: "url_citation", title: "Example" }], "url-less url_citation");
  expectUrlCitationFailure([{ type: "file_citation", filename: "report.pdf" }], "file_id-less file_citation");
  expectUrlCitationFailure([{ type: "file_path", path: "mnt/data/x.csv" }], "unknown annotation type");

  // Stream/complete parity: the same unknown annotation terminates the stream
  // with the same capability instead of relying on outcome-only rejection.
  const decoder = new ResponsesProviderStreamDecoder({
    responseId: "resp_parity",
    model: "logical-key",
    createPartId: () => "part_parity",
  });
  decoder.push({
    event: "response.output_text.delta",
    data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }),
  });
  const parityRes = decoder.push({
    event: "response.output_text.annotation.added",
    data: JSON.stringify({
      type: "response.output_text.annotation.added",
      annotation: { type: "file_path", path: "mnt/data/x.csv" },
    }),
  });
  assert.equal(parityRes.ok, false);
  if (!parityRes.ok) {
    assert.equal(parityRes.error.category, "unsupported_capability");
    assert.equal(parityRes.error.capability, "url-citation-source");
  }
});

test.concurrent("request-side Messages text-block citations reject at decode (user, assistant, system)", () => {
  const coord = coordinator();
  const webSearchCitation = { type: "web_search_result_location", cited_text: "x", url: "https://a.example" };
  const charCitation = CHAR_CITATION;

  const expectCitationCapability = (body: object, capability: string, label: string) => {
    for (const target of ["openai-chat", "openai-responses"] as const) {
      const res = translateRequest(coord, "anthropic-messages", target, body as never);
      assert.equal(res.ok, false, `${label} -> ${target}`);
      if (!res.ok) {
        assert.equal(res.error.capability, capability, `${label} -> ${target}`);
      }
    }
  };

  // User text block: variant attribution matches the preflight convention
  // (web_search_result_location -> url-citation-source, locators -> file row).
  expectCitationCapability(
    {
      model: "wire-model",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi", citations: [webSearchCitation] }] }],
    },
    "url-citation-source",
    "user web_search_result_location",
  );
  expectCitationCapability(
    {
      model: "wire-model",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi", citations: [charCitation] }] }],
    },
    "file-document-citation-source",
    "user char_location",
  );

  // Assistant text block.
  expectCitationCapability(
    {
      model: "wire-model",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello", citations: [charCitation] }] },
      ],
    },
    "file-document-citation-source",
    "assistant char_location",
  );

  // System text block: decode-time rejection is the only complete fix because
  // system blocks have no IR parts to anchor citations to.
  expectCitationCapability(
    {
      model: "wire-model",
      max_tokens: 1024,
      system: [{ type: "text", text: "rules", citations: [charCitation] }],
      messages: [{ role: "user", content: "hi" }],
    },
    "file-document-citation-source",
    "system char_location",
  );
  expectCitationCapability(
    {
      model: "wire-model",
      max_tokens: 1024,
      system: [{ type: "text", text: "rules", citations: [webSearchCitation] }],
      messages: [{ role: "user", content: "hi" }],
    },
    "url-citation-source",
    "system web_search_result_location",
  );
});

test.concurrent("stream requests fail closed like complete: citations, .txt documents, and locator deltas", () => {
  const coord = coordinator();

  // Request-side citations reject on the streaming path with the same
  // capability attribution as the complete path (shared ingress decoder).
  for (const target of ["openai-chat", "openai-responses"] as const) {
    const res = coord.translateStreamRequest({
      sourceProtocol: "anthropic-messages",
      targetProtocol: target,
      logicalModel: "logical-key",
      targetModel: "upstream-target",
      targetDefaultMaxTokens: 2048,
      sourceBody: {
        model: "wire-model",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "hi", citations: [CHAR_CITATION] }] }],
      },
    });
    assert.equal(res.ok, false, `stream citations -> ${target}`);
    if (!res.ok) {
      assert.equal(res.error.capability, "file-document-citation-source", `stream citations -> ${target}`);
    }
  }

  // A C .txt file part is a bytes part on the streaming path too: C->R keeps
  // file_data verbatim; C->M rejects as non-PDF inline bytes.
  const cTxtStream = {
    model: "wire-model",
    stream: true,
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { file_data: "aG Vsb G8=\n", filename: "notes.txt" } }],
      },
    ],
  };
  const cTxtStreamToR = coord.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-responses",
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    sourceBody: cTxtStream,
  });
  assert.equal(cTxtStreamToR.ok, true);
  if (cTxtStreamToR.ok) {
    const input = cTxtStreamToR.value.body.input as Array<{ content: Array<{ type: string; file_data?: string }> }>;
    assert.equal(input[0]?.content[0]?.file_data, "aG Vsb G8=\n");
  }
  const cTxtStreamToM = coord.translateStreamRequest({
    sourceProtocol: "openai-chat",
    targetProtocol: "anthropic-messages",
    logicalModel: "logical-key",
    targetModel: "upstream-target",
    targetDefaultMaxTokens: 2048,
    sourceBody: cTxtStream,
  });
  assert.equal(cTxtStreamToM.ok, false);
  if (!cTxtStreamToM.ok) {
    assert.equal(cTxtStreamToM.error.capability, "document-inline-bytes");
  }

  // Stream decoder parity for response-side locators: a citations_delta
  // without file_id fails at decode with citation-document-location instead of
  // producing a citation event with a fabricated document identity.
  const decoder = new MessagesProviderStreamDecoder({
    responseId: "msg_loc",
    model: "logical-key",
    createPartId: () => "part_loc",
  });
  decoder.push({
    event: "content_block_start",
    data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  });
  const locatorDelta = decoder.push({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "citations_delta", citation: { type: "char_location", cited_text: "x", document_index: 0 } },
    }),
  });
  assert.equal(locatorDelta.ok, false);
  if (!locatorDelta.ok) {
    assert.equal(locatorDelta.error.capability, "citation-document-location");
  }
});

test.concurrent("row tool-result-multipart: media in tool results admitted R↔M, rejected into C", () => {
  const coord = coordinator();
  const mBody = {
    model: "wire-model",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "check this" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "take_photo", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "Here is the photo:" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: SAMPLE_PNG_B64 } },
            ],
          },
        ],
      },
    ],
  };

  // M->R (T1): admitted multipart tool result
  const mToR = translateRequest(coord, "anthropic-messages", "openai-responses", mBody as never);
  assert.equal(mToR.ok, true);
  if (mToR.ok) {
    const input = mToR.value.body.input as Array<{ type: string; call_id?: string; output?: unknown }>;
    const toolOut = input.find((i) => i.type === "function_call_output");
    assert.ok(Array.isArray(toolOut?.output));
    const outList = toolOut?.output as Array<{ type: string }> | undefined;
    assert.equal(outList?.[1]?.type, "input_image");
  }

  // M->C (T3): rejected with tool-result-multipart
  const mToC = translateRequest(coord, "anthropic-messages", "openai-chat", mBody as never);
  assert.equal(mToC.ok, false);
  if (!mToC.ok) {
    assert.equal(mToC.error.capability, "tool-result-multipart");
  }
});

// =====================================================================
// 4. Request Body Size Limit
// =====================================================================

// Enforcement lives at exactly two points (request-body-size-limit row): the
// HTTP ingress body limit — covered by the zero-dispatch 413 process test —
// and the M-bound serialized-body check exercised below. C↔R translations
// carry no universal JSON cap, so no translation-layer media-byte budget
// applies to them.

test.concurrent("row request-body-size-limit: M-bound serialized body > 32 MiB fails closed with payload_too_large", () => {
  const coord = coordinator();

  // Two 17 MiB parts: each is individually admissible, but the serialized
  // Anthropic request body (base64 embedded verbatim) exceeds 32 MiB.
  // 17 MiB = 17_825_792 bytes = 23_767_724 base64 chars
  const partB64 = "A".repeat(23_767_724);

  const cBody = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${partB64}` } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${partB64}` } },
        ],
      },
    ],
  };

  const res = translateRequest(coord, "openai-chat", "anthropic-messages", cBody);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.category, "payload_too_large");
  }
});

// =====================================================================
// 5. Worked Examples
// =====================================================================

test.concurrent("worked example: inline-image translation and size boundary", () => {
  const coord = coordinator();
  const dataUri = `data:image/jpeg;base64,${SAMPLE_PNG_B64}`;

  const cInput = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image:" },
          { type: "image_url", image_url: { url: dataUri, detail: "low" } },
        ],
      },
    ],
  };

  // C→R: preserves data URI and detail
  const cToR = translateRequest(coord, "openai-chat", "openai-responses", cInput as never);
  assert.equal(cToR.ok, true);
  if (cToR.ok) {
    const input = cToR.value.body.input as Array<{ content: Array<{ type: string; image_url?: string; detail?: string }> }>;
    assert.equal(input[0]?.content[1]?.type, "input_image");
    assert.equal(input[0]?.content[1]?.image_url, dataUri);
    assert.equal(input[0]?.content[1]?.detail, "low");
  }

  // C→M: without detail, converts data URI to base64 block
  const cInputNoDetail = {
    model: "wire-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image:" },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
  };
  const cToM = translateRequest(coord, "openai-chat", "anthropic-messages", cInputNoDetail as never);
  assert.equal(cToM.ok, true);
  if (cToM.ok) {
    const msgs = cToM.value.body.messages as Array<{
      content: Array<{ type: string; text?: string; source?: { type: string; media_type?: string; data?: string } }>;
    }>;
    assert.equal(msgs[0]?.content[1]?.type, "image");
    assert.equal(msgs[0]?.content[1]?.source?.type, "base64");
    assert.equal(msgs[0]?.content[1]?.source?.media_type, "image/jpeg");
    assert.equal(msgs[0]?.content[1]?.source?.data, SAMPLE_PNG_B64);
  }
});
