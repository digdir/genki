import { describe, expect, it } from 'vitest';
import { textPart, type Event, type RiskClass, type Task } from '@genai/contracts';
import { platformSettings, SettingsRegistry, type CompiledCapability } from '@genai/definitions';
import {
  InMemoryEventLog,
  InMemoryRetentionStore,
  InMemoryTaskStore,
  retentionPolicy,
} from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { runDocumentFolder } from './run-documents.js';
import { retentionFor } from './retention-policy.js';
import { purgeExpired, scheduleRetention } from './retention.js';
import { InMemoryTraceDeliveries } from './trace-deliveries.js';
import type { Clock } from './scheduler.js';

const tenant = '991825827';
const now = new Date('2026-10-12T03:17:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const capability = (
  service: string,
  riskClass: RiskClass,
  settings: Record<string, unknown> = {},
) =>
  ({
    capability: {
      descriptor: { id: `${tenant}/${service}/default`, version: '1', oversight: { riskClass } },
      config: { settings },
    },
    service: { tenant, id: service, version: 1 },
    publicName: `${tenant}/${service}`,
    aliases: [],
  }) as unknown as CompiledCapability;

const taskOf = (id: string, service: string, endedDaysAgo?: number): Task => ({
  id,
  tenant,
  owner: 'kernel',
  status: endedDaysAgo === undefined ? 'running' : 'completed',
  principal: { kind: 'employee', id: 'kari' },
  service: {
    capability: { id: `${tenant}/${service}/default`, version: '1' },
    strategy: { id: 'single-call', version: '1' },
    configHash: 'x',
  },
  result: [textPart('hemmelig svar')],
  artifacts: [],
  usage: {},
  createdAt: daysAgo((endedDaysAgo ?? 0) + 1),
  ...(endedDaysAgo === undefined ? {} : { endedAt: daysAgo(endedDaysAgo) }),
});

const event = (task: string, type: string, data: unknown): Omit<Event, 'seq'> => ({
  type,
  v: 1,
  task,
  ts: now.toISOString(),
  data,
  actor: 'kernel',
});

const collect = async (log: InMemoryEventLog, task: string) => {
  const all: Event[] = [];
  for await (const e of log.read(task, 0, () => false)) all.push(e);
  return all;
};

const setup = async (tasks: Task[], capabilities: CompiledCapability[]) => {
  const log = new InMemoryEventLog();
  const store = new InMemoryTaskStore();
  for (const task of tasks) {
    await store.put({
      task,
      principal: { kind: 'employee', issuer: 'test', subject: 'kari' },
      lastSeq: 1,
    });
    await log.append(event(task.id, 'kernel.task.status', { status: 'completed' }));
    await log.append(event(task.id, 'kernel.result', [textPart('hemmelig svar')]));
  }
  const settings = new SettingsRegistry(platformSettings);
  const deps = {
    store: new InMemoryRetentionStore(log, store),
    settings,
    capabilities: async () => capabilities,
    now: () => now,
  };
  return { log, store, settings, deps };
};

describe('retention policy', () => {
  it('a high-risk service keeps content at least 183 days even when it chooses the transient class', () => {
    expect(
      retentionPolicy({ retentionClass: 'transient', riskClass: 'high', auditDays: 730 }),
    ).toMatchObject({ payloadDays: 183, envelopeDays: 730 });
    expect(
      retentionPolicy({ retentionClass: 'transient', riskClass: 'limited', auditDays: 730 }),
    ).toMatchObject({ payloadDays: 30 });
    expect(
      retentionPolicy({ retentionClass: 'transient', riskClass: 'minimal', auditDays: 730 }),
    ).toMatchObject({ payloadDays: 7 });
  });

  it('never keeps the audit envelope shorter than the content', () => {
    expect(
      retentionPolicy({ retentionClass: 'case', riskClass: 'minimal', auditDays: 200 }),
    ).toMatchObject({ payloadDays: 365, envelopeDays: 365 });
  });

  it('takes the retention class from the service settings over the tenant and the platform default', () => {
    const settings = new SettingsRegistry(platformSettings);
    settings.setTenant(tenant, 'retention.class', 'case');

    expect(retentionFor(settings, tenant, capability('svar', 'minimal'))).toMatchObject({
      retentionClass: 'case',
      payloadDays: 365,
    });
    expect(
      retentionFor(
        settings,
        tenant,
        capability('svar', 'minimal', { 'retention.class': 'transient' }),
      ),
    ).toMatchObject({ retentionClass: 'transient', payloadDays: 7 });
    expect(retentionFor(new SettingsRegistry(platformSettings), tenant, undefined)).toMatchObject({
      retentionClass: 'standard',
      payloadDays: 183,
      envelopeDays: 730,
    });
  });
});

