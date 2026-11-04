import { describe, expect, it } from 'vitest';
import { pipelineSpec } from '@genai/ingest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { InMemoryExecutionStore, IngestionService, type IngestionBackend } from './ingestion.js';
import { seedPipelines } from './pipeline-seeds.js';

const dataset = 'digdir/kudos';
const u1 = 'de77ffc7-1a57-456a-af49-167e699a4e6e';
const u2 = 'a2b1e2f5-0eaa-4a34-a287-017e4e65727f';
const u3 = 'e1791a13-38bd-4f11-b548-4603b988f48b';

const idle: IngestionBackend = {
  name: 'test',
  available: true,
  run: () => new Promise(() => undefined),
};

const slice = {
  kind: 'kudos',
  types: ['Årsrapport', 'Evaluering'],
  since: '2020-01-01',
  until: '2024-12-31',
  orgs: ['Digdir', 'NAV'],
  documents: [u1, u2],
};

const without = (...keys: string[]) =>
  Object.fromEntries(Object.entries(slice).filter(([key]) => !keys.includes(key)));

const service = async () => {
  const ingestion = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend: idle,
  });
  const first = await save(ingestion, slice);
  if (!first.ok) throw new Error(JSON.stringify(first.errors));
  return ingestion;
};

const save = (ingestion: IngestionService, source: Record<string, unknown>) =>
  ingestion.save({
    scope: 'digdir',
    dataset,
    id: 'kudos',
    spec: { name: 'Kudos', source },
    by: 'kari',
    reason: 'Test',
  });

describe('Kudos slices', () => {
  it('a pipeline change that narrows a Kudos slice is refused (since, until, documents, types, orgs)', async () => {
    const narrowed: [string, Record<string, unknown>, RegExp][] = [
      [
        'spec.source.since',
        { since: '2022-01-01' },
        /startdatoen flyttes fra 2020-01-01 til 2022-01-01/,
      ],
      [
        'spec.source.until',
        { until: '2023-12-31' },
        /sluttdatoen flyttes fra 2024-12-31 til 2023-12-31/,
      ],
      ['spec.source.documents', { documents: [u1] }, new RegExp(`dokumentene mister ${u2}`)],
      ['spec.source.types', { types: ['Årsrapport'] }, /dokumenttypene mister Evaluering/],
      ['spec.source.orgs', { orgs: ['Digdir'] }, /virksomhetene mister NAV/],
    ];
    for (const [path, change, message] of narrowed) {
      const ingestion = await service();
      const saved = await save(ingestion, { ...slice, ...change });

      expect(saved.ok, path).toBe(false);
      if (saved.ok) continue;
      expect(saved.errors[0]?.path).toBe(path);
      expect(saved.errors[0]?.message).toMatch(message);
      expect(saved.errors[0]?.message).toMatch(/kan bare utvides/);
    }

    const ingestion = await service();
    const open = await save(ingestion, without('until'));
    expect(open.ok).toBe(true);
    const closed = await save(ingestion, slice);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.errors[0]?.message).toMatch(/en sluttdato settes \(2024-12-31\)/);
  });

  it('a pipeline change that widens a Kudos slice is saved', async () => {
    const ingestion = await service();
    for (const source of [
      { ...slice, since: '2018-01-01' },
      { ...slice, since: '2018-01-01', until: '2025-12-31' },
      { ...slice, since: '2018-01-01', until: '2025-12-31', documents: [u1, u2, u3] },
      {
        ...slice,
        since: '2018-01-01',
        until: '2025-12-31',
        documents: [u1, u2, u3],
        types: ['Årsrapport', 'Evaluering', 'Instruks'],
      },
      { ...without('until', 'orgs', 'documents'), since: '2018-01-01', types: [] },
    ]) {
      const saved = await save(ingestion, source);
      expect(saved.ok, JSON.stringify(source)).toBe(true);
    }
  });

  it('a narrowed Kudos pipeline in the configuration is refused with the reason', async () => {
    const ingestion = new IngestionService({
      store: new InMemoryConfigEntryStore(),
      executions: new InMemoryExecutionStore(),
      backend: idle,
    });
    const seed = (since: string) => ({
      dataset,
      id: 'kudos',
      spec: pipelineSpec.parse({
        name: 'Kudos',
        source: { kind: 'kudos', types: ['Årsrapport'], since },
      }),
    });
    await seedPipelines(ingestion, [seed('2020-01-01')]);
    const [outcome] = await seedPipelines(ingestion, [seed('2022-01-01')]);

    expect(outcome).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(outcome)).toMatch(/startdatoen flyttes/);
  });
});
