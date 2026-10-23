import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { envSecrets } from '@genai/kernel';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IndexWriterRouter,
  parseKnowledgeCatalog,
  probeKnowledgeEndpoint,
  type DatasetConfig,
  type DatasetEmbedding,
  type IndexDocument,
  type IndexWriter,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import {
  fixtureFilters,
  fixtureVector,
  indexWriterContract,
  knowledgeAdapterContract,
  openTarget,
  seedCorpus,
} from '@genai/port-knowledge/testing';
import { fakeEmbedder } from '@genai/port-embedding/testing';
import {
  migrateKnowledge,
  pgvectorEngine,
  type PgvectorEngineOptions,
  type QueryEmbedder,
} from './index.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const signal = new AbortController().signal;
const embedding: DatasetEmbedding = { model: 'fixture', dimensions: 32 };
const endpoint = { options: { connection: 'platform' } };

const fixtureEmbedder = (dataset: DatasetConfig): QueryEmbedder => ({
  embed: async (texts) => texts.map((t) => fixtureVector(t, dataset.embedding?.dimensions ?? 0)),
});

const engineWith = (embedder: PgvectorEngineOptions['embedder'] = fixtureEmbedder) =>
  pgvectorEngine({ pool, embedder });

const writerOf = (engine: ReturnType<typeof pgvectorEngine>) =>
  engine.writer.connect(
    { options: { connection: 'platform' }, timeoutMs: 5000 },
    { signal },
  ) as IndexWriter;

