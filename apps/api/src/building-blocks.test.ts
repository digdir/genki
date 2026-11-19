import { Hono } from 'hono';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { Principal, Ref } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  SettingsRegistry,
  type ServiceDefinition,
} from '@genai/definitions';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import type { ToolPort } from '@genai/port-tools';
import { InMemoryEvalRunStore, type EvalRun } from '@genai/eval';
import type { ModelDescription } from '@genai/port-model';
import { A2aToolSource } from '@genai/providers-a2a-client';
import { OpenApiToolSource } from '@genai/providers-openapi-tools';
import {
  ConnectionToolSources,
  InMemoryConnections,
  McpToolSource,
  TenantSecrets,
  type EgressRequest,
  type EgressResponse,
  type RemoteTool,
} from '@genai/providers-mcp-client';
import { tenantAccess, type Access } from './access.js';
import { createAdmin } from './admin.js';
import { blockUsage, tenantServiceUses } from './block-usage.js';
import {
  adoptionKind,
  blockStatusFor,
  createBuildingBlocksModule,
  defaultPolicy,
  disabledBlockText,
  runtimeBlocksKey,
  withBlockSettings,
  outsideEuRule,
  outsideEuText,
  policyKind,
  readBlockPolicy,
  type ApprovalRequest,
  type BlockChangeResult,
  type BlockVersion,
  type BuildingBlock,
  type BuildingBlockList,
  type ContractTestReport,
  type RegistrationResult,
} from './building-blocks.js';
import type { CatalogRegistry } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { actorNames } from './actor-names.js';
import { operationGovernance } from '@genai/composition';
import { adminExtensions, TenantDirectory, TenantSecretVault } from './extensions.js';
import { localeMiddleware } from './i18n/index.js';
import type { ModuleDeps } from './platform-modules.js';
import { digdir, files, klarsprak, plugins, settingDefinitions } from './testkit.js';

const model = (id: string, residency: ModelDescription['residency']): ModelDescription => ({
  id,
  endpoint: 'foundry',
  deployment: id.split('/')[1] ?? id,
  residency,
  capabilities: ['stream'],
  apis: { chat: 'openai/chat-completions@1' },
  operations: ['chat'],
  enabled: true,
  origin: 'discovered',
  classified: true,
  parameters: {},
  rejectedParameters: {},
});

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  operator: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '999888777' },
};

