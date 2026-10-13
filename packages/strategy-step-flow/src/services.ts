import type { InvocationContext, Strategy } from '@genai/kernel';
import type { FlowRuntimeConfig } from './blocks.js';

export interface FlowChunk {
  chunkId: string;
  content?: string;
  document?: string;
  position?: number;
  totalChunks?: number;
  title?: string;
  url?: string;
  headers?: string[];
  version?: string;
  publishedAt?: string;
  score?: number;
  rerankScore?: number;
}

export interface FlowDocument {
  id: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  fields?: Record<string, unknown>;
}

export interface FlowDocumentQuery {
  ids?: string[];
  filters?: Record<string, unknown>;
  limit: number;
}

export interface FlowConversationTurn {
  role: string;
  text: string;
}

export interface FlowRetrieval {
  plan(
    query: string,
    history: FlowConversationTurn[],
    signal: AbortSignal,
  ): Promise<{ queries: string[]; userIntent?: string }>;
  retrieve(
    queries: string[],
    options: { userIntent?: string; filters?: Record<string, (string | number)[]> },
    signal: AbortSignal,
  ): Promise<{ chunks: FlowChunk[]; attribution?: unknown }>;
  rerank(query: string, chunks: FlowChunk[], signal: AbortSignal): Promise<FlowChunk[]>;
  documents?(query: FlowDocumentQuery, signal: AbortSignal): Promise<FlowDocument[]>;
  readDocument?(document: string, maxChunks: number, signal: AbortSignal): Promise<FlowChunk[]>;
}

export type FlowRetrievalFactory = (
  ctx: InvocationContext,
  config: FlowRuntimeConfig,
) => FlowRetrieval | Promise<FlowRetrieval>;

export interface FlowServices {
  retrieval?: FlowRetrievalFactory;
  agent?: Strategy<unknown>;
  now: () => Date;
}
