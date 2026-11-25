import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { personKeys } from '@genai/identity';
import { envSecrets, KernelError, type Kernel } from '@genai/kernel';
import type { Principal, Task } from '@genai/contracts';
import { createAccessPeopleModule } from './access-people.js';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { createPlatform, platformModules } from './composition.js';
import {
  contentGatedKernel,
  contentRoutes,
  osloDayEnd,
  skillDefinitionRoutes,
} from './content-reason.js';
import { auth, plugins, settingDefinitions } from './testkit.js';

const metadataRoutes = new Set([
  'DELETE /tenants/:tenant/api-key-policies/:id',
  'DELETE /tenants/:tenant/api-keys/:id/policy',
  'DELETE /tenants/:tenant/building-blocks/approval-requests/:request',
  'DELETE /tenants/:tenant/catalog/:kind/:id',
  'DELETE /tenants/:tenant/clients/:client/hostnames/:hostname',
  'DELETE /tenants/:tenant/clients/:id',
  'DELETE /tenants/:tenant/datasets/:dataset/pipelines/:id',
  'DELETE /tenants/:tenant/datasets/:id',
  'DELETE /tenants/:tenant/gates/:id',
  'DELETE /tenants/:tenant/guardrail-rules/:id',
  'DELETE /tenants/:tenant/hooks/:id',
  'DELETE /tenants/:tenant/maskinporten-clients/:clientId',
  'DELETE /tenants/:tenant/projects/:project',
  'DELETE /tenants/:tenant/projects/:project/subscriptions/:selection',
  'DELETE /tenants/:tenant/secrets/:name',
  'DELETE /tenants/:tenant/services/:id',
  'DELETE /tenants/:tenant/services/:id/draft',
  'DELETE /tenants/:tenant/services/:id/draft/blocks/:publisher/:blockId',
  'DELETE /tenants/:tenant/services/:id/environments/:environment',
  'DELETE /tenants/:tenant/settings/:key',
  'DELETE /tenants/:tenant/skills/:id/share',
  'DELETE /tenants/:tenant/step-flows/:id',
  'DELETE /tenants/:tenant/tracing/connections/:id',
  'GET /tenants/:tenant/access',
  'GET /tenants/:tenant/api-key-policies',
  'GET /tenants/:tenant/audit',
  'GET /tenants/:tenant/blocks',
  'GET /tenants/:tenant/blocks/:id/share-requests',
  'GET /tenants/:tenant/blocks/:publisher/:id',
  'GET /tenants/:tenant/building-blocks',
  'GET /tenants/:tenant/building-blocks/:kind/:id',
  'GET /tenants/:tenant/building-blocks/:kind/:id/versions',
  'GET /tenants/:tenant/building-blocks/manifest-preview',
  'GET /tenants/:tenant/building-blocks/secrets',
  'GET /tenants/:tenant/building-blocks/step_flow/:id/definition',
  'GET /tenants/:tenant/catalog',
  'GET /tenants/:tenant/catalog/:kind/:id/versions',
  'GET /tenants/:tenant/clients',
  'GET /tenants/:tenant/clients/:client/hostnames',
  'GET /tenants/:tenant/connectors',
  'GET /tenants/:tenant/connectors/:id',
  'GET /tenants/:tenant/connectors/network',
  'GET /tenants/:tenant/datasets',
  'GET /tenants/:tenant/datasets/:dataset/pipelines',
  'GET /tenants/:tenant/datasets/:dataset/pipelines/:id',
  'GET /tenants/:tenant/datasets/:dataset/pipelines/:id/estimate',
  'GET /tenants/:tenant/datasets/:dataset/pipelines/:id/executions',
  'GET /tenants/:tenant/datasets/:dataset/pipelines/:id/versions',
  'GET /tenants/:tenant/datasets/:id',
  'GET /tenants/:tenant/datasets/:id/engine',
  'GET /tenants/:tenant/datasets/:id/engine-switches',
  'GET /tenants/:tenant/datasets/:id/engine-switches/:sid',
  'GET /tenants/:tenant/datasets/:id/engine-switches/estimate',
  'GET /tenants/:tenant/definitions',
  'GET /tenants/:tenant/definitions/strategies',
  'GET /tenants/:tenant/definitions/template',
  'GET /tenants/:tenant/diagnostics/services/:service/resolution',
  'GET /tenants/:tenant/gates',
  'GET /tenants/:tenant/gates/:id/versions',
  'GET /tenants/:tenant/guardrail-rules',
  'GET /tenants/:tenant/guardrail-rules/:id/versions',
  'GET /tenants/:tenant/hooks',
  'GET /tenants/:tenant/integrations',
  'GET /tenants/:tenant/knowledge/endpoints',
  'GET /tenants/:tenant/knowledge/engines',
  'GET /tenants/:tenant/maskinporten-clients',
  'GET /tenants/:tenant/me',
  'GET /tenants/:tenant/me/flags',
  'GET /tenants/:tenant/me/preferences',
  'GET /tenants/:tenant/overview',
  'GET /tenants/:tenant/playground/options',
  'GET /tenants/:tenant/plugins',
  'GET /tenants/:tenant/private-networks',
  'GET /tenants/:tenant/projects',
  'GET /tenants/:tenant/projects/:project',
  'GET /tenants/:tenant/projects/:project/subscriptions',
  'GET /tenants/:tenant/projects/sources',
  'GET /tenants/:tenant/proposals',
  'GET /tenants/:tenant/proposals/:pid',
  'GET /tenants/:tenant/quota-requests',
  'GET /tenants/:tenant/service-drafts',
  'GET /tenants/:tenant/service-failures',
  'GET /tenants/:tenant/services',
  'GET /tenants/:tenant/services/:id/draft',
  'GET /tenants/:tenant/services/:id/draft/checks',
  'GET /tenants/:tenant/services/:id/environment-history',
  'GET /tenants/:tenant/services/:id/environments',
  'GET /tenants/:tenant/services/:id/lifecycle',
  'GET /tenants/:tenant/services/:id/risk-confirmations',
  'GET /tenants/:tenant/services/:service/api-keys',
  'GET /tenants/:tenant/services/:service/hostnames',
  'GET /tenants/:tenant/services/:service/shared-with',
  'GET /tenants/:tenant/settings',
  'GET /tenants/:tenant/settings/effective',
  'GET /tenants/:tenant/settings/overrides',
  'GET /tenants/:tenant/skill-tools',
  'GET /tenants/:tenant/skills',
  'GET /tenants/:tenant/skills/:id/requirements',
  'GET /tenants/:tenant/skills/:id/usage',
  'GET /tenants/:tenant/status',
  'GET /tenants/:tenant/step-flows/blocks',
  'GET /tenants/:tenant/step-flows/operations',
  'GET /tenants/:tenant/step-flows/recipes',
  'GET /tenants/:tenant/step-flows/recipes/:id/versions/:version',
  'GET /tenants/:tenant/tool-connections',
  'GET /tenants/:tenant/tracing/connections',
  'GET /tenants/:tenant/triggers',
  'GET /tenants/:tenant/usage',
  'PATCH /tenants/:tenant/services/:id/environments/:environment',
  'POST /tenants/:tenant/api-key-policies',
  'POST /tenants/:tenant/api-keys/:id/revoke',
  'POST /tenants/:tenant/blocks/:id/share-requests',
  'POST /tenants/:tenant/blocks/import',
  'POST /tenants/:tenant/blocks/preview',
  'POST /tenants/:tenant/building-blocks',
  'POST /tenants/:tenant/building-blocks/:kind/:id/adopt',
  'POST /tenants/:tenant/building-blocks/:kind/:id/approval-requests',
  'POST /tenants/:tenant/building-blocks/contract-tests',
  'POST /tenants/:tenant/building-blocks/manifest-preview',
  'POST /tenants/:tenant/clients/:client/hostnames',
  'POST /tenants/:tenant/clients/:id/webhook/test',
  'POST /tenants/:tenant/connectors/:id/sync',
  'POST /tenants/:tenant/datasets',
  'POST /tenants/:tenant/datasets/:dataset/pipelines',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/execute',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/executions/:execution/cancel',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/executions/:execution/readmit',
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/executions/:execution/redrive',
  'POST /tenants/:tenant/datasets/:id/engine-switches',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/activate',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/cancel',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/readmit',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/retry',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/rollback',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/apply',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/revert',
  'POST /tenants/:tenant/definitions/complete',
  'POST /tenants/:tenant/hooks/:id/test',
  'POST /tenants/:tenant/import',
  'POST /tenants/:tenant/projects',
  'POST /tenants/:tenant/projects/:project/runs/:run/cancel',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/check',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/pause',
  'POST /tenants/:tenant/projects/:project/subscriptions/:selection/resume',
  'POST /tenants/:tenant/proposals/:pid/approve',
  'POST /tenants/:tenant/proposals/:pid/reject',
  'POST /tenants/:tenant/proposals/:pid/send-for-approval',
  'POST /tenants/:tenant/quota-requests',
  'POST /tenants/:tenant/services/:id/batch-runs/:runId/cancel',
  'POST /tenants/:tenant/services/:id/draft/rebase',
  'POST /tenants/:tenant/services/:id/environments',
  'POST /tenants/:tenant/services/:id/environments/:environment/promote',
  'POST /tenants/:tenant/services/:id/environments/:environment/rollback',
  'POST /tenants/:tenant/services/:id/eval-runs/:runId/cancel',
  'POST /tenants/:tenant/services/:id/improvements/:pid/decision',
  'POST /tenants/:tenant/services/:id/risk-confirmations',
  'POST /tenants/:tenant/services/:service/address',
  'POST /tenants/:tenant/skills',
  'POST /tenants/:tenant/skills/:id/attachments',
  'POST /tenants/:tenant/skills/:id/fix',
  'POST /tenants/:tenant/skills/:id/publish',
  'POST /tenants/:tenant/skills/:id/share',
  'POST /tenants/:tenant/tasks/:task/cancel',
  'POST /tenants/:tenant/tool-connections/:id/revoke',
  'POST /tenants/:tenant/tool-connections/:id/sync',
  'POST /tenants/:tenant/tracing/connections/:id/check',
  'PUT /tenants/:tenant/api-key-policies/:id',
  'PUT /tenants/:tenant/api-keys/:id/policy',
  'PUT /tenants/:tenant/building-blocks/:kind/:id/settings',
  'PUT /tenants/:tenant/catalog/:kind/:id',
  'PUT /tenants/:tenant/clients/:id/hosted',
  'PUT /tenants/:tenant/connectors/:id/credentials',
  'PUT /tenants/:tenant/datasets/:dataset/pipelines/:id',
  'PUT /tenants/:tenant/datasets/:id',
  'PUT /tenants/:tenant/flags/:key',
  'PUT /tenants/:tenant/gates/:id',
  'PUT /tenants/:tenant/guardrail-rules/:id',
  'PUT /tenants/:tenant/me/flags/:key',
  'PUT /tenants/:tenant/me/preferences',
  'PUT /tenants/:tenant/pins/:key',
  'PUT /tenants/:tenant/projects/:project',
  'PUT /tenants/:tenant/projects/:project/subscriptions/:selection',
  'PUT /tenants/:tenant/secrets/:name',
  'PUT /tenants/:tenant/secrets/:name/hosts',
  'PUT /tenants/:tenant/services/:id/draft',
  'PUT /tenants/:tenant/services/:id/draft/blocks/:publisher/:blockId',
  'PUT /tenants/:tenant/services/:id/lifecycle',
  'PUT /tenants/:tenant/settings/:key',
  'PUT /tenants/:tenant/triggers/:id/pause',
]);

