/**
 * @fileoverview Protocol-neutral Intermediate Representation (IR) for translation.
 *
 * Defines the private type algebra that standardizes requests, outcomes, and stream events
 * across OpenAI Chat, OpenAI Responses, and Anthropic Messages. Ingress codecs decode
 * raw payloads into these shapes, validators verify structural invariants, and egress
 * codecs serialize them into target wire representations.
 *
 * Protocol-specific options that have no semantic representation in the IR are carried
 * in separate wire option sidecars defined in `src/translation/contracts.ts`.
 */

import type { NormalizedFailure } from "../domain/operations.ts";

/** Free-form JSON value permitted in tool schemas and structured outputs. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** Readonly JSON object with arbitrary string keys. */
export interface JsonObject {
  /** Property value indexed by name. */
  readonly [key: string]: JsonValue;
}

/** Readonly non-empty array guaranteed to contain at least one element. */
export type NonEmpty<T> = readonly [T, ...T[]];

/** Supported custom-tool grammar syntax literals. */
export const GRAMMAR_SYNTAX_VALUES = ["lark", "regex"] as const;

/** Grammar syntax format admitted for custom tool definitions. */
export type GrammarSyntax = (typeof GRAMMAR_SYNTAX_VALUES)[number];

/** Binary payload source for image content parts. */
export type IrBinarySource =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "bytes"; readonly mediaType: string; readonly base64: string }
  | { readonly type: "gateway_file"; readonly fileId: string };

/** Document source for file and text input parts. */
export type IrDocumentSource =
  | IrBinarySource
  | { readonly type: "text"; readonly mediaType: "text/plain"; readonly text: string };

/** Single content part within a user message or tool result. */
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

/** Origin reference pointed to by a text citation. */
export type IrCitationSource =
  | { readonly type: "url"; readonly url: string; readonly title?: string }
  | { readonly type: "gateway_file"; readonly fileId: string; readonly name?: string }
  | { readonly type: "input_document"; readonly documentId: string; readonly name?: string };

/** Citation metadata attached to assistant text. */
export interface IrCitation {
  /** Origin that the cited text references. */
  readonly source: IrCitationSource;
  /** Quoted excerpt from the cited source, if provided by the model. */
  readonly quotedText?: string;
}

/** Content part within an assistant message in the conversation history. */
export type IrAssistantPart =
  | {
      readonly type: "text";
      readonly text: string;
      readonly citations?: readonly IrCitation[];
    }
  | { readonly type: "refusal"; readonly text?: string };

/** Tool invocation emitted by the assistant. */
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

/** Single item in the request conversation transcript. */
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

/** Tool definition exposed to the model during completion. */
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
            readonly syntax: GrammarSyntax;
            readonly definition: string;
          };
    };

/** Tool selection directive constraining how the model invokes tools. */
export type IrToolChoice =
  | { readonly type: "none" }
  | { readonly type: "auto" }
  | { readonly type: "required" }
  | { readonly type: "named"; readonly name: string };

/** Admitted text verbosity level literals. */
export const VERBOSITY_VALUES = ["low", "medium", "high"] as const;

/** Verbosity level governing completion conciseness. */
export type Verbosity = (typeof VERBOSITY_VALUES)[number];

/** Admitted reasoning effort level literals. */
export const REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

/** Reasoning effort parameter directing model deliberation depth. */
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Reasoning controls configuring deliberation budget for thinking models. */
export interface IrReasoningControl {
  /** Reasoning effort budget parameter guiding model deliberation. */
  readonly effort?: ReasoningEffort;
}

/** Output format constraint specifying expected completion structure. */
export type IrOutputFormat =
  | { readonly type: "text" }
  | {
      readonly type: "json_schema";
      readonly schema: JsonObject;
      readonly name?: string;
      readonly description?: string;
      readonly strict?: boolean;
    };

