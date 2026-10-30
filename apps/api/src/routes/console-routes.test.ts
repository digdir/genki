import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { InMemoryEvalRunStore, InMemoryLabelStore, type EvalRun } from '@genai/eval';
import { createAdmin, type SupportSession } from '../admin.js';
import { auth, digdir, files, klarsprak, other, plugins, settingDefinitions } from '../testkit.js';
import {
  consoleAdminExtensions,
  registerConsoleRoutes,
  type ConsoleDeps,
} from './console-routes.js';

const at = new Date('2026-10-07T10:00:00Z');

const run = (id: string, endedAt: string, mean: number, ci: [number, number]): EvalRun => ({
  id,
  testSet: { tenant: digdir, id: 'kudos', version: 1 },
  capability: `${digdir}/klarsprak/default`,
  splits: ['validation'],
  repeats: 1,
  startedAt: endedAt,
  endedAt,
  provenance: {
    commit: 'abc',
    data: 'kudos@1',
    servedModels: ['foundry/gpt-4o'],
    judges: ['rubric-v1'],
    services: ['klarsprak'],
  },
  results: [
    {
      case: 'q1',
      split: 'validation',
      repeat: 0,
      task: 't1',
      tags: [],
      scores: [
        {
          evaluator: 'rubric-v1',
          version: '1',
          metric: 'judge',
          value: mean,
          applicable: true,
          state: 'scored',
          reason: 'ok',
        },
      ],
    },
  ],
  metrics: { judge: { mean, ci, n: 10 } },
  byTag: {},
  incomplete: [],
});

