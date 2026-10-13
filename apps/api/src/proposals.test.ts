import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { InMemoryEvalRunStore } from '@genai/eval';
import {
  InMemoryConnections,
  McpToolSource,
  type EgressRequest,
  type EgressResponse,
  type RemoteTool,
} from '@genai/providers-mcp-client';
import type { AssistantProposal } from '@genai/strategy-builder';
import { tenantAccess } from './access.js';
import { createAdmin } from './admin.js';
import { createBuildingBlocksModule } from './building-blocks.js';
import type { CatalogRegistry } from './catalog-registry.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { adminExtensions, TenantDirectory } from './extensions.js';
import type { ModuleDeps } from './platform-modules.js';
import {
  connectorMappingKind,
  createProposalsModule,
  storeProposal,
  type CatalogProposal,
  type OperatorProposal,
  type ProposalDecision,
} from './proposals.js';
import { digdir, plugins, settingDefinitions } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  mona: {
    kind: 'employee',
    issuer: 'test',
    subject: 'mona',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services', 'manage-services'] }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  operator: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  per: { kind: 'employee', issuer: 'test', subject: 'per', tenant: '974760673' },
};

const fakeMcp = (tools: () => RemoteTool[]) => ({
  request: async (
    _allow: unknown,
    _target: string,
    init: EgressRequest,
  ): Promise<EgressResponse> => {
    const message = JSON.parse(init.body ?? '{}') as { id?: number; method: string };
    if (message.id === undefined) return { status: 202, headers: {}, body: '' };
    const result = message.method === 'tools/list' ? { tools: tools() } : {};
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
    };
  },
});

const proposal = (level: 2 | 3 | 4): AssistantProposal => ({
  id: `a${level}`,
  level,
  kind: level === 2 ? 'connector' : level === 3 ? 'building_block' : 'platform_change',
  title: level === 3 ? 'Risikoscore for tilskudd' : 'Kobling til fagsystemets database',
  detail: 'Foreslått av assistenten',
  validation: { ok: true },
  requiresApproval: true,
  appliedToDraft: false,
  ...(level === 2
    ? {
        mapping: [
          { table: 'soknad', becomes: 'document' as const, fields: ['tekst'] },
          { table: 'logg', becomes: 'excluded' as const, reason: 'Ikke relevant' },
        ],
        permissions: [{ type: 'data', value: 'soknad' }],
        tests: [{ name: 'Minst én tabell blir dokumenter', passed: true }],
      }
    : {}),
  ...(level === 3
    ? {
        permissions: [
          { type: 'network', value: 'https://risiko.example.no/mcp', note: 'MCP-server' },
        ],
        tests: [],
        quality: 'Samme svar som Excel-arket på 48 av 50',
      }
    : {}),
  ...(level === 4
    ? { platformChange: { summary: 'Les Excel-ark direkte', caseId: '', status: 'sent' as const } }
    : {}),
});

