import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { logFailedIngestion } from './ingestion-failure-log.js';
import { InMemoryExecutionStore, IngestionService, type IngestionBackend } from './ingestion.js';

const tenant = '991825827';
const dataset = `${tenant}/sider`;
const target = { dataset, endpoint: `${tenant}/sok`, collections: {} };

const runWith = async (backend: IngestionBackend) => {
  const service = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend,
  });
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  logFailedIngestion(service, (msg, fields) => lines.push({ msg, fields }));
  const saved = await service.save({
    scope: tenant,
    dataset,
    id: 'nettsider',
    spec: {
      name: 'Nettsidene',
      source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
      chunking: { minimumLength: 1 },
      schedule: 'none',
    },
    by: 'kari',
    reason: 'Test',
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
  const started = await service.execute({ pipeline: saved.value, target, by: 'kari' });
  if (!started.ok) throw new Error(JSON.stringify(started.errors));
  await started.done;
  return { run: started.value, lines };
};

describe('ingestion failure log', () => {
  it('logs a failed ingestion run by its ids, without the error text', async () => {
    const { run, lines } = await runWith({
      name: 'test',
      available: true,
      run: async () => {
        throw new Error('https://intern.example/hemmelig answered 500');
      },
    });
    expect(lines).toEqual([
      {
        msg: 'ingestion run failed',
        fields: { execution: run.id, dataset, pipeline: 'nettsider', backend: 'test' },
      },
    ]);
  });

  it('logs nothing for a run that succeeds', async () => {
    const { lines } = await runWith({
      name: 'test',
      available: true,
      run: async () => ({ stored: 1, skipped: 0, failed: [] }),
    });
    expect(lines).toEqual([]);
  });
});
