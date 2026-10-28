import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentId } from '@genai/ingest';
import { envSecrets } from '@genai/kernel';
import { IndexWriterRouter, KnowledgeRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { parquetReader } from '@genai/providers-parquet';
import { InMemoryConfigEntryStore } from './config-store.js';
import { indexIngestionBackend } from './index-ingestion.js';
import {
  InMemoryExecutionStore,
  IngestionService,
  pipelineSpec,
  type IngestionJob,
} from './ingestion.js';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../packages/providers-parquet/src/fixtures',
        `${name}.parquet`,
      ),
    ),
  );

const definitions = 'https://data.example/definitions.parquet';
const records = 'https://data.example/records.parquet';
const duplicates = 'https://data.example/duplicate-identical.parquet';
const conflicting = 'https://data.example/duplicate-conflict.parquet';
const files: Record<string, string> = {
  [definitions]: 'definitions',
  [records]: 'lookup-records',
  [duplicates]: 'lookup-duplicate-identical',
  [conflicting]: 'lookup-duplicate-conflict',
  'https://data.example/a.parquet': 'shard-a',
  'https://data.example/b.parquet': 'shard-b',
};
const hfBase = 'https://huggingface.co/datasets/kelkalot/every-ai-policy-ever/resolve/v1.18/';
files[`${hfBase}data/definitions.parquet`] = 'definitions';
files[`${hfBase}data/records.parquet`] = 'lookup-records';

