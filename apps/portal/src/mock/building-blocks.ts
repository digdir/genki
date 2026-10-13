import type {
  ApprovalRequest,
  BlockChangeResult,
  BlockEvent,
  BlockKind,
  BlockVersion,
  BuildingBlockList,
  CatalogItem,
  CatalogProposal,
  ConnectionInput,
  ConnectionCheckFailure,
  ConnectorView,
  ContractTest,
  ContractTestReport,
  LoggedChange,
  ManifestPreview,
  Permission,
  RegistrationInput,
  RegistrationResult,
  RegistrationType,
  SettingChange,
  SettingValue,
} from '../api/building-blocks';
import {
  builderProposals,
  blockKinds,
  contractTestFailures,
  authUnavailable,
  defaultSettingsSchema,
  emptyTenantBlocks,
  exampleBlocks,
  exampleSecretNames,
  exampleVersions,
  extensionPointLabel,
  mcpContractTests,
} from '../data/building-blocks';
import type { MockHandler, MockRequest } from '../mock';
import { reasonProblem } from '../components/ReasonField';

export interface BuildingBlocksMockOptions {
  items?: CatalogItem[];
  empty?: boolean;
  proposals?: CatalogProposal[];
  versions?: Record<string, BlockVersion[]>;
  by?: string;
  secrets?: string[];
  firstSyncError?: string;
  privateNetworks?: string[];
  checkFailure?: ConnectionCheckFailure;
  connectors?: ConnectorView[];
}

const hostOf = (url = '') => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'byggekloss';

const secretRef = (tenant: string, secret: string) =>
  secret.startsWith('secret://') ? secret : `secret://tenant/${tenant}/${secret}`;

const problem = (
  req: MockRequest,
  status: number,
  title: string,
  errors: { path: string; message: string }[] = [],
  extra: Record<string, unknown> = {},
) => req.json({ type: 'about:blank', title, status, errors, ...extra }, status);

export const registrationManifest = (input: RegistrationInput, tenant: string): ManifestPreview => {
  const host = hostOf(input.endpoint);
  const secret = input.auth?.secret ? secretRef(tenant, input.auth.secret) : undefined;
  const data =
    input.type === 'skill_package'
      ? 'Ingen. Pakken leses av tjenesten når den trengs.'
      : input.type === 'extension_point' && input.extensionPoint
        ? `Det punktet gir tilgang til: ${extensionPointLabel(input.extensionPoint).toLowerCase()}`
        : 'Det tjenesten sender i kallet';
  const permissions: Permission[] = [
    { type: 'network', value: host ?? 'Ingen', note: '' },
    {
      type: 'secret',
      value: secret ?? (input.auth?.kind === 'maskinporten' ? 'Maskinporten' : 'Ingen'),
      note: '',
    },
    { type: 'data', value: data, note: '' },
  ];
  const list = (items: string[]) =>
    items.length === 0 ? ' []' : `\n${items.map((i) => `      - ${i}`).join('\n')}`;
  const manifest = [
    'apiVersion: genai/v1',
    'kind: BuildingBlock',
    'metadata:',
    `  tenant: "${tenant}"`,
    `  id: ${input.id ?? slugOf(input.name)}`,
    `  name: ${input.name}`,
    '  version: 1',
    'spec:',
    `  type: ${input.type}`,
    ...(input.endpoint ? [`  endpoint: ${input.endpoint}`] : []),
    ...(input.extensionPoint ? [`  extensionPoint: ${input.extensionPoint}`] : []),
    '  auth:',
    `    kind: ${input.auth?.kind ?? 'none'}`,
    ...(secret ? [`    secret: ${secret}`] : []),
    '  permissions:',
    `    network:${list(host ? [host] : [])}`,
    `    secrets:${list(secret ? [secret] : [])}`,
    `    data:${list([data])}`,
    '',
  ].join('\n');
  return { manifest, permissions };
};

const maskinportenRefused: Partial<Record<RegistrationType, string>> = {
  mcp: 'MCP-servere',
  a2a: 'A2A-agenter',
  openapi: 'REST-verktøy',
};