const tenantRoutes = async () => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: {},
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async () => undefined,
    modules: [
      ...platformModules,
      createAccessPeopleModule({ kind: 'not-configured', key: personKeys('test-person-key') }),
    ],
  });
  const settings = new SettingsRegistry(settingDefinitions);
  const admin = createAdmin({ store: platform.definitions, plugins: platform.plugins, settings });
  const modules = new Hono();
  platform.mount(modules, admin);
  const core = createApp('test', {
    platform: { store: new InMemoryDefinitionStore(plugins), plugins, settings, auth, admin },
  });
  return new Set(
    [...modules.routes, ...core.routes]
      .filter((r) => r.method !== 'ALL' && /^\/tenants\/:tenant(\/|$)/.test(r.path))
      .map((r) => `${r.method} ${r.path}`),
  );
};

describe('which tenant routes hold content', () => {
  it('classifies every tenant route as content or metadata, and nothing as both', async () => {
    const routes = await tenantRoutes();

    const skillReads = [...skillDefinitionRoutes].filter((r) => r.includes(' /tenants/'));
    const content = new Set([...contentRoutes, ...skillReads]);

    expect([...routes].filter((r) => !content.has(r) && !metadataRoutes.has(r))).toEqual([]);
    expect([...content].filter((r) => metadataRoutes.has(r))).toEqual([]);
    expect([...content, ...metadataRoutes].filter((r) => !routes.has(r))).toEqual([]);
  });
});

