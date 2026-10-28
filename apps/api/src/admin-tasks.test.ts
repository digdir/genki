import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { reasonFreeWrites } from './change-reason.js';
import { bootPlatform, digdir, testService } from './testkit.js';

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

const reason = 'Endring i testen';

const notAdminChanges = reasonFreeWrites;

const throughAdminTasks = [
  'DELETE /operator/catalog/:kind/:id',
  'DELETE /operator/datasets/:dataset/pipelines/:id',
  'DELETE /operator/gates/:id',
  'DELETE /operator/guardrail-rules/:id',
  'DELETE /operator/hooks/:id',
  'DELETE /operator/knowledge/endpoints/:id',
  'DELETE /operator/model-endpoints/:id',
  'DELETE /operator/plugins/:id',
  'DELETE /tenants/:tenant/api-key-policies/:id',
  'DELETE /tenants/:tenant/api-keys/:id/policy',
  'DELETE /tenants/:tenant/building-blocks/approval-requests/:request',
  'DELETE /tenants/:tenant/catalog/:kind/:id',
  'DELETE /tenants/:tenant/clients/:id',
  'DELETE /tenants/:tenant/datasets/:dataset/pipelines/:id',
  'DELETE /tenants/:tenant/datasets/:id/uploads/:name',
  'DELETE /tenants/:tenant/gates/:id',
  'DELETE /tenants/:tenant/guardrail-rules/:id',
  'DELETE /tenants/:tenant/hooks/:id',
  'DELETE /tenants/:tenant/maskinporten-clients/:clientId',
  'DELETE /tenants/:tenant/projects/:project',
  'DELETE /tenants/:tenant/projects/:project/subscriptions/:selection',
  'DELETE /tenants/:tenant/services/:id/draft',
  'DELETE /tenants/:tenant/settings/:key',
  'DELETE /tenants/:tenant/skills/:id/share',
  'DELETE /tenants/:tenant/skills/:id/testcases/:index',
  'DELETE /tenants/:tenant/test-sets/:id/cases/:case',
  'POST /definitions',
  'POST /operator/audit/exports',
  'POST /operator/building-blocks/:id/contract-tests',
  'POST /operator/building-blocks/approval-requests/:request/decision',
  'POST /operator/datasets',
  'POST /operator/datasets/:dataset/pipelines',
  'POST /operator/datasets/:dataset/pipelines/:id/execute',
  'POST /operator/datasets/:dataset/pipelines/:id/executions/:execution/cancel',
  'POST /operator/datasets/:id/engine-switches',
  'POST /operator/datasets/:id/engine-switches/:sid/activate',
  'POST /operator/datasets/:id/engine-switches/:sid/cancel',
  'POST /operator/datasets/:id/engine-switches/:sid/retry',
  'POST /operator/datasets/:id/engine-switches/:sid/rollback',
  'POST /operator/model-endpoints',
  'POST /operator/onboarding/requests/:id/decision',
  'POST /operator/plugins',
  'POST /operator/plugins/:id/contract-tests',
  'POST /operator/plugins/promotions',
  'POST /operator/proposals/:pid/decision',
  'POST /operator/proposals/:pid/status',
  'POST /operator/quality/labels',
  'POST /operator/quality/matrix/release',
  'POST /operator/quality/matrix/runs',
  'POST /operator/skills/shares/:id/decision',
  'PUT /operator/recipes/shares/:flow',
  'DELETE /operator/recipes/shares/:flow',
  'POST /operator/support-sessions/:id/end',
  'POST /operator/support-sessions/:id/extend',
  'POST /operator/tasks/:task/cancel',
  'POST /operator/tenants',
  'POST /support-sessions',
  'POST /tenants/:tenant/api-key-policies',
  'POST /tenants/:tenant/api-keys',
  'POST /tenants/:tenant/api-keys/:id/revoke',
  'POST /tenants/:tenant/api-keys/:id/rotate',
  'POST /tenants/:tenant/building-blocks',
  'POST /tenants/:tenant/building-blocks/:kind/:id/adopt',
  'POST /tenants/:tenant/building-blocks/:kind/:id/approval-requests',
  'POST /tenants/:tenant/clients/:id/webhook/test',
  'POST /tenants/:tenant/connectors/:id/sync',
  'POST /tenants/:tenant/datasets',
  'POST /tenants/:tenant/datasets/:dataset/pipelines',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/execute',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/executions/:execution/cancel',
  'POST /tenants/:tenant/datasets/:id/engine-switches',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/activate',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/cancel',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/retry',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/rollback',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/apply',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/revert',
  'POST /tenants/:tenant/datasets/:id/uploads',
  'POST /tenants/:tenant/import',
  'POST /tenants/:tenant/maskinporten-clients',
  'POST /tenants/:tenant/projects',
  'POST /tenants/:tenant/projects/:project/points',
  'POST /tenants/:tenant/projects/:project/runs',
  'POST /tenants/:tenant/projects/:project/runs/:run/cancel',
  'POST /tenants/:tenant/projects/:project/runs/:run/retry',
  'POST /tenants/:tenant/projects/:project/runs/:run/review',
  'POST /tenants/:tenant/projects/:project/runs/estimate',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/check',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/pause',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/resume',
  'POST /tenants/:tenant/proposals/:pid/approve',
  'POST /tenants/:tenant/proposals/:pid/reject',
  'POST /tenants/:tenant/proposals/:pid/send-for-approval',
  'POST /tenants/:tenant/services/:id/batch-runs',
  'POST /tenants/:tenant/services/:id/batch-runs/:runId/cancel',
  'POST /tenants/:tenant/services/:id/batch-runs/:runId/retry',
  'POST /tenants/:tenant/services/:id/draft/rebase',
  'POST /tenants/:tenant/services/:id/improvements/:pid/decision',
  'POST /tenants/:tenant/services/:id/risk-confirmations',
  'POST /tenants/:tenant/services/:service/api-keys',
  'POST /tenants/:tenant/skills',
  'POST /tenants/:tenant/skills/:id/attachments',
  'POST /tenants/:tenant/skills/:id/copy',
  'POST /tenants/:tenant/skills/:id/fix',
  'POST /tenants/:tenant/skills/:id/fix/:fixId/apply',
  'POST /tenants/:tenant/skills/:id/publish',
  'POST /tenants/:tenant/skills/:id/share',
  'POST /tenants/:tenant/skills/import',
  'POST /tenants/:tenant/tasks/:task/export',
  'POST /tenants/:tenant/tasks/:task/review/approve',
  'POST /tenants/:tenant/test-sets',
  'POST /tenants/:tenant/test-sets/:setId/cases',
  'POST /tenants/:tenant/testcase-candidates',
  'POST /tenants/:tenant/testcase-candidates/:id/review',
  'POST /tenants/:tenant/tool-connections',
  'POST /tenants/:tenant/tool-connections/:id/approve',
  'POST /tenants/:tenant/tool-connections/:id/sync',
  'POST /testcase-candidates/:id/review',
  'PUT /operator/catalog/:kind/:id',
  'PUT /operator/datasets/:dataset/pipelines/:id',
  'PUT /operator/datasets/:id',
  'PUT /operator/gates/:id',
  'PUT /operator/guardrail-rules/:id',
  'PUT /operator/hooks/:id',
  'PUT /operator/models/:id{.+}',
  'PUT /operator/models/:id{.+}/price',
  'PUT /operator/secrets/:name',
  'PUT /operator/shared-services/:tenant/:id',
  'PUT /operator/tenants/:tenant/private-networks',
  'PUT /settings/defaults/:key',
  'PUT /tenants/:tenant/api-key-policies/:id',
  'PUT /tenants/:tenant/api-keys/:id/policy',
  'PUT /tenants/:tenant/building-blocks/:kind/:id/settings',
  'PUT /tenants/:tenant/catalog/:kind/:id',
  'PUT /tenants/:tenant/clients/:id',
  'PUT /tenants/:tenant/connectors/:id/credentials',
  'PUT /tenants/:tenant/datasets/:dataset/pipelines/:id',
  'PUT /tenants/:tenant/datasets/:id',
  'PUT /tenants/:tenant/gates/:id',
  'PUT /tenants/:tenant/guardrail-rules/:id',
  'PUT /tenants/:tenant/hooks/:id',
  'PUT /tenants/:tenant/pins/:key',
  'PUT /tenants/:tenant/projects/:project',
  'PUT /tenants/:tenant/projects/:project/subscriptions/:selection',
  'PUT /tenants/:tenant/secrets/:name',
  'PUT /tenants/:tenant/secrets/:name/hosts',
  'PUT /tenants/:tenant/services/:id/draft',
  'PUT /tenants/:tenant/services/:id/lifecycle',
  'PUT /tenants/:tenant/settings/:key',
  'PUT /tenants/:tenant/skills/:id',
  'PUT /tenants/:tenant/tasks/:task/review/edits',
  'PUT /tenants/:tenant/test-sets/:id',
  'PUT /tenants/:tenant/test-sets/:id/cases/:case',
  'PUT /tenants/:tenant/triggers/:id/pause',
];

