// Normative Private Protocol IR — verbatim type algebra definitions
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type NonEmpty<T> = readonly [T, ...T[]];

export type IrBinarySource =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "bytes"; readonly mediaType: string; readonly base64: string }
  | { readonly type: "gateway_file"; readonly fileId: string };

export type IrDocumentSource =
  | IrBinarySource
  | { readonly type: "text"; readonly mediaType: "text/plain"; readonly text: string };

export type IrInputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: IrBinarySource;
      readonly detail?: "auto" | "low" | "high";
    }
  | {
      readonly type: "document";
      readonly documentId: string;
      readonly source: IrDocumentSource;
      readonly name?: string;
    };

export type IrCitationSource =
  | { readonly type: "url"; readonly url: string; readonly title?: string }
  | { readonly type: "gateway_file"; readonly fileId: string; readonly name?: string }
  | { readonly type: "input_document"; readonly documentId: string; readonly name?: string };

export interface IrCitation {
  readonly source: IrCitationSource;
  readonly quotedText?: string;
}

export type IrAssistantPart =
  | {
      readonly type: "text";
      readonly text: string;
      readonly citations?: readonly IrCitation[];
    }
  | { readonly type: "refusal"; readonly text?: string };

export type IrToolCall =
  | {
      readonly type: "function";
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly arguments?: JsonObject;
    }
  | {
      readonly type: "custom";
      readonly callId: string;
      readonly name: string;
      readonly inputText: string;
    };

export type IrItem =
  | {
      readonly type: "instruction";
      readonly authority: "system" | "developer";
      readonly separation: "advisory" | "required";
      readonly text: string;
    }
  | {
      readonly type: "message";
      readonly role: "user";
      readonly content: NonEmpty<IrInputPart>;
    }
  | {
      readonly type: "message";
      readonly role: "assistant";
      readonly content: NonEmpty<IrAssistantPart>;
    }
  | { readonly type: "tool_call"; readonly call: IrToolCall }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly isError: boolean;
      readonly content: readonly IrInputPart[];
    };

export type IrTool =
  | {
      readonly type: "function";
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: JsonObject;
      readonly strict?: boolean;
    }
  | {
      readonly type: "custom";
      readonly name: string;
      readonly description?: string;
      readonly format:
        | { readonly type: "text" }
        | {
            readonly type: "grammar";
            readonly syntax: "lark" | "regex";
            readonly definition: string;
          };
    };

export type IrToolChoice =
  | { readonly type: "none" }
  | { readonly type: "auto" }
  | { readonly type: "required" }
  | { readonly type: "named"; readonly name: string };

export interface IrReasoningControl {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type IrOutputFormat =
  | { readonly type: "text" }
  | {
      readonly type: "json_schema";
      readonly schema: JsonObject;
      readonly name?: string;
      readonly description?: string;
      readonly strict?: boolean;
    };

export interface IrGenerationControls {
  readonly temperature?: number;
  readonly verbosity?: "low" | "medium" | "high";
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: NonEmpty<string>;
  readonly reasoning?: IrReasoningControl;
}

export interface IrRequest {
  readonly model: string;
  readonly delivery: "complete" | "stream";
  readonly items: readonly IrItem[];
  readonly tools?: readonly IrTool[];
  readonly toolChoice?: IrToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly generation?: IrGenerationControls;
  readonly output?: IrOutputFormat;
}

export type IrFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "refusal"
  | "content_filter"
  | "context_limit"
  | "other";

export interface IrFinish {
  readonly reason: IrFinishReason;
  readonly stopSequence?: string;
}

export type IrOutputPart =
  | {
      readonly type: "text";
      readonly partId: string;
      readonly text: string;
      readonly citations?: readonly IrCitation[];
    }
  | { readonly type: "refusal"; readonly partId: string; readonly text?: string }
  | { readonly type: "tool_call"; readonly partId: string; readonly call: IrToolCall };

export interface IrUsage {
  readonly input: number;
  readonly output: number;
  readonly total?: number;
  readonly cacheReadInput?: number;
  readonly cacheWriteInput?: number;
  readonly reasoningOutput?: number;
}

export interface IrOutcome {
  readonly responseId: string;
  readonly model: string;
  readonly parts: readonly IrOutputPart[];
  readonly finish: IrFinish;
  readonly usage?: IrUsage;
}

export type IrFailureCategory =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "unavailable"
  | "provider"
  | "unsupported_capability"
  | "stream_interrupted";

export interface IrFailure {
  readonly category: IrFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly capability?: string;
}

export type IrCompletedResult =
  | { readonly ok: true; readonly outcome: IrOutcome }
  | { readonly ok: false; readonly failure: IrFailure };

export type IrPartDescriptor =
  | { readonly type: "text" }
  | { readonly type: "refusal" }
  | { readonly type: "function_call"; readonly callId: string; readonly name: string }
  | { readonly type: "custom_call"; readonly callId: string; readonly name: string };

export type IrStreamEvent =
  | {
      readonly type: "response_start";
      readonly responseId: string;
      readonly model: string;
    }
  | {
      readonly type: "part_start";
      readonly responseId: string;
      readonly partId: string;
      readonly part: IrPartDescriptor;
    }
  | {
      readonly type: "text_delta" | "refusal_delta";
      readonly responseId: string;
      readonly partId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_arguments_delta";
      readonly responseId: string;
      readonly partId: string;
      readonly callId: string;
      readonly text: string;
    }
  | {
      readonly type: "citation";
      readonly responseId: string;
      readonly partId: string;
      readonly citation: IrCitation;
    }
  | {
      readonly type: "part_end";
      readonly responseId: string;
      readonly partId: string;
      readonly partType: "text" | "refusal" | "custom_call";
    }
  | {
      readonly type: "part_end";
      readonly responseId: string;
      readonly partId: string;
      readonly partType: "function_call";
      readonly arguments?: JsonObject;
    }
  | {
      readonly type: "response_end";
      readonly responseId: string;
      readonly finish: IrFinish;
      readonly usage?: IrUsage;
    }
  | {
      readonly type: "error";
      readonly responseId: string;
      readonly failure: IrFailure;
    };
