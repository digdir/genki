import type {
  EndpointTestResult,
  EngineCapability,
  JsonSchema,
  KnowledgeEndpoint,
  KnowledgeEndpointItem,
  KnowledgeEngine,
  StoredSecret,
} from '../../types';

const auth = (secretTitle: string, description?: string): JsonSchema => ({
  title: 'Innlogging',
  oneOf: [
    {
      type: 'object',
      title: 'API-nøkkel',
      required: ['kind', 'secret'],
      properties: {
        kind: { const: 'api-key' },
        secret: {
          type: 'string',
          title: secretTitle,
          'x-secret': true,
          ...(description ? { description } : {}),
        },
      },
    },
    {
      type: 'object',
      title: 'Bearer-token',
      required: ['kind', 'secret'],
      properties: {
        kind: { const: 'bearer' },
        secret: { type: 'string', title: 'Token', 'x-secret': true },
      },
    },
  ],
});

const remote = (
  engine: string,
  baseURL: JsonSchema,
  authSchema: JsonSchema,
  options: JsonSchema,
) => ({
  type: 'object',
  required: ['engine', 'baseURL', 'auth'],
  properties: { engine: { const: engine }, baseURL, auth: authSchema, options },
});

const vectorEngineOptions: JsonSchema = {
  type: 'object',
  properties: {
    hnswM: {
      type: 'integer',
      title: 'Koblinger per node (HNSW m)',
      description: 'Høyere tall gir bedre treff, men tar mer plass.',
      minimum: 4,
      maximum: 64,
      default: 16,
    },
    efSearch: {
      type: 'integer',
      title: 'Søkebredde (ef_search)',
      description: 'Hvor mange kandidater som vurderes i hvert søk.',
      minimum: 10,
      maximum: 1000,
      default: 100,
    },
    language: {
      type: 'string',
      title: 'Språk for ordsøk',
      enum: ['norwegian', 'simple'],
      enumTitles: ['Norsk', 'Uten språkregler'],
      default: 'norwegian',
    },
  },
};

const all = [
  'search.text',
  'search.vector',
  'search.hybrid',
  'filter.term',
  'facets',
  'fetch',
  'range',
];

export const exampleKnowledgeEngines: KnowledgeEngine[] = [
  {
    engine: 'pgvector',
    title: 'Innebygd søk',
    tech: 'Postgres med pgvector',
    builtin: true,
    dataLocation: 'norway',
    probe: true,
    requiresBaseURL: false,
    endpoint: {
      type: 'object',
      required: ['engine'],
      properties: { engine: { const: 'pgvector' }, options: vectorEngineOptions },
    },
    endpointOptions: vectorEngineOptions,
    capabilities: all,
  },
  {
    engine: 'typesense',
    title: 'Typesense',
    tech: 'Typesense 28',
    builtin: false,
    dataLocation: 'norway',
    probe: true,
    requiresBaseURL: true,
    endpoint: remote(
      'typesense',
      {
        type: 'string',
        format: 'uri',
        title: 'Adresse',
        description: 'Adressen til Typesense-klyngen. Må begynne med https://.',
      },
      auth('API-nøkkel', 'Velg en hemmelighet. Nøkkelen vises aldri.'),
      {
        type: 'object',
        required: ['collectionPrefix'],
        properties: {
          collectionPrefix: {
            type: 'string',
            title: 'Prefiks for samlinger',
            pattern: '^[a-z0-9_]+$',
            description: 'Små bokstaver, tall og _.',
          },
          connectionTimeoutSeconds: {
            type: 'integer',
            title: 'Tidsavbrudd i sekunder',
            minimum: 1,
            maximum: 60,
            default: 5,
          },
          vectorSearch: { type: 'boolean', title: 'Vektorsøk', default: true },
        },
      },
    ),
    capabilities: all.filter((c) => c !== 'range'),
  },
  {
    engine: 'azure-ai-search',
    title: 'Azure AI Search',
    tech: 'Microsoft Azure',
    builtin: false,
    dataLocation: 'eu',
    probe: true,
    requiresBaseURL: true,
    endpoint: remote(
      'azure-ai-search',
      {
        type: 'string',
        format: 'uri',
        title: 'Adresse',
        description: 'For eksempel https://navn.search.windows.net',
      },
      auth('API-nøkkel'),
      {
        type: 'object',
        required: ['region'],
        properties: {
          region: {
            type: 'string',
            title: 'Region',
            enum: ['swedencentral', 'norwayeast'],
            enumTitles: ['Sverige sentralt', 'Norge øst'],
          },
          semanticRanker: { type: 'boolean', title: 'Semantisk rangering', default: false },
        },
      },
    ),
    capabilities: all.filter((c) => c !== 'range'),
  },
  {
    engine: 'opensearch',
    title: 'OpenSearch',
    tech: 'OpenSearch 2 uten vektortillegg',
    builtin: false,
    dataLocation: 'norway',
    probe: false,
    requiresBaseURL: true,
    endpoint: remote(
      'opensearch',
      { type: 'string', format: 'uri', title: 'Adresse' },
      auth('Passord'),
      {
        type: 'object',
        required: ['indexPrefix'],
        properties: {
          indexPrefix: { type: 'string', title: 'Prefiks for indekser', pattern: '^[a-z0-9-]+$' },
          knn: {
            type: 'boolean',
            title: 'Vektorsøk (k-NN)',
            description: 'Krever at tillegget er installert på klyngen.',
            default: false,
          },
        },
      },
    ),
    capabilities: ['search.text', 'filter.term', 'fetch', 'range'],
  },
];