const boot = () => bootPlatform({ people: { kari }, services: ['hjelper'] });

describe('writes run as admin tasks', () => {
  it('creating, changing and deleting a project are audited admin tasks', async () => {
    const { send, admin } = await boot();
    const base = `/tenants/${digdir}/projects`;

    const created = await send(base, 'kari', {
      body: { id: 'arsrapporter', name: 'Årsrapporter' },
      reason,
    });
    const updated = await send(`${base}/arsrapporter`, 'kari', {
      method: 'PUT',
      body: { name: 'Årsrapporter 2024', version: 1 },
      reason,
    });
    const point = await send(`${base}/arsrapporter/points`, 'kari', {
      body: { text: 'Se på rapporteringen' },
      reason,
    });
    const removed = await send(`${base}/arsrapporter`, 'kari', { method: 'DELETE', reason });

    expect([created.status, updated.status, point.status, removed.status]).toEqual([
      201, 200, 201, 200,
    ]);
    const audit = await admin.audit(digdir);
    expect(audit.map((a) => [a.action, a.outcome, a.target, a.actor])).toEqual([
      ['platform.project.create', 'applied', 'project:arsrapporter', 'employee:test:kari'],
      ['platform.project.update', 'applied', 'project:arsrapporter', 'employee:test:kari'],
      [
        'platform.project.point.add',
        'applied',
        'project:arsrapporter/points',
        'employee:test:kari',
      ],
      ['platform.project.delete', 'applied', 'project:arsrapporter', 'employee:test:kari'],
    ]);
    expect(audit[0]?.task).toBe(created.headers.get('genai-task'));
    expect(await admin.events(audit[0]?.task ?? '')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'x.platform.change',
          data: expect.objectContaining({ action: 'platform.project.create', reason }),
        }),
      ]),
    );
  });

  it('a project write the work refuses is audited as rejected and keeps its route error', async () => {
    const { send, admin } = await boot();

    const missing = await send(`/tenants/${digdir}/projects/finnes-ikke`, 'kari', {
      method: 'PUT',
      body: { name: 'Ukjent' },
      reason,
    });

    expect(missing.status).toBe(404);
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.project.update',
      outcome: 'rejected',
    });
  });

  it('saving, rebasing and deleting a service draft are audited admin tasks', async () => {
    const { send, admin } = await boot();
    const draft = `/tenants/${digdir}/services/hjelper/draft`;

    const saved = await send(draft, 'kari', {
      method: 'PUT',
      body: { definition: testService('hjelper') },
      reason,
    });
    const removed = await send(draft, 'kari', { method: 'DELETE', body: { revision: 1 }, reason });

    expect([saved.status, removed.status]).toEqual([200, 200]);
    expect((await admin.audit(digdir)).map((a) => [a.action, a.outcome, a.target])).toEqual([
      ['platform.service.draft.save', 'applied', 'service-draft:hjelper'],
      ['platform.service.draft.delete', 'applied', 'service-draft:hjelper'],
    ]);
    expect(saved.headers.get('genai-task')).toBeTruthy();
  });

  it('a tenant secret is audited as an admin task and its value never reaches the audit', async () => {
    const { send, admin } = await boot();
    const path = `/tenants/${digdir}/secrets/arkiv-nokkel`;

    const saved = await send(path, 'kari', {
      method: 'PUT',
      body: { value: 'hemmelig-verdi', allowedHosts: ['https://arkiv.example.no'] },
      reason,
    });

    const audit = (await admin.audit(digdir)).filter((a) => a.action === 'platform.secrets.set');
    expect(saved.status).toBe(200);
    expect(audit.map((a) => [a.outcome, a.task])).toEqual([
      ['applied', saved.headers.get('genai-task')],
    ]);
    expect(JSON.stringify(audit)).not.toContain('hemmelig-verdi');
  });

  it('a route-only action called without its route is refused', async () => {
    const { admin } = await boot();

    const direct = await admin.perform(kari, 'platform.project.create', {
      tenant: digdir,
      reason,
    });

    expect(direct).toMatchObject({ ok: false, errors: [{ path: 'action' }] });
  });
});

