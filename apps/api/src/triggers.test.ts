import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryTriggerRuns, triggerId } from '@genai/jobs';
import type { TriggerRunView, TriggerView } from './triggers.js';
import { bootPlatform, digdir, files, readJson as json, testService } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  bruker: {
    kind: 'employee',
    issuer: 'test',
    subject: 'bruker',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: '999888777',
    authorizedFor: [{ org: '999888777' }],
  },
};

const queue = { kind: 'queue-message' as const, queue: 'innkommende-post' };
const nightly = { kind: 'schedule' as const, cron: '0 2 * * *' };
const folder = { kind: 'document-arrives' as const, folder: 'opptak' };
const queueId = triggerId('post', queue);
const folderId = triggerId('referat', folder);

const boot = async () => {
  const runs = new InMemoryTriggerRuns();
  const booted = await bootPlatform({ people, triggerRuns: runs, services: ['veileder'] });
  for (const [id, name, triggers] of [
    ['post', 'Sorter innkommende post', [queue, nightly]],
    ['referat', 'Møtereferat', [folder]],
  ] as const) {
    const service = testService(id);
    await booted.platform.definitions.publish(
      {
        ...service,
        metadata: { ...service.metadata, name },
        spec: { ...service.spec, triggers },
      },
      'test',
      'test',
      files,
    );
  }
  const record = (
    id: string,
    trigger: string,
    service: string,
    at: Date,
    outcome: 'completed' | 'failed',
    extra: { task?: string; error?: string } = {},
  ) =>
    runs.record({
      id,
      tenant: digdir,
      service,
      trigger,
      kind: service === 'post' ? 'queue-message' : 'document-arrives',
      target: service === 'post' ? 'innkommende-post' : 'opptak',
      outcome,
      at: at.toISOString(),
      ...extra,
    });
  const list = async (as = 'kari') =>
    (await json<{ data: TriggerView[] }>(await booted.send(`/tenants/${digdir}/triggers`, as)))
      .data;
  return { ...booted, runs, record, list };
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

describe('triggers per tenant', () => {
  it('lists every trigger on published services with last run and counts for the last 7 days', async () => {
    const { record, list } = await boot();
    await record('r1', queueId, 'post', daysAgo(10), 'completed', { task: 'gammel' });
    await record('r2', queueId, 'post', daysAgo(2), 'completed', { task: 'opg_1' });
    await record('r3', queueId, 'post', daysAgo(1), 'failed', {
      task: 'opg_2',
      error: 'svarte ikke',
    });

    const triggers = await list();

    expect(triggers.map((t) => t.serviceName)).toEqual([
      'Møtereferat',
      'Sorter innkommende post',
      'Sorter innkommende post',
    ]);
    expect(triggers.map((t) => `${t.kind} ${t.target}`).sort()).toEqual([
      'document-arrives opptak',
      'queue-message innkommende-post',
      'schedule 0 2 * * *',
    ]);
    const post = triggers.find((t) => t.id === queueId);
    expect(post).toMatchObject({
      service: 'post',
      status: 'active',
      runs7d: 2,
      failed7d: 1,
      lastRun: {
        id: 'r3',
        outcome: 'failed',
        task: 'opg_2',
        error: 'svarte ikke',
        timeline: `/tenants/${digdir}/tasks/opg_2/timeline`,
      },
    });
    expect(triggers.find((t) => t.kind === 'schedule')?.nextRunAt).toMatch(/T\d\d:00:00/);
    expect(triggers.find((t) => t.id === folderId)).toMatchObject({ runs7d: 0, status: 'active' });
  });

  it('marks a trigger as failing when it could not start the service at all', async () => {
    const { record, list } = await boot();
    await record('r1', folderId, 'referat', daysAgo(1), 'failed', { error: 'ingen tilgang' });

    expect((await list()).find((t) => t.id === folderId)?.status).toBe('failing');
  });

  it('shows recent runs of one trigger newest first, and 404 for an unknown trigger', async () => {
    const { record, send } = await boot();
    await record('r1', queueId, 'post', daysAgo(2), 'completed', { task: 'opg_1' });
    await record('r2', queueId, 'post', daysAgo(1), 'completed', { task: 'opg_2' });

    const page = await json<{ trigger: TriggerView; data: TriggerRunView[] }>(
      await send(`/tenants/${digdir}/triggers/${queueId}/runs?limit=1`, 'bruker'),
    );
    const unknown = await send(`/tenants/${digdir}/triggers/finnes-ikke/runs`, 'kari');

    expect(page.trigger.id).toBe(queueId);
    expect(page.data.map((r) => r.id)).toEqual(['r2']);
    expect(unknown.status).toBe(404);
  });

  it('pauses and resumes a trigger with a reason, audits it, and needs the manage right', async () => {
    const { send, list, admin } = await boot();
    const pause = (paused: boolean, as = 'kari', reason = 'Køen flyttes til ny leverandør') =>
      send(`/tenants/${digdir}/triggers/${queueId}/pause`, as, {
        method: 'PUT',
        body: { paused },
        reason,
      });

    const refused = await pause(true, 'bruker');
    const noReason = await pause(true, 'kari', '');
    const paused = await pause(true);
    const whilePaused = (await list()).find((t) => t.id === queueId);
    await pause(false);

    expect(refused.status).toBe(403);
    expect(noReason.status).toBe(400);
    expect(paused.status).toBe(200);
    expect(whilePaused).toMatchObject({ status: 'paused', pausedBy: 'employee:test:kari' });
    expect((await list()).find((t) => t.id === queueId)?.status).toBe('active');
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ action: 'platform.trigger.pause', outcome: 'applied' }),
    );
  });

  it('keeps triggers inside the tenant', async () => {
    const { send } = await boot();

    expect((await send(`/tenants/${digdir}/triggers`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/triggers/${queueId}/runs`, 'ola')).status).toBe(404);
  });
});
