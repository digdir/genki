import type {
  DatasetEngineView,
  DefaultEmbedding,
  EngineSwitchView,
  KnowledgeEndpointView,
  RetrievalComparison,
  SwitchEstimateView,
  SwitchMethod,
} from '../api/search-engines';
import type { MockHandler } from '../mock';
import { reasonProblem } from '../components/ReasonField';

export type EngineScenario =
  'builtin' | 'typesense' | 'no-facets' | 'switching' | 'worse' | 'failed' | 'no-test-set';

export interface SearchEnginesMockOptions {
  scenario?: EngineScenario;
  dataset?: string;
  progressStep?: number;
  failAt?: number;
  endpoints?: KnowledgeEndpointView[];
  defaultEmbedding?: DefaultEmbedding | null;
}

export const exampleDefaultEmbedding: DefaultEmbedding = {
  model: 'foundry/text-embedding-3-small',
  dimensions: 1536,
  residency: 'global',
};

const norbert = 'NorBERT-embed-v3 (AIVAR)';
const embeddingModelLabel = 'text-embedding-3-large (Azure OpenAI)';

const all = [
  'text_search',
  'vector_search',
  'hybrid',
  'filters',
  'facets',
  'full_document',
  'ordered_passages',
] as const;

const capabilities = (...missing: (typeof all)[number][]) => ({
  supported: all.filter((c) => !missing.includes(c)),
  missing: all.filter((c) => missing.includes(c)),
});

const endpoint = (
  view: Omit<KnowledgeEndpointView, 'name' | 'scope' | 'status' | 'shared' | 'version'>,
): KnowledgeEndpointView => ({
  ...view,
  name: view.id,
  scope: 'platform',
  status: view.datasetCount ? 'ok' : 'unused',
  shared: true,
  version: 1,
});

export const exampleEndpoints: KnowledgeEndpointView[] = [
  endpoint({
    id: 'platform-pg',
    engine: 'pgvector',
    title: 'Innebygd søk',
    tech: 'Postgres med pgvector',
    builtin: true,
    runsAt: 'platform',
    dataLocation: 'norway',
    embeddingModel: norbert,
    writeKeyRequired: false,
    capabilities: capabilities(),
    datasetCount: 184,
  }),
  endpoint({
    id: 'typesense-digdir',
    engine: 'typesense',
    title: 'Typesense',
    tech: 'Typesense 28',
    builtin: false,
    runsAt: 'typesense.ki.digdir.example.no',
    dataLocation: 'norway',
    embeddingModel: norbert,
    writeKeyRequired: true,
    capabilities: capabilities('ordered_passages'),
    datasetCount: 23,
  }),
  endpoint({
    id: 'azure-sverige',
    engine: 'azure-ai-search',
    title: 'Azure AI Search',
    tech: 'Microsoft Azure',
    builtin: false,
    runsAt: 'eksempel.search.windows.net',
    dataLocation: 'eu',
    embeddingModel: embeddingModelLabel,
    writeKeyRequired: false,
    capabilities: capabilities('ordered_passages'),
    datasetCount: 2,
  }),
  endpoint({
    id: 'opensearch-sev',
    engine: 'opensearch',
    title: 'OpenSearch',
    tech: 'OpenSearch 2 uten vektortillegg',
    builtin: false,
    runsAt: 'sok.eksempelverk.no',
    dataLocation: 'norway',
    writeKeyRequired: false,
    capabilities: capabilities('vector_search', 'hybrid', 'facets'),
    datasetCount: 4,
  }),
];

const latency: Record<string, number> = {
  'platform-pg': 180,
  'typesense-digdir': 90,
  'azure-sverige': 210,
  'opensearch-sev': 120,
};

const testSets = ['Rapportassistenten · Spørsmål om rapporter'];

