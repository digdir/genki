import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { folderSource, runIndexIngest } from '@genai/ingest';
import { fakeEmbedder } from '@genai/port-embedding/testing';
import {
  IndexWriterRouter,
  type IndexDocument,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import { memoryEngine, openTarget } from '@genai/port-knowledge/testing';
import { pgvectorEngine } from '@genai/providers-pgvector';
import { createPool } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { InMemoryConfigEntryStore } from './config-store.js';
import { indexIngestionBackend } from './index-ingestion.js';
import { IngestionService, InMemoryExecutionStore, type Pipeline } from './ingestion.js';

let ids = 0;
describe.each(['memory', 'pgvector'])('pipeline carry-forward on %s', (kind) => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: ReturnType<typeof createPool> | undefined;
  let adapters: { writer: IndexWriterAdapter; adapter: KnowledgeAdapter };
  const roots: string[] = [];
  beforeAll(async () => {
    if (kind === 'pgvector') {
      container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
      pool = createPool({ connectionString: container.getConnectionUri() });
      const engine = pgvectorEngine({ pool });
      adapters = {
        writer: engine.writer as IndexWriterAdapter,
        adapter: engine.adapter as KnowledgeAdapter,
      };
    } else adapters = memoryEngine();
  }, 120_000);
  afterAll(async () => {
    await stopPostgres(container, pool ? [pool] : []);
  });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const boot = async (beforePromote?: () => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-carry-'));
    roots.push(root);
    await writeFile(join(root, 'a.md'), '# Tilskudd\n\nKommunen gir tilskudd til foreninger.');
    await writeFile(
      join(root, 'b.md'),
      '# Skyplattform\n\nEtaten flytter tjenester til en skyplattform.',
    );
    const id = `digdir/carry-${++ids}`;
    const endpoint = {
      engine: kind,
      ...(kind === 'pgvector' ? { options: { connection: 'platform' } } : {}),
    };
    const writerAdapter: IndexWriterAdapter = beforePromote
      ? {
          ...adapters.writer,
          connect: (endpoint, context) => {
            const writer = adapters.writer.connect(endpoint, context);
            const promote = writer.promoteIfActive?.bind(writer);
            if (!promote) throw new Error('test writer needs conditional promotion');
            return {
              ...writer,
              promoteIfActive: async (...args) => {
                await beforePromote();
                return promote(...args);
              },
            };
          },
        }
      : adapters.writer;
    const writers = new IndexWriterRouter({
      catalog: {
        endpoints: { local: endpoint },
        datasets: [{ id, endpoint: 'local', residency: 'norway' }],
      },
      adapters: [writerAdapter],
      knowledgeAdapters: [adapters.adapter],
      secrets: envSecrets({}),
    });
    const backend = indexIngestionBackend({
      writers,
      platformTenant: '991825827',
      folderRoot: root,
      residencyOf: () => 'norway',
    });
    const store = new InMemoryConfigEntryStore();
    const ingestion = new IngestionService({
      store,
      executions: new InMemoryExecutionStore(),
      backend,
    });
    const save = async (
      pipeline: string,
      scope = 'platform',
      enabled = true,
      metadataStyle: 'none' | 'json' = 'json',
    ) => {
      const saved = await ingestion.save({
        scope,
        dataset: id,
        id: pipeline,
        spec: {
          name: pipeline,
          enabled,
          source: { kind: 'folder', path: '.', include: [`${pipeline}.md`] },
          chunking: { minimumLength: 1, metadataStyle },
        },
        by: 'kari',
        reason: 'Test pipeline carry forward',
      });
      if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
      return saved.value;
    };
    const target = { dataset: id, endpoint: 'local', collections: {} };
    const run = async (pipeline: Pipeline, scope = 'platform') => {
      const started = await ingestion.execute({
        pipeline,
        target,
        scope,
        tenant: '991825827',
        by: 'kari',
      });
      if (!started.ok) throw new Error(JSON.stringify(started.errors));
      const execution = await started.done;
      expect(execution, execution.error).toMatchObject({
        status: 'succeeded',
        report: { promoted: true },
      });
      return execution;
    };
    const route = writers.open(id, { signal: new AbortController().signal });
    const search = (query: string) =>
      openTarget({ adapter: adapters.adapter, endpoint }, route.dataset).search({
        query,
        profile: 'content',
      });
    const owners = async () => {
      const owners: unknown[] = [];
      for await (const doc of route.writer.read?.(route.dataset) ?? []) owners.push(doc.pipeline);
      return owners.sort();
    };
    return { root, id, ingestion, store, backend, target, save, run, route, search, owners };
  };

  it('normal service runs a then b keep both searchable, including platform pipelines run by the platform tenant', async () => {
    const { save, run, search, owners } = await boot();
    const a = await save('a'),
      b = await save('b');
    await run(a);
    await run(b);
    expect((await search('foreninger')).hits).toHaveLength(1);
    expect((await search('skyplattform')).hits).toHaveLength(1);
    expect(await owners()).toEqual(['a', 'b']);
  });

  it.each(['deleted', 'disabled'])(
    'a %s sibling drops out at the next normal service run',
    async (state) => {
      const { id, ingestion, save, run, search, owners } = await boot();
      const a = await save('a'),
        b = await save('b');
      await run(a);
      await run(b);
      if (state === 'deleted')
        await ingestion.remove({
          scope: 'platform',
          dataset: id,
          id: 'b',
          by: 'kari',
          reason: 'Delete sibling pipeline',
        });
      else await save('b', 'platform', false);
      await run(a);
      expect((await search('foreninger')).hits).toHaveLength(1);
      expect((await search('skyplattform')).hits).toEqual([]);
      expect(await owners()).toEqual(['a']);
    },
  );

  it('pipelines in a different scope do not preserve documents for a single-pipeline dataset', async () => {
    const { save, run, owners } = await boot();
    const a = await save('a'),
      b = await save('b', '991825827');
    await run(b, '991825827');
    await run(a);
    expect(await owners()).toEqual(['a']);
  });

  it('turning source metadata off still attributes documents and preserves siblings', async () => {
    const { save, run, owners } = await boot();
    const a = await save('a', 'platform', true, 'none'),
      b = await save('b', 'platform', true, 'none');
    await run(a);
    await run(b);
    expect(await owners()).toEqual(['a', 'b']);
  });

  it.each(['same model', 'changed model with siblings', 'changed model without siblings'])(
    'copies stored vectors only with compatible model provenance: %s',
    async (scenario) => {
      const { root, route, search } = await boot();
      const embedder = fakeEmbedder({ dimensions: 8 });
      const dataset = { ...route.dataset, embedding: { model: 'fake/embedder', dimensions: 8 } };
      const source = (name: string) =>
        folderSource({
          entries: [{ path: `${root}/${name}.md`, lastmod: '1' }],
          basePath: `${root}/`,
          read: async () =>
            name === 'a'
              ? '# Tilskudd\n\nTilskudd til foreninger.'
              : '# Skyplattform\n\nEn skyplattform.',
        });
      const target = (generation: string) => ({
        dataset,
        writer: route.writer,
        generation,
        needs: { vectors: true },
        embedder,
      });
      const chunking = {
        strategy: { kind: 'header-based' as const },
        minimumLength: 1,
        maximumLength: 4000,
        metadataStyle: 'pr' as const,
      };
      await runIndexIngest({
        source: source('a'),
        chunking,
        pipeline: { id: 'a', siblings: ['b'] },
        target: target('a1'),
      });
      let original: IndexDocument | undefined;
      for await (const doc of route.writer.read?.(dataset) ?? []) original = doc;
      const calls = embedder.calls.length;
      expect(original?.embeddingModel).toBe('fake/embedder');
      const changed = scenario !== 'same model';
      const next = changed ? fakeEmbedder({ id: 'new-model', dimensions: 8 }) : embedder;
      const result = runIndexIngest({
        source: source('b'),
        chunking,
        pipeline: { id: 'b', siblings: scenario === 'changed model without siblings' ? [] : ['a'] },
        target: {
          ...target('b1'),
          dataset: { ...dataset, embedding: { model: next.info().id, dimensions: 8 } },
          embedder: next,
        },
      });
      if (scenario === 'changed model with siblings') {
        await expect(result).rejects.toThrow(/embedding model changed.*combined rebuild/);
        expect(next.calls).toEqual([]);
        expect(await route.writer.active(dataset)).toBe('a1');
        expect((await search('foreninger')).hits).toHaveLength(1);
        return;
      }
      expect(await result).toMatchObject({ promoted: true });
      const indexed: IndexDocument[] = [];
      for await (const doc of route.writer.read?.(dataset) ?? []) indexed.push(doc);
      if (changed) {
        expect(indexed).toHaveLength(1);
        expect(indexed[0]?.embeddingModel).toBe('new-model');
        expect((await search('foreninger')).hits).toHaveLength(0);
        expect((await search('skyplattform')).hits).toHaveLength(1);
        return;
      }
      expect(indexed).toHaveLength(2);
      expect(indexed.find((d) => d.pipeline === 'a')).toEqual(original);
      expect(embedder.calls.slice(calls).flat()).toEqual([expect.stringContaining('skyplattform')]);
      expect((await search('foreninger')).hits).toHaveLength(1);
      expect((await search('skyplattform')).hits).toHaveLength(1);
    },
  );

  it('overlapping service instances cannot promote a stale sibling snapshot and a retry keeps both sources', async () => {
    let overlapping = false,
      arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforePromote = async () => {
      if (!overlapping) return;
      if (++arrived === 2) release();
      await gate;
    };
    const { store, backend, ingestion, save, run, target, owners } = await boot(beforePromote);
    const a = await save('a'),
      b = await save('b');
    await run(a);
    const second = new IngestionService({
      store,
      backend,
      executions: new InMemoryExecutionStore(),
    });
    overlapping = true;
    const started = await Promise.all([
      ingestion.execute({ pipeline: a, target, scope: 'platform', by: 'kari' }),
      second.execute({ pipeline: b, target, scope: 'platform', by: 'kari' }),
    ]);
    const results = await Promise.all(
      started.map((s) => {
        if (!s.ok) throw new Error(JSON.stringify(s.errors));
        return s.done;
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['failed', 'succeeded']);
    expect(results.find((r) => r.status === 'failed')?.error).toContain('changed during ingestion');
    overlapping = false;
    await run(results[0]?.status === 'failed' ? a : b);
    expect(await owners()).toEqual(['a', 'b']);
  });
});