const setupProblem = (input: RegistrationInput, tenant: string) => {
  const auth = input.auth;
  if (auth?.kind === 'maskinporten' && maskinportenRefused[input.type])
    return `Innlogging med Maskinporten støttes ikke ennå for ${maskinportenRefused[input.type]}.`;
  const unavailable = auth ? authUnavailable(input.type, auth.kind) : undefined;
  if (unavailable) return `Innlogging med ${unavailable}`;
  if (
    (auth?.kind === 'bearer' ||
      auth?.kind === 'api-key' ||
      auth?.kind === 'oauth-client-credentials') &&
    !auth.secret
  )
    return 'Velg hemmeligheten som skal brukes til innlogging.';
  if (input.type === 'openapi' && !input.document && !input.documentUrl)
    return 'Velg en OpenAPI-fil eller skriv adressen til den.';
  if (
    auth?.secret?.startsWith('secret://') &&
    !auth.secret.startsWith(`secret://tenant/${tenant}/`)
  )
    return 'Velg en av hemmelighetene til virksomheten.';
  return undefined;
};

export const runContractTests = (input: RegistrationInput, tenant = ''): ContractTestReport => {
  const refused = setupProblem(input, tenant);
  if (refused)
    return {
      type: input.type,
      passed: false,
      results: [{ name: 'Oppsettet er gyldig', passed: false, reason: refused }],
      tools: [],
    };
  if (input.type === 'a2a') return a2aContractTests(input);
  if (input.type === 'openapi') return openApiContractTests(input);
  const failing = /saksarkiv/.test(input.endpoint ?? '');
  const results = mcpContractTests.map((name): ContractTest => {
    const reason = failing ? contractTestFailures[name] : undefined;
    return reason ? { name, passed: false, reason } : { name, passed: true };
  });
  return {
    type: input.type,
    passed: results.every((r) => r.passed),
    results,
    tools: [{ name: 'hent_sak', description: 'Henter en sak med vedlegg' }],
  };
};

const exampleOperations = [
  { operation: 'hentSak', method: 'GET', path: '/saker/{id}', description: 'Henter en sak.' },
  { operation: 'sokSaker', method: 'GET', path: '/saker', description: 'Søker i saker.' },
  { operation: 'opprettSak', method: 'POST', path: '/saker', description: 'Oppretter en sak.' },
];

const a2aContractTests = (input: RegistrationInput): ContractTestReport => {
  const id = input.id ?? slugOf(input.name);
  const results: ContractTest[] = [
    { name: 'Oppsettet er gyldig', passed: true },
    { name: 'Har et gyldig agentkort (A2A 1.0)', passed: true },
    { name: 'Ferdighetene har navn og beskrivelse', passed: true },
    { name: 'Respekterer tidsavbrudd', passed: true },
    { name: 'Bruker bare adressene i manifestet', passed: true },
  ];
  return {
    type: 'a2a',
    passed: true,
    results,
    tools: [{ name: `${id}.svar`, description: `${input.name}: Svarer på spørsmål.` }],
    agent: {
      name: 'Skatteveilederen',
      description:
        'Svarer på spørsmål om skatteregler for tilskudd og stipend, med henvisning til Lovdata.',
      version: '0.3',
      provider: 'Statens eksempelverk',
      skills: [
        { name: 'Skatt på tilskudd', description: 'svarer på om et tilskudd er skattepliktig' },
        {
          name: 'Skatt på stipend',
          description: 'forklarer reglene for stipend fra det offentlige',
        },
      ],
    },
  };
};

const openApiContractTests = (input: RegistrationInput): ContractTestReport => {
  const id = input.id ?? slugOf(input.name);
  const statusOf = (o: (typeof exampleOperations)[number]) =>
    input.operations && !input.operations.includes(o.operation)
      ? ('not_selected' as const)
      : o.method !== 'GET' && !input.writes
        ? ('write_disabled' as const)
        : ('enabled' as const);
  const enabled = exampleOperations.filter((o) => statusOf(o) === 'enabled');
  const results: ContractTest[] = [
    { name: 'Oppsettet er gyldig', passed: true },
    { name: 'OpenAPI-fila kan leses (3.0 eller 3.1)', passed: true },
    enabled.length > 0
      ? { name: 'Operasjonene som er valgt, finnes og har beskrivelse', passed: true }
      : {
          name: 'Operasjonene som er valgt, finnes og har beskrivelse',
          passed: false,
          reason: 'Ingen operasjoner er valgt. Velg minst én.',
        },
    { name: 'Skriveoperasjoner er av til de slås på', passed: true },
    { name: 'Bruker bare adressene i manifestet', passed: true },
  ];
  return {
    type: 'openapi',
    passed: results.every((r) => r.passed),
    results,
    tools: exampleOperations.map((o) => ({
      name: `${id}.${o.operation.toLowerCase()}`,
      description: o.description,
      operation: o.operation,
      method: o.method,
      path: o.path,
      readOnly: o.method === 'GET',
      status: statusOf(o),
    })),
  };
};