export const exampleComparisons: Record<'better' | 'worse', RetrievalComparison> = {
  better: {
    testSets,
    cases: 40,
    k: 5,
    hitAt5: [0.92, 0.94],
    meanRank: [1.6, 1.5],
    latencyMs: [180, 120],
    errors: [0, 0],
    verdict: 'better',
    examples: [
      {
        case: 'rapporter/1',
        question: 'Hva sier evalueringene om digital veiledning?',
        old: { first: 'Evaluering av digital veiledning (2023)', rank: 1 },
        new: { first: 'Evaluering av digital veiledning (2023)', rank: 1 },
        verdict: 'same',
      },
      {
        case: 'rapporter/2',
        question: 'Hvor lang var ventetiden på telefon i 2024?',
        old: { first: 'Årsrapport 2024, side 18', rank: 1 },
        new: { first: 'Årsrapport 2024, side 18', rank: 1 },
        verdict: 'same',
      },
      {
        case: 'rapporter/3',
        question: 'Saksnummer 2023/4471',
        old: { rank: null },
        new: { first: 'Tilsynsrapport 2023/4471', rank: 1 },
        verdict: 'better',
      },
    ],
  },
  worse: {
    testSets,
    cases: 40,
    k: 5,
    hitAt5: [0.92, 0.81],
    meanRank: [1.6, 2.4],
    latencyMs: [180, 210],
    errors: [0, 0],
    verdict: 'worse',
    examples: [
      {
        case: 'rapporter/1',
        question: 'Hva sier evalueringene om digital veiledning?',
        old: { first: 'Evaluering av digital veiledning (2023)', rank: 1 },
        new: { first: 'Evaluering av digital veiledning (2023)', rank: 1 },
        verdict: 'same',
      },
      {
        case: 'rapporter/3',
        question: 'Saksnummer 2023/4471',
        old: { first: 'Tilsynsrapport 2023/4471', rank: 1 },
        new: { rank: null },
        verdict: 'worse',
      },
      {
        case: 'rapporter/4',
        question: 'Hva er tildelingen til Prøvetilsynet i 2025?',
        old: { first: 'Tildelingsbrev 2025, Prøvetilsynet', rank: 1 },
        new: { first: 'Tildelingsbrev 2024, Prøvetilsynet', rank: 1 },
        verdict: 'worse',
      },
    ],
  },
};

interface DatasetState {
  endpoint: string;
  previous?: { endpoint: string; keptUntil: string; switch: string };
  switch?: EngineSwitchView;
  count: number;
}

const usedByOf = (dataset: string) =>
  dataset === 'digdir/kudos'
    ? [{ tenant: '991825827', id: 'rapportassistenten', name: 'Rapportassistenten' }]
    : [];

const retentionDays = 14;

