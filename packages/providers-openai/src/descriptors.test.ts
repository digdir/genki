import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type GateRecord } from '@genai/kernel';
import { loadDescriptors, type DescriptorRegistry } from '@genai/operations';
import { fixturesFor, type OperationFixture } from '@genai/operations/contract';
import { EmbeddingRouter } from '@genai/port-embedding';
import { ModelRouter, type DecisionRequest } from '@genai/port-model';
import { fakeHttp, testContext, type FakeServer } from '@genai/port-model/testing';
import { openAiChat, openAiEmbeddings } from './index.js';

const descriptors = loadDescriptors();
const fixtureDir = join(import.meta.dirname, '..', '..', 'operations', 'fixtures');

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const serve = async (fixture: OperationFixture) => {
  const server = await fakeHttp(() => ({
    status: fixture.response.status ?? 200,
    json: fixture.response.body,
  }));
  servers.push(server);
  return server;
};

const auth = { kind: 'api-key', header: 'api-key', secret: 'secret://env/test-key' } as const;

const embedders = (url: string, fixture: OperationFixture, described?: string) =>
  new EmbeddingRouter({
    catalog: {
      endpoints: {
        compatible: { protocol: 'openai-embeddings', baseURL: `${url}/v1`, auth },
      },
      models: [
        {
          id: 'compatible/small',
          endpoint: 'compatible',
          deployment: fixture.deployment,
          residency: 'eu',
          dimensions: (fixture.result as { vectors: number[][] }).vectors[0]?.length ?? 1,
          ...(described ? { descriptors: { embed: described } } : {}),
        },
      ],
    },
    adapters: [openAiEmbeddings],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
    descriptors,
    maxRetries: 0,
  });

const deciders = (
  url: string,
  fixture: OperationFixture,
  described?: string,
  registry = descriptors,
) =>
  new ModelRouter({
    catalog: {
      endpoints: {
        compatible: { protocol: 'openai-chat', baseURL: `${url}/openai/v1`, auth },
      },
      models: [
        {
          id: 'compatible/decider',
          endpoint: 'compatible',
          deployment: fixture.deployment,
          residency: 'eu',
          operations: ['chat', 'decide'],
          ...(described ? { descriptors: { decide: described } } : {}),
        },
      ],
    },
    adapters: [openAiChat],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
    descriptors: registry,
    maxRetries: 0,
  });

const audited = () => {
  const audit: GateRecord[] = [];
  const { ctx, metered } = testContext();
  return {
    ctx: {
      ...ctx,
      audit: async (record: GateRecord) => {
        audit.push(record);
      },
    },
    audit,
    metered,
  };
};

const embedOnce = async (fixture: OperationFixture, described?: string) => {
  const server = await serve(fixture);
  const { ctx, audit, metered } = audited();
  const result = await embedders(server.url, fixture, described)
    .open({ kind: 'embedder', id: 'compatible/small' }, ctx)
    .embed(fixture.input as string[]);
  return { result, seen: server.seen, audit, metered };
};

const decideOnce = async (fixture: OperationFixture, described?: string) => {
  const server = await serve(fixture);
  const { ctx, audit, metered } = audited();
  const result = await deciders(server.url, fixture, described)
    .decisions()
    .open({ kind: 'model', id: 'compatible/decider' }, ctx)
    .decide(fixture.input as DecisionRequest);
  return { result, seen: server.seen, audit, metered };
};

const withoutDescriptor = ({ descriptor: _d, ...record }: GateRecord) => record;

describe('descriptors against the hand-written adapters', () => {
  for (const fixture of fixturesFor(fixtureDir, 'openai/embed@1'))
    it(`an embed descriptor produces the same request and result as the hand-written adapter (${fixture.name})`, async () => {
      const adapter = await embedOnce(fixture);
      const described = await embedOnce(fixture, 'openai/embed@1');
      expect(described.seen[0]?.path).toBe(adapter.seen[0]?.path);
      expect(described.seen[0]?.path).toBe('/v1/embeddings');
      expect(described.seen[0]?.body).toEqual(adapter.seen[0]?.body);
      expect(described.seen[0]?.body).toEqual(fixture.request.body);
      expect(described.seen[0]?.headers['api-key']).toBe('test-key');
      expect(adapter.seen[0]?.headers['api-key']).toBe('test-key');
      expect(described.result).toEqual(adapter.result);
      expect(described.metered).toEqual(adapter.metered);
      expect(described.audit[0]).toMatchObject({ descriptor: 'openai/embed@1' });
      expect(withoutDescriptor(described.audit[0] as GateRecord)).toMatchObject(
        withoutDescriptor({ ...(adapter.audit[0] as GateRecord) }),
      );
    });

  for (const fixture of fixturesFor(fixtureDir, 'openai/decide@1'))
    it(`a decide descriptor produces the same request and result as the hand-written adapter (${fixture.name})`, async () => {
      const adapter = await decideOnce(fixture);
      const described = await decideOnce(fixture, 'openai/decide@1');
      expect(described.seen[0]?.path).toBe('/openai/v1/decisions');
      expect(described.seen[0]?.path).toBe(adapter.seen[0]?.path);
      expect(described.seen[0]?.body).toEqual(adapter.seen[0]?.body);
      expect(described.seen[0]?.headers['api-key']).toBe('test-key');
      expect(described.result).toEqual(adapter.result);
      expect(described.metered).toEqual(adapter.metered);
      expect(withoutDescriptor(described.audit[0] as GateRecord)).toEqual(
        adapter.audit[0] as GateRecord,
      );
    });

  it('the hand-written adapter stays the default path and a catalog opts one operation in', async () => {
    const [fixture] = fixturesFor(fixtureDir, 'openai/decide@1');
    if (!fixture) throw new Error('no decide fixture');
    const adapter = await decideOnce(fixture);
    const described = await decideOnce(fixture, 'openai/decide@1');
    expect(adapter.audit[0]?.descriptor).toBeUndefined();
    expect(adapter.seen[0]?.headers['x-stainless-lang']).toBeDefined();
    expect(described.seen[0]?.headers['x-stainless-lang']).toBeUndefined();
  });

  it('a catalog that names an unknown descriptor, or one in review, is refused', () => {
    const [fixture] = fixturesFor(fixtureDir, 'openai/decide@1');
    if (!fixture) throw new Error('no decide fixture');
    expect(() => deciders('http://127.0.0.1:9', fixture, 'openai/decide@9')).toThrow(
      /no descriptor openai\/decide@9/,
    );
    const decide = descriptors.get('openai/decide@1');
    if (!decide) throw new Error('no decide descriptor');
    const inReview: DescriptorRegistry = {
      get: (id) => (id === decide.id ? { ...decide, status: 'review' } : undefined),
      list: () => [{ ...decide, status: 'review' }],
    };
    expect(() => deciders('http://127.0.0.1:9', fixture, decide.id, inReview)).toThrow(/in review/);
    expect(() => deciders('http://127.0.0.1:9', fixture, 'openai/embed@1')).toThrow(
      /describes embed, not decide/,
    );
  });
});
