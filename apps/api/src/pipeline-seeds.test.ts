import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { serviceDefinition } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { IndexWriterRouter, KnowledgeRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { loadCatalog } from './catalogs.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { indexIngestionBackend } from './index-ingestion.js';
import { InMemoryExecutionStore, InMemoryIngestionBackend, IngestionService } from './ingestion.js';
import { pipelineSeedActor, readPipelineSeeds, seedPipelines } from './pipeline-seeds.js';

const repo = join(import.meta.dirname, '..', '..', '..');
const local = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(local, file), 'utf8')) as unknown;
const signal = new AbortController().signal;

const service = () =>
  new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend: new InMemoryIngestionBackend(() => []),
  });

const seed = (name: string) => ({
  dataset: 'digdir/genki-docs',
  id: 'genki-docs',
  spec: {
    name,
    source: { kind: 'folder' as const, path: '.', include: ['README.md'] },
    chunking: {
      strategy: { kind: 'header-based' as const },
      minimumLength: 200,
      maximumLength: 4000,
      metadataStyle: 'json' as const,
    },
    parallelism: 2,
    maxDocumentFailures: 10,
    enabled: true,
    schedule: 'none' as const,
  },
});

const genkiDocs = () => {
  const found = readPipelineSeeds(join(local, 'pipelines')).seeds.find(
    (s) => s.id === 'genki-docs',
  );
  if (!found) throw new Error('no genki-docs pipeline seed');
  return found;
};

describe('pipeline seeds', () => {
  it('reads every local pipeline seed without errors, each for a dataset in the knowledge catalog', () => {
    const read = readPipelineSeeds(join(local, 'pipelines'));
    const datasets = (yaml('knowledge.yaml') as { datasets: { id: string }[] }).datasets.map(
      (d) => d.id,
    );

    expect(read.unreadable).toEqual([]);
    expect(read.seeds.length).toBeGreaterThan(0);
    for (const s of read.seeds) expect(datasets).toContain(s.dataset);
  });

  it('creates a missing pipeline in the platform scope as the seed', async () => {
    const ingestion = service();

    expect(await seedPipelines(ingestion, [seed('Docs')])).toMatchObject([{ state: 'created' }]);
    expect(await ingestion.get(platformScope, 'digdir/genki-docs', 'genki-docs')).toMatchObject({
      by: pipelineSeedActor,
      spec: { name: 'Docs' },
    });
    expect(await seedPipelines(ingestion, [seed('Docs')])).toMatchObject([{ state: 'present' }]);
  });

  it('updates a pipeline only the seed has saved, and leaves one a person changed alone', async () => {
    const ingestion = service();
    await seedPipelines(ingestion, [seed('Docs')]);

    expect(await seedPipelines(ingestion, [seed('Docs v2')])).toMatchObject([{ state: 'updated' }]);
    await ingestion.save({
      scope: platformScope,
      dataset: 'digdir/genki-docs',
      id: 'genki-docs',
      spec: seed('Changed by Kari').spec,
      by: 'employee:test:kari',
      reason: 'test',
    });

    expect(await seedPipelines(ingestion, [seed('Docs v3')])).toMatchObject([{ state: 'kept' }]);
    expect((await ingestion.get(platformScope, 'digdir/genki-docs', 'genki-docs'))?.spec.name).toBe(
      'Changed by Kari',
    );
  });
});

