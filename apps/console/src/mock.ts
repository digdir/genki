import {
  exampleAgencies,
  exampleBlockTypes,
  exampleEffective,
  exampleHistory,
  exampleJudges,
  exampleLabelQueue,
  exampleMatrix,
  exampleModelUsage,
  exampleOnboarding,
  exampleOperations,
  exampleOperatorAudit,
  exampleRegistry,
  exampleSettingHistory,
  exampleSettingsGrid,
  exampleTenants,
  exampleTimeline,
  exampleTracing,
} from './example-data';
import { fixtureSchemaFetch } from '@genai/schema-forms/fixtures';
import { queueMock } from './screens/queue/mock';
import { searchEnginesMock } from './screens/search-engines/mock';
import { translator } from './i18n';
import { reasonProblem, reasonTooShort } from './reason';
import type {
  AccessRequest,
  AuditEntry,
  BuildingBlocks,
  Capability,
  ModelPrice,
  DefaultVersion,
  OperatorModel,
  QualityOverview,
  RefreshResult,
  RunningTask,
  SettingInfo,
  SharedService,
  OnboardingRequest,
  SupportSession,
  SupportSessionRow,
  Residency,
  Tenant,
  TraceConnection,
  TraceSettings,
  TenantKey,
} from './types';

export { exampleTenants } from './example-data';

const baseModels: OperatorModel[] = [
  {
    id: 'foundry-openai/gpt-4o-2m-tps',
    endpoint: 'foundry-openai',
    deployment: 'gpt-4o-2M-tps',
    family: 'gpt-4o',
    residency: 'global',
    capabilities: ['stream', 'tools', 'json-schema'],
    enabled: true,
    origin: 'discovered',
    classified: false,
  },
  {
    id: 'foundry-openai/gpt-4.1',
    endpoint: 'foundry-openai',
    deployment: 'gpt-4.1',
    family: 'gpt-4.1',
    residency: 'eu',
    capabilities: ['stream', 'tools', 'json-schema'],
    enabled: true,
    origin: 'discovered',
    classified: true,

    price: { inputPerThousand: 0.02, outputPerThousand: 0.08 },
  },
  {
    id: 'foundry-claude/claude-sonnet-5-5',
    endpoint: 'foundry-claude',
    deployment: 'claude-sonnet-5-5',
    family: 'claude-sonnet-5-5',
    residency: 'global',
    capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
    enabled: false,
    origin: 'discovered',
    classified: true,
  },
];

export const exampleModels: OperatorModel[] = baseModels.map((m) => {
  const usage = exampleModelUsage[m.id];
  return usage ? { ...m, usage } : m;
});

export const exampleShared: SharedService[] = [
  {
    tenant: '991825827',
    id: 'klarsprak',
    name: 'Klarspråk',
    version: 3,
    availableTo: '*',
    publicNames: ['klarsprak__default'],
  },
  {
    tenant: '991825827',
    id: 'kunnskapsassistenten',
    name: 'Kunnskapsassistenten',
    version: 5,
    availableTo: null,
    publicNames: ['kunnskapsassistenten__default'],
  },
  {
    tenant: '999888777',
    id: 'postsortering',
    name: 'Postsortering',
    version: 1,
    availableTo: ['910111222'],
    publicNames: ['postsortering__default'],
  },
];

export const exampleBlocks: BuildingBlocks = {
  strategies: [
    {
      ref: 'agent-loop@1',
      configSchema: { type: 'object' },
      usedBy: ['991825827/kunnskapsassistenten'],
    },
    { ref: 'single-call@1', configSchema: { type: 'object' }, usedBy: ['991825827/klarsprak'] },
    { ref: 'step-flow@1', configSchema: { type: 'object' }, usedBy: [] },
  ],
  blocks: [
    {
      ref: 'classify@1',
      description: 'Klassifiser tekst',
      usedBy: ['999888777/postsortering-flyt'],
    },
    { ref: 'retrieve@1', description: 'Søk i datasett', usedBy: [] },
  ],
  tools: [
    { ref: 'rag@1', configSchema: { type: 'object' }, usedBy: ['991825827/kunnskapsassistenten'] },
  ],
  types: exampleBlockTypes,
  registry: exampleRegistry,
  agencies: exampleAgencies,
};

export const exampleQuality: QualityOverview = {
  services: [
    {
      tenant: '991825827',
      service: 'kunnskapsassistenten',
      testSet: 'ka-kudos',
      run: 'r2',
      endedAt: '2026-10-06T21:40:00Z',
      servedModels: ['foundry-openai/gpt-4o-2m-tps'],
      metrics: { judge: { mean: 0.61, ci: [0.54, 0.68], n: 252 } },
      regressions: [],
    },
  ],
  judges: exampleJudges,
  matrix: exampleMatrix,
  matrixRuns: [],
  candidates: [
    { id: 'NorLlama-70B 0.9', residency: 'norway', testSets: 3 },
    { id: 'Fjord-8B 1.0', residency: 'norway', testSets: 0 },
  ],
  modelsInUse: [{ id: 'Borealis-27B 2.1', services: 4 }],
  history: exampleHistory,
};

export const exampleSupport: SupportSessionRow[] = [
  {
    id: 's2',
    operator: 'Jon Øien',
    tenant: '983888999',
    reason: 'Feil i datasett meldt av kunden, sak DIG-4409',
    openedAt: '2026-10-07T09:12:00+02:00',
    expiresAt: '2026-10-07T09:42:00+02:00',
    status: 'expired',
  },
];

export const exampleRunning: RunningTask[] = [
  {
    task: 't-101',
    tenant: '974222333',
    status: 'running',
    at: '2026-10-07T09:58:00Z',
    service: 'spor-regelverket',
  },
  {
    task: 't-102',
    tenant: '999888777',
    status: 'queued',
    at: '2026-10-07T09:59:00Z',
    service: 'hoeringsoppsummering',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = () =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404 }), {
    status: 404,
    headers: { 'content-type': 'application/problem+json' },
  });

const needReason = () =>
  json(
    {
      title: 'Invalid request',
      status: 400,
      errors: [
        {
          path: 'change-reason',
          message: reasonProblem(translator('nb'), ''),
        },
      ],
    },
    400,
  );