const lookup = (extra: object = {}) => ({
  url: records,
  key: 'id',
  on: 'record_id',
  fields: ['jurisdiction', 'country', 'region'],
  ...extra,
});
const mapping = (lookups: object[] = [lookup()], metadata: string[] = ['record_id']) => ({
  fields: {
    id: 'id',
    title: 'term',
    text: ['definition', 'english'],
    metadata,
  },
  lookups,
});
const job = (source: object, execution = 'run-1'): IngestionJob => ({
  execution,
  target: { dataset: 'tenant/docs', endpoint: 'memory', collections: {} },
  pipeline: {
    dataset: 'tenant/docs',
    id: 'p',
    version: 1,
    by: 'test',
    at: '',
    reason: 'test',
    spec: pipelineSpec.parse({
      name: 'definitions',
      source: { kind: 'parquet', ...source },
      chunking: { minimumLength: 1 },
    }),
  },
});
const definitionsJob = (lookups?: object[], execution = 'run-1', metadata?: string[]) =>
  job({ url: definitions, mapping: mapping(lookups, metadata) }, execution);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const setup = async (send?: (url: string) => Response | Promise<Response>, maxBytes?: number) => {
  const root = await mkdtemp(join(tmpdir(), 'parquet-lookup-test-'));
  roots.push(root);
  const engine = memoryEngine();
  const catalog = {
    endpoints: { memory: { engine: 'memory' } },
    datasets: [
      {
        id: 'tenant/docs',
        endpoint: 'memory',
        residency: 'norway' as const,
        filters: { jurisdiction: 'multiselect' as const, topics: 'multiselect' as const },
      },
    ],
  };
  const writers = new IndexWriterRouter({
    catalog,
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const fetched: string[] = [];
  const fetcher = (async (input) => {
    const url = String(input);
    fetched.push(url);
    if (send) return send(url);
    const name = files[url];
    return name ? new Response(fixture(name)) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  const backend = indexIngestionBackend({
    writers,
    platformTenant: 'tenant',
    residencyOf: () => undefined,
    web: { resolve: async () => ['93.184.216.34'] },
    parquet: {
      reader: parquetReader(),
      fetch: fetcher,
      workingDirectory: root,
      ...(maxBytes ? { maxBytes } : {}),
    },
  });
  const route = writers.open('tenant/docs', { signal: new AbortController().signal });
  const documents = async () => {
    const generation = await route.writer.active(route.dataset);
    const docs: Record<string, unknown>[] = [];
    if (!route.writer.read) throw new Error('test writer must support read');
    if (generation)
      for await (const doc of route.writer.read(route.dataset, generation))
        docs.push(doc as unknown as Record<string, unknown>);
    return docs;
  };
  const byId = async () =>
    new Map(
      (await documents()).map((d) => [String((d.fields as { source_id: string }).source_id), d]),
    );
  const knowledge = new KnowledgeRouter({
    catalog,
    adapters: [engine.adapter],
    secrets: envSecrets({}),
  }).open(
    { kind: 'dataset', id: 'tenant/docs' },
    {
      tenant: 'tenant',
      principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: 'tenant' },
      task: 'test',
      signal: new AbortController().signal,
      meter: async () => undefined,
    },
  );
  return { backend, root, fetched, route, documents, byId, knowledge };
};
const signal = () => new AbortController().signal;
const fieldsOf = (doc: Record<string, unknown> | undefined) =>
  (doc?.fields ?? {}) as Record<string, unknown>;

describe('Parquet lookups through the ingestion backend and real reader', () => {
  it.each([
    {
      name: 'single file',
      source: { url: definitions, mapping: mapping([]) },
      stored: 26,
    },
    {
      name: 'sharded table',
      source: {
        urls: ['https://data.example/a.parquet', 'https://data.example/b.parquet'],
        table: 'train',
        mapping: { fields: { id: 'id', title: 'title', text: ['body'] } },
      },
      stored: 4,
    },
  ])('runs a stored pipeline saved before lookups existed: $name', async ({ source, stored }) => {
    const state = await setup();
    const legacy = job(source);
    if (legacy.pipeline.spec.source.kind !== 'parquet') throw new Error('expected Parquet');
    Reflect.deleteProperty(legacy.pipeline.spec.source.mapping, 'lookups');
    const store = new InMemoryConfigEntryStore();
    await store.append({
      ...legacy.pipeline,
      kind: 'ingestion-pipeline',
      scope: 'tenant',
      id: 'tenant/docs#p',
      deleted: false,
    });
    const service = new IngestionService({
      store,
      executions: new InMemoryExecutionStore(),
      backend: state.backend,
    });
    const pipeline = await service.get('tenant', 'tenant/docs', 'p');
    if (!pipeline) throw new Error('expected stored pipeline');

    const execution = await service.execute({ pipeline, target: legacy.target, by: 'test' });

    if (!execution.ok) throw new Error('expected accepted execution');
    expect(await execution.done).toMatchObject({
      status: 'succeeded',
      report: { stored, promoted: true },
    });
    expect(await readdir(state.root)).toEqual([]);
  });

  it('joins each definition to its record and stores the joined fields as filterable metadata', async () => {
    const state = await setup();

    // The on column is read for the join even though the mapping stores no column of its own.
    const report = await state.backend.run(definitionsJob(undefined, 'run-1', []), signal());

    expect(report).toMatchObject({ stored: 26, failed: [], promoted: true });
    const docs = await state.byId();
    expect('record_id' in fieldsOf(docs.get('D0002'))).toBe(false);
    expect(fieldsOf(docs.get('D0002'))).toMatchObject({
      jurisdiction: 'European Union',
      country: 'European Union',
      region: 'Europe',
    });
    expect(fieldsOf(docs.get('D0010'))).toMatchObject({ jurisdiction: 'Colorado (US)' });
    const { hits } = await state.knowledge.search({
      query: 'AI system',
      filters: { jurisdiction: ['European Union'] },
      limit: 50,
    });
    expect([...new Set(hits.map((h) => h.fields.source_id))].sort()).toEqual(['D0002', 'D0003']);
    expect(hits[0]?.text).toContain('- Jurisdiction: European Union');
  });

  it('keeps a joined list value as a list, under the name given with as', async () => {
    const state = await setup();

    await state.backend.run(
      definitionsJob([lookup({ fields: [{ column: 'safety_topics', as: 'topics' }] })]),
      signal(),
    );

    const topics = fieldsOf((await state.byId()).get('D0005')).topics;
    expect(topics).toEqual([
      'risk-based classification',
      'general-purpose / frontier AI',
      'transparency & labelling',
      'deepfakes & synthetic media',
      'human oversight',
      'safety institute',
    ]);
    const { hits } = await state.knowledge.search({
      query: 'artificial intelligence',
      filters: { topics: ['safety institute'] },
      limit: 50,
    });
    expect([...new Set(hits.map((h) => h.fields.record_id))]).toEqual(['KR-02']);
  });

  it('leaves the joined fields absent when the key has no match, and counts it in the run report', async () => {
    const state = await setup();

    const report = await state.backend.run(definitionsJob(), signal());

    const unmatched = [...(await state.byId()).values()].filter(
      (d) => fieldsOf(d).record_id === 'US-04',
    );
    expect(unmatched).toHaveLength(5);
    expect(unmatched.every((d) => !('jurisdiction' in fieldsOf(d)))).toBe(true);
    expect(report.source).toEqual({
      lookups: [{ file: records, rows: 12, keys: 12, matched: 21, missing: 5 }],
    });
  });

  it('accepts a key repeated with identical values and keeps it once', async () => {
    const state = await setup();

    const report = await state.backend.run(definitionsJob([lookup({ url: duplicates })]), signal());

    expect(report).toMatchObject({ stored: 26, promoted: true });
    expect(report.source).toEqual({
      lookups: [{ file: duplicates, rows: 13, keys: 12, matched: 21, missing: 5 }],
    });
  });

  it('refuses a key repeated with different values, keeps the previous generation and cleans up', async () => {
    const state = await setup();
    await state.backend.run(definitionsJob(undefined, 'good'), signal());

    await expect(
      state.backend.run(definitionsJob([lookup({ url: conflicting })], 'bad'), signal()),
    ).rejects.toThrow(/has key EU-03 twice with different values/);

    expect(await state.route.writer.active(state.route.dataset)).toBe('good');
    expect(await readdir(state.root)).toEqual([]);
  });

  it('fails the run when the lookup file has more rows than maxRows, and accepts exactly maxRows', async () => {
    const state = await setup();

    await expect(
      state.backend.run(definitionsJob([lookup({ maxRows: 11 })], 'over'), signal()),
    ).rejects.toThrow(/has more than 11 rows/);
    expect(await readdir(state.root)).toEqual([]);
    await expect(
      state.backend.run(definitionsJob([lookup({ maxRows: 12 })], 'exact'), signal()),
    ).resolves.toMatchObject({ promoted: true });
  });

  it('caps a lookup download at the platform ceiling even when the lookup allows more', async () => {
    const state = await setup(undefined, 256);

    await expect(
      state.backend.run(definitionsJob([lookup({ maxBytes: 1024 * 1024 })]), signal()),
    ).rejects.toThrow(/size limit/);
    expect(await readdir(state.root)).toEqual([]);
  });

  it('fails the run when the key map passes maxMemoryBytes', async () => {
    const state = await setup();

    await expect(
      state.backend.run(definitionsJob([lookup({ maxMemoryBytes: 1024 })]), signal()),
    ).rejects.toThrow(/needs more than 1024 bytes/);
    expect(await readdir(state.root)).toEqual([]);
  });

  it('reads a Hugging Face lookup file from the same dataset and revision as the source', async () => {
    const state = await setup();

    const report = await state.backend.run(
      job({
        huggingface: {
          dataset: 'kelkalot/every-ai-policy-ever',
          file: 'data/definitions.parquet',
          revision: 'v1.18',
        },
        mapping: mapping([
          { file: 'data/records.parquet', key: 'id', on: 'record_id', fields: ['jurisdiction'] },
        ]),
      }),
      signal(),
    );

    expect(state.fetched).toEqual([
      `${hfBase}data/records.parquet`,
      `${hfBase}data/definitions.parquet`,
    ]);
    expect(report.source).toMatchObject({
      lookups: [{ file: 'data/records.parquet', matched: 21 }],
    });
  });

  it('keeps document ids the same with and without a lookup', async () => {
    const state = await setup();
    await state.backend.run(definitionsJob([], 'plain'), signal());
    const plain = (await state.documents()).map((d) => d.id).sort();

    await state.backend.run(definitionsJob(undefined, 'joined'), signal());

    expect((await state.documents()).map((d) => d.id).sort()).toEqual(plain);
    expect(plain).toContain(documentId(`${definitions}#D0002`));
  });

  it('reads the lookup before the first shard, with one file on disk at a time, and cleans up', async () => {
    const state: Awaited<ReturnType<typeof setup>> = await setup(async (url) => {
      expect(await readdir(state.root)).toHaveLength(1);
      return new Response(fixture(files[url] as string));
    });

    const report = await state.backend.run(
      job({
        urls: ['https://data.example/b.parquet', 'https://data.example/a.parquet'],
        table: 'train',
        mapping: {
          fields: { id: 'id', title: 'title', text: ['body'] },
          lookups: [lookup({ on: 'id' })],
        },
      }),
      signal(),
    );

    expect(state.fetched).toEqual([
      records,
      'https://data.example/a.parquet',
      'https://data.example/b.parquet',
    ]);
    expect(report).toMatchObject({ stored: 4, promoted: true });
    expect(report.source).toMatchObject({ lookups: [{ matched: 0, missing: 4 }] });
    expect(await readdir(state.root)).toEqual([]);
  });

  it('adds no source facts to the report of a single-file or sharded spec without lookups', async () => {
    const state = await setup();

    const single = await state.backend.run(definitionsJob([], 'single'), signal());
    const sharded = await state.backend.run(
      job(
        {
          urls: ['https://data.example/a.parquet', 'https://data.example/b.parquet'],
          table: 'train',
          mapping: { fields: { id: 'id', title: 'title', text: ['body'] } },
        },
        'sharded',
      ),
      signal(),
    );

    expect(single).toMatchObject({ stored: 26, promoted: true });
    expect(sharded).toMatchObject({ stored: 4, promoted: true });
    expect('source' in single || 'source' in sharded).toBe(false);
    expect(state.fetched).not.toContain(records);
  });

  it('cleans the lookup file when it cannot be decoded, and fails the run', async () => {
    const state = await setup((url) =>
      url === records ? new Response('not parquet') : new Response(fixture(files[url] as string)),
    );

    await expect(state.backend.run(definitionsJob(), signal())).rejects.toThrow(/Parquet/);
    expect(await readdir(state.root)).toEqual([]);
    expect(state.fetched).toEqual([records]);
  });

  it('fails when the lookup file lacks a field column or the source lacks the on column', async () => {
    const state = await setup();

    await expect(
      state.backend.run(definitionsJob([lookup({ fields: ['nope'] })], 'field'), signal()),
    ).rejects.toThrow(`the Parquet lookup ${records} has no column nope`);
    await expect(
      state.backend.run(definitionsJob([lookup({ on: 'law_id' })], 'on'), signal()),
    ).rejects.toThrow('the Parquet file has no column law_id');
    expect(await readdir(state.root)).toEqual([]);
  });

  it('refuses a lookup file without a huggingface source, both file and url, and a joined name stored twice', () => {
    const spec = (source: object) =>
      pipelineSpec.safeParse({ name: 'p', source: { kind: 'parquet', ...source } });
    const messages = (source: object) => {
      const parsed = spec(source);
      return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    };

    expect(
      messages({
        url: definitions,
        mapping: mapping([
          { file: 'data/records.parquet', key: 'id', on: 'record_id', fields: ['jurisdiction'] },
        ]),
      }),
    ).toContain('a lookup file needs a huggingface source; use url otherwise');
    expect(
      messages({ url: definitions, mapping: mapping([lookup({ file: 'data/records.parquet' })]) }),
    ).toContain('a lookup needs exactly one of file and url');
    expect(
      messages({ url: definitions, mapping: mapping([lookup({ fields: ['record_id'] })]) }),
    ).toContain('record_id is stored twice');
    expect(
      spec({ url: definitions, mapping: mapping([lookup(), lookup(), lookup(), lookup()]) })
        .success,
    ).toBe(false);
  });
});