/** Generation controls and sampling hyperparameters governing model output. */
export interface IrGenerationControls {
  /** Sampling temperature governing randomness; higher values increase variance. */
  readonly temperature?: number;
  /** Output text verbosity level. */
  readonly verbosity?: Verbosity;
  /** Nucleus sampling probability cutoff mass. */
  readonly topP?: number;
  /** Maximum completion tokens to generate. */
  readonly maxOutputTokens?: number;
  /** Custom sequence tokens that halt further generation when produced. */
  readonly stopSequences?: NonEmpty<string>;
  /** Explicit reasoning effort guidance for thinking models. */
  readonly reasoning?: IrReasoningControl;
}

/** Protocol-neutral intermediate representation of an inbound language model request. */
export interface IrRequest {
  /** Canonical logical model key requested by the client. */
  readonly model: string;
  /** Delivery format: complete single response or server-sent events stream. */
  readonly delivery: "complete" | "stream";
  /** Ordered transcript items forming the prompt and conversation history. */
  readonly items: readonly IrItem[];
  /** Tool definitions made available to the model during generation. */
  readonly tools?: readonly IrTool[];
  /** Tool execution directive guiding model tool invocation behavior. */
  readonly toolChoice?: IrToolChoice;
  /** Whether the model is permitted to generate multiple tool calls concurrently. */
  readonly parallelToolCalls?: boolean;
  /** Sampling parameters and generation controls. */
  readonly generation?: IrGenerationControls;
  /** Structured output specification constraining model completion schema. */
  readonly output?: IrOutputFormat;
}

/** Standardized termination reason for model generation. */
export type IrFinishReason = "stop" | "length" | "tool_calls" | "refusal" | "content_filter" | "context_limit";

/** Outcome completion metadata describing how and why generation halted. */
export interface IrFinish {
  /** Normalized reason code explaining the generation stop condition. */
  readonly reason: IrFinishReason;
  /** Specific stop sequence that halted generation, if triggered. */
  readonly stopSequence?: string;
}

/** Individual content part produced in the model's completion response. */
export type IrOutputPart =
  | {
      readonly type: "text";
      readonly partId: string;
      readonly text: string;
      readonly citations?: readonly IrCitation[];
    }
  | { readonly type: "refusal"; readonly partId: string; readonly text?: string }
  | { readonly type: "tool_call"; readonly partId: string; readonly call: IrToolCall };

/** Normalized token consumption metrics for request and response accounting. */
export interface IrUsage {
  /** Tokens consumed in prompt items and context. */
  readonly input: number;
  /** Tokens generated in completion text, tool calls, and reasoning. */
  readonly output: number;
  /** Total tokens consumed across prompt and completion. */
  readonly total?: number;
  /** Cached prompt tokens read from cache. */
  readonly cacheReadInput?: number;
  /** Uncached prompt tokens written to cache. */
  readonly cacheWriteInput?: number;
  /** Internal reasoning tokens produced prior to visible completion. */
  readonly reasoningOutput?: number;
}

/** Protocol-neutral intermediate representation of a completed model response. */
export interface IrOutcome {
  /** Unique provider response identifier. */
  readonly responseId: string;
  /** Model identifier that produced the completion. */
  readonly model: string;
  /** Ordered output content parts generated by the model. */
  readonly parts: readonly IrOutputPart[];
  /** Completion termination details and stop condition. */
  readonly finish: IrFinish;
  /** Token usage accounting for the completed request. */
  readonly usage?: IrUsage;
}

/** Normalized failure taxonomy categorizing translation and upstream errors. */
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

/** Descriptor identifying the kind and metadata of a content part beginning on a stream. */
export type IrPartDescriptor =
  | { readonly type: "text" }
  | { readonly type: "refusal" }
  | { readonly type: "function_call"; readonly callId: string; readonly name: string }
  | { readonly type: "custom_call"; readonly callId: string; readonly name: string };

/**
 * Ordered semantic events emitted during streaming translation.
 * Represents lifecycle boundaries, incremental deltas, citations, and terminal states.
 */
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
      readonly failure: NormalizedFailure;
    };