export const exampleSecrets: StoredSecret[] = [
  {
    ref: 'secret://platform/typesense-api-key',
    name: 'typesense-api-key',
    updatedAt: '2026-10-02',
  },
  { ref: 'secret://platform/azure-search-key', name: 'azure-search-key', updatedAt: '2026-09-14' },
  {
    ref: 'secret://platform/opensearch-passord',
    name: 'opensearch-passord',
    updatedAt: '2026-08-01',
  },
];

const capabilitiesOf = (engine: KnowledgeEngine): KnowledgeEndpoint['capabilities'] => {
  const names: [EngineCapability, (c: string[]) => boolean][] = [
    ['text_search', (c) => c.includes('search.text')],
    ['vector_search', (c) => c.includes('search.vector')],
    ['hybrid', (c) => c.includes('search.hybrid')],
    ['filters', (c) => c.some((x) => x.startsWith('filter.'))],
    ['facets', (c) => c.includes('facets')],
    ['full_document', (c) => c.includes('fetch')],
    ['ordered_passages', (c) => c.includes('range')],
  ];
  return {
    supported: names.filter(([, has]) => has(engine.capabilities)).map(([n]) => n),
    missing: names.filter(([, has]) => !has(engine.capabilities)).map(([n]) => n),
  };
};

const hostOf = (spec: Record<string, unknown>, builtin: boolean) => {
  if (builtin) return 'platform';
  try {
    return new URL(String(spec.baseURL)).hostname;
  } catch {
    return 'unknown';
  }
};

export const exampleSpecs: Record<string, Record<string, unknown>> = {
  'innebygd-sok': {
    engine: 'pgvector',
    options: { hnswM: 16, efSearch: 100, language: 'norwegian' },
  },
  'typesense-digdir': {
    engine: 'typesense',
    baseURL: 'https://typesense.ki.digdir.example.no',
    auth: { kind: 'api-key', secret: 'secret://platform/typesense-api-key' },
    options: { collectionPrefix: 'ki_prod', connectionTimeoutSeconds: 5, vectorSearch: true },
    sharing: { tenants: '*' },
  },
  'azure-sverige': {
    engine: 'azure-ai-search',
    baseURL: 'https://eksempel.search.windows.net',
    auth: { kind: 'api-key', secret: 'secret://platform/azure-search-key' },
    options: { region: 'swedencentral', semanticRanker: false },
  },
  'opensearch-sev': {
    engine: 'opensearch',
    baseURL: 'https://sok.eksempelverk.example.no',
    auth: { kind: 'api-key', secret: 'secret://platform/opensearch-passord' },
    options: { indexPrefix: 'ki-sev', knn: false },
  },
};

const datasetCounts: Record<string, number> = {
  'innebygd-sok': 184,
  'typesense-digdir': 23,
  'opensearch-sev': 4,
};