const agentCard = {
  name: 'Skatteveilederen',
  description: 'Svarer på spørsmål om skatt.',
  version: '1',
  supportedInterfaces: [
    { url: 'https://agent.example.no/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'fradrag', name: 'Fradrag', description: 'Forklarer fradrag.', tags: [] }],
};

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Saks-API', version: '1' },
  paths: {
    '/saker/{id}': {
      get: {
        operationId: 'hentSak',
        summary: 'Henter en sak.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      delete: { operationId: 'slettSak', summary: 'Sletter en sak.' },
    },
  },
};

const fakeMcp = (tools: () => RemoteTool[]) => ({
  request: async (
    _allow: unknown,
    target: string,
    init: EgressRequest,
  ): Promise<EgressResponse> => {
    if (init.method === 'GET') {
      const body = target.endsWith('agent-card.json')
        ? agentCard
        : target.endsWith('openapi.json')
          ? openApiDocument
          : undefined;
      return body
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : { status: 404, headers: {}, body: '' };
    }
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

const residencyPolicy = (scope: string) => ({
  kind: policyKind,
  scope,
  id: 'residency',
  version: 1,
  spec: { rules: [outsideEuRule] },
  deleted: false,
  by: 'drift',
  at: '2026-10-07T08:00:00Z',
  reason: 'Ikke modeller utenfor EU/EØS',
});

const setup = async ({
  residencyRule = true,
  blockRefs = [] as string[],
  catalog = undefined as unknown as CatalogRegistry | undefined,
  access = undefined as Access | undefined,
  tools = [] as string[],
  guardrails = [] as string[],
  governed = false,
} = {}) => {
  const runs = new InMemoryEvalRunStore();
  const blockSet = new Set(blockRefs);
  const store = new InMemoryDefinitionStore({
    ...plugins,
    ...(tools.length > 0
      ? {
          tools: new Map(tools.map((t) => [t, z.unknown()])),
          models: new Map([
            ['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream', 'tools'] }],
          ]),
        }
      : {}),
    blocks: blockSet,
    settings: settingDefinitions,
  });
  await store.publish(klarsprak(), 'test', 'første versjon', files);
  const configEntries = new InMemoryConfigEntryStore();
  if (residencyRule) await configEntries.append(residencyPolicy(platformScope));
  const connections = new InMemoryConnections();
  let served: RemoteTool[] = [{ name: 'lookup', description: 'Slår opp' }];
  const fake = fakeMcp(() => served);
  const sent: { target: string; headers: Record<string, string> }[] = [];
  const guard = {
    request: async (allow: unknown, target: string, init: EgressRequest) => {
      sent.push({ target, headers: init.headers ?? {} });
      return fake.request(allow, target, init);
    },
  };
  const vault = new TenantSecretVault();
  const secrets = vault.resolver({ resolve: async () => 'secret' });
  const sourceOptions = {
    registry: connections,
    secrets,
    guard: guard as never,
  };
  const source = new ConnectionToolSources(connections, [
    new McpToolSource(sourceOptions),
    new A2aToolSource(sourceOptions),
    new OpenApiToolSource(sourceOptions),
  ]);
  const deps = {
    platformTenant: digdir,
    catalog:
      catalog ??
      ({
        visibleTo: () => [],
        list: () => [],
        get: () => undefined,
        history: async () => [],
      } as unknown as CatalogRegistry),
    definitions: store,
    plugins: {
      ...plugins,
      guardrails: new Map(guardrails.map((g) => [g, z.unknown()])),
      blocks: blockSet,
    },
    configEntries,
    models: {
      describe: () => [
        { ...model('foundry/gpt-4o', 'norway'), maker: 'OpenAI' },
        model('azure/gpt-41', 'eu'),
        model('openai/gpt-5', 'global'),
      ],
    },
    knowledge: { resolve: () => undefined },
    engines: () => [],
    evalStores: { runs },
    connections,
    ...(governed ? { operations: { governance: operationGovernance(configEntries, 'test') } } : {}),
  } as unknown as ModuleDeps;
  let ids = 0;
  const blocks = createBuildingBlocksModule({
    guard: guard as never,
    secrets,
    secretNames: (tenant) => vault.names(tenant),
    newId: () => `req-${++ids}`,
    now: () => new Date('2026-10-07T10:00:00Z'),
  })(deps);
  const admin = createAdmin({
    store,
    plugins,
    settings: new SettingsRegistry(settingDefinitions),
    platformTenant: digdir,
    tenants: async () => [{ orgNumber: digdir, name: 'Digitaliseringsdirektoratet' }],
    extensions: {
      ...adminExtensions({
        tools: {
          connections,
          source,
          secrets: new TenantSecrets(secrets),
          onToolsChanged: async () => undefined,
        },
        directory: new TenantDirectory(),
      }),
      ...blocks.handlers,
    },
  });
  const app = new Hono();
  app.use('*', localeMiddleware);
  blocks.mount(app, {
    ...deps,
    admin,
    authenticate: async (request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: access ?? tenantAccess(admin),
  });
  const send = (
    path: string,
    who: string,
    init: {
      method?: string;
      body?: unknown;
      reason?: string;
      ifMatch?: string;
      name?: string;
      language?: string;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...(init.ifMatch ? { 'if-match': init.ifMatch } : {}),
        ...(init.language ? { 'accept-language': init.language } : {}),
        ...(init.name ? { 'actor-name': encodeURIComponent(init.name) } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const serve = (tools: RemoteTool[]) => {
    served = tools;
  };
  return { send, admin, configEntries, connections, serve, vault, blocks, store, sent, runs };
};

const json = async <T>(res: Response) => (await res.json()) as T;
const base = `/tenants/${digdir}/building-blocks`;
const enc = encodeURIComponent;

describe('building blocks API', () => {
  it('answers 404 for a tenant the caller cannot reach, never 403', async () => {
    const { send } = await setup();

    const res = await send(`/tenants/999888777/building-blocks`, 'kari');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('checks the right on the acting principal the tenant access gives, not the raw caller', async () => {
    const delegated: Access = (principal, tenant) => ({
      ...principal,
      tenant,
      authorizedFor: [{ org: tenant }],
    });
    const raw = await setup();
    const acting = await setup({ access: delegated });

    expect((await raw.send(`${base}/secrets`, 'erik')).status).toBe(403);
    expect((await acting.send(`${base}/secrets`, 'erik')).status).toBe(200);
  });

  it('a model block page builds only model blocks, without listing tool connections or trace judges', async () => {
    const { send, connections, runs } = await setup();
    let asked = 0;
    const list = connections.list.bind(connections);
    connections.list = async (...args: Parameters<typeof list>) => {
      asked += 1;
      return list(...args);
    };
    const listRuns = runs.list.bind(runs);
    let runLists = 0;
    runs.list = async (...args: Parameters<typeof listRuns>) => {
      runLists += 1;
      return listRuns(...args);
    };

    const res = await send(`${base}/model/${enc('azure/gpt-41')}`, 'kari');

    expect(res.status).toBe(200);
    expect(asked).toBe(0);
    expect(runLists).toBe(1);
  });

  it('a model outside the tenant residencies is not_allowed with the policy text', async () => {
    const { send } = await setup();

    const list = await json<BuildingBlockList>(await send(`${base}?kind=model`, 'kari'));
    const gpt5 = list.data.find((b) => b.id === 'openai/gpt-5');
    const adopt = await send(`${base}/model/${enc('openai/gpt-5')}/adopt`, 'kari', {
      body: {},
      reason: 'Vi trenger en sterkere modell',
    });

    expect(gpt5).toMatchObject({
      status: 'not_allowed',
      dataLocation: 'global',
      policyBlock: { ownedBy: 'digdir', text: outsideEuText },
    });
    expect(list.data.find((b) => b.id === 'foundry/gpt-4o')).toMatchObject({
      status: 'in_use',
      usedBy: [{ id: 'klarsprak', name: 'Klarspråk' }],
    });
    expect(adopt.status).toBe(409);
  });

  it("scores a block by the services' latest completed runs, never a newer run still running or failed", async () => {
    const { send, runs } = await setup();
    const evalRun = (id: string, endedAt: string, extra: Partial<EvalRun>): EvalRun => ({
      id,
      testSet: { tenant: digdir, id: 'klarsprak-sett', version: 1 },
      capability: `${digdir}/klarsprak/default`,
      splits: ['validation'],
      repeats: 1,
      startedAt: endedAt,
      endedAt,
      provenance: {
        commit: 'abc',
        data: 'd',
        servedModels: ['foundry/gpt-4o'],
        judges: [],
        services: [],
      },
      results: [],
      metrics: { 'exact-text': { mean: 0.9, ci: [0.8, 1], n: 10 } },
      byTag: {},
      incomplete: [],
      ...extra,
    });
    await runs.save({
      run: evalRun('ferdig', '2026-10-01T10:00:00Z', { status: 'completed' }),
      tenant: digdir,
      task: 't1',
      service: 'klarsprak',
    });
    await runs.save({
      run: evalRun('feilet', '2026-10-02T10:00:00Z', { status: 'failed', metrics: {} }),
      tenant: digdir,
      task: 't2',
      service: 'klarsprak',
    });

    const list = await json<{ data: { id: string; scores: { run: string; score: number }[] }[] }>(
      await send(base, 'kari'),
    );

    expect(list.data.find((b) => b.id === 'foundry/gpt-4o')?.scores).toEqual([
      expect.objectContaining({ run: 'ferdig', score: 90 }),
    ]);
  });

  it('never scores a block by a run limited to marked cases', async () => {
    const { send, runs } = await setup();
    const evalRun = (id: string, endedAt: string, extra: Partial<EvalRun>): EvalRun => ({
      id,
      testSet: { tenant: digdir, id: 'klarsprak-sett', version: 1 },
      capability: `${digdir}/klarsprak/default`,
      splits: ['validation'],
      repeats: 1,
      startedAt: endedAt,
      endedAt,
      provenance: {
        commit: 'abc',
        data: 'd',
        servedModels: ['foundry/gpt-4o'],
        judges: [],
        services: [],
      },
      results: [],
      metrics: { 'exact-text': { mean: 0.9, ci: [0.8, 1], n: 10 } },
      byTag: {},
      incomplete: [],
      status: 'completed',
      ...extra,
    });
    await runs.save({
      run: evalRun('hele', '2026-10-01T10:00:00Z', {}),
      tenant: digdir,
      task: 't1',
      service: 'klarsprak',
    });
    await runs.save({
      run: evalRun('merket', '2026-10-02T10:00:00Z', {
        metrics: { 'exact-text': { mean: 0.2, ci: [0.2, 0.2], n: 1 } },
        tested: { version: 1, selected: ['c1'] },
      }),
      tenant: digdir,
      task: 't2',
      service: 'klarsprak',
    });

    const list = await json<{ data: { id: string; scores: { run: string; score: number }[] }[] }>(
      await send(base, 'kari'),
    );

    expect(list.data.find((b) => b.id === 'foundry/gpt-4o')?.scores).toEqual([
      expect.objectContaining({ run: 'hele', score: 90 }),
    ]);
  });

  it('adopting needs a reason and records Endret av', async () => {
    const { send, admin } = await setup();
    const path = `${base}/model/${enc('azure/gpt-41')}/adopt`;

    const missing = await send(path, 'kari', { body: {} });
    const short = await send(path, 'kari', { body: {}, reason: 'kort' });
    const adopted = await send(path, 'kari', { body: {}, reason: 'Trenger lange dokumenter' });
    const result = await json<BlockChangeResult>(adopted);
    const versions = await json<{ data: BlockVersion[] }>(
      await send(`${base}/model/${enc('azure/gpt-41')}/versions`, 'kari'),
    );

    expect(missing.status).toBe(400);
    expect(short.status).toBe(400);
    expect(adopted.status).toBe(200);
    expect(result.block).toMatchObject({
      status: 'in_use',
      changedBy: { by: 'employee:test:kari', reason: 'Trenger lange dokumenter' },
    });
    expect(versions.data).toContainEqual(
      expect.objectContaining({ source: 'tenant', event: 'adopted', by: 'employee:test:kari' }),
    );
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({
        action: 'platform.block.adopt',
        actor: 'employee:test:kari',
        outcome: 'applied',
        reason: 'Trenger lange dokumenter',
      }),
    );
  });

  it('names when and by whom the organisation took a model into use, also after a settings change', async () => {
    const { send, configEntries } = await setup();
    await actorNames(configEntries).remember(people.kari as Principal, 'Kari Nordmann');
    const model = `${base}/model/${enc('foundry/gpt-4o')}`;
    const before = await json<Record<string, unknown>>(await send(model, 'kari'));
    await send(`${model}/adopt`, 'kari', { body: {}, reason: 'Trenger norsk lagring' });
    const changed = await send(`${model}/settings`, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: true } },
      reason: 'Bekrefter at den er på',
    });

    const after = await json<Record<string, unknown>>(await send(model, 'kari'));

    expect(changed.status).toBe(200);
    expect(before).not.toHaveProperty('adoptedAt');
    expect(after).toMatchObject({
      adoptedAt: '2026-10-07T10:00:00.000Z',
      adoptedByName: 'Kari Nordmann',
    });
  });

  it('settings changes are versioned and report affected services', async () => {
    const { send } = await setup();
    const path = `${base}/model/${enc('foundry/gpt-4o')}/settings`;

    const first = await send(path, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: false } },
      reason: 'Stopper bruken mens vi tester',
      ifMatch: '0',
    });
    const stale = await send(path, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: true } },
      reason: 'Slår på igjen',
      ifMatch: '0',
    });
    const invalid = await send(path, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: 'ja' } },
      reason: 'Feil type på verdien',
    });
    const second = await send(path, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: null } },
      reason: 'Tilbake til plattformstandard',
      ifMatch: '1',
    });

    expect(first.status).toBe(200);
    expect(await json<BlockChangeResult>(first)).toMatchObject({
      version: 1,
      changes: [{ key: 'enabled', before: null, after: false }],
      affectedServices: [{ id: 'klarsprak', name: 'Klarspråk' }],
      block: { tenantOverrides: { enabled: false }, settingsVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect(invalid.status).toBe(400);
    expect(await json<BlockChangeResult>(second)).toMatchObject({
      version: 2,
      block: { tenantOverrides: {} },
    });
  });

  it('registering an MCP block refuses until the contract test passes', async () => {
    const { send, serve, connections } = await setup();
    const input = {
      type: 'mcp',
      name: 'Saksarkivet',
      endpoint: 'https://arkiv.testetaten.example.no/mcp',
      auth: { kind: 'none' },
    };

    const tested = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', { body: input }),
    );
    const refused = await send(base, 'kari', { body: input, reason: 'Nytt arkivverktøy' });
    serve([{ name: 'lookup', description: 'Slår opp en sak', inputSchema: { type: 'object' } }]);
    const registered = await send(base, 'kari', { body: input, reason: 'Nytt arkivverktøy' });
    const preview = await json<{ manifest: string }>(
      await send(`${base}/manifest-preview`, 'kari', { body: input }),
    );
    const tool = await json<BuildingBlock>(await send(`${base}/tool/saksarkivet`, 'kari'));

    expect(tested.passed).toBe(false);
    expect(tested.results).toContainEqual(
      expect.objectContaining({ name: 'Verktøyene har beskrivelse og inputSchema', passed: false }),
    );
    expect(refused.status).toBe(422);
    expect(await connections.get(digdir, 'saksarkivet')).toMatchObject({
      tools: [expect.objectContaining({ remoteName: 'lookup' })],
    });
    expect(registered.status).toBe(201);
    expect(preview.manifest).toContain('apiVersion: genai/v1');
    expect(preview.manifest).toContain('arkiv.testetaten.example.no');
    expect(tool).toMatchObject({
      kind: 'tool',
      publisher: { type: 'own' },
      permissions: [{ type: 'network', value: 'arkiv.testetaten.example.no' }],
    });
  });

  it('the secrets route lists names from the secret store and never values', async () => {
    const { send, admin, vault } = await setup();
    await vault.set(digdir, 'arkiv-nokkel', 'hemmelig-verdi', ['https://arkiv.example.no']);
    await vault.set('999888777', 'annen-nokkel', 'hemmelig-verdi');
    await admin.perform(people.kari as Principal, 'platform.secrets.set', {
      tenant: digdir,
      name: 'bare-i-loggen',
      reason: 'Står i loggen, men ikke i hvelvet',
    });

    const listed = await send(`${base}/secrets`, 'kari');
    const refused = await send(`${base}/secrets`, 'erik');
    const body = await listed.text();

    expect(listed.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      data: [
        {
          name: 'arkiv-nokkel',
          ref: `secret://tenant/${digdir}/arkiv-nokkel`,
          allowedHosts: ['https://arkiv.example.no'],
        },
      ],
    });
    expect(body).not.toContain('hemmelig-verdi');
    expect(refused.status).toBe(403);
  });

  it('a connection cannot use a tenant secret bound to another host', async () => {
    const { send, connections, vault, sent, admin } = await setup();
    await vault.set(digdir, 'arkiv-nokkel', 'hemmelig-verdi', ['https://arkiv.example.no']);
    const input = {
      type: 'mcp',
      name: 'Annen tjener',
      endpoint: 'https://annen.example.com/mcp',
      auth: { kind: 'bearer', secret: 'arkiv-nokkel' },
    };

    const tested = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', { body: input }),
    );
    const registered = await send(base, 'kari', { body: input, reason: 'Ny MCP-tjener' });
    const direct = await admin.perform(people.kari as Principal, 'platform.tools.register', {
      tenant: digdir,
      reason: 'Ny MCP-tjener rett i API-et',
      connection: {
        id: 'annen',
        name: 'Annen tjener',
        endpoint: 'https://annen.example.com/mcp',
        version: '1',
        allow: [{ host: 'annen.example.com' }],
        auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/arkiv-nokkel` },
      },
    });
    const message =
      'Hemmeligheten «arkiv-nokkel» er ikke satt opp for https://annen.example.com. Be noen med retten «Administrere tjenester» om å legge til adressen på hemmeligheten.';

    expect(tested).toMatchObject({
      passed: false,
      results: [{ name: 'Oppsettet er gyldig', passed: false, reason: message }],
    });
    expect(registered.status).toBe(400);
    expect(await registered.json()).toMatchObject({
      errors: [{ path: 'auth.secret', message }],
    });
    expect(direct).toMatchObject({ ok: false, errors: [{ message }] });
    expect(await connections.list(digdir)).toEqual([]);
    expect(sent.filter((r) => JSON.stringify(r.headers).includes('hemmelig-verdi'))).toEqual([]);
    expect(sent.filter((r) => new URL(r.target).origin === 'https://annen.example.com')).toEqual(
      [],
    );
  });

  it('the refusal of a secret bound to another host is in English when asked for', async () => {
    const { send, vault } = await setup();
    await vault.set(digdir, 'arkiv-nokkel', 'hemmelig-verdi', ['https://arkiv.example.no']);

    const registered = await send(base, 'kari', {
      body: {
        type: 'mcp',
        name: 'Annen tjener',
        endpoint: 'https://annen.example.com/mcp',
        auth: { kind: 'bearer', secret: 'arkiv-nokkel' },
      },
      reason: 'Ny MCP-tjener',
      language: 'en',
    });

    expect(await registered.json()).toMatchObject({
      errors: [
        {
          message:
            'The secret «arkiv-nokkel» is not set up for https://annen.example.com. Ask someone with the right «Manage services» to add the address to the secret.',
        },
      ],
    });
  });

  it('a connection to the host a secret is set for registers and syncs with the secret', async () => {
    const { send, connections, vault, sent, serve } = await setup();
    await vault.set(digdir, 'arkiv-nokkel', 'hemmelig-verdi', ['https://arkiv.example.no']);
    serve([{ name: 'lookup', description: 'Slår opp en sak', inputSchema: { type: 'object' } }]);

    const registered = await send(base, 'kari', {
      body: {
        type: 'mcp',
        name: 'Arkiv',
        endpoint: 'https://arkiv.example.no/mcp',
        auth: { kind: 'bearer', secret: 'arkiv-nokkel' },
      },
      reason: 'Arkivet med nøkkel',
    });

    expect(registered.status).toBe(201);
    expect((await connections.get(digdir, 'arkiv'))?.tools).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({
      target: 'https://arkiv.example.no/mcp',
      headers: { authorization: 'Bearer hemmelig-verdi' },
    });
  });

  it('the MCP contract test refuses Maskinporten and secrets of others with a reason', async () => {
    const { send } = await setup();
    const input = {
      type: 'mcp',
      name: 'Saksarkivet',
      endpoint: 'https://arkiv.testetaten.example.no/mcp',
    };

    const maskinporten = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', {
        body: { ...input, auth: { kind: 'maskinporten' } },
      }),
    );
    const foreign = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', {
        body: { ...input, auth: { kind: 'api-key', secret: 'secret://env/FOUNDRY_OPENAI_KEY' } },
      }),
    );

    expect(maskinporten).toMatchObject({
      passed: false,
      results: [
        {
          name: 'Oppsettet er gyldig',
          passed: false,
          reason: 'Innlogging med Maskinporten støttes ikke ennå for MCP-servere.',
        },
      ],
    });
    expect(foreign.results[0]).toMatchObject({
      passed: false,
      reason: 'Velg en av hemmelighetene til virksomheten.',
    });
  });

  it('registers an OpenAPI document with read operations only, and lists every operation for picking', async () => {
    const { send, connections, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    const input = {
      type: 'openapi',
      name: 'Saks-API',
      endpoint: 'https://api.example.no/v1',
      document: JSON.stringify(openApiDocument),
      auth: { kind: 'api-key', secret: 'saks-api' },
    };

    const tested = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', { body: input }),
    );
    const registered = await send(base, 'kari', { body: input, reason: 'Nytt REST-verktøy' });

    expect(tested.passed).toBe(true);
    expect(tested.tools).toEqual([
      expect.objectContaining({ operation: 'hentSak', method: 'GET', status: 'enabled' }),
      expect.objectContaining({
        operation: 'slettSak',
        method: 'DELETE',
        status: 'write_disabled',
      }),
    ]);
    expect(registered.status).toBe(201);
    expect(await connections.get(digdir, 'saks-api')).toMatchObject({
      connection: { protocol: 'openapi', writes: false, auth: { kind: 'header' } },
      tools: [expect.objectContaining({ name: 'saks-api.hentsak' })],
    });
  });

  it('keeps the residency given at registration and shows it as where the tool processes data', async () => {
    const { send, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    const input = {
      type: 'openapi',
      name: 'Saks-API',
      endpoint: 'https://api.example.no/v1',
      document: JSON.stringify(openApiDocument),
      auth: { kind: 'api-key', secret: 'saks-api' },
    };

    const wrong = await send(base, 'kari', {
      body: { ...input, residency: 'mars' },
      reason: 'Nytt REST-verktøy',
    });
    const registered = await send(base, 'kari', {
      body: { ...input, residency: 'eu' },
      reason: 'Nytt REST-verktøy',
    });
    const block = await json<Record<string, unknown>>(await send(`${base}/tool/saks-api`, 'kari'));

    expect(wrong.status).toBe(400);
    expect(registered.status).toBe(201);
    expect(block).toMatchObject({ residency: 'eu', dataLocation: 'eu' });
  });

  it('write operations from OpenAPI stay off until Digdir approves them, while read operations work at once', async () => {
    const { send, connections, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    const input = {
      type: 'openapi',
      name: 'Saks-API',
      endpoint: 'https://api.example.no/v1',
      document: JSON.stringify(openApiDocument),
      auth: { kind: 'api-key', secret: 'saks-api' },
      operations: ['hentSak', 'slettSak'],
      writes: true,
    };

    const registered = await json<RegistrationResult>(
      await send(base, 'kari', { body: input, reason: 'Saks-API med sletting' }),
    );
    const before = await connections.get(digdir, 'saks-api');
    const block = await json<{ status: string }>(await send(`${base}/tool/saks-api`, 'kari'));
    const queue = await json<{ data: { id: string; grants?: string; status: string }[] }>(
      await send('/operator/building-blocks/approval-requests?status=pending', 'operator'),
    );
    const decided = await send(
      `/operator/building-blocks/approval-requests/${registered.writesApproval?.request}/decision`,
      'operator',
      { body: { approve: true }, reason: 'Sletting er avklart med virksomheten' },
    );
    const after = await connections.get(digdir, 'saks-api');

    expect(registered.writesApproval).toEqual({ request: expect.any(String), state: 'pending' });
    expect(before?.connection.writes).toBe(false);
    expect(before?.tools.map((t) => t.name)).toEqual(['saks-api.hentsak']);
    expect(block.status).toBe('pending_approval');
    expect(queue.data).toContainEqual(
      expect.objectContaining({ id: registered.writesApproval?.request, grants: 'writes' }),
    );
    expect(decided.status).toBe(200);
    expect(after?.connection.writes).toBe(true);
    expect(after?.tools.map((t) => t.name)).toEqual(['saks-api.hentsak', 'saks-api.slettsak']);
  });

  it('a write grant never approves a tool the organisation revoked', async () => {
    const { send, connections, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    const registered = await json<RegistrationResult>(
      await send(base, 'kari', {
        body: {
          type: 'openapi',
          name: 'Saks-API',
          endpoint: 'https://api.example.no/v1',
          document: JSON.stringify(openApiDocument),
          auth: { kind: 'api-key', secret: 'saks-api' },
          operations: ['hentSak', 'slettSak'],
          writes: true,
        },
        reason: 'Saks-API med sletting',
      }),
    );
    const before = await connections.get(digdir, 'saks-api');
    if (before) await connections.save({ ...before, revoked: ['slettSak'] });

    await send(
      `/operator/building-blocks/approval-requests/${registered.writesApproval?.request}/decision`,
      'operator',
      { body: { approve: true }, reason: 'Sletting er avklart med virksomheten' },
    );
    const after = await connections.get(digdir, 'saks-api');

    expect(after?.connection.writes).toBe(true);
    expect(after?.tools.map((t) => t.name)).toEqual(['saks-api.hentsak']);
    expect(after?.pending.map((t) => t.name)).toEqual(['saks-api.slettsak']);
  });

  it('registering a tool connection directly keeps OpenAPI writes off unless an operator registers it', async () => {
    const { send, connections, admin, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    await send(base, 'kari', {
      body: {
        type: 'openapi',
        name: 'Saks-API',
        endpoint: 'https://api.example.no/v1',
        document: JSON.stringify(openApiDocument),
        auth: { kind: 'api-key', secret: 'saks-api' },
        operations: ['hentSak', 'slettSak'],
      },
      reason: 'Saks-API uten sletting',
    });
    const stored = (await connections.get(digdir, 'saks-api'))?.connection;
    const register = (principal: Principal, id: string) =>
      admin.perform(principal, 'platform.tools.register', {
        tenant: digdir,
        reason: 'Saks-API med sletting',
        connection: { ...stored, id, writes: true },
      });

    const byTenant = await register(people.kari as Principal, 'saks-tenant');
    const byOperator = await register(
      { ...(people.operator as Principal), actor: people.operator as Principal },
      'saks-operator',
    );

    expect(byTenant.ok).toBe(true);
    expect((await connections.get(digdir, 'saks-tenant'))?.connection.writes).toBe(false);
    expect(byOperator.ok).toBe(true);
    expect((await connections.get(digdir, 'saks-operator'))?.connection.writes).toBe(true);
  });

  it('a write grant is saved inside the decision task that approves it', async () => {
    const { send, connections, admin, vault } = await setup();
    await vault.set(digdir, 'saks-api', 'verdi', ['https://api.example.no']);
    const registered = await json<RegistrationResult>(
      await send(base, 'kari', {
        body: {
          type: 'openapi',
          name: 'Saks-API',
          endpoint: 'https://api.example.no/v1',
          document: JSON.stringify(openApiDocument),
          auth: { kind: 'api-key', secret: 'saks-api' },
          operations: ['hentSak', 'slettSak'],
          writes: true,
        },
        reason: 'Saks-API med sletting',
      }),
    );
    const request = registered.writesApproval?.request;
    const before = await connections.get(digdir, 'saks-api');
    const approved = await send(
      `/operator/building-blocks/approval-requests/${request}/decision`,
      'operator',
      { body: { approve: true }, reason: 'Sletting er avklart med virksomheten' },
    );

    const decisions = (await admin.audit()).filter((a) => a.action === 'platform.block.decide');
    expect(before?.connection.writes).toBe(false);
    expect(decisions.map((a) => [a.outcome, a.task])).toEqual([
      ['applied', approved.headers.get('genai-task')],
    ]);
    expect((await connections.get(digdir, 'saks-api'))?.connection.writes).toBe(true);
  });

  it('refuses an OpenAPI connection to a private address in the contract test', async () => {
    const { send } = await setup();

    const tested = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', {
        body: {
          type: 'openapi',
          name: 'Internt',
          endpoint: 'https://10.1.2.3/api',
          documentUrl: 'https://10.1.2.3/openapi.json',
        },
      }),
    );

    expect(tested.results[0]).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/private address/),
    });
  });

  it('settings for a block that is not in use are refused with 409', async () => {
    const { send } = await setup();

    const res = await send(`${base}/model/${enc('azure/gpt-41')}/settings`, 'kari', {
      method: 'PUT',
      body: { settings: { enabled: false } },
      reason: 'Prøver å endre',
    });

    expect(res.status).toBe(409);
  });

  it('registers an A2A agent from its agent card, one tool per skill', async () => {
    const { send, connections } = await setup();
    const input = {
      type: 'a2a',
      name: 'Skatteveilederen',
      endpoint: 'https://agent.example.no/.well-known/agent-card.json',
      auth: { kind: 'none' },
    };

    const tested = await json<ContractTestReport>(
      await send(`${base}/contract-tests`, 'kari', { body: input }),
    );
    const registered = await send(base, 'kari', { body: input, reason: 'Ny agent for skatt' });

    expect(tested.passed).toBe(true);
    expect(tested.tools).toEqual([
      { name: 'skatteveilederen.fradrag', description: 'Skatteveilederen: Forklarer fradrag.' },
    ]);
    expect(tested.agent).toMatchObject({
      name: 'Skatteveilederen',
      description: 'Svarer på spørsmål om skatt.',
      version: '1',
      skills: [{ name: 'Fradrag', description: 'Forklarer fradrag.' }],
    });
    expect(registered.status).toBe(201);
    expect(await connections.get(digdir, 'skatteveilederen')).toMatchObject({
      connection: { protocol: 'a2a' },
      tools: [expect.objectContaining({ name: 'skatteveilederen.fradrag' })],
    });
  });

  it('skill packages are still unsupported', async () => {
    const { send } = await setup();

    const res = await send(base, 'kari', {
      body: { type: 'skill_package', name: 'Pakke' },
      reason: 'Ny ferdighetspakke',
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 'unsupported', title: 'API ikke bestemt' });
  });

  it('a user without manage-services cannot adopt', async () => {
    const { send } = await setup();

    const res = await send(`${base}/model/${enc('azure/gpt-41')}/adopt`, 'erik', {
      body: {},
      reason: 'Trenger lange dokumenter',
    });
    const read = await send(base, 'erik');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      title: 'Du trenger rettigheten «Administrere tjenester»',
    });
    expect(read.status).toBe(200);
  });

  it('the operator sees and decides approval requests', async () => {
    const { send, configEntries, admin } = await setup();
    await configEntries.append({
      kind: policyKind,
      scope: platformScope,
      id: 'default',
      version: 1,
      spec: {
        rules: [
          outsideEuRule,
          {
            id: 'models-in-eu',
            match: { kind: 'model', residency: ['eu'] },
            effect: 'requires_approval',
            ownedBy: 'digdir',
            text: 'Digdir må godkjenne modeller som behandler data utenfor Norge.',
            approver: 'digdir',
          },
        ],
      },
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-10-07T09:00:00Z',
      reason: 'Godkjenning for EU-modeller',
    });
    const block = `${base}/model/${enc('azure/gpt-41')}`;

    const before = await json<BuildingBlock>(await send(block, 'kari'));
    const adopt = await send(`${block}/adopt`, 'kari', {
      body: {},
      reason: 'Vil bruke modellen nå',
    });
    const asked = await send(`${block}/approval-requests`, 'kari', {
      body: {},
      reason: 'Trenger lange dokumenter',
      name: 'Kari Østby',
    });
    const request = await json<ApprovalRequest>(asked);
    const waiting = await json<BuildingBlock>(await send(block, 'kari'));
    const notOperator = await send('/operator/building-blocks/approval-requests', 'kari');
    const listed = await json<{ data: unknown[] }>(
      await send('/operator/building-blocks/approval-requests?status=pending', 'operator'),
    );
    const tenantDecides = await send(
      `/operator/building-blocks/approval-requests/${request.id}/decision`,
      'kari',
      { body: { approve: true }, reason: 'Godkjenner selv' },
    );
    const decided = await send(
      `/operator/building-blocks/approval-requests/${request.id}/decision`,
      'operator',
      { body: { approve: true }, reason: 'Avtale med leverandøren er på plass' },
    );
    const after = await json<BuildingBlock>(await send(block, 'kari'));

    expect(before).toMatchObject({ status: 'requires_approval', approver: 'digdir' });
    expect(adopt.status).toBe(409);
    expect(asked.status).toBe(200);
    expect(waiting).toMatchObject({
      status: 'pending_approval',
      pendingRequest: { id: request.id, by: 'employee:test:kari' },
    });
    expect(notOperator.status).toBe(403);
    expect(listed.data).toEqual([
      {
        id: request.id,
        tenant: digdir,
        tenantName: 'Digitaliseringsdirektoratet',
        block: {
          kind: 'model',
          id: 'azure/gpt-41',
          version: before.version,
          name: before.name,
          publisher: before.publisher.name,
          dataLocation: before.dataLocation,
          rule: before.policyBlock,
          access: before.permissions,
          scores: before.scores,
          services: before.usedBy.map((u) => u.name),
        },
        reason: 'Trenger lange dokumenter',
        requestedBy: 'Kari Østby',
        requestedAt: request.requestedAt,
        status: 'pending',
      },
    ]);
    expect(tenantDecides.status).toBe(403);
    expect(decided.status).toBe(200);
    expect((await admin.audit()).map((a) => [a.action, a.outcome])).toContainEqual([
      'platform.block.decide',
      'applied',
    ]);
    expect(await json<ApprovalRequest>(decided)).toMatchObject({
      state: 'approved',
      decision: { by: 'operator:test:drift', reason: 'Avtale med leverandøren er på plass' },
    });
    expect(after.status).toBe('in_use');
  });

  it('withdrawing an approval request makes the block require approval again', async () => {
    const { send, configEntries } = await setup();
    await configEntries.append({
      kind: policyKind,
      scope: digdir,
      id: 'default',
      version: 1,
      spec: {
        rules: [
          {
            id: 'eu-models',
            match: { kind: 'model', id: 'azure/gpt-41' },
            effect: 'requires_approval',
            ownedBy: digdir,
            text: 'Vi godkjenner denne selv.',
            approver: 'digdir',
          },
        ],
      },
      deleted: false,
      by: 'employee:test:kari',
      at: '2026-10-07T09:00:00Z',
      reason: 'Egen regel',
    });
    const block = `${base}/model/${enc('azure/gpt-41')}`;
    const request = await json<ApprovalRequest>(
      await send(`${block}/approval-requests`, 'kari', { body: {}, reason: 'Trenger modellen' }),
    );

    const withdrawn = await send(`${base}/approval-requests/${request.id}`, 'kari', {
      method: 'DELETE',
      reason: 'Ombestemte oss',
    });

    expect(withdrawn.status).toBe(200);
    expect((await json<BuildingBlock>(await send(block, 'kari'))).status).toBe('requires_approval');
  });
});

describe('search engines in the catalogue', () => {
  it('lists every platform endpoint for the platform tenant, with the registry name and version and real usage', async () => {
    const endpoint = (id: string, engine: string, sharing?: unknown) => ({
      kind: 'knowledge-endpoint' as const,
      id,
      scope: platformScope,
      version: 3,
      spec: { engine, name: id, ...(sharing ? { sharing } : {}) },
    });
    const items = [
      endpoint('kudos-typesense', 'typesense'),
      endpoint('platform-pg', 'pgvector', { tenants: '*' }),
      {
        kind: 'dataset' as const,
        id: 'digdir/kudos',
        scope: platformScope,
        version: 1,
        spec: { name: 'Kudos', endpoint: 'kudos-typesense' },
      },
    ];
    const catalog = {
      visibleTo: (tenant: string) =>
        items.filter((i) => i.kind !== 'knowledge-endpoint' || i.id === 'platform-pg' || !tenant),
      list: ({ kind }: { kind?: string } = {}) => items.filter((i) => !kind || i.kind === kind),
      get: (kind: string, id: string) => items.find((i) => i.kind === kind && i.id === id),
      history: async () => [],
    } as unknown as CatalogRegistry;
    const { send, store } = await setup({ catalog });
    const ka = klarsprak({ id: 'ka' });
    const result = await store.publish(
      { ...ka, spec: { ...ka.spec, knowledge: { datasets: [{ dataset: 'digdir/kudos' }] } } },
      'test',
      'ny',
      files,
    );
    expect(result.ok).toBe(true);

    const list = await json<BuildingBlockList>(await send(`${base}?kind=search_engine`, 'kari'));

    expect(list.data.map((b) => b.id).sort()).toEqual(['kudos-typesense', 'platform-pg']);
    expect(list.data.find((b) => b.id === 'kudos-typesense')).toMatchObject({
      version: '3',
      kind: 'search_engine',
      usedBy: [{ id: 'ka' }],
    });
    expect(list.data.find((b) => b.id === 'platform-pg')?.usedBy).toEqual([]);
  });
});

describe('platform building block texts', () => {
  const flow = (id: string, name: string, purpose: string) => ({
    apiVersion: 'genai/v1' as const,
    kind: 'StepFlow' as const,
    metadata: { tenant: digdir, id, name },
    spec: { purpose, steps: [{ id: 'hent', block: 'retrieve@1' }] },
  });

  it('shows platform step flows and step blocks in bokmål and English, and tenant text as written', async () => {
    const { send, store } = await setup({ blockRefs: ['retrieve@1'] });
    await store.publish(flow('basic-rag', 'Basic RAG', 'Plan queries'), 'test', 'første versjon');
    await store.publish(flow('egen-flyt', 'Min flyt', 'Skrevet av oss'), 'test', 'første versjon');
    const list = async (language?: string) =>
      (
        await json<BuildingBlockList>(
          await send(`${base}?kind=step_flow`, 'kari', language ? { language } : {}),
        )
      ).data;

    const nb = await list();
    const en = await list('en');

    expect(nb.find((b) => b.id === 'basic-rag')).toMatchObject({
      name: 'Enkel RAG',
      description: expect.stringContaining('Planlegger spørringer'),
    });
    expect(en.find((b) => b.id === 'basic-rag')).toMatchObject({
      name: 'Basic RAG',
      description: expect.stringContaining('Plan queries'),
    });
    expect(nb.find((b) => b.id === 'retrieve@1')).toMatchObject({ name: 'Søk' });
    expect(en.find((b) => b.id === 'retrieve@1')).toMatchObject({ name: 'Search' });
    for (const found of [nb, en])
      expect(found.find((b) => b.id === 'egen-flyt')).toMatchObject({
        name: 'Min flyt',
        description: 'Skrevet av oss',
      });
  });

  it("calls the platform organisation's own step flows its own, and the flows shipped with genki Digdir's", async () => {
    const { send, store } = await setup({ blockRefs: ['retrieve@1'] });
    await store.publish(flow('basic-rag', 'Basic RAG', 'Plan queries'), 'test', 'første versjon');
    await store.publish(flow('egen-flyt', 'Min flyt', 'Skrevet av oss'), 'test', 'første versjon');

    const list = (await json<BuildingBlockList>(await send(`${base}?kind=step_flow`, 'kari'))).data;

    expect(list.find((b) => b.id === 'egen-flyt')?.publisher).toEqual({
      type: 'own',
      name: digdir,
    });
    expect(list.find((b) => b.id === 'basic-rag')?.publisher.type).toBe('digdir');
    expect(list.find((b) => b.id === 'retrieve@1')?.publisher.type).toBe('digdir');
  });
});

describe('the built-in guardrails and judges', () => {
  it('have a name and a description in the language asked for, not their id', async () => {
    const { send } = await setup({ guardrails: ['pii-before-model'] });

    const read = async (kind: string, language: string) =>
      (
        await json<{ data: { id: string; name: string; description: string }[] }>(
          await send(`${base}?kind=${kind}`, 'kari', { language }),
        )
      ).data;

    expect((await read('guardrail', 'nb')).find((b) => b.id === 'pii-before-model')).toMatchObject({
      name: 'Personopplysninger før modellen',
      description: expect.stringContaining('fødselsnumre'),
    });
    expect((await read('judge', 'en')).find((b) => b.id === 'answer-quality')).toMatchObject({
      name: 'Answer quality',
      description: expect.stringContaining('correct'),
    });
  });
});

describe("the organisation's own shared services", () => {
  it('lists its own shared service with the services that use it, and leaves out services it has not shared', async () => {
    const { send, store } = await setup({ tools: ['veileder__default@1'] });
    const shared = klarsprak({ id: 'veileder' });
    await store.publish(
      { ...shared, spec: { ...shared.spec, availableTo: '*' } },
      'test',
      'deles med alle',
      files,
    );
    const user = klarsprak({ id: 'bruker' });
    const published = await store.publish(
      { ...user, spec: { ...user.spec, tools: ['veileder__default@1'] } },
      'test',
      'bruker veilederen',
      files,
    );
    expect(published.ok ? [] : published.errors).toEqual([]);

    const listed = await json<{ data: { id: string; usedBy: { id: string }[] }[] }>(
      await send(`${base}?kind=shared_service`, 'kari'),
    );

    expect(listed.data.map((b) => b.id)).toEqual([`${digdir}/veileder`]);
    expect(listed.data[0]?.usedBy.map((u) => u.id)).toEqual(['bruker']);
  });
});

describe('a shared step flow definition', () => {
  const flow = (tenant: string, id: string, name: string) => ({
    apiVersion: 'genai/v1' as const,
    kind: 'StepFlow' as const,
    metadata: { tenant, id, name },
    spec: { purpose: 'Henter svar', steps: [{ id: 'hent', block: 'retrieve@1' }] },
  });
  const other = '999888777';

  it('gives any member the latest version of a platform step flow, for its diagram and YAML', async () => {
    const { send, store } = await setup({ blockRefs: ['retrieve@1'] });
    await store.publish(flow(digdir, 'basic-rag', 'Basic RAG'), 'test', 'første versjon');
    await store.publish(flow(digdir, 'basic-rag', 'Basic RAG 2'), 'test', 'andre versjon');

    const ownRead = await send(`${base}/step_flow/basic-rag/definition`, 'erik');
    const otherRead = await send(
      `/tenants/${other}/building-blocks/step_flow/basic-rag/definition`,
      'ola',
    );

    for (const res of [ownRead, otherRead]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: 'basic-rag',
        owner: digdir,
        version: 2,
        publishedAt: expect.any(String),
        yaml: expect.stringContaining('name: Basic RAG 2'),
        definition: { kind: 'StepFlow', metadata: { id: 'basic-rag', name: 'Basic RAG 2' } },
      });
    }
  });

  it("never gives one organisation's own step flow to another", async () => {
    const { send, store } = await setup({ blockRefs: ['retrieve@1'] });
    await store.publish(flow(other, 'egen-flyt', 'Egen flyt'), 'test', 'første versjon');

    const theirs = await send(`${base}/step_flow/egen-flyt/definition`, 'kari');
    const owners = await send(
      `/tenants/${other}/building-blocks/step_flow/egen-flyt/definition`,
      'ola',
    );
    const stepBlock = await send(`${base}/step_flow/retrieve@1/definition`, 'kari');
    const outsider = await send(
      `/tenants/${other}/building-blocks/step_flow/egen-flyt/definition`,
      'kari',
    );

    expect(theirs.status).toBe(404);
    expect(owners.status).toBe(200);
    expect(stepBlock.status).toBe(404);
    expect(outsider.status).toBe(404);
  });
});

describe('block usage', () => {
  it('console usage is unchanged after extracting block-usage', async () => {
    const withBlocks = { ...plugins, blocks: new Set(['retrieve@1', 'summarise@1']) };
    const store = new InMemoryDefinitionStore({ ...withBlocks, settings: settingDefinitions });
    await store.publish(klarsprak(), 'test', 'første versjon', files);
    await store.publish(
      {
        apiVersion: 'genai/v1',
        kind: 'StepFlow',
        metadata: { tenant: digdir, id: 'flyt', name: 'Flyt' },
        spec: {
          purpose: 'Henter og oppsummerer',
          steps: [
            { id: 'hent', block: 'retrieve@1' },
            {
              id: 'gjenta',
              repeat: { until: 'ferdig', max: 2, steps: [{ id: 'kort', block: 'summarise@1' }] },
            },
          ],
        },
      },
      'test',
      'første versjon',
    );

    const usage = await blockUsage({ store, tenants: () => [digdir] });

    expect(Object.fromEntries([...usage].map(([ref, users]) => [ref, [...users].sort()]))).toEqual({
      'single-call@1': [`${digdir}/klarsprak`],
      'retrieve@1': [`${digdir}/flyt (stegflyt)`],
      'summarise@1': [`${digdir}/flyt (stegflyt)`],
    });
    expect(await tenantServiceUses(store, digdir)).toEqual([
      {
        service: 'klarsprak',
        name: 'Klarspråk',
        version: 1,
        references: [{ kind: 'model', id: 'foundry/gpt-4o' }],
      },
    ]);
  });
});

describe('block policy reader', () => {
  it('has no rules by default, so a global model is available', async () => {
    const policy = await readBlockPolicy(new InMemoryConfigEntryStore(), '999888777');

    expect(defaultPolicy).toEqual([]);
    expect(policy.rules).toEqual([]);
    expect(
      blockStatusFor(policy, { kind: 'model', id: 'openai/gpt-5', dataLocation: 'global' }).status,
    ).toBe('available');
  });

  it('applies an explicit residency policy and lets an approved adoption through', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await configEntries.append(residencyPolicy(platformScope));
    await configEntries.append({
      kind: policyKind,
      scope: '999888777',
      id: 'eu-models',
      version: 1,
      spec: {
        rules: [
          {
            id: 'models-in-eu',
            match: { kind: 'model', residency: ['eu'] },
            effect: 'requires_approval',
            ownedBy: 'digdir',
            text: 'Digdir må godkjenne modeller i EU/EØS.',
          },
        ],
      },
      deleted: false,
      by: 'kari',
      at: '2026-10-07T09:00:00Z',
      reason: 'Egen regel for EU-modeller',
    });
    const before = await readBlockPolicy(configEntries, '999888777');
    await configEntries.append({
      kind: adoptionKind,
      scope: '999888777',
      id: 'model:azure/gpt-41',
      version: 1,
      spec: { status: 'in_use', settings: {}, approvedBy: 'drift', event: 'approved' },
      deleted: false,
      by: 'drift',
      at: '2026-10-07T10:00:00Z',
      reason: 'Godkjent for lange dokumenter',
    });
    const after = await readBlockPolicy(configEntries, '999888777');

    expect(before.rules.map((r) => r.id)).toEqual(['models-outside-eu-eea', 'models-in-eu']);
    expect(
      blockStatusFor(before, { kind: 'model', id: 'openai/gpt-5', dataLocation: 'global' }),
    ).toMatchObject({ status: 'not_allowed', blocked: { text: outsideEuText } });
    expect(
      blockStatusFor(before, { kind: 'model', id: 'azure/gpt-41', dataLocation: 'eu' }),
    ).toMatchObject({ status: 'requires_approval', approver: 'digdir' });
    expect(
      blockStatusFor(after, { kind: 'model', id: 'azure/gpt-41', dataLocation: 'eu' }).status,
    ).toBe('in_use');
    expect(
      blockStatusFor(after, { kind: 'model', id: 'local/llama', dataLocation: 'norway' }).status,
    ).toBe('available');
  });
});

const probe = (
  onRun: (ctx: InvocationContext, config: unknown) => Promise<void> = async () => {},
) => {
  const seen: unknown[] = [];
  const strategy: Strategy = {
    id: 'probe',
    version: '1',
    requires: { kernel: 1, ports: ['tools'], features: [] },
    run: async function* (ctx, _input, config): AsyncIterable<Emitted> {
      seen.push(config);
      await onRun(ctx, config);
      yield { type: 'kernel.result', data: [] };
    },
  };
  return { strategy, seen };
};

const decorate = async (
  blocks: ReturnType<ReturnType<typeof createBuildingBlocksModule>>,
  store: InMemoryDefinitionStore,
  definition: ServiceDefinition,
) => {
  const [compiled] = await store.capabilities();
  if (!compiled) throw new Error('no published capability');
  return blocks.decorateCapability?.(compiled.capability, {
    compiled,
    definition,
    origin: 'service',
  });
};

const drain = async (events: AsyncIterable<Emitted>) => {
  for await (const event of events) void event;
};

const runWith = (
  strategy: Strategy,
  config: unknown,
  use: InvocationContext['use'] = async () => undefined as never,
) =>
  drain(
    strategy.run({ tenant: digdir, use } as unknown as InvocationContext, { data: {} }, config),
  );

describe('building-block settings at run time', () => {
  it('a block turned off for the tenant is refused at publish and at run', async () => {
    const { send, blocks, store, configEntries } = await setup();
    const published = await store.get('Service', digdir, 'klarsprak');
    const definition = published?.definition as ServiceDefinition;
    const decorated = await decorate(blocks, store, definition);
    const { strategy, seen } = probe();
    const guarded = withBlockSettings(configEntries, strategy);
    const settings = (enabled: boolean | null) =>
      send(`${base}/model/${enc('foundry/gpt-4o')}/settings`, 'kari', {
        method: 'PUT',
        body: { settings: { enabled } },
        reason: 'Endrer bruken av modellen',
      });

    await runWith(guarded, decorated?.config);
    expect(await blocks.checkPublish(definition)).toEqual([]);
    await settings(false);
    const atPublish = await blocks.checkPublish(definition);
    const atRun = runWith(guarded, decorated?.config);

    expect(atPublish).toEqual([
      { path: 'spec.model', message: disabledBlockText('foundry/gpt-4o') },
    ]);
    await expect(atRun).rejects.toMatchObject({
      code: 'forbidden',
      message:
        'Byggeklossen «foundry/gpt-4o» er slått av for virksomheten. Slå den på igjen under Byggeklosser, eller fjern den fra tjenesten.',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty(runtimeBlocksKey);
    await settings(null);
    await runWith(guarded, decorated?.config);
    expect(seen).toHaveLength(2);
  });

  it('a tool timeout set for the tenant applies to its calls', async () => {
    const { send, blocks, store, configEntries, connections } = await setup();
    await connections.register({
      id: 'arkiv',
      tenant: digdir,
      name: 'Arkiv',
      endpoint: 'https://arkiv.example.no/mcp',
      version: '1',
      allow: [{ host: 'arkiv.example.no' }],
    });
    const state = await connections.get(digdir, 'arkiv');
    if (!state) throw new Error('the connection was not registered');
    await connections.save({
      ...state,
      tools: [{ remoteName: 'lookup', name: 'arkiv.lookup', description: 'Slår opp', input: {} }],
    });
    await send(`${base}/tool/arkiv/adopt`, 'kari', { body: {}, reason: 'Arkivet skal brukes' });
    const tooLong = await send(`${base}/tool/arkiv/settings`, 'kari', {
      method: 'PUT',
      body: { settings: { timeoutSeconds: 30 } },
      reason: 'Mer tid til arkivet',
    });
    const set = await send(`${base}/tool/arkiv/settings`, 'kari', {
      method: 'PUT',
      body: { settings: { timeoutSeconds: 2 } },
      reason: 'Arkivet skal svare raskt',
    });
    const published = (await store.get('Service', digdir, 'klarsprak'))
      ?.definition as ServiceDefinition;
    const definition = {
      ...published,
      spec: { ...published.spec, tools: ['arkiv.lookup@1'] },
    } as ServiceDefinition;
    const decorated = await decorate(blocks, store, definition);
    const opened: Ref[] = [];
    const hanging: ToolPort = {
      definition: () => ({
        name: 'arkiv.lookup',
        version: '1',
        description: '',
        input: {},
        origin: 'mcp',
      }),
      call: () => new Promise(() => undefined),
    };
    let outcome: Promise<unknown> = Promise.resolve();
    const { strategy } = probe(async (ctx) => {
      const port = await ctx.use<ToolPort>('tools', { kind: 'tool', id: 'arkiv.lookup@1' });
      outcome = port.call({}).catch((error: unknown) => error);
    });

    vi.useFakeTimers();
    try {
      await runWith(
        withBlockSettings(configEntries, strategy),
        decorated?.config,
        async (_p, ref) => {
          opened.push(ref);
          return hanging as never;
        },
      );
      await vi.advanceTimersByTimeAsync(1999);
      const early = await Promise.race([outcome, Promise.resolve('venter')]);
      await vi.advanceTimersByTimeAsync(1);

      expect(tooLong.status).toBe(400);
      expect(set.status).toBe(200);
      expect(opened).toEqual([{ kind: 'tool', id: 'arkiv.lookup@1' }]);
      expect(early).toBe('venter');
      expect(await outcome).toMatchObject({
        code: 'failed',
        message: 'Verktøyet svarte ikke innen 2 sekunder.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists one judge:criteria block at its prompt version for runs judged by two models', async () => {
    const { send, runs } = await setup();
    for (const [id, model] of [
      ['r1', 'foundry/claude'],
      ['r2', 'foundry/gpt-4o'],
    ] as const)
      await runs.save({
        tenant: digdir,
        task: `task-${id}`,
        service: 'svar',
        run: {
          id,
          testSet: { tenant: digdir, id: 'svar-sett', version: 1 },
          capability: `${digdir}/svar`,
          splits: ['validation'],
          repeats: 1,
          startedAt: '2026-11-12T10:00:00.000Z',
          endedAt: '2026-11-12T10:01:00.000Z',
          provenance: {
            commit: 'abc',
            data: 'd1',
            servedModels: ['m'],
            judges: [`judge:criteria@2+${model}`],
            services: [],
          },
          results: [],
          metrics: { 'judge.criteria': { mean: 1, ci: [1, 1], n: 1 } },
          byTag: {},
          incomplete: [],
        },
      });

    const listed = await json<{ data: BuildingBlock[] }>(await send(`${base}?kind=judge`, 'kari'));
    const block = await json<BuildingBlock>(
      await send(`${base}/judge/${encodeURIComponent('judge:criteria')}`, 'kari'),
    );

    expect(listed.data.map((b) => b.id).filter((id) => id.startsWith('judge:criteria'))).toEqual([
      'judge:criteria',
    ]);
    expect(block.version).toBe('2');
  });

  it('every block setting has an effect: judges have none and a tool gets at most its own timeout', async () => {
    const { send, connections } = await setup();
    await connections.register({
      id: 'arkiv',
      tenant: digdir,
      name: 'Arkiv',
      endpoint: 'https://arkiv.example.no/mcp',
      version: '1',
      allow: [{ host: 'arkiv.example.no' }],
      timeoutMs: 5000,
    });

    const judge = await json<BuildingBlock>(await send(`${base}/judge/answer-quality`, 'kari'));
    const tool = await json<BuildingBlock>(await send(`${base}/tool/arkiv`, 'kari'));

    expect(judge.settingsSchema.properties).toEqual({});
    expect(Object.keys(tool.settingsSchema.properties)).toEqual(['enabled', 'timeoutSeconds']);
    expect(tool.settingsSchema.properties.timeoutSeconds).toMatchObject({
      default: 5,
      maximum: 5,
    });
  });
});

describe('facts a building block page shows', () => {
  const entry = (kind: string, scope: string, id: string, spec: unknown) => ({
    kind,
    scope,
    id,
    version: 1,
    spec,
    deleted: false,
    by: 'drift',
    at: '2026-10-07T08:00:00Z',
    reason: 'Satt opp for testen',
  });
  const flow = (name: string) => ({
    apiVersion: 'genai/v1' as const,
    kind: 'StepFlow' as const,
    metadata: { tenant: digdir, id: 'svarflyt', name },
    spec: { purpose: 'Henter svar', steps: [{ id: 'hent', block: 'retrieve@1' }] },
  });

  it('dates the version a step flow is on even when no update is waiting', async () => {
    const { send, store } = await setup({ blockRefs: ['retrieve@1'] });
    await store.publish(flow('Svarflyt'), 'test', 'første versjon');
    await store.publish(flow('Svarflyt 2'), 'test', 'andre versjon');
    const published = (await store.versions('StepFlow', digdir, 'svarflyt')).at(-1)?.publishedAt;

    const block = await json<BuildingBlock>(await send(`${base}/step_flow/svarflyt`, 'kari'));

    expect(block).toMatchObject({ version: '2', versionAt: published });
    expect(block.update).toBeUndefined();
  });

  it('marks a guardrail rule the platform made mandatory as required and counts it, never a tenant rule', async () => {
    const { send, configEntries } = await setup();
    const rule = { kind: 'regex', pattern: '\\d{11}', action: 'block', message: 'Fødselsnummer' };
    await configEntries.append(
      entry('guardrail-rule', platformScope, 'fnr', { spec: rule, mandatory: true }),
    );
    await configEntries.append(entry('guardrail-rule', platformScope, 'navn', { spec: rule }));
    await configEntries.append(
      entry('guardrail-rule', digdir, `${digdir}/egen`, { spec: rule, mandatory: true }),
    );

    const list = await json<BuildingBlockList>(await send(`${base}?kind=guardrail`, 'kari'));

    expect(list.counts.required).toEqual({ guardrail: 1 });
    expect(list.data.filter((b) => b.required).map((b) => b.id)).toEqual(['custom-rules/fnr']);
  });

  it('names the connection and maker of a model, the API and maturity of each call type, and whether the connection has a processor record', async () => {
    const { send, configEntries } = await setup({ governed: true });
    await configEntries.append(
      entry('operation-maturity', 'test', 'chat', { maturity: 'production' }),
    );
    await configEntries.append(
      entry('processor-record', platformScope, 'foundry', {
        agreement: 'Databehandleravtale 2026-04',
        subProcessors: [{ name: 'Microsoft', location: 'Norge' }],
        retention: { days: 0 },
      }),
    );

    const block = await json<Record<string, unknown>>(
      await send(`${base}/model/${enc('foundry/gpt-4o')}`, 'erik'),
    );

    expect(block.connection).toBe('foundry');
    expect(block.maker).toBe('OpenAI');
    expect(block.operations).toEqual([
      {
        operation: 'chat',
        api: 'openai/chat-completions@1',
        builtIn: true,
        maturity: 'production',
      },
    ]);
    expect(block.processor).toEqual({
      recorded: true,
      subProcessors: [{ name: 'Microsoft', location: 'Norge' }],
      retentionDays: 0,
    });
    expect(JSON.stringify(block)).not.toContain('Databehandleravtale');
  });

  it('says a model has no processor record when none is recorded, and gives no maturity or processor fact without operation governance', async () => {
    const governed = await setup({ governed: true });
    const plain = await setup();

    const recorded = await json<Record<string, unknown>>(
      await governed.send(`${base}/model/${enc('azure/gpt-41')}`, 'kari'),
    );
    const ungoverned = await json<Record<string, unknown>>(
      await plain.send(`${base}/model/${enc('azure/gpt-41')}`, 'kari'),
    );

    expect(recorded.processor).toEqual({ recorded: false });
    expect(recorded.maker).toBeUndefined();
    expect(recorded.operations).toEqual([
      { operation: 'chat', api: 'openai/chat-completions@1', builtIn: true, maturity: 'test' },
    ]);
    expect(ungoverned.processor).toBeUndefined();
    expect(ungoverned.operations).toEqual([
      { operation: 'chat', api: 'openai/chat-completions@1', builtIn: true },
    ]);
  });

  it('gives model facts only to a member of the tenant asked for', async () => {
    const { send } = await setup({ governed: true });

    const res = await send(`${base}/model/${enc('foundry/gpt-4o')}`, 'ola');

    expect(res.status).toBe(404);
  });
});
