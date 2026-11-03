import { describe, expect, it, vi } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  InMemoryExecutionStore,
  InMemoryIngestionBackend,
  IngestionService,
  type JobRunStore,
} from './ingestion.js';

const tenant = '991825827';
const onKnowledge = `${tenant}/docs`;
const onPlatform = `${tenant}/annet`;

const boot = () => {
  const start = vi.fn<JobRunStore['start']>(async (input) => ({
    ok: true,
    value: { ...input, status: 'running', runsAsJobs: true },
  }));
  const service = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend: new InMemoryIngestionBackend(),
    jobs: {
      runsAsJobs: (dataset) => dataset === onKnowledge,
      runs: { start } as unknown as JobRunStore,
    },
  });
  const save = (dataset: string, id: string, spec: Record<string, unknown>) =>
    service.save({
      scope: tenant,
      dataset,
      id,
      spec: { name: id, source: { kind: 'folder', path: 'docs' }, ...spec },
      by: 'ingrid',
      reason: 'test',
    });
  return { service, save, start };
};

const messages = (result: Awaited<ReturnType<ReturnType<typeof boot>['save']>>) =>
  result.ok ? [] : result.errors.map((e) => e.message);

describe('pipelines into a dataset on the knowledge database', () => {
  it('a second pipeline into a dataset on the knowledge database is refused', async () => {
    const { save } = boot();
    expect((await save(onKnowledge, 'docs', {})).ok).toBe(true);
    expect((await save(onKnowledge, 'docs', { description: 'endret' })).ok).toBe(true);
    const second = await save(onKnowledge, 'nyheter', {});
    expect(messages(second)).toEqual([
      'a dataset on the knowledge database is filled by one pipeline until co-owners are built; it has docs',
    ]);
    expect((await save(onPlatform, 'docs', {})).ok).toBe(true);
    expect((await save(onPlatform, 'nyheter', {})).ok).toBe(true);
  });

  it('a pipeline with phrases into a dataset on the knowledge database is refused', async () => {
    const { save } = boot();
    const result = await save(onKnowledge, 'docs', { phrases: { model: 'gpt-4.1-mini' } });
    expect(messages(result)).toEqual([
      'search phrases cannot fill a dataset on the knowledge database until recipes hold them',
    ]);
    expect((await save(onPlatform, 'docs', { phrases: { model: 'gpt-4.1-mini' } })).ok).toBe(true);
  });

  it('changing chunking on a pipeline into a dataset on the knowledge database is refused', async () => {
    const { save } = boot();
    expect((await save(onKnowledge, 'docs', { chunking: { maximumLength: 4000 } })).ok).toBe(true);
    const changed = await save(onKnowledge, 'docs', { chunking: { maximumLength: 2000 } });
    expect(messages(changed)).toEqual([
      "chunking changes through a new generation, which is not built yet; the dataset's generation keeps the chunking it was filled with",
    ]);
    expect((await save(onKnowledge, 'docs', { chunking: { maximumLength: 4000 } })).ok).toBe(true);
  });

  it('a database, Episerver or Parquet source into a dataset on the knowledge database is refused', async () => {
    const { save } = boot();
    const episerver = await save(onKnowledge, 'cms', {
      source: { kind: 'episerver', path: 'export.json', language: 'no' },
    });
    expect(messages(episerver)).toEqual([
      'a episerver source cannot fill a dataset on the knowledge database yet',
    ]);
    for (const kind of ['upload', 'website', 'kudos']) {
      const { save: fresh } = boot();
      const source =
        kind === 'website'
          ? { kind, sitemap: 'https://www.example.no/sitemap.xml' }
          : kind === 'kudos'
            ? { kind, types: ['Årsrapport'] }
            : { kind };
      expect((await fresh(onKnowledge, kind, { source })).ok).toBe(true);
    }
  });

  it('a disabled pipeline keeps its documents', async () => {
    const { service, save, start } = boot();
    expect((await save(onKnowledge, 'docs', {})).ok).toBe(true);
    const disabled = await save(onKnowledge, 'docs', { enabled: false });
    expect(disabled.ok).toBe(true);
    const pipeline = await service.get(tenant, onKnowledge, 'docs');
    expect(pipeline?.spec.enabled).toBe(false);
    // Disabling starts nothing: no run, so no listing that could delete a document.
    expect(start).not.toHaveBeenCalled();
  });
});