describe('purging content that went to a trace sink', () => {
  it("marks a purged task's traces in the sink for deletion, and no other task's", async () => {
    const { deps } = await setup(
      [taskOf('fresh', 'svar', 10), taskOf('old', 'svar', 100)],
      [capability('svar', 'minimal')],
    );
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record(
      [
        { tenant, sink: 'etaten', task: 'old', trace: 'trace-old' },
        { tenant, sink: 'etaten', task: 'fresh', trace: 'trace-fresh' },
      ],
      now.toISOString(),
    );

    const run = await purgeExpired({ ...deps, deliveries });

    expect(run.traceDeletes).toBe(1);
    expect((await deliveries.pending(10)).map((d) => d.trace)).toEqual(['trace-old']);
  });
});

describe('purging expired tasks', () => {
  it('drops the content after the retention class and keeps the envelope until the audit period ends', async () => {
    const { log, store, deps } = await setup(
      [taskOf('fresh', 'svar', 10), taskOf('old', 'svar', 100), taskOf('ancient', 'svar', 800)],
      [capability('svar', 'minimal')],
    );

    const run = await purgeExpired(deps);

    expect(run).toMatchObject({ payloads: 1, envelopes: 1 });
    expect((await collect(log, 'fresh')).map((e) => e.data)).toEqual([
      { status: 'completed' },
      [textPart('hemmelig svar')],
    ]);
    expect((await collect(log, 'old')).map((e) => e.data)).toEqual([
      { status: 'completed' },
      { erased: true },
    ]);
    expect((await store.get('old'))?.task.result).toBeUndefined();
    expect((await store.get('old'))?.principal.subject).toBe('erased');
    expect(await collect(log, 'ancient')).toEqual([]);
    expect(await store.get('ancient')).toBeUndefined();
  });

  it('purging twice changes nothing the second time', async () => {
    const { deps } = await setup(
      [taskOf('old', 'svar', 100), taskOf('ancient', 'svar', 800)],
      [capability('svar', 'minimal')],
    );

    await purgeExpired(deps);
    const again = await purgeExpired(deps);

    expect(again).toMatchObject({ payloads: 0, envelopes: 0 });
  });

  it('never purges a task that has not ended', async () => {
    const { log, deps } = await setup([taskOf('running', 'svar')], [capability('svar', 'minimal')]);

    await purgeExpired({ ...deps, now: () => new Date('2030-01-01T00:00:00Z') });

    expect(await collect(log, 'running')).toHaveLength(2);
  });

  it('keeps the content of a task whose service is gone as long as a high-risk one', async () => {
    const { log, deps } = await setup([taskOf('orphan', 'borte', 100)], []);

    const run = await purgeExpired(deps);

    expect(run.groups).toMatchObject([{ capability: `${tenant}/borte/default`, payloadDays: 183 }]);
    expect((await collect(log, 'orphan')).at(-1)?.data).toEqual([textPart('hemmelig svar')]);
  });
});

describe('purging expired conversations', () => {
  it('purges conversations by the retention period of the service they talk to', async () => {
    const { deps } = await setup([], [capability('svar', 'minimal'), capability('vedtak', 'high')]);
    const cutoffs: Record<string, string> = {};
    const threads = {
      agents: async () => ['svar', 'vedtak', 'borte'],
      purge: async (cutoff: { agent: string; before: Date }) => {
        cutoffs[cutoff.agent] = cutoff.before.toISOString();
        return 1;
      },
    };

    const run = await purgeExpired({ ...deps, threads });

    expect(run.conversations).toBe(3);
    expect(cutoffs).toEqual({
      svar: daysAgo(90),
      vedtak: daysAgo(183),
      borte: daysAgo(183),
    });
  });
});

