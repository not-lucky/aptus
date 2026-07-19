import { describe, expect, it } from "vitest";
import { redactValue, validateCanonicalRequest } from "../../src/domain/index.js";
import type { CanonicalChunk, CanonicalMessage, CanonicalRequest, CanonicalResponse, RouteCandidate } from "../../src/domain/index.js";
import type { AdapterRegistry, CanonicalRequestBuilder, ChunkVisitor, ContentBlockVisitor, GatewayApplication, GatewayCommand, ProviderDispatchDecorator, ProviderFactory, ProtocolAdapterFactory, RouteResolver, SelectionStrategy, TraceRecordBuilder } from "../../src/application/index.js";
import type { EgressTranslationAdapter, IngressTranslationAdapter, ProviderDispatchPort, RawIngressInput, TranslationContext } from "../../src/ports/index.js";

const request: CanonicalRequest = {
  requestId: "req_task3", receivedAt: "2026-07-19T00:00:00Z",
  source: { adapter: "custom", protocol: "custom", path: "/v1/custom" },
  model: "test", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  routing: {}, stream: false,
};
const response: CanonicalResponse = {
  requestId: "req_task3", responseId: "resp_task3", createdAt: "2026-07-19T00:00:00Z", model: "test", status: "completed", choices: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  cost: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0, currency: "USD" },
  provider: { providerId: "provider_task3", credentialId: "credential_task3", physicalModel: "model_task3", responseHeaders: {}, upstreamStatus: 200 },
};
const candidate: RouteCandidate = { routeId: "route_task3", providerId: "provider_task3", credentialId: "credential_task3", physicalModel: "model_task3", capabilities: new Set(), estimatedCostUsd: 0 };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