describe('every write route', () => {
  const writeRoutes = (app: Awaited<ReturnType<typeof boot>>['app']) => [
    ...new Set(
      app.routes
        .filter(
          (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.includes('*'),
        )
        .map((r) => `${r.method} ${r.path}`),
    ),
  ];

  it('is classified as an admin task or not an admin change', async () => {
    const { app } = await boot();
    const routes = writeRoutes(app);
    const classified = [...throughAdminTasks, ...Object.keys(notAdminChanges)];

    expect(routes.filter((r) => !classified.includes(r))).toEqual([]);
    expect(classified.filter((r) => !routes.includes(r))).toEqual([]);
  });

  it('never answers a write with success without an audit entry unless it is not an admin change', async () => {
    const { app, send, admin } = await boot();
    const silent: string[] = [];
    for (const route of writeRoutes(app)) {
      if (route in notAdminChanges) continue;
      const [method = 'POST', template = ''] = route.split(' ');
      const path = template.replace(':tenant', digdir).replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x');
      const before = (await admin.audit()).length;
      const res = await send(path, 'kari', { method, body: {}, reason });
      if (res.status < 300 && (await admin.audit()).length === before) silent.push(route);
    }

    expect(silent).toEqual([]);
  }, 60_000);
});

describe('the change-reason header', () => {
  const auditedWrites = (app: Awaited<ReturnType<typeof boot>>['app']) =>
    [
      ...new Set(
        app.routes
          .filter(
            (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.includes('*'),
          )
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].filter((route) => !(route in reasonFreeWrites));

  const concrete = (template: string) =>
    template.replace(':tenant', digdir).replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x');

  it.each([
    ['missing', undefined],
    ['shorter than ten characters', 'for kort'],
  ])(
    'every audited write is refused with 400 before any change when the reason is %s',
    async (_, short) => {
      const { app, send, admin } = await boot();
      const wrong: string[] = [];
      for (const route of auditedWrites(app)) {
        const [method = 'POST', template = ''] = route.split(' ');
        const before = (await admin.audit()).length;
        const res = await send(concrete(template), 'kari', {
          method,
          body: {},
          ...(short ? { reason: short } : {}),
        });
        const body = (await res.json().catch(() => ({}))) as { errors?: { path: string }[] };
        const named = body.errors?.some((e) => e.path === 'change-reason');
        if (res.status !== 400 || !named || (await admin.audit()).length !== before)
          wrong.push(`${route} -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
    },
    60_000,
  );

  it('accepts the reason in the body only on the routes that document it', async () => {
    const { send } = await boot();
    const res = await send('/support-sessions', 'kari', {
      body: { tenant: digdir, reason: 'for kort', minutes: 5 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ path: 'change-reason' }] });
  });
});