describe('the GenKI docs', () => {
  it('are a pgvector dataset that embeds with a configured embedding model', () => {
    const env = { FOUNDRY_OPENAI_BASE_URL: 'https://foundry.example' };
    const catalog = loadCatalog(local, 'knowledge.yaml', 'datasets', env).catalog as {
      endpoints: Record<string, { engine: string }>;
      datasets: {
        id: string;
        endpoint: string;
        embedding?: { model: string; dimensions: number };
      }[];
    };
    const docs = catalog.datasets.find((d) => d.id === 'digdir/genki-docs');
    const models = (
      loadCatalog(local, 'embeddings.yaml', 'models', env).catalog as {
        models: { id: string; dimensions: number }[];
      }
    ).models;

    expect(docs).toMatchObject({ name: 'GenKI-dokumentasjon', endpoint: 'platform-pg' });
    expect(catalog.endpoints[docs?.endpoint ?? '']?.engine).toBe('pgvector');
    expect(models.find((m) => m.id === docs?.embedding?.model)?.dimensions).toBe(
      docs?.embedding?.dimensions,
    );
  });

  it('answer through the GenKI guide in chat and the OpenAI API, with sources, from that dataset only', () => {
    const guide = serviceDefinition.parse(yaml('services/genki-guide.yaml'));
    const kunnskapsassistenten = serviceDefinition.parse(
      yaml('services/kunnskapsassistenten.yaml'),
    );

    expect(guide.spec.knowledge?.datasets?.map((d) => d.dataset)).toEqual(['digdir/genki-docs']);
    expect(guide.spec.output).toMatchObject({ kind: 'answer', withSources: true });
    expect(guide.spec.exposure).toMatchObject({ chat: true, openai: true });
    expect(guide.spec.model?.primary).toBe(kunnskapsassistenten.spec.model?.primary);
    expect(readFileSync(join(local, 'prompts', 'genki-guide.nb.md'), 'utf8')).toMatch(
      /Nevn aldri en filsti/,
    );
  });

  it('guide searches with the atlas context and several queries before saying the docs do not cover it', () => {
    const prompt = readFileSync(join(local, 'prompts', 'genki-guide.nb.md'), 'utf8');

    expect(prompt).toContain('Context from the atlas');
    expect(prompt).toMatch(/pakkenavnene .* som søkeord/);
    expect(prompt).toMatch(/minst tre ulike søk.*før du konkluderer/);
    expect(prompt).toMatch(/si at det kommer fra System Atlas/);
    expect(prompt).not.toContain('\u2014');
  });
});

const index = async () => {
  const engine = memoryEngine();
  const catalog = {
    endpoints: { local: { engine: 'memory' } },
    datasets: [{ id: 'digdir/genki-docs', endpoint: 'local', residency: 'global' as const }],
  };
  const writers = new IndexWriterRouter({
    catalog,
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const pipeline = genkiDocs();
  const report = await indexIngestionBackend({
    writers,
    residencyOf: () => 'global',
    folderRoot: repo,
    platformTenant: 'digdir',
  }).run(
    {
      execution: 'x1',
      pipeline: { ...pipeline, version: 1, by: 'test', at: '2026-10-16T10:00:00Z', reason: 't' },
      target: { dataset: 'digdir/genki-docs', endpoint: 'local', collections: {} },
    },
    signal,
  );
  const port = new KnowledgeRouter({
    catalog,
    adapters: [engine.adapter],
    secrets: envSecrets({}),
  }).open(
    { kind: 'dataset', id: 'digdir/genki-docs' },
    {
      tenant: 'digdir',
      principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: 'digdir' },
      task: 't1',
      signal,
      meter: async () => undefined,
    },
  );
  const search = async (query: string) =>
    (await port.search({ query, profile: port.info().profiles[0] ?? '', limit: 50 })).hits;
  return { report, search };
};

let indexed: ReturnType<typeof index> | undefined;
const indexGenkiDocs = () => (indexed ??= index());

describe('the indexed GenKI docs', () => {
  it('are read from the repository with a GitHub link to each file and the first heading as title', async () => {
    const { report, search } = await indexGenkiDocs();

    expect(report).toMatchObject({ skipped: 0, failed: [] });
    expect(report.stored).toBeGreaterThan(40);

    const found = await search('GENAI_LOCKDOWN');
    const urls = found.map((h) => h.url);

    expect(urls).toContain(
      'https://github.com/digdir/genki/blob/main/docs/adr/0033-locked-test-environment.md',
    );
    expect(found.find((h) => h.url?.endsWith('0033-locked-test-environment.md'))?.title).toBe(
      '0033 Locked test environment',
    );
    expect(urls.every((u) => u?.startsWith('https://github.com/digdir/genki/blob/main/'))).toBe(
      true,
    );
  });

  it('include the System Atlas module files, titled by their name and linked with .yaml, without the order list', async () => {
    expect(genkiDocs().spec.source).toMatchObject({
      include: expect.arrayContaining(['docs/architecture/modules/*.yaml']),
      extensions: expect.arrayContaining(['.yaml']),
    });

    const { search } = await indexGenkiDocs();
    const client = (await search('@genai/client contract suite')).find((h) =>
      h.url?.endsWith('/modules/client.yaml'),
    );

    expect(client).toMatchObject({
      title: 'Frontend client',
      url: 'https://github.com/digdir/genki/blob/main/docs/architecture/modules/client.yaml',
    });
    expect((await search('mcp-clients')).map((h) => h.url)).not.toContain(
      'https://github.com/digdir/genki/blob/main/docs/architecture/modules/order.yaml',
    );
  });
});
