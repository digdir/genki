import { describe, expect, it } from 'vitest';
import type { Event, Task } from '@genai/contracts';
import { InMemoryEventLog, InMemoryTaskStore, type StoredTask } from '@genai/kernel';
import { failStoppedRuns } from './stopped-runs.js';

const tenant = '991825827';
const now = () => new Date('2026-11-18T10:00:00Z');

const running = (id: string): StoredTask => ({
  task: {
    id,
    service: {
      capability: { id: `${tenant}/ka/default`, version: '1' },
      strategy: { id: 'agent-loop', version: '1' },
      configHash: 'h',
    },
    principal: { kind: 'employee', id: 'kari', tenant },
    tenant,
    owner: tenant,
    status: 'running',
    artifacts: [],
    usage: { inputTokens: 10 },
    createdAt: '2026-11-18T09:50:00.000Z',
  } satisfies Task,
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
  lastSeq: 2,
});

const setup = async (ids: string[]) => {
  const tasks = new InMemoryTaskStore();
  const log = new InMemoryEventLog();
  for (const id of ids) {
    await tasks.put(running(id));
    for (const [type, data] of [
      ['kernel.task.status', { status: 'running' }],
      ['kernel.usage', { usage: { inputTokens: 10, requests: 1 } }],
      ['kernel.usage', { usage: { inputTokens: 30, outputTokens: 5, requests: 1 } }],
    ] as const)
      await log.append({
        type,
        v: 1,
        task: id,
        ts: '2026-11-18T09:50:01.000Z',
        data,
        actor: 'kernel',
      });
  }
  const read = async (id: string) => {
    const events: Event[] = [];
    for await (const e of log.read(id, 0, () => false)) events.push(e);
    return events;
  };
  let claimable = [...ids];
  const deps = {
    tasks: {
      claimStopped: async () => {
        const claimed = claimable.map((id) => ({ id, tenant, scope: `task:${id}` }));
        claimable = [];
        return claimed;
      },
      get: (id: string) => tasks.get(id),
      put: (stored: StoredTask) => tasks.put(stored),
    },
    events: {
      append: (event: Omit<Event, 'seq'>) => log.append(event),
      ofType: async (ids: string[], type: string) =>
        (await Promise.all(ids.map(read))).flat().filter((e) => e.type === type),
    },
    now,
  };
  return { tasks, read, deps, reclaim: (id: string) => (claimable = [id]) };
};

describe('runs whose server stopped', () => {
  it('a run whose lease has run out is marked failed with a reason', async () => {
    const { tasks, read, deps } = await setup(['t1']);

    expect(await failStoppedRuns(deps)).toEqual(['t1']);

    const stored = await tasks.get('t1');
    const events = await read('t1');
    expect(stored?.task).toMatchObject({ status: 'failed', endedAt: '2026-11-18T10:00:00.000Z' });
    expect(stored?.lastSeq).toBe(events.at(-1)?.seq);
    expect(events.filter((e) => e.type === 'kernel.error').map((e) => e.data)).toEqual([
      { code: 'server_stopped', message: 'the server stopped during the run' },
      { code: 'server_stopped', message: 'the server stopped during the run' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'kernel.task.status',
      data: { status: 'failed' },
      ts: '2026-11-18T10:00:00.000Z',
    });
  });

  it('a failed run keeps the usage its model calls recorded', async () => {
    const { tasks, deps } = await setup(['t1']);

    await failStoppedRuns(deps);

    expect((await tasks.get('t1'))?.task.usage).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      requests: 2,
    });
  });

  it('a run claimed again after a sweep that stopped half way gets no second failure', async () => {
    const { tasks, read, deps, reclaim } = await setup(['t1']);
    const halfWay = {
      ...deps,
      tasks: {
        ...deps.tasks,
        put: async () => {
          throw new Error('the database went away');
        },
      },
    };

    await expect(failStoppedRuns(halfWay)).rejects.toThrow('the database went away');
    reclaim('t1');
    await failStoppedRuns(deps);

    const events = await read('t1');
    expect(events.filter((e) => e.type === 'kernel.task.status').map((e) => e.data)).toEqual([
      { status: 'running' },
      { status: 'failed' },
    ]);
    expect((await tasks.get('t1'))?.task.status).toBe('failed');
  });

  it('a run that ended before the sweep read it is left as it ended', async () => {
    const { tasks, read, deps } = await setup(['t1']);
    await tasks.put({ ...running('t1'), task: { ...running('t1').task, status: 'completed' } });

    expect(await failStoppedRuns(deps)).toEqual([]);

    expect((await tasks.get('t1'))?.task.status).toBe('completed');
    expect((await read('t1')).some((e) => e.type === 'kernel.error')).toBe(false);
  });
});
