import type { Interrupt, Part } from '@genai/contracts';
import type { Emitted, InvocationContext } from '@genai/kernel';
import type { z } from 'zod';
import type { FlowServices } from './services.js';

export interface FlowRuntimeConfig {
  model?: { primary?: string; fallback?: string; tenant?: string };
  knowledge?: {
    datasets?: { dataset: string }[];
    reranker?: string;
    retrieval?: Record<string, unknown>;
  };
  tools?: string[];
  [key: string]: unknown;
}

export interface BlockContext {
  invocation: InvocationContext;
  config: FlowRuntimeConfig;
  services: FlowServices;
  step: string;
  input: Record<string, unknown>;
  resumed?: { response: unknown; parts: Part[] };
}

export interface Pause {
  pause: Omit<Interrupt, 'id'> & { id?: string };
}

export type BlockRun<I, P> = (
  ctx: BlockContext,
  input: I,
  params: P,
) => AsyncGenerator<Emitted, unknown>;

export interface Block<I = unknown, P = unknown> {
  name: string;
  version: string;
  description: string;
  input: z.ZodType<I>;
  params: z.ZodType<P>;
  output: z.ZodType;
  run: BlockRun<I, P>;
}

export const blockRef = (block: Pick<Block, 'name' | 'version'>) =>
  `${block.name}@${block.version}`;

export const isPause = (value: unknown): value is Pause =>
  typeof value === 'object' && value !== null && 'pause' in value;

export class BlockRegistry {
  readonly #blocks = new Map<string, Block>();

  register<I, P>(block: Block<I, P>): this {
    const ref = blockRef(block);
    if (this.#blocks.has(ref)) throw new Error(`block ${ref} is already registered`);
    this.#blocks.set(ref, block as unknown as Block);
    return this;
  }

  get(ref: string): Block | undefined {
    return this.#blocks.get(ref);
  }

  refs(): string[] {
    return [...this.#blocks.keys()].sort();
  }

  describe() {
    return this.refs().map((ref) => {
      const block = this.#blocks.get(ref) as Block;
      return { ref, description: block.description };
    });
  }
}