describe('purging uploaded documents', () => {
  const upload = async (blobs: InMemoryBlobStore, service: string, name: string) => {
    const path = `${runDocumentFolder(`${tenant}/${service}/default`)}/${name}/brev.txt`;
    await blobs.put({ tenant, path }, new Uint8Array([1]), 'text/plain');
    return { tenant, path };
  };
  const blobsFrom = (ageDays: number) =>
    new InMemoryBlobStore(() => new Date(now.getTime() - ageDays * 86_400_000));

  it('deletes an uploaded document after the retention period of the service it was uploaded to', async () => {
    const { deps } = await setup([], [capability('svar', 'minimal')]);
    const blobs = blobsFrom(91);
    const key = await upload(blobs, 'svar', 'a');

    const run = await purgeExpired({ ...deps, documents: blobs });

    expect(run.documents).toBe(1);
    expect(await blobs.head(key)).toBeUndefined();
  });

  it('keeps an uploaded document that is still inside the retention period', async () => {
    const { deps } = await setup([], [capability('svar', 'minimal')]);
    const blobs = blobsFrom(89);
    const key = await upload(blobs, 'svar', 'a');

    const run = await purgeExpired({ ...deps, documents: blobs });

    expect(run.documents).toBe(0);
    expect(await blobs.head(key)).toBeDefined();
  });

  it('keeps an uploaded document of a high-risk service for at least 183 days', async () => {
    const { deps } = await setup(
      [],
      [capability('vedtak', 'high', { 'retention.class': 'transient' })],
    );
    const blobs = blobsFrom(100);
    const key = await upload(blobs, 'vedtak', 'a');

    await purgeExpired({ ...deps, documents: blobs });

    expect(await blobs.head(key)).toBeDefined();
  });

  it('documents of a conversation erased as idle are deleted in the same run', async () => {
    const { deps } = await setup([], [capability('svar', 'minimal')]);
    const blobs = blobsFrom(91);
    const key = await upload(blobs, 'svar', 'conversations/samtale-1/a');
    const erased: string[] = [];
    const threads = {
      agents: async () => ['svar'],
      purge: async (cutoff: { agent: string; before: Date }) => {
        erased.push(cutoff.before.toISOString());
        return 1;
      },
    };

    const run = await purgeExpired({ ...deps, threads, documents: blobs });

    expect(erased).toEqual([daysAgo(90)]);
    expect(run.documents).toBe(1);
    expect(await blobs.head(key)).toBeUndefined();
  });

  it('purging uploaded documents twice changes nothing the second time', async () => {
    const { deps } = await setup([], [capability('svar', 'minimal')]);
    const blobs = blobsFrom(91);
    await upload(blobs, 'svar', 'a');
    await purgeExpired({ ...deps, documents: blobs });

    expect((await purgeExpired({ ...deps, documents: blobs })).documents).toBe(0);
  });
});

describe('the scheduled purge', () => {
  const manualClock = () => {
    const timers: (() => void)[] = [];
    const clock: Clock = {
      now: () => now,
      setTimer: (_at, run) => {
        timers.push(run);
        return () => undefined;
      },
    };
    return { clock, fire: () => timers.shift()?.() };
  };

  it('purges only on the worker that holds the lease', async () => {
    const { deps } = await setup([taskOf('old', 'svar', 100)], [capability('svar', 'minimal')]);
    const runs: number[] = [];
    const follower = manualClock();
    const leader = manualClock();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    const idle = scheduleRetention({
      ...deps,
      clock: follower.clock,
      active: async () => false,
      onRun: (run) => runs.push(run.payloads),
    });
    const active = scheduleRetention({
      ...deps,
      clock: leader.clock,
      active: async () => true,
      onRun: (run) => runs.push(run.payloads),
    });
    follower.fire();
    leader.fire();
    await settle();
    idle.stop();
    active.stop();

    expect(runs).toEqual([1]);
  });
});
