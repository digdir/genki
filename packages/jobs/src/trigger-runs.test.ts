import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryTriggerRuns,
  recordTriggerRuns,
  runRecord,
  triggerId,
  type TriggerBinding,
  type TriggerRunRecord,
} from './index.js';

const tenant = '991825827';
const binding: TriggerBinding = {
  tenant,
  service: 'post',
  capability: `${tenant}/post/default`,
  trigger: { kind: 'queue-message', queue: 'innkommende-post' },
};

const run = (id: string, at: string, outcome: TriggerRunRecord['outcome'], trigger = 't1') => ({
  id,
  tenant,
  service: 'post',
  trigger,
  kind: 'queue-message' as const,
  target: 'innkommende-post',
  outcome,
  at,
});

describe('trigger ids', () => {
  it('stay the same for the same trigger and differ between triggers on one service', () => {
    const queue = triggerId('post', { kind: 'queue-message', queue: 'innkommende-post' });

    expect(triggerId('post', { kind: 'queue-message', queue: 'innkommende-post' })).toBe(queue);
    expect(triggerId('post', { kind: 'schedule', cron: '0 2 * * *' })).not.toBe(queue);
    expect(queue).toMatch(/^post-[0-9a-f]{10}$/);
  });
});

describe('in-memory trigger runs', () => {
  it('counts runs since a time and keeps the newest run per trigger for the tenant', async () => {
    const store = new InMemoryTriggerRuns();
    await store.record(run('r1', '2026-10-01T08:00:00.000Z', 'completed'));
    await store.record(run('r2', '2026-10-08T08:00:00.000Z', 'failed'));
    await store.record({ ...run('r3', '2026-10-08T09:00:00.000Z', 'completed'), tenant: 'annen' });

    expect(await store.tally(tenant, '2026-10-02T00:00:00.000Z')).toEqual([
      { trigger: 't1', runs: 1, failed: 1, last: run('r2', '2026-10-08T08:00:00.000Z', 'failed') },
    ]);
    expect((await store.recent(tenant, 't1', 1)).map((r) => r.id)).toEqual(['r2']);
  });

  it('records what the worker reports, with the trigger it came from and a shortened error', async () => {
    const store = new InMemoryTriggerRuns();
    const record = recordTriggerRuns(store, { now: () => new Date('2026-10-09T08:00:00Z') });

    record({ binding, outcome: 'failed', error: 'x'.repeat(2000) });
    await vi.waitFor(async () =>
      expect(await store.recent(tenant, triggerId('post', binding.trigger), 5)).toHaveLength(1),
    );

    const [saved] = await store.recent(tenant, triggerId('post', binding.trigger), 5);
    expect(saved).toMatchObject({
      service: 'post',
      kind: 'queue-message',
      target: 'innkommende-post',
      outcome: 'failed',
      at: '2026-10-09T08:00:00.000Z',
    });
    expect(saved?.task).toBeUndefined();
    expect(saved?.error).toHaveLength(500);
    expect(
      runRecord(
        { binding, task: 'opg_1', outcome: 'completed' },
        new Date(0),
        '00000000-0000-0000-0000-000000000001',
      ),
    ).toMatchObject({
      id: '00000000-0000-0000-0000-000000000001',
      task: 'opg_1',
    });
  });
});