const config = (id: string, extra: Partial<DatasetConfig> = {}): DatasetConfig => ({
  id,
  filters: fixtureFilters,
  options: {},
  ...extra,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

const seeded =
  (withEmbedding: boolean) =>
  async ({ dataset }: { dataset: { id: string } }) => {
    const engine = engineWith();
    await seedCorpus(writerOf(engine), config(dataset.id, withEmbedding ? { embedding } : {}));
    return {
      adapter: engine.adapter,
      endpoint,
      ...(withEmbedding ? { embedding } : {}),
      failingRequest: { query: 'tilskudd '.repeat(300) },
    };
  };

knowledgeAdapterContract('pgvector', seeded(false));

knowledgeAdapterContract('pgvector with embedding', seeded(true));

indexWriterContract('pgvector', async ({ dataset }) => {
  const engine = engineWith();
  return {
    adapter: engine.adapter,
    endpoint,
    writer: writerOf(engine),
    dataset: { ...dataset, options: {} },
  };
});

indexWriterContract('pgvector with embedding', async ({ dataset }) => {
  const engine = engineWith();
  return {
    adapter: engine.adapter,
    endpoint,
    embedding,
    writer: writerOf(engine),
    dataset: { ...dataset, options: {}, embedding },
  };
});

const single = (
  id: string,
  title: string,
  chunks: string[],
  vectors?: number[][],
): IndexDocument => ({
  id,
  title,
  fields: {},
  chunks: chunks.map((text, position) => ({
    id: `${id}-${position}`,
    position,
    text,
    ...(vectors?.[position] ? { vector: vectors[position] } : {}),
  })),
  phrases: [],
});

const seed = async (writer: IndexWriter, dataset: DatasetConfig, documents: IndexDocument[]) => {
  await writer.prepare(dataset, 'g1');
  for (const doc of documents) await writer.store(dataset, 'g1', doc);
  await writer.promote(dataset, 'g1');
};

describe('pgvector engine', () => {
  it('upgrades legacy document storage without attributing user metadata and persists new provenance separately', async () => {
    await migrateKnowledge(pool);
    await pool.query('create schema provenance_upgrade');
    const legacy = new pg.Pool({
      connectionString: container.getConnectionUri(),
      options: '-c search_path=provenance_upgrade,public',
    });
    try {
      await migrateKnowledge(legacy);
      await legacy.query('alter table kn_docs drop column if exists pipeline');
      await legacy.query(
        "insert into kn_generations (dataset, generation) values ('upgrade', 'legacy')",
      );
      await legacy.query(
        "insert into kn_docs (dataset, generation, id, fields, config) values ('upgrade', 'legacy', 'old', $1, 'norwegian')",
        [JSON.stringify({ ingestion_pipeline: 'b', pipeline: 'user-column' })],
      );
      await migrateKnowledge(legacy);
      await migrateKnowledge(legacy);
      const upgraded = writerOf(pgvectorEngine({ pool: legacy }));
      const dataset = config('upgrade');
      const docs: IndexDocument[] = [];
      for await (const doc of upgraded.read?.(dataset, 'legacy') ?? []) docs.push(doc);
      expect(docs[0]?.pipeline).toBeUndefined();
      expect(docs[0]?.fields).toEqual({ ingestion_pipeline: 'b', pipeline: 'user-column' });
      await upgraded.store(dataset, 'legacy', {
        ...single('new', 'New', ['Nytt dokument.']),
        pipeline: 'a',
        fields: { ingestion_pipeline: 'b' },
      });
      const { rows } = await legacy.query<{ pipeline: string; fields: Record<string, unknown> }>(
        "select pipeline, fields from kn_docs where id = 'new'",
      );
      expect(rows[0]).toEqual({ pipeline: 'a', fields: { ingestion_pipeline: 'b' } });
    } finally {
      await legacy.end();
      await pool.query('drop schema provenance_upgrade cascade');
    }
  });

  it('hybrid ranks an exact phrase match above a merely similar chunk', async () => {
    const dims = { model: 'fixture', dimensions: 3 };
    const engine = engineWith(() => ({ embed: async (texts) => texts.map(() => [1, 0, 0]) }));
    const dataset = config('pgvector/hybrid', { embedding: dims, filters: {} });
    await seed(writerOf(engine), dataset, [
      single('eksakt', 'Eksakt', ['Søknadsfristen for tilskudd er 1. mars.'], [[0.8, 0.6, 0]]),
      single('lignende', 'Lignende', ['Midler kan bes om før våren.'], [[1, 0, 0]]),
      single('annet', 'Annet', ['Rapporter leveres årlig.'], [[0, 0, 1]]),
    ]);
    const port = openTarget({ adapter: engine.adapter, endpoint, embedding: dims }, dataset);
    const { hits } = await port.search({ query: 'søknadsfristen for tilskudd', limit: 3 });
    expect(hits.map((h) => h.document).slice(0, 2)).toEqual(['eksakt', 'lignende']);
  });

  it('norwegian text search matches søknad and søknader', async () => {
    const engine = engineWith();
    const dataset = config('pgvector/norsk', { filters: {} });
    await seed(writerOf(engine), dataset, [
      single('entall', 'Entall', ['En søknad om tilskudd.']),
      single('flertall', 'Flertall', ['Alle søknader behandles fortløpende.']),
      single('ingen', 'Ingen', ['Rapporter leveres årlig.']),
    ]);
    const port = openTarget({ adapter: engine.adapter, endpoint }, dataset);
    for (const query of ['søknad', 'søknader']) {
      const { hits } = await port.search({ query, limit: 10 });
      expect(hits.map((h) => h.document).sort(), query).toEqual(['entall', 'flertall']);
    }
  });

  it('datasets are isolated by dataset id', async () => {
    const embedder = fakeEmbedder({ dimensions: 8 });
    const dims = { model: 'fake', dimensions: 8 };
    const engine = engineWith(() => ({
      embed: async (texts) => (await embedder.embed(texts)).vectors,
    }));
    const writer = writerOf(engine);
    const a = config('pgvector/isolert-a', { embedding: dims, filters: {} });
    const b = config('pgvector/isolert-b', { embedding: dims, filters: {} });
    const vectors = [(await embedder.embed(['tilskudd'])).vectors[0] ?? []];
    await seed(writer, a, [single('felles', 'A', ['Tilskudd i datasett A.'], vectors)]);
    await seed(writer, b, [single('felles', 'B', ['Tilskudd i datasett B.'], vectors)]);
    const port = openTarget({ adapter: engine.adapter, endpoint, embedding: dims }, a);
    const { hits } = await port.search({ query: 'tilskudd', limit: 10 });
    expect(hits.map((h) => h.text)).toEqual(['Tilskudd i datasett A.']);
    expect((await port.fetch(['felles-0'])).map((h) => h.title)).toEqual(['A']);
    expect(await port.facets([])).toEqual({});
    await writer.prepare(a, 'g2');
    await expect(writer.drop(b, 'g1')).rejects.toMatchObject({ code: 'bad_request' });
    await writer.drop(a, 'g2');
    expect((await writer.stats(b, 'g1')).documents).toBe(1);
  });

  it('a second pgvector endpoint shares the tables and cannot drop the served generation', async () => {
    const engine = engineWith();
    const writers = new IndexWriterRouter({
      catalog: {
        endpoints: {
          plattform: { engine: 'pgvector', options: { connection: 'platform' } },
          kopi: { engine: 'pgvector', options: { connection: 'platform' } },
        },
        datasets: [{ id: 'pgvector/delt', endpoint: 'plattform', residency: 'norway' }],
      },
      adapters: [engine.writer as IndexWriterAdapter],
      knowledgeAdapters: [engine.adapter as KnowledgeAdapter],
      secrets: envSecrets({}),
    });
    const served = writers.open('pgvector/delt', { signal });
    await seed(served.writer, served.dataset, [single('delt', 'Delt', ['Tilskudd deles.'])]);
    const other = writers.openAt('pgvector/delt', 'kopi', { signal });
    await expect(other.writer.drop(other.dataset, 'g1', { force: true })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await other.writer.active(other.dataset)).toBe('g1');
    expect((await served.writer.stats(served.dataset, 'g1')).documents).toBe(1);
  });

  it('reports the generation searches read, so a task can record it', async () => {
    const engine = engineWith();
    const writer = writerOf(engine);
    const dataset = config('pgvector/generasjon', { filters: {} });
    const reader = engine.adapter.connect({ ...endpoint, timeoutMs: 5000 } as never);

    expect(await reader.served?.(dataset as never, signal)).toEqual({});
    await seed(writer, dataset, [single('en', 'En', ['Første.'])]);
    expect(await reader.served?.(dataset as never, signal)).toEqual({ generation: 'g1' });
    await writer.prepare(dataset, 'g2');
    await writer.promote(dataset, 'g2');
    expect(await reader.served?.(dataset as never, signal)).toEqual({ generation: 'g2' });
  });

  it('custom profiles search vectors alone and named document fields', async () => {
    const engine = engineWith();
    const datasetOptions = {
      profiles: {
        vektor: { target: 'phrases', mode: 'vector' },
        sammendrag: { target: 'docs', mode: 'text', fields: ['sammendrag', 'title'] },
      },
    };
    const dataset = config('pgvector/profiler', { embedding, options: datasetOptions });
    await seedCorpus(writerOf(engine), dataset);
    const port = openTarget(
      { adapter: engine.adapter, endpoint, embedding, datasetOptions },
      dataset,
    );
    expect(port.info().profiles).toEqual(['vektor', 'sammendrag']);
    const vector = await port.search({ query: 'Kan tilskudd brukes til skyplattform?', limit: 1 });
    expect(vector.hits.map((h) => h.id)).toEqual(['dok-1-2']);
    const fields = await port.search({
      query: 'innovasjon',
      profile: 'sammendrag',
      filters: { aar: { gte: 2024 } },
    });
    expect(fields.hits.map((h) => h.document)).toEqual(['dok-5']);
  });

  it('an endpoint with an external connection is refused', () => {
    const { adapter } = engineWith();
    const result = parseKnowledgeCatalog(
      {
        endpoints: {
          ekstern: {
            engine: 'pgvector',
            options: { connection: 'postgres://bruker:hemmelig@db.example.no/kunnskap' },
          },
        },
        datasets: [],
      },
      [adapter],
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('endpoints.ekstern.options.connection');
  });

  it('probe succeeds on a reachable endpoint and fails clearly otherwise', async () => {
    const probe = (engine: ReturnType<typeof pgvectorEngine>) =>
      probeKnowledgeEndpoint(
        { engine: 'pgvector' },
        { adapters: [engine.adapter], secrets: envSecrets({}), timeoutMs: 5000 },
      );
    expect(await probe(engineWith())).toMatchObject({ ok: true, engine: 'pgvector' });
    const unreachable = new pg.Pool({
      connectionString: 'postgres://ingen:ingen@127.0.0.1:1/ingen',
      connectionTimeoutMillis: 2000,
    });
    try {
      expect(await probe(pgvectorEngine({ pool: unreachable }))).toMatchObject({
        ok: false,
        code: 'unavailable',
        message: expect.stringMatching(/ECONNREFUSED|connect/),
      });
    } finally {
      await unreachable.end();
    }
  });
});
