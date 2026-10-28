import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  InMemoryExecutionStore,
  IngestionService,
  type Execution,
  type IngestionBackend,
} from './ingestion.js';

const tenant = '991825827';
const dataset = `${tenant}/sider`;
const target = { dataset, endpoint: `${tenant}/sok`, collections: {} };

const waitsForCancel: IngestionBackend = {
  name: 'test',
  available: true,
  run: (_job, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    }),
};

class RefusesCancelled extends InMemoryExecutionStore {
  override async save(execution: Execution) {
    if (execution.status === 'cancelled')
      throw new Error('violates check constraint "ingestion_executions_status_check"');
    await super.save(execution);
  }
}

const start = async (executions: InMemoryExecutionStore, errors: string[] = []) => {
  const service = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions,
    backend: waitsForCancel,
    onError: (message) => errors.push(message),
  });
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
  return { service, started };
};

describe('cancelling an ingestion run', () => {
  it('stores the run as cancelled', async () => {
    const executions = new InMemoryExecutionStore();
    const { service, started } = await start(executions);

    service.cancel({ dataset, execution: started.value.id, by: 'kari' });
    await started.done;

    expect(await executions.get(started.value.id)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'kari',
    });
  });

  it('settles and frees the dataset when the run cannot be saved', async () => {
    const errors: string[] = [];
    const { service, started } = await start(new RefusesCancelled(), errors);

    service.cancel({ dataset, execution: started.value.id, by: 'kari' });

    await expect(started.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(errors).toEqual([expect.stringContaining('was not saved')]);
    expect(service.cancel({ dataset, execution: started.value.id, by: 'kari' }).ok).toBe(false);
  });
});