const connectionTypes: RegistrationType[] = ['mcp', 'a2a', 'openapi'];

const unsupported = (req: MockRequest, type: RegistrationType) =>
  problem(
    req,
    501,
    connectionTypes.includes(type) ? 'Typen støttes ikke ennå' : 'API ikke bestemt',
    [{ path: 'type', message: 'unsupported' }],
    { code: 'unsupported' },
  );

const route = /^\/tenants\/([^/]+)\/building-blocks(?:\/(.*))?$/;
const proposalsRoute = /^\/tenants\/([^/]+)\/proposals(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const connectorsRoute = /^\/tenants\/([^/]+)\/connectors(?:\/([^/]+)\/(sync|credentials))?$/;

export const buildingBlocksMock = (options: BuildingBlocksMockOptions = {}): MockHandler => {
  let items = structuredClone(
    options.items ?? (options.empty ? emptyTenantBlocks() : exampleBlocks),
  );
  let proposals = structuredClone(options.proposals ?? builderProposals);
  let connectors: ConnectorView[] = structuredClone(options.connectors ?? []);
  const failNext = new Set<string>();
  const running = (now: string) => ({ status: 'running' as const, startedAt: now });
  const settled = (c: ConnectorView): ConnectorView => {
    if (c.status !== 'syncing' || !c.lastSync) return c;
    const now = new Date().toISOString();
    const error = failNext.delete(c.id) ? options.firstSyncError : undefined;
    return error
      ? {
          ...c,
          status: 'failed',
          lastSync: { ...c.lastSync, status: 'failed', endedAt: now, error },
        }
      : {
          ...c,
          status: 'connected',
          lastSync: { ...c.lastSync, status: 'succeeded', endedAt: now, rows: 50, skipped: 0 },
        };
  };
  const versions = structuredClone(options.versions ?? exampleVersions);
  const requests: ApprovalRequest[] = [];
  const by = options.by ?? 'Kari Nordmann';
  const secretNames = options.secrets ?? exampleSecretNames;
  const logged = (reason: string): LoggedChange => ({
    by,
    at: new Date().toISOString(),
    reason: reason.trim(),
  });
  const keyOf = (item: Pick<CatalogItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;
  const replace = (item: CatalogItem) => {
    items = items.map((i) => (keyOf(i) === keyOf(item) ? item : i));
    return item;
  };
  const record = (
    item: CatalogItem,
    event: BlockEvent,
    change: LoggedChange,
    changes?: SettingChange[],
  ) => {
    const next = replace({ ...item, settingsVersion: item.settingsVersion + 1, changedBy: change });
    versions[keyOf(item)] = [
      ...(versions[keyOf(item)] ?? []),
      {
        source: 'tenant',
        version: String(next.settingsVersion),
        ...change,
        event,
        ...(changes ? { changes } : {}),
      },
    ];
    return next;
  };
  const listOf = (req: MockRequest): BuildingBlockList => {
    const kind = req.url.searchParams.get('kind');
    const status = req.url.searchParams.get('status');
    const publisher = req.url.searchParams.get('publisher');
    const byKind = Object.fromEntries(
      blockKinds.map((k) => [k.kind, items.filter((i) => i.kind === k.kind).length]),
    ) as Record<BlockKind, number>;
    return {
      data: items.filter(
        (i) =>
          (!kind || i.kind === kind) &&
          (!status || i.status === status) &&
          (!publisher || i.publisher.type === publisher),
      ),
      counts: {
        inUse: items.filter((i) => i.status === 'in_use').length,
        catalog: items.length,
        byKind,
      },
    };
  };
  const shortReason = (req: MockRequest, min: number) =>
    (req.reason ?? '').trim().length < min
      ? problem(req, 400, 'Invalid request', [
          {
            path: 'change-reason',
            message: min > 1 ? `Begrunnelsen må ha minst ${min} tegn.` : 'a reason is required',
          },
        ])
      : undefined;

  const proposalRoute = (req: MockRequest) => {
    const match = proposalsRoute.exec(req.path);
    if (!match) return undefined;
    const [, , pid, action] = match;
    if (!pid && req.method === 'GET') {
      const state = req.url.searchParams.get('state');
      const level = req.url.searchParams.get('level');
      return req.json({
        data: proposals.filter(
          (p) => (!state || p.state === state) && (!level || String(p.level) === level),
        ),
      });
    }
    const proposal = proposals.find((p) => p.id === decodeURIComponent(pid ?? ''));
    if (!proposal) return problem(req, 404, 'Not found');
    if (!action && req.method === 'GET') return req.json(proposal);
    if (req.method !== 'POST' || !action) return undefined;
    if (action !== 'approve' && action !== 'reject' && action !== 'send-for-approval')
      return undefined;
    const reason = (req.reason ?? req.body<{ reason?: string }>()?.reason ?? '').trim();
    const reasonError = reasonProblem(reason);
    if (action !== 'reject' && reasonError)
      return problem(req, 400, 'Invalid request', [{ path: 'reason', message: reasonError }]);
    if (proposal.state === 'approved' || proposal.state === 'rejected')
      return problem(req, 409, 'Forslaget er allerede behandlet');
    const connection =
      action === 'approve' && proposal.level === 2
        ? req.body<{ connection?: ConnectionInput }>()?.connection
        : undefined;
    if (action === 'approve' && proposal.level === 2 && !connection?.password)
      return problem(req, 422, 'Fyll inn hvor databasen er og hvordan plattformen logger på', [
        { path: 'connection', message: 'connection details are required' },
      ]);
    if (connection) {
      const reach = reachOf(connection.host);
      if (!reach.allowed)
        return problem(
          req,
          422,
          reach.network === 'blocked'
            ? 'Adressen kan ikke brukes'
            : 'Databasen ligger på et privat nettverk',
          [{ path: 'connection.host', message: refusal(connection.host, reach.network) }],
        );
      if (options.checkFailure)
        return problem(req, 422, 'Fikk ikke lest fra databasen', [options.checkFailure]);
    }
    const changedBy = logged(reason);
    const state =
      action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'sent_for_approval';
    const done: CatalogProposal = {
      ...proposal,
      state,
      ...(action === 'send-for-approval' ? {} : { decision: changedBy }),
    };
    proposals = proposals.map((p) => (p.id === done.id ? done : p));
    if (action === 'approve' && proposal.level === 3 && proposal.item) {
      const item = proposal.item;
      items = [
        ...items.filter((i) => keyOf(i) !== keyOf(item)),
        {
          ...item,
          status: 'in_use',
          usedBy: [proposal.forService],
          changedBy,
          settingsVersion: item.settingsVersion + 1,
        },
      ];
    }
    if (connection) {
      const now = new Date().toISOString();
      connectors = [
        ...connectors,
        {
          id: `${proposal.forService.id}.${proposal.id}`,
          name: proposal.item?.name ?? `Kobling for ${proposal.forService.name}`,
          service: proposal.forService.id,
          proposal: proposal.id,
          approvedBy: by,
          approvedAt: now,
          status: 'syncing',
          dataset: proposal.id,
          connection: {
            engine: 'postgres',
            host: connection.host,
            port: connection.port ?? 5432,
            database: connection.database,
            user: connection.user,
            tls: connection.tls ?? true,
            credentials: 'stored',
            ...(() => {
              const reach = reachOf(connection.host);
              return { network: reach.network, networkAllowed: reach.allowed };
            })(),
          },
          ...(proposal.source ? { source: proposal.source } : {}),
          lastSync: running(now),
        },
      ];
      if (options.firstSyncError) failNext.add(`${proposal.forService.id}.${proposal.id}`);
    }
    return req.json({ proposal: done, changedBy });
  };

  const refusal = (host: string, network: string) =>
    network === 'blocked'
      ? `${host} kan ikke brukes. Plattformens egne adresser, lokale adresser og metadata-adresser er alltid stengt.`
      : `${host} ligger på et privat nettverk som ikke er åpnet for virksomheten. Digdir kan åpne adressen. Be Digdir om å legge den til i listen over tillatte private nettverk.`;

  const reachOf = (host: string) => {
    const entries = options.privateNetworks ?? [];
    const network = /^(127\.|169\.254\.|localhost$)/.test(host)
      ? ('blocked' as const)
      : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.intern$/.test(host)
        ? ('private' as const)
        : ('public' as const);
    const allowed = network === 'public' || (network === 'private' && entries.includes(host));
    return { network, allowed };
  };

  const networkRoute = (req: MockRequest) => {
    const tenant = /^\/tenants\/([^/]+)\/(?:private-networks|connectors\/network)$/.exec(req.path);
    if (!tenant || req.method !== 'GET') return undefined;
    if (req.path.endsWith('/private-networks'))
      return req.json({
        tenant: decodeURIComponent(tenant[1] ?? ''),
        entries: options.privateNetworks ?? [],
      });
    const host = req.url.searchParams.get('host') ?? '';
    const { network, allowed } = reachOf(host);
    return req.json({
      host,
      network,
      allowed,
      ...(allowed
        ? {}
        : {
            message: refusal(host, network),
          }),
    });
  };

  const connectorRoute = (req: MockRequest) => {
    const match = connectorsRoute.exec(req.path);
    if (!match) return undefined;
    const [, , id, action] = match;
    if (!id && req.method === 'GET') {
      const shown = connectors;
      connectors = connectors.map(settled);
      return req.json({ data: shown });
    }
    const found = connectors.find((c) => c.id === decodeURIComponent(id ?? ''));
    if (found && action === 'credentials' && req.method === 'PUT')
      return req.body<{ password?: string }>()?.password
        ? req.json(found)
        : problem(req, 400, 'Invalid request', [{ path: 'body.password', message: 'required' }]);
    if (!found || req.method !== 'POST') return problem(req, 404, 'Not found');
    const synced: ConnectorView = {
      ...found,
      status: 'syncing',
      lastSync: running(new Date().toISOString()),
    };
    connectors = connectors.map((c) => (c.id === synced.id ? synced : c));
    return req.json(synced, 202);
  };

  return (req) => {
    const proposalResponse = proposalRoute(req) ?? networkRoute(req) ?? connectorRoute(req);
    if (proposalResponse) return proposalResponse;
    const match = route.exec(req.path);
    if (!match) return undefined;
    const tenant = decodeURIComponent(match[1] ?? '');
    const rest = (match[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    const [first, second, third] = rest;

    if (rest.length === 0 && req.method === 'GET') return req.json(listOf(req));
    if (rest.length === 0 && req.method === 'POST') {
      const input = req.body<RegistrationInput>();
      if (!connectionTypes.includes(input.type)) return unsupported(req, input.type);
      const missing = shortReason(req, 1);
      if (missing) return missing;
      const report = runContractTests(input, tenant);
      if (!input.name?.trim() || !report.passed)
        return problem(
          req,
          422,
          'Kontrakttesten er ikke bestått',
          report.results
            .filter((r) => !r.passed)
            .map((r) => ({ path: r.name, message: r.reason ?? '' })),
          { contractTests: report.results },
        );
      const id = input.id ?? slugOf(input.name);
      const host = hostOf(input.endpoint) ?? '';
      const change = logged(req.reason ?? '');
      const wantsWrites = input.type === 'openapi' && input.writes === true;
      const item: CatalogItem = {
        id,
        kind: 'tool',
        name: input.name.trim(),
        description: input.endpoint ?? '',
        publisher: { type: 'own', name: tenant },
        version: '1',
        dataLocation: null,
        status: wantsWrites ? 'pending_approval' : 'available',
        ...(wantsWrites ? { approver: 'digdir' } : {}),
        capabilities: report.tools
          .filter((t) => !t.status || t.status === 'enabled')
          .filter((t) => !wantsWrites || t.readOnly !== false)
          .map((t) => (t.description ? `${t.name}: ${t.description}` : t.name)),
        permissions: [{ type: 'network', value: host, note: '' }],
        usedBy: [],
        scores: [],
        settingsSchema: defaultSettingsSchema,
        tenantOverrides: {},
        settingsVersion: 0,
        right: 'manage-services',
      };
      items = [...items.filter((i) => keyOf(i) !== keyOf(item)), item];
      versions[keyOf(item)] = [{ source: 'publisher', version: '1' }];
      const result: RegistrationResult = {
        id,
        kind: 'tool',
        version: '1',
        contractTests: report.results,
        synced: true,
        changedBy: change,
        ...(wantsWrites
          ? { writesApproval: { request: `req-skriv-${id}`, state: 'pending' as const } }
          : {}),
      };
      return req.json(result, 201);
    }
    if (first === 'secrets' && !second && req.method === 'GET')
      return req.json({
        data: [...secretNames].sort().map((name) => ({
          name,
          ref: `secret://tenant/${tenant}/${name}`,
        })),
      });
    if (first === 'manifest-preview' && !second && req.method === 'POST')
      return req.json(registrationManifest(req.body<RegistrationInput>(), tenant));
    if (first === 'contract-tests' && !second && req.method === 'POST') {
      const input = req.body<RegistrationInput>();
      if (!connectionTypes.includes(input.type)) return unsupported(req, input.type);
      return req.json(runContractTests(input, tenant));
    }
    if (!first || !second) return undefined;
    const item = items.find((i) => i.kind === first && i.id === second);
    if (!item) return problem(req, 404, 'Not found');
    if (!third && req.method === 'GET') return req.json(item);
    if (third === 'versions' && req.method === 'GET')
      return req.json({ data: versions[keyOf(item)] ?? [] });
    if (third === 'adopt' && req.method === 'POST') {
      const missing = shortReason(req, 10);
      if (missing) return missing;
      if (item.status === 'not_allowed')
        return problem(req, 409, 'Conflict', [
          { path: 'status', message: item.policyBlock?.text ?? 'not allowed' },
        ]);
      if (item.status === 'requires_approval' || item.status === 'pending_approval')
        return problem(req, 409, 'Conflict', [
          { path: 'status', message: 'this building block needs approval first' },
        ]);
      const block = record({ ...item, status: 'in_use' }, 'adopted', logged(req.reason ?? ''));
      const result: BlockChangeResult = {
        block,
        version: block.settingsVersion,
        changes: [],
        affectedServices: [],
      };
      return req.json(result);
    }
    if (third === 'approval-requests' && req.method === 'POST') {
      const missing = shortReason(req, 10);
      if (missing) return missing;
      if (item.status !== 'requires_approval')
        return problem(req, 409, 'Conflict', [
          { path: 'status', message: `the building block is ${item.status}` },
        ]);
      const change = logged(req.reason ?? '');
      const request: ApprovalRequest = {
        id: `request-${requests.length + 1}`,
        tenant,
        kind: item.kind,
        block: item.id,
        blockName: item.name,
        approver: item.approver ?? 'digdir',
        state: 'pending',
        reason: change.reason,
        requestedBy: change.by,
        requestedAt: change.at,
      };
      requests.push(request);
      record(
        {
          ...item,
          status: 'pending_approval',
          pendingRequest: { id: request.id, by: change.by, at: change.at, reason: change.reason },
        },
        'approval_requested',
        change,
      );
      return req.json(request);
    }
    if (third === 'settings' && req.method === 'PUT') {
      const missing = shortReason(req, 1);
      if (missing) return missing;
      const ifMatch = new Headers(req.init?.headers).get('if-match');
      if (ifMatch !== null && Number(ifMatch.replace(/"/g, '')) !== item.settingsVersion)
        return problem(req, 409, 'Conflict', [
          {
            path: 'if-match',
            message: `the entry is at version ${item.settingsVersion}, not ${ifMatch}`,
          },
        ]);
      if (item.status !== 'in_use' && item.status !== 'pending_approval')
        return problem(req, 409, 'Conflict', [
          { path: 'status', message: `the building block is ${item.status}` },
        ]);
      const { settings } = req.body<{ settings: Record<string, SettingValue | null> }>();
      const unknown = Object.keys(settings).find((key) => !item.settingsSchema.properties[key]);
      if (unknown)
        return problem(req, 400, 'Invalid request', [
          {
            path: `settings.${unknown}`,
            message: `${unknown} is not a setting of this building block`,
          },
        ]);
      const before = item.tenantOverrides;
      const next: Record<string, SettingValue> = { ...before };
      for (const [key, value] of Object.entries(settings)) {
        if (value === null) Reflect.deleteProperty(next, key);
        else next[key] = value;
      }
      const changes = [...new Set([...Object.keys(before), ...Object.keys(next)])]
        .filter((key) => before[key] !== next[key])
        .map((key) => ({ key, before: before[key] ?? null, after: next[key] ?? null }));
      const block = record(
        { ...item, tenantOverrides: next },
        'settings',
        logged(req.reason ?? ''),
        changes,
      );
      const result: BlockChangeResult = {
        block,
        version: block.settingsVersion,
        changes,
        affectedServices: item.usedBy,
      };
      return req.json(result);
    }
    return undefined;
  };
};