describe("application pattern contracts", () => {
  it("connects translation, routing, dispatch, decoration, facade, and egress", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const input: RawIngressInput = { path: "/v1/custom", headers: {}, body: { model: "test" }, requestId: "req_task3" };
    const context: TranslationContext = { requestId: "req_task3", signal, trustedRoutingHeaders: {} };
    let ingressContext: TranslationContext | undefined;
    const ingress: IngressTranslationAdapter = { protocol: "custom", paths: new Set(["/v1/custom"]), canTranslate: () => true, translate: (raw, observed) => { expect(raw.requestId).toBe(input.requestId); ingressContext = observed; return request; } };
    const egressValues: Array<[CanonicalResponse | CanonicalChunk, TranslationContext]> = [];
    const egress: EgressTranslationAdapter = { protocol: "custom", encodeResponse: (value, observed) => { expect(observed.requestId).toBe(input.requestId); expect(observed.signal).toBe(signal); egressValues.push([value, observed]); return "encoded-response"; }, encodeChunk: (value, observed) => { expect(observed.requestId).toBe(input.requestId); expect(observed.signal).toBe(signal); egressValues.push([value, observed]); return "encoded-chunk"; }, encodeError: () => "encoded-error" };
    const resolver: RouteResolver = { resolve: async (_request, observed) => { expect(observed.requestId).toBe("req_task3"); expect(observed.signal).toBe(signal); return [candidate]; } };
    const forwarded: unknown[][] = [];
    const dispatch: ProviderDispatchPort = { dispatch: async (selected, selectedRequest, observed) => { forwarded.push([selected, selectedRequest, observed]); return response; }, stream: async function* (selected, selectedRequest, observed) { forwarded.push([selected, selectedRequest, observed]); yield { type: "response_start", responseId: "resp_task3", model: "test", createdAt: "2026-07-19T00:00:00Z" }; yield { type: "response_end", status: "completed" }; } };
    const decorator: ProviderDispatchDecorator = { inner: dispatch, dispatch: (...args) => dispatch.dispatch(...args), stream: (...args) => dispatch.stream(...args) };
    const factory: ProviderFactory = { create: (providerId) => { expect(providerId).toBe("provider_task3"); return decorator; } };
    const registry: AdapterRegistry = { ingress: (path) => { expect(path).toBe("/v1/custom"); return ingress; }, egress: (protocol) => { expect(protocol).toBe("custom"); return egress; } };
    const application: GatewayApplication = { handle: async (raw) => { const translated = registry.ingress(raw.path).translate(raw, context); const candidates = await resolver.resolve(translated, { request: translated, requestId: context.requestId, signal: context.signal, state: new Map(), getState: () => undefined, setState: () => undefined }); const result = await factory.create(candidates[0]?.providerId ?? "provider").dispatch(candidates[0] ?? candidate, translated, signal); registry.egress("custom").encodeResponse(result, context); return result; }, stream: async function* (raw) { const translated = registry.ingress(raw.path).translate(raw, context); const candidates = await resolver.resolve(translated, { request: translated, requestId: context.requestId, signal: context.signal, state: new Map(), getState: () => undefined, setState: () => undefined }); for await (const chunk of factory.create(candidates[0]?.providerId ?? "provider").stream(candidates[0] ?? candidate, translated, signal)) { registry.egress("custom").encodeChunk(chunk, context); yield chunk; } } };
    expect(await application.handle(input)).toBe(response);
    expect(ingressContext).toBe(context);
    expect(egressValues).toHaveLength(1);
    expect(egressValues[0]?.[1]).toBe(context);
    const streamed = await collect(application.stream(input));
    expect(streamed.map((chunk) => chunk.type)).toEqual(["response_start", "response_end"]);
    expect(forwarded).toEqual([[candidate, request, signal], [candidate, request, signal]]);
    expect(egressValues).toHaveLength(3);
    expect(egressValues.every(([, observed]) => observed.requestId === input.requestId && observed.signal === signal)).toBe(true);
  });

  it("supports validated builders, redacted records, cancellation, undo, selectors, and exhaustive visitors", async () => {
    let modelSet = false; let messageAdded = false; let builtModel = request.model; let builtMessages = request.messages;
    const builder: CanonicalRequestBuilder = { addMessage: function (message: CanonicalMessage) { messageAdded = true; builtMessages = [...builtMessages, message]; return this; }, setModel: function (model) { modelSet = true; builtModel = model; return this; }, build: () => { if (!modelSet || !messageAdded) throw new Error("canonical request builder is incomplete"); const built = { ...request, model: builtModel, messages: builtMessages }; expect(validateCanonicalRequest(built).valid).toBe(true); return built; } };
    expect(() => builder.build()).toThrow("canonical request builder is incomplete"); const added: CanonicalMessage = { role: "user", content: [{ type: "text", text: "added" }] }; builder.setModel("built-model").addMessage(added); const built = builder.build(); expect(built.model).toBe("built-model"); expect(built.messages.at(-1)).toBe(added);
    const sensitive = "fixture-secret";
    const traceBuilder: TraceRecordBuilder = { phase: function () { return this; }, field: function (_name, _value) { return this; }, build: () => redactValue({ secret: sensitive, safe: true }) as Record<string, never> };
    expect(JSON.stringify(traceBuilder.build())).not.toContain(sensitive);
    const contentVisitor: ContentBlockVisitor<string> = { visit: (block) => { switch (block.type) { case "text": return block.text; case "refusal": return block.refusal; case "image_url": return block.url; case "image_base64": return block.data; case "generated_image": return block.data; case "audio_url": return block.url; case "audio_base64": return block.data; case "audio_output": return block.transcript ?? ""; case "document_url": return block.url; case "document_base64": return block.data; case "file_reference": return block.fileId; case "search_result": return block.sourceId; case "reasoning": return block.text ?? ""; case "tool_call": return block.toolCallId; case "tool_result": return block.toolCallId; case "server_tool_call": return block.toolCallId; case "server_tool_result": return block.toolCallId; case "tool_approval_request": return block.toolCallId; case "tool_approval_response": return block.toolCallId; default: { const exhaustive: never = block; return exhaustive; } } } };
    const chunkVisitor: ChunkVisitor<string> = { visit: (chunk) => { switch (chunk.type) { case "response_start": return chunk.responseId; case "content_block_start": return "content_block_start"; case "text_delta": return chunk.text; case "refusal_delta": return chunk.text; case "reasoning_delta": return chunk.text ?? ""; case "audio_delta": return chunk.transcriptDelta ?? ""; case "tool_call_delta": return chunk.id ?? ""; case "citation_added": return "citation_added"; case "content_block_stop": return "content_block_stop"; case "usage": return "usage"; case "choice_end": return "choice_end"; case "response_end": return "response_end"; case "ping": return "ping"; case "error": return chunk.error.code; default: { const exhaustive: never = chunk; return exhaustive; } } } };
    expect(contentVisitor.visit({ type: "text", text: "ok" })).toBe("ok"); expect(chunkVisitor.visit({ type: "response_start", responseId: "r", model: "m", createdAt: "2026-07-19T00:00:00Z" })).toBe("r");
    let executed = 0; let undone = 0;
    const command: GatewayCommand<string> = { execute: async (observed) => { if (observed.aborted) throw new DOMException("The operation was aborted", "AbortError"); executed += 1; return "done"; }, undo: async () => { undone += 1; } };
    expect(await command.execute(new AbortController().signal)).toBe("done"); const aborted = new AbortController(); aborted.abort(); await expect(command.execute(aborted.signal)).rejects.toThrow("The operation was aborted"); await command.undo!(); expect([executed, undone]).toEqual([1, 1]);
    const selector: SelectionStrategy = { select: (candidates) => [...candidates].sort((a, b) => a.providerId.localeCompare(b.providerId)) }; expect(selector.select([candidate, { ...candidate, providerId: "a" }]).map((item) => item.providerId)).toEqual(["a", "provider_task3"]);
  });
});