describe('the end of the Oslo day', () => {
  it.each([
    ['2026-10-06T10:00:00Z', '2026-10-06T22:00:00.000Z'],
    ['2026-12-01T22:30:00Z', '2026-12-01T23:00:00.000Z'],
    ['2026-03-29T00:30:00Z', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25T00:30:00Z', '2026-10-25T23:00:00.000Z'],
  ])('ends a reason given at %s at the next Oslo midnight, %s', (at, end) => {
    expect(osloDayEnd(new Date(at)).toISOString()).toBe(end);
  });
});

describe('runs read through the kernel outside the tenant routes', () => {
  const drift: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };
  const kari: Principal = {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: '991825827',
  };
  const reader: Principal = { kind: 'operator', issuer: 'platform', subject: 'console' };
  const runOf = (owner: Principal) =>
    ({
      id: 't1',
      tenant: '991825827',
      principal: { kind: owner.kind, id: JSON.stringify([owner.issuer, owner.subject]) },
    }) as unknown as Task;
  const gated = (owner: Principal, reason?: string) => {
    const reads: string[] = [];
    const kernel = { task: async () => runOf(owner) } as unknown as Kernel;
    const admin = {
      contentReason: () => (reason ? { reason } : undefined),
      recordContentRead: async (_: Principal, tenant: string, given: string) => {
        reads.push(`${tenant}: ${given}`);
      },
    } as unknown as Parameters<typeof contentGatedKernel>[1];
    return { kernel: contentGatedKernel(kernel, admin, reader), reads };
  };

  it("refuses an operator an organisation's run until a reason is given for it today", async () => {
    const { kernel, reads } = gated(kari);

    await expect(kernel.task(drift, 't1')).rejects.toBeInstanceOf(KernelError);
    expect(reads).toEqual([]);
  });

  it("records an operator's read of an organisation's run with the day's reason", async () => {
    const { kernel, reads } = gated(kari, 'Feil svar i sak 42');

    await kernel.task(drift, 't1');

    expect(reads).toEqual(['991825827: Feil svar i sak 42']);
  });

  it("lets an operator read their own run and a tenant person read the organisation's run", async () => {
    await expect(gated(drift).kernel.task(drift, 't1')).resolves.toMatchObject({ id: 't1' });
    await expect(gated(kari).kernel.task(kari, 't1')).resolves.toMatchObject({ id: 't1' });
  });
});