const setup = async () => {
  const store = new InMemoryDefinitionStore({ ...plugins, settings: settingDefinitions });
  const configEntries = new InMemoryConfigEntryStore();
  const connections = new InMemoryConnections();
  let served: RemoteTool[] = [];
  const guard = fakeMcp(() => served);
  const source = new McpToolSource({
    registry: connections,
    secrets: { resolve: async () => 'secret' },
    guard: guard as never,
  });
  const deps = {
    platformTenant: digdir,
    catalog: {
      visibleTo: () => [],
      get: () => undefined,
      history: async () => [],
    } as unknown as CatalogRegistry,
    definitions: store,
    plugins: { ...plugins, guardrails: new Map(), blocks: new Set<string>() },
    configEntries,
    models: { describe: () => [] },
    knowledge: { resolve: () => undefined },
    engines: () => [],
    evalStores: { runs: new InMemoryEvalRunStore() },
    connections,
  } as unknown as ModuleDeps;
  const now = () => new Date('2026-10-07T10:00:00Z');
  const blocks = createBuildingBlocksModule({ guard, now })(deps);
  let ids = 0;
  const proposals = createProposalsModule({ now, newId: () => `prop-${++ids}` })(deps);
  const admin = createAdmin({
    store,
    plugins,
    settings: new SettingsRegistry(settingDefinitions),
    platformTenant: digdir,
    tenants: async () => [{ orgNumber: digdir, name: 'Digitaliseringsdirektoratet' }],
    extensions: {
      ...adminExtensions({
        tools: { connections, source, onToolsChanged: async () => undefined },
        directory: new TenantDirectory(),
      }),
      ...blocks.handlers,
      ...proposals.handlers,
    },
  });
  const app = new Hono();
  const mountDeps = {
    ...deps,
    admin,
    authenticate: async (request: Request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: tenantAccess(admin),
  };
  blocks.mount(app, mountDeps);
  proposals.mount(app, mountDeps);
  const send = (path: string, who: string, input?: Record<string, unknown>) => {
    const { reason: why, ...body } = input ?? {};
    return app.request(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        ...(typeof why === 'string' ? { 'change-reason': encodeURIComponent(why) } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const create = async (level: 2 | 3 | 4, ask?: string) => {
    const stored = await storeProposal(
      admin,
      people.kari as Principal,
      digdir,
      { id: 'soknadsuttrekk', name: 'Søknadsuttrekk' },
      proposal(level),
      ask,
    );
    if (!stored) throw new Error('not stored');
    return stored;
  };
  const serve = (tools: RemoteTool[]) => {
    served = tools;
  };
  return { app, send, create, serve, connections, configEntries, admin };
};

const json = async <T>(res: Response) => (await res.json()) as T;
const base = `/tenants/${digdir}/proposals`;
const reason = 'Trengs for å regne ut risiko';

describe('assistant proposals', () => {
  it('approving a level-3 proposal needs the register right and a reason and reruns the contract test', async () => {
    const { send, create, serve, connections } = await setup();
    const stored = await create(3);

    const withoutRight = await send(`${base}/${stored.id}/approve`, 'mona', { reason });
    const shortReason = await send(`${base}/${stored.id}/approve`, 'kari', { reason: 'ok' });
    serve([{ name: 'risiko', description: 'Regner ut risiko' }]);
    const failing = await send(`${base}/${stored.id}/approve`, 'kari', { reason });
    const stillPending = await json<CatalogProposal>(await send(`${base}/${stored.id}`, 'kari'));
    serve([{ name: 'risiko', description: 'Regner ut risiko', inputSchema: { type: 'object' } }]);
    const approved = await send(`${base}/${stored.id}/approve`, 'kari', { reason });
    const decision = await json<ProposalDecision>(approved);

    expect(withoutRight.status).toBe(403);
    expect(((await withoutRight.json()) as { title: string }).title).toContain(
      'Registrere byggeklosser',
    );
    expect(shortReason.status).toBe(400);
    expect(failing.status).toBe(422);
    expect(stillPending.state).toBe('pending');
    expect(approved.status).toBe(200);
    expect(decision).toMatchObject({
      proposal: {
        state: 'approved',
        level: 3,
        item: { id: 'risikoscore-for-tilskudd', kind: 'tool' },
        decision: { by: 'employee:test:kari', reason },
      },
      changedBy: { by: 'employee:test:kari', reason },
    });
    expect(decision.proposal.tests.length).toBeGreaterThan(0);
    expect(decision.proposal.tests.every((t) => t.passed)).toBe(true);
    expect((await connections.list(digdir)).map((s) => s.connection.id)).toEqual([
      'risikoscore-for-tilskudd',
    ]);
  });

  it('a direct call cannot approve a level-3 proposal without Registrere byggeklosser', async () => {
    const { create, admin } = await setup();
    const stored = await create(3);

    const result = await admin.perform(people.mona as Principal, 'platform.proposal.decide', {
      tenant: digdir,
      reason,
      id: stored.id,
      op: 'approve',
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('Registrere byggeklosser');
  });

  it('users without the right send a proposal for approval instead', async () => {
    const { send, create } = await setup();
    const stored = await create(3);

    const sent = await send(`${base}/${stored.id}/send-for-approval`, 'erik', { reason });
    const listed = await json<{ data: CatalogProposal[] }>(
      await send(`${base}?state=sent_for_approval&level=3`, 'erik'),
    );

    expect(sent.status).toBe(200);
    expect(listed.data.map((p) => p.id)).toEqual([stored.id]);
  });

  it('approving a level-2 proposal needs Administrere datasett and a platform that reads databases', async () => {
    const { send, create, configEntries } = await setup();
    const stored = await create(2);

    const withoutRight = await send(`${base}/${stored.id}/approve`, 'mona', { reason });
    const turnedOff = await send(`${base}/${stored.id}/approve`, 'kari', {
      reason,
      connection: { host: 'db.etaten.no', database: 'fag', user: 'leser', password: 'hemmelig' },
    });
    const mappings = await configEntries.latest({ kind: connectorMappingKind, scope: digdir });

    expect(withoutRight.status).toBe(403);
    expect(await json(withoutRight)).toMatchObject({
      title: 'Du trenger rettigheten «Administrere datasett»',
    });
    expect(turnedOff.status).toBe(409);
    expect(JSON.stringify(await json(turnedOff))).not.toContain('hemmelig');
    expect(mappings).toEqual([]);
    expect((await json<CatalogProposal>(await send(`${base}/${stored.id}`, 'kari'))).state).toBe(
      'pending',
    );
  });

  it('rejecting leaves nothing active', async () => {
    const { send, create, connections } = await setup();
    const stored = await create(3);

    const rejected = await json<ProposalDecision>(
      await send(`${base}/${stored.id}/reject`, 'kari', { reason: 'Vi bruker Excel-arket' }),
    );
    const again = await send(`${base}/${stored.id}/approve`, 'kari', { reason });

    expect(rejected.proposal.state).toBe('rejected');
    expect(again.status).toBe(409);
    expect(await connections.list(digdir)).toEqual([]);
  });

  it('the operator sees what the person asked the assistant and why it needs a platform change', async () => {
    const { send, create } = await setup();
    const stored = await create(4, 'Kan tjenesten lese Excel-arket direkte?');

    const listed = await json<{ data: OperatorProposal[] }>(
      await send('/operator/proposals?level=4', 'operator'),
    );

    expect(listed.data.find((p) => p.id === stored.id)).toMatchObject({
      ask: 'Kan tjenesten lese Excel-arket direkte?',
      detail: proposal(4).detail,
    });
  });

  it('a level-4 proposal is stored with status sent and a case id and the operator can move it to planned', async () => {
    const { send, create } = await setup();
    const first = await create(4);
    const second = await create(4);

    const listed = await json<{ data: OperatorProposal[] }>(
      await send('/operator/proposals?level=4&status=sent', 'operator'),
    );
    const notOperator = await send(`/operator/proposals/${first.id}/status`, 'kari', {
      status: 'planned',
      reason,
    });
    const tenantApprove = await send(`${base}/${first.id}/approve`, 'kari', { reason });
    const planned = await send(`/operator/proposals/${first.id}/status`, 'operator', {
      status: 'planned',
      reason: 'Tas med i neste versjon',
    });
    const after = await json<CatalogProposal>(await send(`${base}/${first.id}`, 'kari'));
    const reopened = await send(`/operator/proposals/${first.id}/status`, 'operator', {
      status: 'under_review',
      reason: 'Vurderer på nytt',
    });

    expect(first).toMatchObject({
      level: 4,
      state: 'pending',
      platformChange: { summary: 'Les Excel-ark direkte', caseId: 'KI-2026-0001', status: 'sent' },
    });
    expect(second.platformChange?.caseId).toBe('KI-2026-0002');
    expect(listed.data.map((p) => [p.id, p.tenant])).toEqual(
      expect.arrayContaining([
        [first.id, digdir],
        [second.id, digdir],
      ]),
    );
    expect(notOperator.status).toBe(403);
    expect(tenantApprove.status).toBe(409);
    expect(planned.status).toBe(200);
    expect(after).toMatchObject({
      platformChange: { status: 'planned', caseId: 'KI-2026-0001' },
      decision: { by: 'operator:test:drift', reason: 'Tas med i neste versjon' },
    });
    expect(reopened.status).toBe(409);
  });

  it('the level-4 queue shows names and status, and decisions take approve, reason and a case id', async () => {
    const { send, create, admin } = await setup();
    const stored = await create(4);

    const queue = await json<{ data: Record<string, unknown>[] }>(
      await send('/operator/proposals?level=4&status=pending', 'operator'),
    );
    const byTenant = await send(`/operator/proposals/${stored.id}/decision`, 'kari', {
      approve: true,
      reason: 'Godkjenner selv dette',
    });
    const decided = await send(`/operator/proposals/${stored.id}/decision`, 'operator', {
      approve: true,
      reason: 'Tas med i neste versjon',
      caseId: 'SAK-2026-17',
    });
    const after = await json<{ data: Record<string, unknown>[] }>(
      await send('/operator/proposals?level=4', 'operator'),
    );

    expect(queue.data).toEqual([
      expect.objectContaining({
        id: stored.id,
        tenant: digdir,
        tenantName: 'Digitaliseringsdirektoratet',
        title: expect.any(String),
        summary: 'Les Excel-ark direkte',
        status: 'pending',
        createdAt: stored.createdAt,
        caseId: 'KI-2026-0001',
      }),
    ]);
    expect(byTenant.status).toBe(403);
    expect(decided.status).toBe(200);
    expect(after.data[0]).toMatchObject({ status: 'approved', caseId: 'SAK-2026-17' });
    expect((await admin.audit()).map((a) => a.action)).toContain('platform.proposal.status');
  });

  it('an operator rejection keeps the reason on the platform change', async () => {
    const { send, create } = await setup();
    const stored = await create(4);

    await send(`/operator/proposals/${stored.id}/status`, 'operator', {
      status: 'rejected',
      reason: 'Dekkes av eksisterende kobling',
    });
    const after = await json<CatalogProposal>(await send(`${base}/${stored.id}`, 'kari'));

    expect(after).toMatchObject({
      state: 'rejected',
      platformChange: { status: 'rejected', rejectionReason: 'Dekkes av eksisterende kobling' },
    });
  });

  it('a proposal decision takes its reason from the change-reason header and never from the body', async () => {
    const { app, create } = await setup();
    const stored = await create(3);

    const bodyOnly = await app.request(`${base}/${stored.id}/reject`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Begrunnelse bare i kroppen' }),
    });

    expect(bodyOnly.status).toBe(400);
    expect(await bodyOnly.json()).toMatchObject({ errors: [{ path: 'change-reason' }] });
  });

  it('answers 404 on proposal routes to someone who cannot reach the tenant, before any right check', async () => {
    const { send, create } = await setup();
    const stored = await create(3);

    expect((await send(base, 'per')).status).toBe(404);
    expect((await send(`${base}/${stored.id}`, 'per')).status).toBe(404);
    expect((await send(`${base}/${stored.id}/approve`, 'per', { reason })).status).toBe(404);
    expect((await send(`${base}/${stored.id}/approve`, 'operator', { reason })).status).toBe(404);
  });
});