const setup = async (extra: Pick<ConsoleDeps, 'lifecycle' | 'pluginUsage'> = {}) => {
  const store = new InMemoryDefinitionStore({ ...plugins, settings: settingDefinitions });
  await store.publish(klarsprak(), 'test', 'seed', files);
  const runs = new InMemoryEvalRunStore();
  await runs.save({
    run: run('r1', '2026-10-01T00:00:00Z', 0.8, [0.75, 0.85]),
    tenant: digdir,
    task: 'e1',
    service: 'klarsprak',
  });
  await runs.save({
    run: run('r2', '2026-10-05T00:00:00Z', 0.5, [0.45, 0.55]),
    tenant: digdir,
    task: 'e2',
    service: 'klarsprak',
  });
  const labels = new InMemoryLabelStore();
  const sessions: (SupportSession & { endedAt?: string })[] = [
    {
      id: 's1',
      operator: 'operator:test:drift',
      tenant: other,
      reason: 'feilsøking',
      openedAt: '2026-10-07T09:50:00Z',
      expiresAt: '2026-10-07T10:20:00Z',
    },
    {
      id: 's0',
      operator: 'operator:test:drift',
      tenant: digdir,
      reason: 'eldre',
      openedAt: '2026-10-06T09:00:00Z',
      expiresAt: '2026-10-06T09:30:00Z',
    },
  ];
  const running = [
    { task: 'task-1', tenant: digdir, status: 'running', at: '2026-10-07T09:59:00Z' },
  ];
  const cancelled: string[] = [];
  const deps: ConsoleDeps = {
    store,
    ...extra,
    plugins,
    blocks: { describe: () => [{ ref: 'retrieve@1', description: 'Søk' }] },
    tenants: () => [digdir, other],
    runs,
    labels,
    traces: () => ({
      endpoint: 'https://lf.example/api/public/otel?k=1',
      content: false,
      stats: { exported: 5, dropped: 1, failed: 0, sampledOut: 0 },
    }),
    support: {
      list: () => sessions,
      end: (id, when) => {
        const s = sessions.find((x) => x.id === id && !x.endedAt && new Date(x.expiresAt) > when);
        if (s) s.endedAt = when.toISOString();
        return s;
      },
      extend: async (id, minutes, when) => {
        const s = sessions.find((x) => x.id === id && !x.endedAt && new Date(x.expiresAt) > when);
        if (s)
          s.expiresAt = new Date(new Date(s.expiresAt).getTime() + minutes * 60_000).toISOString();
        return s;
      },
    },
    tasks: () => running.filter((t) => !cancelled.includes(t.task)),
    taskDetails: async (task) =>
      task === 'task-1'
        ? { service: 'klarsprak', capability: `${digdir}/klarsprak/default` }
        : undefined,
    cancel: async (task) => {
      cancelled.push(task);
    },
    operations: async () => ({
      incidents: [],
      components: [{ name: 'API', status: 'normal' }],
      queueStats: [{ label: 'Innlesinger som kjører', value: '0' }],
      queue: [],
      triggers: [],
    }),
    organization: async (org) =>
      org === digdir ? { orgNumber: digdir, name: 'Digdir', source: 'platform' } : undefined,
    names: {
      namesOf: async (actors) =>
        new Map(actors.filter((a) => a === 'operator:test:drift').map((a) => [a, 'Dina Drift'])),
    },
    now: () => at,
  };
  const admin = createAdmin({
    store,
    plugins,
    settings: new SettingsRegistry(settingDefinitions),
    extensions: consoleAdminExtensions(deps),
    now: () => at,
  });
  const app = new Hono();
  registerConsoleRoutes(app, { ...deps, admin, authenticate: auth.authenticate });
  const send = (
    path: string,
    who?: string,
    init: { method?: string; body?: unknown; reason?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const auditFor = async (task: string) =>
    (await admin.events(task)).find(
      (e) => e.type === 'x.platform.change' || e.type === 'x.platform.rejected',
    );
  return { send, store, labels, cancelled, auditFor, admin, runs };
};

const readJson = async <T>(res: Response) => (await res.json()) as T;

describe('console routes', () => {
  it('serves the operations overview the platform reports', async () => {
    const { send } = await setup();
    const overview = await readJson<{ components: { name: string }[]; queueStats: unknown[] }>(
      await send('/operator/operations', 'operator'),
    );
    expect(overview.components.map((c) => c.name)).toEqual(['API']);
    expect(overview.queueStats).toEqual([{ label: 'Innlesinger som kjører', value: '0' }]);
  });

  it('looks up an organisation by a valid number and says 404 when nobody knows it', async () => {
    const { send } = await setup();
    expect(await readJson(await send(`/operator/organizations/${digdir}`, 'operator'))).toEqual({
      orgNumber: digdir,
      name: 'Digdir',
      source: 'platform',
    });
    expect((await send('/operator/organizations/123456789', 'operator')).status).toBe(400);
    expect((await send('/operator/organizations/974760673', 'operator')).status).toBe(404);
  });

  it('serves every route only to operators', async () => {
    const { send } = await setup();
    const routes = [
      '/operator/shared-services',
      '/operator/building-blocks',
      '/operator/quality',
      '/operator/quality/label-queue',
      '/operator/tracing',
      '/operator/support-sessions',
      '/operator/running-tasks',
      `/operator/tenants/${digdir}/definitions`,
      `/operator/tenants/${digdir}/definitions/services/klarsprak`,
      `/operator/tenants/${digdir}/definitions/services/klarsprak/versions/1`,
      '/operator/audit',
      '/operator/operations',
      `/operator/organizations/${digdir}`,
    ];
    for (const path of routes) {
      expect((await send(path)).status, path).toBe(401);
      expect((await send(path, 'kari')).status, path).toBe(403);
      expect((await send(path, 'operator')).status, path).toBe(200);
    }
  });

  it('shares a service with all agencies as an audited change with a reason, and refuses without one', async () => {
    const { send, store, auditFor } = await setup();

    const missing = await send(`/operator/shared-services/${digdir}/klarsprak`, 'operator', {
      method: 'PUT',
      body: { availableTo: '*' },
    });
    const shared = await send(`/operator/shared-services/${digdir}/klarsprak`, 'operator', {
      method: 'PUT',
      body: { availableTo: '*' },
      reason: 'Fellestjeneste for alle',
    });

    expect(missing.status).toBe(400);
    expect(shared.status).toBe(200);
    expect((await store.get('Service', digdir, 'klarsprak'))?.definition.spec).toMatchObject({
      availableTo: '*',
    });
    const event = await auditFor(shared.headers.get('genai-task') ?? '');
    expect(event?.data).toMatchObject({
      reason: 'Fellestjeneste for alle',
      before: null,
      after: '*',
    });
    const listed = await readJson<{ data: { id: string; availableTo: unknown }[] }>(
      await send('/operator/shared-services', 'operator'),
    );
    expect(listed.data.find((s) => s.id === 'klarsprak')?.availableTo).toBe('*');
  });

  it('marks an archived service in the tenant list and leaves it out of the shared services', async () => {
    const { send } = await setup({ lifecycle: async () => ({ state: 'archived' }) });

    const list = await readJson<{ data: { id: string; state: string }[] }>(
      await send(`/operator/tenants/${digdir}/definitions`, 'operator'),
    );
    const shared = await readJson<{ data: { id: string }[] }>(
      await send('/operator/shared-services', 'operator'),
    );

    expect(list.data).toEqual([expect.objectContaining({ id: 'klarsprak', state: 'archived' })]);
    expect(shared.data).toEqual([]);
  });

  it('lists the services that run on a model protocol or search engine plugin as its users', async () => {
    const { send } = await setup({
      pluginUsage: async () => new Map([['knowledge.typesense', [`${digdir}/klarsprak`]]]),
    });

    const body = await readJson<{ blocks: { ref: string; usedBy: string[] }[] }>(
      await send('/operator/building-blocks', 'operator'),
    );

    expect(body.blocks.find((b) => b.ref === 'knowledge.typesense')?.usedBy).toEqual([
      `${digdir}/klarsprak`,
    ]);
  });

  it('lists strategies, blocks and tools with schemas and where they are used', async () => {
    const { send } = await setup();
    const body = await readJson<{
      strategies: { ref: string; configSchema: unknown; usedBy: string[] }[];
      blocks: { ref: string }[];
    }>(await send('/operator/building-blocks', 'operator'));
    const single = body.strategies.find((s) => s.ref === 'single-call@1');
    expect(single?.usedBy).toEqual([`${digdir}/klarsprak`]);
    expect(single?.configSchema).toMatchObject({ type: 'object' });
    expect(body.blocks.map((b) => b.ref)).toEqual(['retrieve@1']);
  });

  it('shows the latest run per service with regressions, and judges with calibration marked advisory', async () => {
    const { send, labels } = await setup();
    await labels.add([
      { item: 'a', judge: 'rubric-v1', judgeLabel: 'good', humanLabel: 'bad', labeller: 'x' },
      { item: 'b', judge: 'rubric-v1', judgeLabel: 'good', humanLabel: 'good', labeller: 'x' },
    ]);
    const body = await readJson<{
      services: { run: string; regressions: string[] }[];
      judges: { judge: string; advisory: boolean }[];
    }>(await send('/operator/quality', 'operator'));
    expect(body.services).toEqual([expect.objectContaining({ run: 'r2', regressions: ['judge'] })]);
    expect(body.judges).toEqual([expect.objectContaining({ judge: 'rubric-v1', advisory: true })]);
  });

  it('queues the verdicts of a judge that names its version and model under its evaluator', async () => {
    const { send, runs } = await setup();
    const criteria = run('r3', '2026-10-06T00:00:00Z', 1, [1, 1]);
    criteria.provenance.judges = ['judge:criteria@1+foundry/claude-sonnet'];
    criteria.results = criteria.results.map((r) => ({
      ...r,
      scores: r.scores.map((s) => ({
        ...s,
        evaluator: 'judge:criteria',
        metric: 'judge.criteria',
      })),
    }));
    await runs.save({ run: criteria, tenant: digdir, task: 'e3', service: 'klarsprak' });

    const queue = await readJson<{ data: { item: string; judge: string }[] }>(
      await send('/operator/quality/label-queue', 'operator'),
    );

    expect(queue.data).toContainEqual(
      expect.objectContaining({ item: 'r3:q1:0', judge: 'judge:criteria' }),
    );
  });

  it('queues judge verdicts for labelling and records a human label as an audited change', async () => {
    const { send, labels, auditFor } = await setup();
    const queue = await readJson<{ data: { item: string; judge: string; judgeLabel: string }[] }>(
      await send('/operator/quality/label-queue', 'operator'),
    );
    expect(queue.data.length).toBe(2);
    const first = queue.data[0];

    const res = await send('/operator/quality/labels', 'operator', {
      method: 'POST',
      body: { ...first, humanLabel: 'bad' },
      reason: 'Kalibrering',
    });

    expect(res.status).toBe(200);
    expect(await labels.list()).toEqual([
      expect.objectContaining({ item: first?.item, labeller: 'operator:test:drift' }),
    ]);
    expect((await auditFor(res.headers.get('genai-task') ?? ''))?.type).toBe('x.platform.change');
    const after = await readJson<{ data: unknown[] }>(
      await send('/operator/quality/label-queue', 'operator'),
    );
    expect(after.data.length).toBe(1);
  });

  it('reports trace export status per environment, without a tenants field, query strings or keys', async () => {
    const { send } = await setup();
    const body = await readJson<{ endpoint: string; content: boolean; stats: { dropped: number } }>(
      await send('/operator/tracing', 'operator'),
    );
    expect(body).toMatchObject({
      endpoint: 'https://lf.example/api/public/otel',
      content: false,
      stats: { dropped: 1 },
    });
    expect(body).not.toHaveProperty('tenants');
  });

  it('lists support sessions with status and ends an active one early as an audited change', async () => {
    const { send, auditFor } = await setup();
    const listed = await readJson<{ data: { id: string; status: string }[] }>(
      await send('/operator/support-sessions', 'operator'),
    );
    expect(listed.data.map((s) => [s.id, s.status])).toEqual([
      ['s1', 'active'],
      ['s0', 'expired'],
    ]);

    const ended = await send('/operator/support-sessions/s1/end', 'operator', {
      method: 'POST',
      reason: 'Ferdig med saken',
    });
    const expired = await send('/operator/support-sessions/s0/end', 'operator', {
      method: 'POST',
      reason: 'Ferdig med saken',
    });

    expect(ended.status).toBe(200);
    expect(expired.status).toBe(404);
    expect((await auditFor(ended.headers.get('genai-task') ?? ''))?.data).toMatchObject({
      reason: 'Ferdig med saken',
    });
  });

  it('extends an active support session with a reason, but not an expired one', async () => {
    const { send } = await setup();

    const extended = await send('/operator/support-sessions/s1/extend', 'operator', {
      method: 'POST',
      body: { minutes: 15 },
      reason: 'Trenger mer tid til feilsøkingen',
    });
    const tooLong = await send('/operator/support-sessions/s1/extend', 'operator', {
      method: 'POST',
      body: { minutes: 240 },
      reason: 'Trenger mer tid til feilsøkingen',
    });
    const expired = await send('/operator/support-sessions/s0/extend', 'operator', {
      method: 'POST',
      body: { minutes: 15 },
      reason: 'Trenger mer tid til feilsøkingen',
    });
    const unreasoned = await send('/operator/support-sessions/s1/extend', 'operator', {
      method: 'POST',
      body: { minutes: 15 },
    });

    expect(extended.status).toBe(200);
    expect(await readJson(extended)).toMatchObject({
      id: 's1',
      expiresAt: '2026-10-07T10:35:00.000Z',
    });
    expect(tooLong.status).toBe(400);
    expect(expired.status).toBe(404);
    expect(unreasoned.status).toBe(400);
  });

  it('filters running tasks by tenant and service and cancels one as an audited change', async () => {
    const { send, cancelled } = await setup();
    const all = await readJson<{ data: { task: string; service?: string }[] }>(
      await send('/operator/running-tasks', 'operator'),
    );
    const elsewhere = await readJson<{ data: unknown[] }>(
      await send(`/operator/running-tasks?tenant=${other}`, 'operator'),
    );
    const byService = await readJson<{ data: unknown[] }>(
      await send('/operator/running-tasks?service=klarsprak', 'operator'),
    );
    expect(all.data).toEqual([expect.objectContaining({ task: 'task-1', service: 'klarsprak' })]);
    expect(elsewhere.data).toEqual([]);
    expect(byService.data).toHaveLength(1);

    const withoutReason = await send('/operator/tasks/task-1/cancel', 'operator', {
      method: 'POST',
    });
    const employee = await send('/operator/tasks/task-1/cancel', 'kari', {
      method: 'POST',
      reason: 'x er nødvendig nå',
    });
    const done = await send('/operator/tasks/task-1/cancel', 'operator', {
      method: 'POST',
      reason: 'Henger og må stoppes',
    });
    const again = await send('/operator/tasks/task-1/cancel', 'operator', {
      method: 'POST',
      reason: 'Henger og må stoppes',
    });

    expect(withoutReason.status).toBe(400);
    expect(employee.status).toBe(403);
    expect(done.status).toBe(200);
    expect(again.status).toBe(404);
    expect(cancelled).toEqual(['task-1']);
  });

  it('refuses audited console actions for a non-operator even when called directly', async () => {
    const deps = {
      tasks: () => [],
      support: { list: () => [], end: () => undefined },
    } as unknown as ConsoleDeps;
    const handlers = consoleAdminExtensions(deps);
    const employee: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: digdir,
    };
    for (const action of [
      'platform.service.share',
      'platform.judge.label',
      'platform.support.end',
      'platform.task.cancel',
    ]) {
      const outcome = await handlers[action]?.({ reason: 'x', tenant: digdir }, employee);
      expect(outcome?.ok, action).toBe(false);
    }
  });

  it("shows operators a tenant's service definitions and their version history without a support session", async () => {
    const { send, store } = await setup();
    const current = await store.get('Service', digdir, 'klarsprak');
    await store.publish(
      { ...structuredClone(current?.definition), metadata: { tenant: digdir, id: 'klarsprak' } },
      'employee:test:kari',
      'Ny instruks',
      files,
    );

    const list = await readJson<{ data: { id: string; latestVersion: number }[] }>(
      await send(`/operator/tenants/${digdir}/definitions`, 'operator'),
    );
    const detail = await readJson<{ versions: { version: number; reason: string }[] }>(
      await send(`/operator/tenants/${digdir}/definitions/services/klarsprak`, 'operator'),
    );
    const first = await readJson<{ version: number; definition: { kind: string } }>(
      await send(
        `/operator/tenants/${digdir}/definitions/services/klarsprak/versions/1`,
        'operator',
      ),
    );
    const missing = await send(
      `/operator/tenants/${digdir}/definitions/services/ukjent`,
      'operator',
    );

    expect(list.data).toEqual([expect.objectContaining({ id: 'klarsprak', latestVersion: 2 })]);
    expect(detail.versions.map((v) => [v.version, v.reason])).toEqual([
      [1, 'seed'],
      [2, 'Ny instruks'],
    ]);
    expect(first).toMatchObject({ version: 1, definition: { kind: 'Service' } });
    expect(missing.status).toBe(404);
  });

  it('lists the audit log across tenants and logs an export with a reason', async () => {
    const { send } = await setup();
    await send('/operator/support-sessions/s1/end', 'operator', {
      method: 'POST',
      reason: 'Ferdig med saken',
    });

    const exported = await send('/operator/audit/exports', 'operator', {
      method: 'POST',
      body: { count: 1 },
      reason: 'Eksport av revisjonsloggen',
    });
    const refused = await send('/operator/audit/exports', 'operator', {
      method: 'POST',
      body: { count: 1 },
    });
    const audit = await readJson<{ data: { action: string; reason: string }[] }>(
      await send('/operator/audit', 'operator'),
    );

    expect(exported.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(audit.data.map((e) => e.action).sort()).toEqual([
      'platform.audit.export',
      'platform.support.end',
    ]);
  });

  it('names the person behind each audit entry when the name is known', async () => {
    const { send } = await setup();
    await send('/operator/audit/exports', 'operator', {
      method: 'POST',
      body: { count: 1 },
      reason: 'Eksport av revisjonsloggen',
    });

    const audit = await readJson<{ data: { actor: string; actorName?: string }[] }>(
      await send('/operator/audit', 'operator'),
    );

    expect(audit.data.map((e) => [e.actor, e.actorName])).toEqual([
      ['operator:test:drift', 'Dina Drift'],
    ]);
  });
});