const operatorName = 'Lise Dahl';

const asAccessRequest = (o: OnboardingRequest): AccessRequest => ({
  id: o.orgNumber,
  org: o.orgNumber,
  orgName: o.name,
  contactName: o.requestedBy.split(',')[0] ?? o.requestedBy,
  requestedBy: o.requestedBy,
  requestedAt: o.requestedAt,
  status: o.steps.access.doneAt ? 'approved' : 'pending',
  ...(o.steps.terms.doneAt ? { terms: { at: o.steps.terms.doneAt } } : {}),
  ...(o.steps.access.doneAt
    ? { decision: { by: o.steps.access.doneBy ?? 'Digdir', at: o.steps.access.doneAt, reason: '' } }
    : {}),
});

export {
  exampleEndpoints,
  exampleKnowledgeEngines,
  exampleSecrets,
} from './screens/search-engines/mock';

export const mockFetch = (
  tenants: Tenant[] = exampleTenants,
  models: OperatorModel[] = exampleModels,
  refresh: RefreshResult = { discovered: 3, failed: [] },
  audit: AuditEntry[] = exampleOperatorAudit,
): typeof fetch => {
  const sessions = new Map<string, SupportSession>();
  let shared = structuredClone(exampleShared);
  let queue = structuredClone(exampleLabelQueue);
  let support = structuredClone(exampleSupport);
  let running = structuredClone(exampleRunning);
  let current = structuredClone(models);
  let blocks = structuredClone(exampleBlocks);
  let onboarding = structuredClone(exampleOnboarding);
  const tenantValues = new Map<string, Record<string, unknown>>();
  const tenantKeys = new Map<string, TenantKey[]>([
    [
      '999888777',
      [
        {
          id: 'k-1',
          name: 'Saksbehandlingssystemet',
          prefix: 'gai_sak',
          createdAt: '2026-08-12T09:00:00Z',
          expiresAt: null,
          revokedAt: null,
        },
        {
          id: 'k-2',
          name: 'Test fra laptop',
          prefix: 'gai_tst',
          createdAt: '2026-08-12T10:00:00Z',
          expiresAt: null,
          revokedAt: null,
        },
      ],
    ],
  ]);
  const matrixRuns = new Map<string, { run: Record<string, unknown>; polls: number }>();
  let tenantList = structuredClone(tenants);
  let log = structuredClone(audit);
  const tracing = structuredClone(exampleTracing);
  const grid = structuredClone(exampleSettingsGrid);
  const history = structuredClone(exampleSettingHistory);
  const searchEngines = searchEnginesMock();
  const schemaFixtures = fixtureSchemaFetch();
  const secrets = new Set<string>(['foundry-openai-key', 'foundry-claude-key']);

  const tenantName = (org: string) => tenantList.find((t) => t.orgNumber === org)?.name ?? org;
  const record = (
    tenant: string,
    actionLabel: string,
    target: string,
    reason = '',
    onBehalf = false,
  ) => {
    log = [
      {
        task: `a-${log.length + 100}`,
        tenant,
        ...(onBehalf ? { onBehalfOf: tenant } : {}),
        tenantName: tenant === 'alle' ? 'Alle' : tenantName(tenant),
        action: actionLabel,
        actionLabel,
        actor: `operator:${operatorName}`,
        actorName: operatorName,
        actorOrg: 'Digdir',
        at: new Date().toISOString(),
        outcome: 'applied',
        target,
        reason,
      },
      ...log,
    ];
  };

  const catalog = (): SettingInfo[] =>
    grid.settings.map((s) => ({
      key: s.key,
      description: s.description,
      category: s.category,
      axis: s.scope.includes('dataset') && !s.scope.includes('service') ? 'dataset' : 'service',
      sensitivity: s.type === 'secret' ? 'secret' : 'normal',
      default: s.platform,
      settableAt: ['platform', ...s.scope],
    }));
  const defaults = (): DefaultVersion[] =>
    grid.settings
      .filter((s) => s.type !== 'secret')
      .map((s) => ({ key: s.key, version: s.version, value: s.platform }));

  const configs = new Map<string, Record<string, unknown>[]>([
    [
      '/operator/catalog/entries?kind=model-endpoint',
      [
        {
          id: 'foundry-openai',
          scope: 'platform',
          origin: 'seed',
          version: 1,
          spec: {
            protocol: 'openai-chat',
            baseURL: 'https://foundry.example',
            auth: { kind: 'api-key', secret: 'secret://platform/foundry-openai-key' },
          },
        },
        {
          id: 'foundry-claude',
          scope: 'platform',
          origin: 'seed',
          version: 1,
          spec: {
            protocol: 'anthropic-messages',
            baseURL: 'https://foundry.example/anthropic',
            auth: { kind: 'api-key', secret: 'secret://platform/foundry-claude-key' },
          },
        },
      ],
    ],
    [
      '/operator/catalog/entries?kind=dataset',
      [
        {
          id: 'digdir/kudos',
          scope: 'platform',
          origin: 'seed',
          version: 1,
          spec: { name: 'Kudos', endpoint: 'typesense', residency: 'norway' },
        },
      ],
    ],
    [
      '/operator/gates',
      [
        {
          id: 'klarsprak-overall',
          scope: 'platform',
          version: 1,
          mandatory: false,
          builtin: true,
          spec: { metric: 'klarsprak.overall', kind: 'threshold', threshold: 0.6 },
        },
      ],
    ],
    [
      '/operator/guardrail-rules',
      [
        {
          id: 'fodselsnummer',
          scope: 'platform',
          version: 2,
          mandatory: true,
          builtin: false,
          spec: { kind: 'regex', pattern: '\\b\\d{11}\\b', stage: 'input', action: 'mask' },
          by: 'operator:entra:lise',
          at: '2026-10-06T09:00:00Z',
        },
      ],
    ],
  ]);
  const tenantKinds = ['model-endpoint', 'model', 'knowledge-endpoint', 'dataset'];
  const tenantConfigs = new Map<string, Record<string, unknown>[]>([
    [
      '999888777:catalog:knowledge-endpoint',
      [
        {
          id: '999888777/sok',
          kind: 'knowledge-endpoint',
          scope: '999888777',
          origin: 'api',
          version: 1,
          spec: {
            engine: 'http-search',
            baseURL: 'https://sok.testetaten.example.no',
            auth: { kind: 'bearer', secret: 'secret://tenant/999888777/search-token' },
          },
          by: 'employee:ansattporten:kari',
          at: '2026-10-05T12:00:00Z',
        },
      ],
    ],
    [
      '999888777:gates',
      [
        {
          id: 'hjelpsom',
          scope: '999888777',
          version: 1,
          mandatory: false,
          builtin: false,
          spec: { metric: 'judge.helpfulness', kind: 'threshold', threshold: 0.7 },
          by: 'employee:ansattporten:kari',
          at: '2026-10-05T12:00:00Z',
        },
      ],
    ],
  ]);
  const tenantConfigRoute = (
    path: string,
    search: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ) => {
    const match = /^\/tenants\/(\d{9})\/(catalog|gates|guardrail-rules)(?:\/(.+))?$/.exec(path);
    if (!match) return undefined;
    const [, tenant = '', area = '', rest] = match;
    const kind =
      area === 'catalog' ? (rest?.split('/')[0] ?? new URLSearchParams(search).get('kind')) : null;
    const id = decodeURIComponent((area === 'catalog' ? rest?.split('/')[1] : rest) ?? '');
    const key = area === 'catalog' ? `${tenant}:catalog:${kind ?? ''}` : `${tenant}:${area}`;
    if (method === 'GET' && rest?.endsWith('/versions')) return json({ data: [] });
    if (method === 'GET' && area === 'catalog' && !kind)
      return json({
        data: [...tenantConfigs.entries()]
          .filter(([k]) => k.startsWith(`${tenant}:catalog:`))
          .flatMap(([, v]) => v),
        tenantKinds,
      });
    if (method === 'GET') {
      const shared = (
        configs.get(
          area === 'catalog' ? `/operator/catalog/entries?kind=${kind ?? ''}` : `/operator/${area}`,
        ) ?? []
      ).map((e) => ({ ...e, editable: false }));
      const own = (tenantConfigs.get(key) ?? []).map((e) => ({ ...e, editable: true }));
      return json({ data: [...shared, ...own], ...(area === 'catalog' ? { tenantKinds } : {}) });
    }
    if (!reason) return needReason();
    if (area === 'catalog' && !tenantKinds.includes(kind ?? ''))
      return json(
        {
          title: 'Invalid request',
          status: 400,
          errors: [{ path: 'kind', message: 'platform only' }],
        },
        400,
      );
    const list = tenantConfigs.get(key) ?? [];
    const fullId = area === 'catalog' ? `${tenant}/${id}` : id;
    const target = `${area === 'catalog' ? `${kind ?? ''}/` : `${area}/`}${id}`;
    if (method === 'DELETE') {
      tenantConfigs.set(
        key,
        list.filter((e) => e.id !== fullId),
      );
      record(tenant, 'Slettet oppføring', target, reason, true);
      return json({ ok: true });
    }
    const spec = body();
    if (spec.mandatory === true)
      return json(
        {
          title: 'Invalid request',
          status: 400,
          errors: [{ path: 'mandatory', message: 'only platform entries can be mandatory' }],
        },
        400,
      );
    delete spec.mandatory;
    const found = list.find((e) => e.id === fullId);
    const next = {
      id: fullId,
      ...(kind ? { kind } : {}),
      scope: tenant,
      origin: 'api',
      version: Number(found?.version ?? 0) + 1,
      spec,
      by: 'operator:entra:lise',
      at: new Date().toISOString(),
    };
    tenantConfigs.set(key, found ? list.map((e) => (e.id === fullId ? next : e)) : [...list, next]);
    record(tenant, 'Endret oppføring', target, reason, true);
    return json(next);
  };
  const configListOf = (path: string) =>
    [...configs.keys()].find((k) => k === path) ??
    [...configs.keys()].find((k) => k.split('?')[0] === path);
  const configRoute = (
    path: string,
    search: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ) => {
    const full = `${path}${search}`;
    const tenantReply = tenantConfigRoute(path, search, method, reason, body);
    if (tenantReply) return tenantReply;
    if (!/^\/(operator|tenants\/\d{9})\/(catalog|gates|guardrail-rules|datasets)/.test(path))
      return undefined;
    if (method === 'GET' && /\/versions$/.test(path)) return json({ data: [] });
    if (method === 'POST' && /\/execute$/.test(path))
      return json(
        {
          title: 'Ingestion is not available',
          status: 409,
          errors: [{ path: 'backend', message: 'no write key configured' }],
        },
        409,
      );
    if (method === 'GET' && /\/pipelines$/.test(path))
      return json({
        data: configs.get(path) ?? [],
        backend: { name: 'typesense', available: false, reason: 'no write key configured' },
      });
    if (method === 'GET') {
      const key = configListOf(full);
      return key ? json({ data: configs.get(key) }) : undefined;
    }
    if (!reason) return needReason();
    const catalog = /^\/operator\/catalog\/([^/]+)\/(.+)$/.exec(path);
    const scoped = /^\/operator\/(gates|guardrail-rules)\/([^/]+)$/.exec(path);
    const pipelines =
      /^(\/(?:operator|tenants\/(\d{9}))\/datasets\/[^/]+\/pipelines)(?:\/([^/]+))?$/.exec(path);
    const key = catalog
      ? `/operator/catalog/entries?kind=${catalog[1]}`
      : scoped
        ? `/operator/${scoped[1]}`
        : pipelines
          ? (pipelines[1] ?? '')
          : '';
    const id = decodeURIComponent(
      catalog?.[2] ?? scoped?.[2] ?? pipelines?.[3] ?? String(body().id ?? ''),
    );
    const list = configs.get(key) ?? [];
    if (method === 'DELETE') {
      configs.set(
        key,
        list.filter((e) => e.id !== id),
      );
      return json({ ok: true });
    }
    const spec = body();
    const mandatory = spec.mandatory;
    delete spec.mandatory;
    delete spec.id;
    const found = list.find((e) => e.id === id);
    const next = {
      id,
      scope: pipelines?.[2] ?? 'platform',
      version: Number(found?.version ?? 0) + 1,
      ...(mandatory === undefined ? {} : { mandatory: mandatory === true }),
      spec,
      by: 'operator:entra:lise',
      at: '2026-10-07T10:00:00Z',
    };
    configs.set(key, found ? list.map((e) => (e.id === id ? next : e)) : [...list, next]);
    return json(next);
  };

  const decisions = queueMock(record);
  const endpointKey = '/operator/catalog/entries?kind=model-endpoint';
  const modelRoute = (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ) => {
    const secret = /^\/operator\/secrets\/([^/]+)$/.exec(path);
    const endpoint = /^\/operator\/model-endpoints(?:\/([^/]+))?$/.exec(path);
    const price = /^\/operator\/models\/(.+)\/price$/.exec(path);
    const model = /^\/operator\/models\/(.+)$/.exec(path);
    if (!secret && !endpoint && !(model && method === 'PUT')) return undefined;
    if (!reason) return needReason();
    if (secret && method === 'PUT') {
      const value = body().value;
      if (typeof value !== 'string' || !value)
        return json({ title: 'Hemmeligheten mangler en verdi', status: 400 }, 400);
      const name = decodeURIComponent(secret[1] ?? '');
      secrets.add(name);
      record('alle', 'Lagret hemmelighet', name, reason);
      return new Response(null, { status: 204 });
    }
    if (endpoint && method === 'POST') {
      const b = body() as {
        id?: string;
        protocol?: string;
        baseURL?: string;
        auth?: { kind?: string; secret?: string };
      };
      const list = configs.get(endpointKey) ?? [];
      const errors = [
        ...(b.id && /^[a-z0-9-]+$/.test(b.id) ? [] : [{ path: 'id', message: 'Ugyldig navn' }]),
        ...(b.protocol === 'openai-chat' || b.protocol === 'anthropic-messages'
          ? []
          : [{ path: 'protocol', message: 'Ukjent protokoll' }]),
        ...(/^https:\/\//.test(b.baseURL ?? '')
          ? []
          : [{ path: 'baseURL', message: 'Adressen må starte med https://' }]),
        ...(b.auth?.secret?.startsWith('secret://platform/')
          ? []
          : [{ path: 'auth.secret', message: 'Hemmeligheten må ligge under secret://platform/' }]),
      ];
      if (errors.length)
        return json({ title: 'Ugyldig modellendepunkt', status: 400, errors }, 400);
      if (list.some((e) => e.id === b.id))
        return json({ title: 'Endepunktet finnes allerede', status: 409 }, 409);
      const entry = {
        id: b.id,
        scope: 'platform',
        origin: 'api',
        version: 1,
        spec: { protocol: b.protocol, baseURL: b.baseURL, auth: b.auth },
        by: 'operator:entra:lise',
        at: new Date().toISOString(),
      };
      configs.set(endpointKey, [...list, entry]);
      record('alle', 'La til modellendepunkt', b.id ?? '', reason);
      return json(entry, 201);
    }
    if (endpoint?.[1] && method === 'DELETE') {
      const id = decodeURIComponent(endpoint[1]);
      const list = configs.get(endpointKey) ?? [];
      if (!list.some((e) => e.id === id)) return notFound();
      const services = current
        .filter((m) => m.endpoint === id)
        .flatMap((m) => m.usage ?? [])
        .map((u) => ({ tenant: u.tenant, service: u.service }));
      if (services.length)
        return json({ title: 'Endepunktet er i bruk', status: 409, services }, 409);
      configs.set(
        endpointKey,
        list.filter((e) => e.id !== id),
      );
      current = current.filter((m) => m.endpoint !== id);
      record('alle', 'Fjernet modellendepunkt', id, reason);
      return new Response(null, { status: 204 });
    }
    if (price && method === 'PUT') {
      const id = price[1] ?? '';
      const b = body() as Partial<ModelPrice>;
      const valid = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (!valid(b.inputPerThousand) || !valid(b.outputPerThousand))
        return json({ title: 'Ugyldig pris', status: 400 }, 400);
      const found = current.find((m) => m.id === id);
      if (!found) return notFound();
      const next = {
        ...found,
        price: {
          inputPerThousand: Number(b.inputPerThousand),
          outputPerThousand: Number(b.outputPerThousand),
        },
      };
      current = current.map((m) => (m.id === id ? next : m));
      record('alle', 'Satte pris', found.deployment, reason);
      return json(next.price);
    }
    if (model && method === 'PUT') {
      const id = model[1] ?? '';
      const b = body() as {
        endpoint: string;
        deployment: string;
        residency: Residency;
        capabilities: Capability[];
        enabled: boolean;
      };
      if (!(configs.get(endpointKey) ?? []).some((e) => e.id === b.endpoint))
        return json({ title: 'Ukjent modellendepunkt', status: 400 }, 400);
      const found = current.find((m) => m.id === id);
      const next: OperatorModel = {
        ...found,
        id,
        endpoint: b.endpoint,
        deployment: b.deployment,
        residency: b.residency,
        capabilities: b.capabilities,
        enabled: b.enabled,
        origin: found?.origin ?? 'catalog',
        classified: true,
      };
      current = found ? current.map((m) => (m.id === id ? next : m)) : [...current, next];
      record('alle', found ? 'Endret modell' : 'La til modell', b.deployment, reason);
      return json(next);
    }
    return undefined;
  };

  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://mock',
    );
    const path = url.pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const raw = headers.get('change-reason');
    const given = raw === null ? null : decodeURIComponent(raw);
    const reason = given === null || reasonTooShort(given) ? null : given;
    const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const session = (tenant: string | undefined) => {
      const s = sessions.get(headers.get('support-session') ?? '');
      return s && s.tenant === tenant ? s : undefined;
    };

    if (path === '/operator/onboarding/requests' && method === 'GET') {
      const queued =
        ((await decisions(path, method, reason, body)?.json()) as { data: AccessRequest[] })
          ?.data ?? [];
      const asked = new Set(queued.map((r) => r.org));
      return json({
        data: [
          ...onboarding.filter((o) => !asked.has(o.orgNumber)).map(asAccessRequest),
          ...queued,
        ],
      });
    }
    const onboardingDecision = /^\/operator\/onboarding\/requests\/(\d{9})\/decision$/.exec(path);
    if (onboardingDecision && method === 'POST') {
      const found = onboarding.find((o) => o.orgNumber === onboardingDecision[1]);
      if (!found || found.steps.access.doneAt) return notFound();
      if (!reason) return needReason();
      if (body().approve !== true) {
        onboarding = onboarding.filter((o) => o !== found);
        record(found.orgNumber, 'Avviste tilgangsforespørsel', found.name, reason);
        return json({ ...asAccessRequest(found), status: 'rejected' });
      }
      const next = {
        ...found,
        steps: {
          ...found.steps,
          access: { doneBy: `${operatorName}, Digdir`, doneAt: new Date().toISOString() },
        },
      };
      onboarding = onboarding.map((o) => (o === found ? next : o));
      record(found.orgNumber, 'La til i tilgangslister', 'Ansattporten og Maskinporten', reason);
      return json(asAccessRequest(next));
    }
    const schemaReply = method === 'GET' ? schemaFixtures(path) : undefined;
    if (schemaReply !== undefined) return json(schemaReply);
    const queueReply = decisions(path, method, reason, body);
    if (queueReply) return queueReply;
    const modelReply = modelRoute(path, method, reason, body);
    if (modelReply) return modelReply;
    const engineReply = searchEngines(path, method, reason, body);
    if (engineReply) return engineReply;
    const configReply = configRoute(path, url.search, method, reason, body);
    if (configReply) return configReply;
    if (path === '/operator/tenants' && method === 'GET') return json({ data: tenantList });
    if (path === '/operator/tenants' && method === 'POST') {
      if (!reason) return needReason();
      const { orgNumber, name } = body() as { orgNumber: string; name: string };
      if (tenantList.some((t) => t.orgNumber === orgNumber))
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'orgNumber', message: 'Virksomheten finnes allerede.' }],
          },
          400,
        );
      tenantList = [
        ...tenantList,
        {
          orgNumber,
          name,
          status: 'onboarding',
          services: 0,
          quotaUsedPercent: 0,
          stage: 'Venter på vilkår',
          admin: 'Ikke logget inn ennå',
          servicesActive: 0,
          tokensMillions: 0,
          quotaMillions: 20,
          costNok: 0,
        },
      ];
      record(orgNumber, 'Registrerte virksomhet', name, reason);
      return json({ orgNumber, name });
    }
    const org = /^\/operator\/organizations\/(\d+)$/.exec(path);
    if (org) {
      const known: Record<string, string> = {
        '940999000': 'Eksempel kommune',
        '974760673': 'Brønnøysundregistrene',
        '991825827': 'Digitaliseringsdirektoratet',
      };
      const tenant = tenantList.find((t) => t.orgNumber === org[1])?.name;
      if (tenant) return json({ orgNumber: org[1], name: tenant, source: 'platform' });
      const name = known[org[1] ?? ''];
      return name ? json({ orgNumber: org[1], name, source: 'enhetsregisteret' }) : notFound();
    }
    if (path === '/health') return json({ status: 'ok', version: '484179f' });
    if (path === '/settings') return json({ data: catalog() });
    if (path === '/settings/defaults') return json({ data: defaults() });
    if (path === '/operator/settings/grid') return json(grid);
    const changelogPath = /^\/settings\/defaults\/([^/]+)\/changelog$/.exec(path);
    if (changelogPath) {
      const key = decodeURIComponent(changelogPath[1] ?? '');
      return json({
        data: (history[key] ?? []).map(([version, value, changedAt, why]) => ({
          key,
          version,
          value: JSON.parse(value) as unknown,
          changedAt,
          changedBy: 'operator:Lise Dahl',
          reason: why,
        })),
      });
    }
    const defaultPath = /^\/settings\/defaults\/([^/]+)$/.exec(path);
    if (defaultPath && method === 'PUT') {
      const key = decodeURIComponent(defaultPath[1] ?? '');
      if (!reason) return needReason();
      const { value } = body() as { value: unknown };
      const setting = grid.settings.find((s) => s.key === key);
      if (!setting) return notFound();
      if (typeof value !== typeof setting.platform)
        return json(
          {
            title: 'Invalid setting',
            status: 422,
            errors: [
              {
                path: key,
                message: typeof setting.platform === 'number' ? 'Expected a number' : 'Wrong type',
              },
            ],
          },
          422,
        );
      if (url.searchParams.get('dryRun') === 'true')
        return json({
          dryRun: true,
          services: grid.services.map((s) => {
            const id = `${s.tenant}/${s.name}`;
            const pinned = setting.pins?.[id];
            const own = setting.services[id] ?? setting.tenants[s.tenant];
            const status = pinned ? 'pinned' : own !== undefined ? 'overridden' : 'changes';
            return {
              tenant: s.tenant,
              service: s.name,
              version: 7,
              status,
              before: pinned?.value ?? own ?? setting.platform,
              after: status === 'changes' ? value : (pinned?.value ?? own),
            };
          }),
        });
      setting.version += 1;
      setting.platform = value;
      grid.platformVersion = Math.max(grid.platformVersion, setting.version);
      history[key] = [
        [setting.version, JSON.stringify(value), new Date().toISOString(), reason],
        ...(history[key] ?? []),
      ];
      record('alle', 'Endret plattformstandard', key, reason);
      return json({ task: 't-200', value });
    }
    const transfer = /^\/tenants\/([^/]+)\/(export|import)$/.exec(path);
    if (transfer) {
      if (!session(transfer[1]))
        return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      if (transfer[2] === 'export')
        return json({
          format: 'genai-tenant-export/v1',
          tenant: transfer[1],
          exportedAt: '2026-10-06T12:00:00Z',
          definitions: [
            { definition: { kind: 'Service', metadata: { id: 'rapportassistenten' } }, files: {} },
            { definition: { kind: 'Service', metadata: { id: 'soknadsuttrekk' } }, files: {} },
          ],
          settings: {
            values: { 'search.top_k': 12, 'answer.max_tokens': 600 },
            pins: { 'limits.retention': 11 },
          },
        });
      const bundle = body() as {
        definitions: { definition: { metadata: { id: string } } }[];
        settings: { values: Record<string, unknown> };
      };
      const plan = [
        ...bundle.definitions.map((d) => ({
          target: `Service:${transfer[1]}/${d.definition.metadata.id}`,
          action: d.definition.metadata.id === 'rapportassistenten' ? 'update' : 'create',
          conflict: d.definition.metadata.id === 'rapportassistenten',
        })),
        ...Object.keys(bundle.settings.values).map((k) => ({
          target: `setting:${k}`,
          action: k === 'search.top_k' ? 'update' : 'create',
          conflict: k === 'search.top_k',
        })),
      ];
      const dryRun = url.searchParams.get('dryRun') === 'true';
      if (!dryRun)
        record(
          transfer[1] ?? '',
          'Importerte konfigurasjon',
          `${plan.length} endringer`,
          reason ?? '',
        );
      return json({ dryRun, ...(dryRun ? {} : { task: 't-300' }), plan });
    }
    const tenantSetting = /^\/tenants\/([^/]+)\/settings\/([^/]+)$/.exec(path);
    if (tenantSetting && tenantSetting[2] !== 'effective' && method === 'PUT') {
      const org = tenantSetting[1] ?? '';
      if (!session(org)) return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      if (!reason) return needReason();
      const key = decodeURIComponent(tenantSetting[2] ?? '');
      const value = body().value;
      tenantValues.set(org, { ...tenantValues.get(org), [key]: value });
      record(org, 'Endret innstilling', `${key}: ${String(value)}`, reason, true);
      return json({ key, value });
    }
    const keysPath = /^\/tenants\/([^/]+)\/access$/.exec(path);
    if (keysPath && method === 'GET') {
      if (!session(keysPath[1]))
        return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      return json({ services: [], keys: tenantKeys.get(keysPath[1] ?? '') ?? [] });
    }
    const revokeKey = /^\/tenants\/([^/]+)\/api-keys\/([^/]+)\/revoke$/.exec(path);
    if (revokeKey && method === 'POST') {
      const org = revokeKey[1] ?? '';
      if (!session(org)) return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      if (!reason) return needReason();
      const list = tenantKeys.get(org) ?? [];
      const found = list.find((k) => k.id === revokeKey[2] && !k.revokedAt);
      if (!found) return notFound();
      const next = { ...found, revokedAt: new Date().toISOString() };
      tenantKeys.set(
        org,
        list.map((k) => (k === found ? next : k)),
      );
      record(org, 'Trakk tilbake API-nøkkel', found.name, reason, true);
      return json(next);
    }
    const effective = /^\/tenants\/([^/]+)\/settings\/effective$/.exec(path);
    if (effective) {
      if (!session(effective[1]))
        return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      const service = url.searchParams.get('service') ?? '';
      if (!service)
        return json(
          Object.fromEntries(
            catalog()
              .filter((c) => c.settableAt.includes('tenant'))
              .map((c) => {
                const own = tenantValues.get(effective[1] ?? '') ?? {};
                const value = c.key in own ? own[c.key] : c.default;
                return [
                  c.key,
                  {
                    key: c.key,
                    value,
                    source: c.key in own ? 'tenant' : 'platform',
                    defaultVersion: 1,
                    overridden: [],
                    rejected: [],
                  },
                ];
              }),
          ),
        );
      return effective[1] === '999888777' && /rapport/i.test(service)
        ? json(exampleEffective)
        : notFound();
    }
    const timeline = /^\/tenants\/([^/]+)\/tasks\/([^/]+)\/timeline$/.exec(path);
    if (timeline) {
      if (!session(timeline[1]))
        return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      return timeline[1] === '999888777' && timeline[2] === exampleTimeline.id
        ? json(exampleTimeline)
        : notFound();
    }
    if (path === '/operator/models' && method === 'GET') return json({ data: current });
    if (path === '/operator/models/refresh' && method === 'POST')
      return reason ? json(refresh) : json({ error: 'a change reason is required' }, 400);
    if (path.startsWith('/operator/models/') && method === 'PATCH') {
      if (!reason) return json({ error: 'a change reason is required' }, 400);
      const id = path.slice('/operator/models/'.length);
      const found = current.find((m) => m.id === id);
      if (!found) return json({ error: `no model ${id}` }, 404);
      const updated = { ...found, ...body(), classified: true };
      current = current.map((m) => (m.id === id ? updated : m));
      record('alle', 'Endret modell', found.deployment, reason);
      return json(updated);
    }
    if (path === '/support-sessions' && method === 'POST') {
      const b = body() as { tenant: string; reason: string; minutes?: number };
      const minutes = b.minutes ?? 30;
      const opened: SupportSession = {
        id: `s-${sessions.size + 10}`,
        operator: operatorName,
        operatorName,
        tenant: b.tenant,
        reason: b.reason,
        openedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
      };
      sessions.set(opened.id, opened);
      support = [{ ...opened, status: 'active' }, ...support];
      record(
        b.tenant,
        `Støttetilgang startet (${minutes} min)`,
        'Hele portalen, endringer logges',
        b.reason,
      );
      return json(opened, 201);
    }
    const auditPath = /^\/tenants\/([^/]+)\/audit$/.exec(path);
    if (auditPath && method === 'GET') {
      if (!session(auditPath[1]))
        return json({ title: 'Not allowed for this tenant', status: 403 }, 403);
      return json(log.filter((a) => a.tenant === auditPath[1]));
    }
    if (path === '/operator/audit' && method === 'GET') return json({ data: log });
    if (path === '/operator/audit/exports' && method === 'POST') {
      record('alle', 'Eksporterte revisjonslogg', `${String(body().count)} hendelser`);
      return json({ ok: true });
    }
    const tenantDefs =
      /^\/operator\/tenants\/(\d{9})\/definitions(?:\/(services|step-flows)\/([^/]+)(?:\/versions\/(\d+))?)?$/.exec(
        path,
      );
    if (tenantDefs && method === 'GET') {
      const [, org, , id, version] = tenantDefs;
      const own = shared.filter((x) => x.tenant === org);
      const at = '2026-10-01T09:00:00Z';
      const versionOf = (x: SharedService, n: number) => ({
        version: n,
        publishedBy: 'employee:ansattporten:kari',
        publishedAt: at,
        reason: n === 1 ? 'Første versjon' : 'Delt med flere virksomheter',
        definition: {
          apiVersion: 'genai/v1',
          kind: 'Service',
          metadata: { tenant: org, id: x.id, name: x.name, version: n },
          spec: { purpose: x.name, riskClass: 'limited', availableTo: x.availableTo ?? undefined },
        },
        files: {},
      });
      if (!id)
        return json({
          data: own.map((x) => ({
            kind: 'Service',
            id: x.id,
            name: x.name,
            latestVersion: x.version,
            publishedAt: at,
            publishedBy: 'employee:ansattporten:kari',
          })),
        });
      const found = own.find((x) => x.id === id);
      if (!found) return json({ title: 'Not found', status: 404 }, 404);
      const all = Array.from({ length: found.version }, (_, i) => versionOf(found, i + 1));
      if (version) {
        const v = all[Number(version) - 1];
        return v ? json(v) : json({ title: 'Not found', status: 404 }, 404);
      }
      return json({
        kind: 'Service',
        tenant: org,
        id,
        latest: all.at(-1),
        versions: all.map(({ definition: _d, files: _f, ...v }) => v),
      });
    }
    if (path === '/operator/shared-services' && method === 'GET') return json({ data: shared });
    const share = /^\/operator\/shared-services\/([^/]+)\/([^/]+)$/.exec(path);
    if (share && method === 'PUT') {
      if (!reason) return needReason();
      const b = body() as { availableTo: SharedService['availableTo'] };
      shared = shared.map((x) =>
        x.tenant === share[1] && x.id === share[2]
          ? { ...x, availableTo: b.availableTo, version: x.version + 1 }
          : x,
      );
      return json({ availableTo: b.availableTo });
    }
    if (path === '/operator/building-blocks') return json(blocks);
    const block =
      /^\/operator\/building-blocks\/([^/]+)\/(availability|disable|contract-tests|versions\/([^/]+)\/release)$/.exec(
        path,
      );
    if (block) {
      const id = decodeURIComponent(block[1] ?? '');
      const found = blocks.registry?.find((b) => b.id === id);
      if (!found) return notFound();
      if (block[2] === 'contract-tests') return json({ ok: true });
      if (!reason) return needReason();
      const update = (patch: Partial<typeof found>) => {
        blocks = {
          ...blocks,
          registry: (blocks.registry ?? []).map((b) => (b.id === id ? { ...b, ...patch } : b)),
        };
      };
      if (block[2] === 'availability') {
        const b = body() as { availability: 'all' | 'selected' | 'none'; agencies: string[] };
        update({ availability: b.availability, agencies: b.agencies });
        record('alle', 'Endret tilgjengelighet', found.name, reason);
      } else if (block[2] === 'disable') {
        update({
          availability: 'none',
          agencies: [],
          badge: 'Deaktivert',
          serviceCount: 0,
          services: [],
        });
        record('alle', 'Deaktiverte byggekloss', found.name, reason);
      } else {
        if (!found.next || !found.next.testPassed)
          return json({ title: 'Contract tests failed', status: 409 }, 409);
        const released = { ...found };
        delete released.next;
        blocks = {
          ...blocks,
          registry: (blocks.registry ?? []).map((b) =>
            b.id === id
              ? {
                  ...released,
                  changelog: [
                    {
                      version: `${found.next?.version ?? ''} (tilgjengelig)`,
                      at: 'I dag',
                      text: found.next?.description ?? '',
                    },
                    ...(found.changelog ?? []),
                  ],
                }
              : b,
          ),
        };
        record('alle', 'Gjorde versjon tilgjengelig', `${found.name} ${block[3] ?? ''}`, reason);
      }
      return json({ ok: true });
    }
    if (path === '/operator/quality') return json(exampleQuality);
    if (path === '/operator/quality/matrix/estimate' && method === 'POST') {
      const b = body() as { model: string; current: string };
      return json({
        ...b,
        testSets: [
          {
            tenant: '991825827',
            service: 'rapportassistenten',
            name: 'Rapportassistenten',
            testSet: 'rapporter',
            cases: 40,
          },
        ],
        cases: 80,
        estimatedCostNok: 4.2,
        unpriced: [],
      });
    }
    if (path === '/operator/quality/matrix/runs' && method === 'POST') {
      if (!reason) return needReason();
      const b = body() as { model: string; current: string; confirmedCostNok?: number };
      const id = `m${Date.now()}`;
      matrixRuns.set(id, {
        run: {
          id,
          model: b.model,
          current: b.current,
          startedAt: new Date().toISOString(),
          estimatedCostNok: b.confirmedCostNok ?? 0,
        },
        polls: 0,
      });
      return json(
        {
          id,
          model: b.model,
          current: b.current,
          status: 'queued',
          startedAt: new Date().toISOString(),
          endedAt: null,
          estimatedCostNok: b.confirmedCostNok ?? 0,
          costNok: null,
          testSets: 1,
          done: 0,
        },
        202,
      );
    }
    const matrixRun = /^\/operator\/quality\/matrix\/runs\/([^/]+)$/.exec(path);
    if (matrixRun && method === 'GET') {
      const found = matrixRuns.get(matrixRun[1] ?? '');
      if (!found) return notFound();
      found.polls += 1;
      const sets: [string, string, number, number][] = [
        ['Rapportassistenten', 'Saksbehandling, bokmål', 0.841, 0.853],
        ['Rapportassistenten', 'Nynorsk', 0.796, 0.754],
        ['Vedtaksutkast', 'Klarspråk', 0.81, 0.822],
        ['Vedtaksutkast', 'Lange dokumenter', 0.723, 0.798],
      ];
      const done = Math.min(sets.length, found.polls);
      const finished = done === sets.length;
      const estimate = Number(found.run.estimatedCostNok);
      return json({
        ...found.run,
        status: finished ? 'succeeded' : 'running',
        endedAt: finished ? new Date().toISOString() : null,
        costNok: finished ? estimate * 1.03 : (estimate * done) / sets.length,
        testSets: sets.length,
        done,
        rows: sets.map(([name, testSet, before, after], i) => ({
          tenant: '991825827',
          service: name.toLowerCase(),
          name,
          testSet,
          cases: 40,
          current: { score: before, passed: 36, total: 40 },
          candidate: i < done ? { score: after, passed: 35, total: 40 } : null,
        })),
      });
    }
    if (path === '/operator/plugins' && method === 'POST') {
      if (!reason) return needReason();
      const manifest = (body() as { manifest?: Record<string, unknown> }).manifest ?? {};
      if (typeof manifest.id !== 'string' || typeof manifest.kind !== 'string')
        return json(
          {
            title: 'Invalid plug-in',
            status: 400,
            errors: [{ path: 'manifest.id', message: 'Required' }],
          },
          400,
        );
      blocks = {
        ...blocks,
        registry: [
          ...(blocks.registry ?? []),
          {
            id: manifest.id,
            type:
              ({ model: 'modell', knowledge: 'sok', blob: 'lagring' } as Record<string, string>)[
                manifest.kind
              ] ?? 'verktoy',
            name: String(manifest.title ?? manifest.id),
            version: String(manifest.version ?? '1.0.0'),
            provider: String(manifest.publisher ?? ''),
            origin: 'external',
            dataLocation: typeof manifest.dataLocation === 'string' ? manifest.dataLocation : null,
            availability: 'none',
            agencies: [],
            serviceCount: 0,
            services: [],
          },
        ],
      };
      record('alle', 'Registrerte ekstern byggekloss', manifest.id, reason);
      return json({ manifest: { ...manifest, origin: 'external' } }, 201);
    }
    if (path === '/operator/quality/matrix/release' && method === 'POST') {
      record('alle', 'Gjorde versjon tilgjengelig', String(body().name), reason ?? '');
      return json({ ok: true });
    }
    if (path === '/operator/quality/label-queue') return json({ data: queue, total: queue.length });
    if (path === '/operator/quality/labels' && method === 'POST') {
      if (!reason) return needReason();
      const b = body() as { item: string };
      queue = queue.filter((q) => q.item !== b.item);
      return json(b);
    }
    if (path === '/operator/tracing' && method === 'GET') return json(tracing);
    const trace = /^\/operator\/tracing\/([^/]+)(\/test)?$/.exec(path);
    if (trace) {
      const tool = decodeURIComponent(trace[1] ?? '');
      const existing = tracing.connections?.[tool];
      if (trace[2]) {
        return existing?.status === 'failing'
          ? json({ delivered: false, code: '401' })
          : json({ delivered: true, seconds: 0.8 });
      }
      if (!reason) return needReason();
      if (method === 'DELETE') {
        tracing.connections = Object.fromEntries(
          Object.entries(tracing.connections ?? {}).filter(([id]) => id !== tool),
        );
        return json({ ok: true });
      }
      const b = body() as TraceSettings;
      const newSecret = Object.values(b.secrets).some(Boolean);
      const next: TraceConnection = {
        hosting: b.hosting,
        values: b.values,
        scope: b.scope,
        content: b.content,
        mask: b.mask,
        sampleRate: b.sampleRate,
        syncScores: b.syncScores,
        annotations: b.annotations,
        status: !existing || newSecret ? 'ok' : existing.status,
        secretsStored: true,
        lastDelivery: existing?.lastDelivery ?? new Date().toISOString(),
        sent24h: existing?.sent24h ?? 0,
        queued: existing?.queued ?? 0,
      };
      tracing.connections = { ...tracing.connections, [tool]: next };
      record('alle', existing ? 'Endret sporing' : 'Koblet til sporing', tool, reason);
      return json(next);
    }
    if (path === '/operator/support-sessions') return json({ data: support });
    const extendSession = /^\/operator\/support-sessions\/([^/]+)\/extend$/.exec(path);
    if (extendSession && method === 'POST') {
      if (!reason) return needReason();
      const found = sessions.get(extendSession[1] ?? '');
      if (!found) return notFound();
      const minutes = Number(body().minutes ?? 15);
      const next = {
        ...found,
        expiresAt: new Date(new Date(found.expiresAt).getTime() + minutes * 60000).toISOString(),
      };
      sessions.set(found.id, next);
      support = support.map((x) => (x.id === found.id ? { ...x, expiresAt: next.expiresAt } : x));
      record(found.tenant, `Støttetilgang forlenget (${minutes} min)`, 'Hele portalen', reason);
      return json(next);
    }
    const endSession = /^\/operator\/support-sessions\/([^/]+)\/end$/.exec(path);
    if (endSession && method === 'POST') {
      if (!reason) return needReason();
      const found = support.find((x) => x.id === endSession[1] && x.status === 'active');
      if (!found) return notFound();
      support = support.map((x) =>
        x === found ? { ...x, status: 'ended', endedAt: new Date().toISOString() } : x,
      );
      sessions.delete(found.id);
      record(found.tenant, 'Støttetilgang avsluttet', 'Hele portalen', reason);
      return json({ ...found, status: 'ended' });
    }
    if (path === '/operator/running-tasks') {
      const tenant = url.searchParams.get('tenant');
      const service = url.searchParams.get('service');
      return json({
        data: running.filter(
          (t) => (!tenant || t.tenant === tenant) && (!service || t.service === service),
        ),
      });
    }
    const cancel = /^\/operator\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (cancel && method === 'POST') {
      if (!reason) return needReason();
      if (!running.some((t) => t.task === cancel[1])) return notFound();
      running = running.filter((t) => t.task !== cancel[1]);
      return json({ task: cancel[1], cancelled: true });
    }
    if (path === '/operator/operations') return json(exampleOperations);
    const remind = /^\/operator\/onboarding\/(\d+)\/reminders$/.exec(path);
    if (remind && method === 'POST') {
      const found =
        onboarding.find((o) => o.orgNumber === remind[1]) ??
        tenantList.find((t) => t.orgNumber === remind[1]);
      if (!found) return notFound();
      record(found.orgNumber, 'Sendte påminnelse', found.name);
      return json({ ok: true });
    }
    return notFound();
  };
};
