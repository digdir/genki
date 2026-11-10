import { InMemoryProviderObjects, type LedgerObject } from '@genai/kernel';
import { describe, expect, it } from 'vitest';
import { sweepProviderObjects } from './provider-object-sweep.js';

const object = (id: string, deleteBy: string): LedgerObject => ({
  tenant: '991825827',
  run: 'run-1',
  connection: 'openai',
  descriptor: 'openai/batch@1',
  deployment: 'gpt-x',
  step: 'upload',
  field: 'id',
  objectId: id,
  deleteBy,
  deletable: true,
});

const at = new Date('2026-11-06T03:00:00Z');

describe('the nightly sweep of provider objects', () => {
  it('deletes an object left past its delete-by time and strikes it from the ledger', async () => {
    const store = new InMemoryProviderObjects(() => at);
    await store.created(object('file-1', '2026-11-06T01:00:00Z'));
    await store.created(object('file-2', '2026-11-07T01:00:00Z'));
    const removed: string[] = [];
    const run = await sweepProviderObjects({
      store,
      now: () => at,
      remove: async (r) => void removed.push(r.objectId),
      report: () => undefined,
    });
    expect(run).toMatchObject({ deleted: 1, incidents: 0 });
    expect(removed).toEqual(['file-1']);
    expect((await store.list('991825827', 'open')).map((r) => r.objectId)).toEqual(['file-2']);
  });

  it('records an incident and reports an object the provider will not delete', async () => {
    const store = new InMemoryProviderObjects(() => at);
    await store.created(object('file-1', '2026-11-06T01:00:00Z'));
    const reported: string[] = [];
    const run = await sweepProviderObjects({
      store,
      now: () => at,
      remove: async () => {
        throw new Error('the provider answered 500');
      },
      report: (r, reason) => void reported.push(`${r.objectId}: ${reason}`),
    });
    expect(run).toMatchObject({ deleted: 0, incidents: 1 });
    expect(reported).toEqual(['file-1: the provider answered 500']);
    expect((await store.list('991825827', 'incident'))[0]?.incident).toBe(
      'the provider answered 500',
    );
  });

  it('leaves a retained object alone', async () => {
    const store = new InMemoryProviderObjects(() => at);
    await store.created({ ...object('file-1', '2026-11-06T01:00:00Z'), deletable: false });
    const run = await sweepProviderObjects({
      store,
      now: () => at,
      remove: async () => {
        throw new Error('must not be called');
      },
      report: () => undefined,
    });
    expect(run).toMatchObject({ deleted: 0, incidents: 0 });
  });
});
