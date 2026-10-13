import { createHash } from 'node:crypto';
import type { Ref, Usage } from '@genai/contracts';
import type { PortContext } from '@genai/kernel';
import { z } from 'zod';
import type { EmbeddingAdapter, EmbeddingModelConfig } from './adapter.js';
import type { EmbedderInfo, EmbeddingPort, EmbedResult, Residency } from './port.js';

export const fakeVector = (text: string, dimensions: number): number[] => {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block++) {
    const digest = createHash('sha256').update(`${block}:${text}`).digest();
    for (let i = 0; i + 1 < digest.length && values.length < dimensions; i += 2)
      values.push(digest.readUInt16BE(i) / 32_767.5 - 1);
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((v) => v / norm);
};

const tokens = (text: string) => text.split(/\s+/).filter(Boolean).length;

export interface FakeEmbedderOptions {
  id?: string;
  dimensions?: number;
  residency?: Residency;
  maxBatch?: number;
}

export interface FakeEmbedder extends EmbeddingPort {
  calls: string[][];
}

export const fakeEmbedder = (options: FakeEmbedderOptions = {}): FakeEmbedder => {
  const dimensions = options.dimensions ?? 8;
  const calls: string[][] = [];
  const info: EmbedderInfo = {
    id: options.id ?? 'fake/embedder',
    residency: options.residency ?? 'norway',
    dimensions,
    ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
  };
  return {
    calls,
    info: () => info,
    embed: async (texts) => {
      calls.push([...texts]);
      return {
        vectors: texts.map((t) => fakeVector(t, dimensions)),
        usage: { inputTokens: texts.reduce((n, t) => n + tokens(t), 0) },
      };
    },
  };
};

export interface FakeEmbeddingAdapter extends EmbeddingAdapter<
  Record<string, never>,
  Record<string, never>
> {
  calls: { deployment: string; texts: string[] }[];
}

export const fakeEmbeddingAdapter = (
  protocol = 'fake',
  respond: (model: EmbeddingModelConfig, texts: string[]) => EmbedResult = (model, texts) => ({
    vectors: texts.map((t) => fakeVector(t, model.dimensions)),
    usage: { inputTokens: texts.reduce((n, t) => n + tokens(t), 0) },
  }),
): FakeEmbeddingAdapter => {
  const calls: FakeEmbeddingAdapter['calls'] = [];
  return {
    protocol,
    calls,
    endpointOptions: z.strictObject({}),
    modelOptions: z.strictObject({}),
    connect: () => ({
      embed: async (model, texts) => {
        calls.push({ deployment: model.deployment, texts: [...texts] });
        return respond(model, texts);
      },
    }),
  };
};

export interface TestContext {
  ctx: PortContext;
  metered: { usage: Usage; model?: Ref }[];
}

export const testContext = (signal: AbortSignal = new AbortController().signal): TestContext => {
  const metered: TestContext['metered'] = [];
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '999888777' },
    task: 't1',
    signal,
    meter: async (usage, model) => {
      metered.push({ usage, ...(model ? { model } : {}) });
    },
  };
  return { ctx, metered };
};
