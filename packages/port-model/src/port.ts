import type { Usage } from '@genai/contracts';
import type { ParameterRules, TunableParameter } from './parameters.js';

export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const residencyAllows = (allowed: Residency, actual: Residency) =>
  residencies.indexOf(actual) <= residencies.indexOf(allowed);

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; continuation?: unknown }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const defaultMaxOutputTokens = 4000;

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  reasoning?: 'low' | 'medium' | 'high';
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Marks a call that writes the answer the user reads; only these get language instructions. */
  purpose?: 'answer';
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  servedModel: string;
  continuation?: unknown;
  droppedParameters?: TunableParameter[];
}

export type ChatChunk = { kind: 'delta'; text: string } | { kind: 'done'; result: ChatResult };

export const capabilities = ['stream', 'tools', 'json-schema', 'reasoning'] as const;
export type Capability = (typeof capabilities)[number];

export const builtInOperations = ['chat', 'decide'] as const;
export type BuiltInOperation = (typeof builtInOperations)[number];
export type Operation = string;
export const operationKindPattern = /^[a-z][a-z0-9-]*$/;
export const defaultOperations: Operation[] = ['chat'];

/** The operation kinds a catalogue may list: the built-in kinds and every kind a registered descriptor defines. */
export const operationKinds = (descriptors?: { list(): { operation: string }[] }): string[] => [
  ...new Set([...builtInOperations, ...(descriptors?.list().map((d) => d.operation) ?? [])]),
];

export interface ModelInfo {
  id: string;
  residency: Residency;
  capabilities: Capability[];
  operations?: Operation[];
  contextWindow?: number;
  parameters?: ParameterRules;
}

export interface ModelPort {
  info(): ModelInfo;
  chat(request: ChatRequest): Promise<ChatResult>;
  chatStream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

export type ModelErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'content_filtered'
  | 'bad_request'
  | 'unauthorized'
  | 'cancelled'
  | 'residency'
  | 'unsupported'
  | 'refused';

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