const datasetsOn: Record<string, { tenant: string; id: string; name: string }[]> = {
  'typesense-digdir': [
    { tenant: '991825827', id: 'kudos', name: 'Kudos' },
    { tenant: '999888777', id: 'regelverk', name: 'Regelverk' },
  ],
  'opensearch-sev': [{ tenant: '974222333', id: 'saksarkiv', name: 'Saksarkiv' }],
};

const viewOf = (id: string, spec: Record<string, unknown>, version = 1): KnowledgeEndpoint => {
  const engine = exampleKnowledgeEngines.find((e) => e.engine === spec.engine);
  const datasetCount = datasetCounts[id] ?? 0;
  return {
    id,
    name: typeof spec.name === 'string' ? spec.name : id,
    scope: 'platform',
    engine: String(spec.engine),
    title: engine?.title ?? String(spec.engine),
    ...(engine?.tech ? { tech: engine.tech } : {}),
    builtin: engine?.builtin ?? false,
    runsAt: hostOf(spec, engine?.builtin ?? false),
    ...(engine?.dataLocation ? { dataLocation: engine.dataLocation } : {}),
    writeKeyRequired: engine?.engine === 'typesense',
    capabilities: engine ? capabilitiesOf(engine) : { supported: [], missing: [] },
    datasetCount,
    status: datasetCount ? 'ok' : 'unused',
    shared: spec.sharing !== undefined,
    version,
  };
};

export const exampleEndpoints: KnowledgeEndpoint[] = Object.entries(exampleSpecs).map(
  ([id, spec]) => viewOf(id, spec),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

export const searchEnginesMock = () => {
  const specs = structuredClone(exampleSpecs);
  const versions = new Map<string, number>();
  const endpoints = () =>
    Object.entries(specs).map(([id, spec]) => viewOf(id, spec, versions.get(id)));
  return (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Response | undefined => {
    if (method === 'GET' && path === '/operator/knowledge/engines')
      return json({ data: exampleKnowledgeEngines });
    if (method === 'GET' && path === '/operator/knowledge/endpoints')
      return json({ data: endpoints() });
    if (method === 'GET' && path === '/operator/knowledge/secrets')
      return json({ data: exampleSecrets });
    if (method === 'POST' && path === '/operator/knowledge/endpoints/test') {
      const spec = body();
      const engine = exampleKnowledgeEngines.find((e) => e.engine === spec.engine);
      const ok = Boolean(engine?.builtin) || /^https:\/\//.test(String(spec.baseURL ?? ''));
      const reply: EndpointTestResult = ok
        ? { ok: true, engine: String(spec.engine), message: 'Tilkoblingen virker.', ms: 84 }
        : {
            ok: false,
            engine: String(spec.engine),
            code: 'unavailable',
            message: 'Fikk ikke kontakt. Sjekk adressen.',
            ms: 5000,
          };
      return json(reply);
    }
    const removing = /^\/operator\/knowledge\/endpoints\/([^/]+)$/.exec(path);
    if (removing && method === 'DELETE') {
      const id = decodeURIComponent(removing[1] as string);
      if (!reason)
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'change-reason', message: 'a reason is required' }],
          },
          400,
        );
      if (!specs[id]) return json({ title: 'Not found', status: 404 }, 404);
      const datasets = datasetsOn[id];
      if (datasets?.length)
        return json({ title: 'Endepunktet er i bruk', status: 409, datasets }, 409);
      Reflect.deleteProperty(specs, id);
      return new Response(null, { status: 204 });
    }
    const item = /^\/operator\/catalog\/knowledge-endpoint\/([^/]+)$/.exec(path);
    if (!item) return undefined;
    const id = decodeURIComponent(item[1] as string);
    if (method === 'GET') {
      const spec = specs[id];
      return spec
        ? json({
            id,
            kind: 'knowledge-endpoint',
            scope: 'platform',
            version: versions.get(id) ?? 1,
            spec,
          } satisfies KnowledgeEndpointItem)
        : json({ title: 'Not found', status: 404 }, 404);
    }
    if (method === 'PUT') {
      if (!reason)
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'change-reason', message: 'a reason is required' }],
          },
          400,
        );
      const spec = body();
      specs[id] = spec;
      const version = (versions.get(id) ?? 1) + 1;
      versions.set(id, version);
      return json({ id, kind: 'knowledge-endpoint', scope: 'platform', version, spec });
    }
    return undefined;
  };
};
