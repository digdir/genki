import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { InMemoryExecutionStore, InMemoryIngestionBackend, IngestionService } from './ingestion.js';

const service = () =>
  new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend: new InMemoryIngestionBackend(() => []),
  });

const save = (ingestion: IngestionService, dataset: string, id: string) =>
  ingestion.save({
    scope: 'platform',
    dataset,
    id,
    spec: { name: id, source: { kind: 'upload' } },
    by: 'kari',
    reason: 'test',
  });

describe('one pipeline per dataset', () => {
  it('refuses a second pipeline on a dataset, since each run replaces the index the other built', async () => {
    const ingestion = service();
    expect(await save(ingestion, 'digdir/rapporter', 'forste')).toMatchObject({ ok: true });

    const second = await save(ingestion, 'digdir/rapporter', 'andre');

    expect(second).toMatchObject({ ok: false, errors: [{ path: 'id' }] });
    expect(second.ok ? '' : second.errors[0]?.message).toContain(
      'already filled by pipeline forste',
    );
    expect((await ingestion.list('platform', 'digdir/rapporter')).map((p) => p.id)).toEqual([
      'forste',
    ]);
  });

  it('still saves new versions of the same pipeline, pipelines on other datasets, and a new one after a delete', async () => {
    const ingestion = service();
    await save(ingestion, 'digdir/rapporter', 'forste');

    expect(await save(ingestion, 'digdir/rapporter', 'forste')).toMatchObject({ ok: true });
    expect(await save(ingestion, 'digdir/rapporter-definisjoner', 'andre')).toMatchObject({
      ok: true,
    });
    await ingestion.remove({
      scope: 'platform',
      dataset: 'digdir/rapporter',
      id: 'forste',
      by: 'kari',
      reason: 'test',
    });
    expect(await save(ingestion, 'digdir/rapporter', 'tredje')).toMatchObject({ ok: true });
  });
});
