import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal, Task } from '@genai/contracts';
import { tenantAccess } from './access.js';
import type { Admin } from './admin.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import type { ModuleDeps, MountDeps } from './platform-modules.js';
import { resultReviewsModule } from './result-reviews.js';
import { digdir } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
};

const table = {
  title: 'Måloppnåelse 2025',
  columns: [
    { key: 'goal', label: 'Mål' },
    { key: 'assessment', label: 'Vurdering' },
  ],
  rows: [
    {
      cells: {
        goal: { value: 'Mål 1', sources: [] },
        assessment: { value: 'Nådd', sources: [{ document: 'kudos:1' }] },
      },
    },
  ],
};

const task = (id: string, owner: string, status: Task['status'] = 'completed'): Task =>
  ({
    id,
    tenant: digdir,
    status,
    principal: { kind: 'employee', id: JSON.stringify(['test', owner]) },
    service: { capability: { id: `${digdir}/maloppnaelse/default`, version: '4' } },
    result: [
      { mime: 'application/vnd.genai.table+json', body: { kind: 'json', json: table } },
      { mime: 'text/csv', body: { kind: 'text', text: 'Mål;Vurdering\nMål 1;Nådd' } },
    ],
    artifacts: [],
    usage: {},
    owner: 'kernel',
    createdAt: '2026-10-08T10:14:00.000Z',
  }) as unknown as Task;

const boot = () => {
  const tasks = [task('t1', 'kari'), task('t2', 'kari', 'running')];
  const module = resultReviewsModule({
    configEntries: new InMemoryConfigEntryStore(),
  } as unknown as ModuleDeps);
  const app = new Hono();
  const audit: { action: string; reason: string; target: string; outcome: string }[] = [];
  const admin = {
    within: async (
      _principal: Principal,
      action: string,
      data: { reason: string },
      work: () => Promise<{ value: unknown; target: string }>,
    ) => {
      try {
        const done = await work();
        audit.push({ action, reason: data.reason, target: done.target, outcome: 'applied' });
        return { value: done.value, task: `audit-${audit.length}` };
      } catch (error) {
        audit.push({ action, reason: data.reason, target: action, outcome: 'rejected' });
        throw error;
      }
    },
  };
  module.mount(app, {
    admin,
    authenticate: async (request: Request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: tenantAccess({ supportSession: () => undefined } as unknown as Admin),
    task: async (id: string) => tasks.find((t) => t.id === id),
    events: async function* (id: string) {
      if (id !== 't1') return;
      yield { type: 'kernel.task.started', data: {} };
      yield {
        type: 'kernel.task.input',
        data: {
          input: {
            data: {
              agency: ['Digdir', 'Udir'],
              year: 2025,
              query: 'Virksomheter: Digdir, Udir\nÅr: 2025',
              history: [],
            },
          },
        },
      };
    },
  } as unknown as MountDeps);
  const call = (
    path: string,
    who: string,
    init: { method?: string; body?: unknown; reason?: string } = {},
  ) =>
    app.request(`/tenants/${digdir}/tasks/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        'actor-name': encodeURIComponent('Kari Nordmann'),
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { call, audit };
};

describe('reviewing a table result', () => {
  it('returns the table as a draft until someone approves it', async () => {
    const { call } = boot();

    const response = await call('t1/review', 'kari');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: 't1',
      table: { title: 'Måloppnåelse 2025' },
      csv: expect.stringContaining('Mål 1'),
      edits: [],
      approval: { status: 'draft' },
    });
  });

  it('returns the form values the run was started with, so the table can show them later', async () => {
    const { call } = boot();
    const body = (await (await call('t1/review', 'kari')).json()) as { input?: unknown };
    expect(body.input).toEqual({ agency: ['Digdir', 'Udir'], year: 2025 });
    expect(await (await call('t2/review', 'kari')).json()).not.toHaveProperty('input');
  });

  it('keeps edited cells with the original value and who changed them', async () => {
    const { call } = boot();

    const response = await call('t1/review/edits', 'kari', {
      method: 'PUT',
      body: { edits: [{ row: 0, column: 'assessment', value: 'Delvis nådd' }] },
      reason: 'Rettet vurderingen av mål 1',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      edits: [
        {
          row: 0,
          column: 'assessment',
          value: 'Delvis nådd',
          original: 'Nådd',
          by: 'employee:test:kari',
          byName: 'Kari Nordmann',
        },
      ],
    });
  });

  it('records who approved the table and when, and refuses edits afterwards', async () => {
    const { call } = boot();

    const approved = await call('t1/review/approve', 'kari', {
      body: {},
      reason: 'Sjekket kildene i alle cellene',
    });
    const edit = await call('t1/review/edits', 'kari', {
      method: 'PUT',
      body: { edits: [{ row: 0, column: 'assessment', value: 'Ikke nådd' }] },
      reason: 'Prøver å endre etter godkjenning',
    });

    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      approval: {
        status: 'approved',
        by: 'employee:test:kari',
        byName: 'Kari Nordmann',
        at: expect.any(String),
        reason: 'Sjekket kildene i alle cellene',
      },
    });
    expect(edit.status).toBe(409);
  });

  it('needs a change reason, a finished run and valid cells', async () => {
    const { call } = boot();

    const noReason = await call('t1/review/approve', 'kari', { body: {} });
    const running = await call('t2/review/approve', 'kari', {
      body: {},
      reason: 'Godkjenner før den er ferdig',
    });
    const badCell = await call('t1/review/edits', 'kari', {
      method: 'PUT',
      body: { edits: [{ row: 5, column: 'nope', value: 'x' }] },
      reason: 'Endrer en celle som ikke finnes',
    });

    expect(noReason.status).toBe(400);
    expect(running.status).toBe(409);
    expect(badCell.status).toBe(400);
  });

  it('lets only the person who started the run change or approve it', async () => {
    const { call } = boot();

    const approve = await call('t1/review/approve', 'ola', {
      body: {},
      reason: 'Godkjenner en annens tabell',
    });
    const missing = await call('nope/review', 'kari');

    expect(approve.status).toBe(403);
    expect(missing.status).toBe(404);
  });

  it('records edits and approvals as audited admin tasks with the change reason', async () => {
    const { call, audit } = boot();

    const edit = await call('t1/review/edits', 'kari', {
      method: 'PUT',
      body: { edits: [{ row: 0, column: 'assessment', value: 'Delvis nådd' }] },
      reason: 'Kilden sier delvis nådd',
    });
    const approve = await call('t1/review/approve', 'kari', {
      body: {},
      reason: 'Sjekket kildene i alle cellene',
    });

    expect([edit.status, approve.status]).toEqual([200, 200]);
    expect(edit.headers.get('genai-task')).toBe('audit-1');
    expect(audit).toEqual([
      {
        action: 'platform.task.review.edit',
        reason: 'Kilden sier delvis nådd',
        target: 'task-review:t1',
        outcome: 'applied',
      },
      {
        action: 'platform.task.review.approve',
        reason: 'Sjekket kildene i alle cellene',
        target: 'task-review:t1',
        outcome: 'applied',
      },
    ]);
  });

  it('answers 409, not 500, when two edits of the same table race', async () => {
    const { call } = boot();
    const edit = (value: string) =>
      call('t1/review/edits', 'kari', {
        method: 'PUT',
        body: { edits: [{ row: 0, column: 'assessment', value }] },
        reason: 'Retter vurderingen samtidig',
      });

    const statuses = (await Promise.all([edit('Nådd'), edit('Ikke nådd')])).map((r) => r.status);

    expect(statuses.sort()).toEqual([200, 409]);
  });
});