const problem = (status: number, title: string, path = 'to') =>
  new Response(
    JSON.stringify({ type: 'about:blank', title, status, errors: [{ path, message: title }] }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );

export const searchEnginesMock = (options: SearchEnginesMockOptions = {}): MockHandler => {
  const endpoints = options.endpoints ?? exampleEndpoints;
  const defaultEmbedding =
    options.defaultEmbedding === undefined ? exampleDefaultEmbedding : options.defaultEmbedding;
  const step = options.progressStep ?? 10;
  const target = options.dataset ?? 'digdir/kudos';
  const states = new Map<string, DatasetState>();
  const failOnce = new Set<string>();

  const endpointOf = (id: string) =>
    endpoints.find((e) => e.id === id) ?? (endpoints[0] as KnowledgeEndpointView);

  const newSwitch = (
    dataset: string,
    s: DatasetState,
    to: string,
    method: SwitchMethod,
    patch: Partial<EngineSwitchView> = {},
  ): EngineSwitchView => {
    const n = ++s.count;
    const at = new Date().toISOString();
    return {
      id: `${dataset.split('/').pop() ?? dataset}:${n}`,
      sid: String(n),
      version: 1,
      dataset,
      from: s.endpoint,
      to,
      method,
      state: 'running',
      estimate: {
        costNok: method === 'copy' ? { min: 30, max: 50 } : { min: 1500, max: 2400 },
        durationMinutes: method === 'copy' ? { min: 20, max: 25 } : { min: 180, max: 240 },
      },
      progress: { percent: 0, documents: 0, total: 48312 },
      attempt: 1,
      startedAt: at,
      startedBy: 'employee:altinn:kari',
      updatedAt: at,
      minimumReasonLength: 10,
      canRollback: false,
      ...patch,
    };
  };

  const stateOf = (dataset: string): DatasetState => {
    const found = states.get(dataset);
    if (found) return found;
    const endpoint =
      dataset === '999888777/nettsider'
        ? 'typesense-digdir'
        : dataset === target && options.scenario === 'typesense'
          ? 'typesense-digdir'
          : dataset === target && options.scenario === 'no-facets'
            ? 'opensearch-sev'
            : 'platform-pg';
    const fresh: DatasetState = { endpoint, count: 0 };
    if (dataset === target) {
      if (options.scenario === 'switching')
        fresh.switch = newSwitch(dataset, fresh, 'opensearch-sev', 'copy', {
          progress: { percent: 40, documents: 19325, total: 48312 },
        });
      if (options.scenario === 'worse')
        fresh.switch = newSwitch(dataset, fresh, 'azure-sverige', 'reingest', {
          progress: { percent: 100, documents: 48312, total: 48312 },
          state: 'ready',
          comparison: exampleComparisons.worse,
          minimumReasonLength: 20,
        });
      if (options.scenario === 'failed')
        fresh.switch = newSwitch(dataset, fresh, 'opensearch-sev', 'copy', {
          progress: { percent: 60, documents: 28987, total: 48312 },
          state: 'failed',
          error: { message: 'OpenSearch svarte ikke etter tre forsøk', percent: 60 },
        });
    }
    if (fresh.switch && options.failAt !== undefined) failOnce.add(fresh.switch.sid);
    states.set(dataset, fresh);
    return fresh;
  };

  const view = (tenant: string, dataset: string): DatasetEngineView => {
    const s = stateOf(dataset);
    const e = endpointOf(s.endpoint);
    const embedding = e.embeddingModel ? { model: e.embeddingModel, dimensions: 1024 } : null;
    return {
      dataset,
      endpoint: e.id,
      engine: e.engine,
      title: e.title,
      ...(e.tech ? { tech: e.tech } : {}),
      builtin: e.builtin,
      runsAt: e.runsAt,
      ...(e.dataLocation ? { dataLocation: e.dataLocation } : {}),
      embedding,
      capabilities: e.capabilities,
      latencyMs: latency[e.id] ?? 150,
      usedBy: usedByOf(dataset),
      canSwitch: !/^\d{9}\//.test(dataset) || dataset.startsWith(`${tenant}/`),
      retentionDays,
      ...(s.switch ? { activeSwitch: s.switch } : {}),
      ...(s.previous
        ? { previous: { ...s.previous, title: endpointOf(s.previous.endpoint).title } }
        : {}),
    };
  };

  const advance = (sw: EngineSwitchView) => {
    if (sw.state === 'comparing') {
      sw.state = 'ready';
      if (options.scenario === 'no-test-set')
        sw.comparisonNote = 'Datasettet har ikke noe testsett med forventede kilder.';
      else {
        sw.comparison =
          sw.to === 'azure-sverige' ? exampleComparisons.worse : exampleComparisons.better;
        sw.minimumReasonLength = sw.comparison.verdict === 'worse' ? 20 : 10;
      }
      return;
    }
    if (sw.state !== 'running') return;
    const total = sw.progress.total ?? 0;
    const next = Math.min(100, sw.progress.percent + step);
    if (failOnce.has(sw.sid) && options.failAt !== undefined && next >= options.failAt) {
      failOnce.delete(sw.sid);
      sw.progress = { ...sw.progress, percent: options.failAt };
      sw.state = 'failed';
      sw.error = {
        message: `${endpointOf(sw.to).title} svarte ikke etter tre forsøk`,
        percent: options.failAt,
      };
      return;
    }
    sw.progress = { percent: next, documents: Math.round((total * next) / 100), total };
    if (next >= 100) sw.state = 'comparing';
  };

  const planProblem = (s: DatasetState, to: string) => {
    const toEndpoint = endpoints.find((e) => e.id === to);
    if (!toEndpoint) return problem(404, `ukjent søkemotor ${to}`);
    if (to === s.endpoint) return problem(409, 'Datasettet bruker allerede denne søkemotoren.');
    if (toEndpoint.writeKeyRequired) return problem(409, 'Krever egen skrivenøkkel');
    return undefined;
  };

  const copyProblem = (s: DatasetState, to: string) => {
    const from = endpointOf(s.endpoint).embeddingModel;
    const next = endpointOf(to).embeddingModel;
    return from && next && from !== next
      ? `Kopiering krever samme vektormodell. Nå brukes ${from}, den nye søkemotoren bruker ${next}. Les inn på nytt fra kilden.`
      : undefined;
  };

  return (request) => {
    const { path, method } = request;
    const endpointsMatch = /^\/tenants\/[^/]+\/knowledge\/endpoints$/.exec(path);
    if (endpointsMatch && method === 'GET')
      return request.json({ data: endpoints, defaultEmbedding });
    const match =
      /^\/tenants\/([^/]+)\/datasets\/([^/]+)\/(engine|engine-switches)(?:\/(.+))?$/.exec(path);
    if (!match) return undefined;
    const tenant = decodeURIComponent(match[1] as string);
    const dataset = decodeURIComponent(match[2] as string);
    const s = stateOf(dataset);
    const rest = match[4];
    if (match[3] === 'engine') return rest ? undefined : request.json(view(tenant, dataset));

    if (!rest && method === 'GET') return request.json({ data: s.switch ? [s.switch] : [] });

    if (rest === 'estimate' && method === 'GET') {
      const to = request.url.searchParams.get('to') ?? '';
      const refused = planProblem(s, to);
      if (refused) return refused;
      const copy = copyProblem(s, to);
      const estimate: SwitchEstimateView = {
        dataset,
        from: s.endpoint,
        to,
        estimate: true,
        basis: { documents: 48312, counted: true },
        copy: {
          available: !copy,
          ...(copy ? { reason: copy } : {}),
          costNok: { min: 30, max: 50 },
          durationMinutes: { min: 20, max: 25 },
        },
        reingest: {
          available: true,
          costNok: copy ? { min: 2000, max: 2400 } : { min: 1500, max: 1900 },
          durationMinutes: { min: 180, max: 240 },
        },
      };
      return request.json(estimate);
    }
    if (!rest && method === 'POST') {
      const body = request.body<{ to: string; method: SwitchMethod }>();
      const refused = planProblem(s, body.to);
      if (refused) return refused;
      if (body.method === 'copy') {
        const copy = copyProblem(s, body.to);
        if (copy) return problem(409, copy, 'method');
      }
      const sw = newSwitch(dataset, s, body.to, body.method);
      if (options.failAt !== undefined) failOnce.add(sw.sid);
      s.switch = sw;
      return request.json(sw, 202);
    }
    const [switchId, action] = (rest ?? '').split('/').map(decodeURIComponent);
    const sw = s.switch?.sid === switchId ? s.switch : undefined;
    if (!action && method === 'GET') {
      if (!sw) return request.notFound();
      advance(sw);
      return request.json(sw);
    }
    if (method !== 'POST') return undefined;
    const reasonOf = () => {
      return (request.reason ?? '').trim();
    };
    if (action === 'retry' && sw) {
      if (sw.state !== 'failed')
        return problem(409, 'Bare et bytte som har stoppet kan prøves på nytt.', 'state');
      sw.state = 'running';
      sw.attempt += 1;
      sw.progress = { percent: 0, documents: 0, total: sw.progress.total ?? 0 };
      delete sw.error;
      return request.json(sw, 202);
    }
    if (action === 'cancel' && sw) {
      sw.state = 'cancelled';
      delete s.switch;
      return request.json(sw);
    }
    if (action === 'activate' && sw) {
      if (sw.state !== 'ready')
        return problem(409, 'Byttet er ikke klart til å tas i bruk.', 'state');
      const reason = reasonOf();
      if (reason.length < sw.minimumReasonLength)
        return problem(400, 'Begrunnelsen er for kort', 'reason');
      const keptUntil = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
      s.previous = { endpoint: s.endpoint, keptUntil, switch: sw.id };
      s.endpoint = sw.to;
      delete s.switch;
      const done: EngineSwitchView = {
        ...sw,
        state: 'active',
        previousKeptUntil: keptUntil,
        canRollback: true,
        decision: {
          action: 'activate',
          by: 'employee:altinn:kari',
          at: new Date().toISOString(),
          reason,
        },
      };
      return request.json(done);
    }
    const previous = s.previous;
    if (action === 'rollback' && previous && previous.switch.endsWith(`:${switchId}`)) {
      const reason = reasonOf();
      if (reasonProblem(reason)) return problem(400, 'Begrunnelsen er for kort', 'reason');
      const from = s.endpoint;
      s.endpoint = previous.endpoint;
      delete s.previous;
      const at = new Date().toISOString();
      const back: EngineSwitchView = {
        ...newSwitch(dataset, s, from, 'copy'),
        id: previous.switch,
        sid: switchId ?? '',
        from: previous.endpoint,
        to: from,
        state: 'rolled_back',
        progress: { percent: 100, documents: 48312, total: 48312 },
        decision: { action: 'rollback', by: 'employee:altinn:kari', at, reason },
      };
      return request.json(back);
    }
    return request.notFound();
  };
};
