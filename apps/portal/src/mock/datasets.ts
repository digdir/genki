import type {
  DatasetDeleteResult,
  DatasetDetailView,
  DatasetDocumentDetail,
  DatasetSearchHit,
  DocumentListing,
  DocumentSortKey,
  ExecutionView,
  PipelineView,
  DatasetChange,
  NewDatasetSpec,
  NewEndpointDataset,
  SkippedDocument,
  UploadedFile,
  UploadResult,
} from '../api/datasets';
import { isOpen } from '../api/datasets';
import type { MockHandler } from '../mock';

export interface DatasetsMockOptions {
  datasets?: DatasetDetailView[];
  pipelines?: Record<string, PipelineView[]>;
  executions?: Record<string, ExecutionView[]>;
  uploads?: Record<string, UploadedFile[]>;
  pollsUntilDone?: number;
  report?: { stored: number; skipped: SkippedDocument[] };
  documents?: Record<string, DatasetDocumentDetail[]>;
  documentsFound?: Record<string, number | undefined>;
  listing?: Record<string, DocumentListing>;
}

const day = 86_400_000;
const maxUploadBytes = 50 * 1024 * 1024;
const uploadTypes = /\.(pdf|docx|txt|md|html?)$/i;

const tomorrow = () => new Date(Date.now() + day).toISOString();

export const exampleLiveDatasets: DatasetDetailView[] = [
  {
    id: 'digdir/kudos',
    fullId: 'digdir/kudos',
    name: 'Kudos-rapporter',
    aliases: ['eksempel:kudos-rapporter'],
    description: 'Rapporter fra statlige virksomheter i rapportarkivet Kudos.',
    scope: 'platform',
    editable: false,
    residency: 'norway',
    index: { endpoint: 'elastic-digdir' },
    facets: ['type', 'orgs_long'],
    source: 'kudos',
    documents: null,
    chunks: null,
    lastExecution: {
      status: 'succeeded',
      startedAt: '2026-10-07T01:00:00Z',
      endedAt: '2026-10-07T01:42:00Z',
      stored: 48312,
      skipped: 0,
    },
    nextRunAt: '2026-10-09T01:00:00Z',
  },
  {
    id: 'veiledere',
    fullId: '999888777/veiledere',
    name: 'Veiledere og rundskriv',
    aliases: ['eksempel:veiledere-og-rundskriv'],
    description: 'Veiledere og rundskriv lastet opp av fagavdelingen.',
    scope: '999888777',
    editable: true,
    residency: 'global',
    effectiveResidency: 'global',
    index: { endpoint: 'kunnskapsserveren' },
    facets: [],
    searchScope: 'tenant',
    source: 'upload',
    documents: 6,
    chunks: 48,
    usedBy: [],
    lastExecution: {
      status: 'succeeded',
      startedAt: '2026-10-07T09:12:00Z',
      endedAt: '2026-10-07T09:13:10Z',
      stored: 6,
      skipped: 2,
    },
    nextRunAt: null,
    skipped: [
      { document: 'Skannet vedtak 2019.pdf', reason: 'no_text' },
      { document: 'Presentasjon.pages', reason: 'unsupported_type' },
    ],
  },
  {
    id: 'nettsider',
    fullId: '999888777/nettsider',
    name: 'Nettsidene til Testetaten',
    description: 'Alle offentlige sider på testetaten.example.no.',
    scope: '999888777',
    editable: true,
    residency: 'global',
    effectiveResidency: 'global',
    index: { endpoint: 'kunnskapsserveren' },
    facets: [],
    searchScope: 'tenant',
    source: 'website',
    documents: 1240,
    chunks: 9810,
    usedBy: [
      {
        kind: 'service',
        tenant: '999888777',
        id: 'rapportassistenten',
        name: 'Rapportassistenten',
        addedAt: '2026-10-01T09:30:00Z',
        addedBy: 'kari.nordmann@testetaten.example.no',
        addedByName: 'Kari Nordmann',
      },
    ],
    lastExecution: {
      status: 'failed',
      startedAt: '2026-10-08T02:00:00Z',
      endedAt: '2026-10-08T02:03:00Z',
      stored: 0,
      skipped: 0,
    },
    nextRunAt: '2026-10-09T02:00:00Z',
  },
];

const ownerNames: Record<string, string> = {
  '999888777': 'Testetaten',
  digdir: 'Digitaliseringsdirektoratet',
};

const ownerFacts = (viewer: string, d: DatasetDetailView) => {
  const tenant = d.scope === 'platform' ? 'digdir' : (d.scope ?? viewer);
  const succeeded = d.lastExecution?.status === 'succeeded' ? d.lastExecution.endedAt : null;
  return {
    owner: { tenant, name: ownerNames[tenant] ?? null },
    updatedAt: d.scope === viewer ? succeeded : null,
  };
};

const examplePipelines: Record<string, PipelineView[]> = {
  '999888777/veiledere': [
    {
      id: 'upload',
      version: 1,
      spec: { name: 'Veiledere og rundskriv', source: { kind: 'upload' }, schedule: 'none' },
    },
  ],
  '999888777/nettsider': [
    {
      id: 'website',
      version: 2,
      spec: {
        name: 'Nettsidene til Testetaten',
        source: {
          kind: 'website',
          sitemap: 'https://testetaten.example.no/sitemap.xml',
          include: [],
          exclude: ['/sok', '/sok/**'],
        },
        schedule: 'daily',
      },
    },
  ],
};

const exampleExecutions: Record<string, ExecutionView[]> = {
  '999888777/veiledere/upload': [
    {
      id: 'ex-veiledere-1',
      status: 'succeeded',
      startedBy: 'kari.nordmann@testetaten.example.no',
      startedByName: 'Kari Nordmann',
      startedAt: '2026-10-07T09:12:00Z',
      endedAt: '2026-10-07T09:13:10Z',
      report: {
        stored: 6,
        skipped: 2,
        skippedDocuments: [
          { document: 'Skannet vedtak 2019.pdf', reason: 'no_text' },
          { document: 'Presentasjon.pages', reason: 'unsupported_type' },
        ],
        failed: [],
      },
    },
  ],
  '999888777/nettsider/website': [
    {
      id: 'ex-nettsider-2',
      status: 'failed',
      startedBy: 'kari.nordmann@testetaten.example.no',
      startedByName: 'Kari Nordmann',
      startedAt: '2026-10-08T02:00:00Z',
      endedAt: '2026-10-08T02:03:00Z',
      error: 'sitemap returned 503',
    },
    {
      id: 'ex-nettsider-1',
      status: 'succeeded',
      startedAt: '2026-10-07T02:00:00Z',
      endedAt: '2026-10-07T02:14:00Z',
      report: { stored: 1240, skipped: 0, failed: [] },
    },
  ],
};

const exampleUploads: Record<string, UploadedFile[]> = {
  '999888777/veiledere': [
    { name: 'Veileder for søkere.docx', size: 348_160, type: 'docx' },
    { name: 'Rundskriv 3-2026.pdf', size: 634_880, type: 'pdf' },
  ],
};

const doc = (
  id: string,
  title: string,
  fields: Record<string, unknown>,
  extra: Partial<DatasetDocumentDetail> = {},
): DatasetDocumentDetail => ({ id, title, fields, status: 'indexed', ...extra });

const chunksOf = (...texts: string[]) =>
  texts.map((text, position) => ({ id: `c${position}`, position, page: position + 1, text }));

export const exampleDocuments: Record<string, DatasetDocumentDetail[]> = {
  '999888777/veiledere': [
    doc(
      'rundskriv-3-2026',
      'Rundskriv 3-2026',
      { type: 'Rundskriv', year: '2026', unit: 'Fagavdelingen' },
      {
        original: { name: 'Rundskriv 3-2026.pdf', size: 634_880, type: 'pdf' },
        excerpt:
          'Rundskrivet gjelder fra 1. mars 2026 og erstatter rundskriv 7-2024. Endringene gjelder fristene for klage.',
        chunks: chunksOf(
          'Rundskrivet gjelder fra 1. mars 2026 og erstatter rundskriv 7-2024.',
          'Endringene gjelder fristene for klage.',
        ),
        chunkCount: 2,
      },
    ),
    doc(
      'veileder-for-sokere',
      'Veileder for søkere',
      { type: 'Veileder', year: '2025', unit: 'Fagavdelingen' },
      {
        original: { name: 'Veileder for søkere.docx', size: 348_160, type: 'docx' },
        excerpt:
          'Veilederen forklarer hvordan du søker, hva du må legge ved og hvor lang tid det tar.',
      },
    ),
    doc(
      'veileder-tilsyn',
      'Veileder for tilsyn',
      { type: 'Veileder', year: '2024', unit: 'Tilsynsavdelingen' },
      {
        original: { name: 'Veileder for tilsyn.pdf', size: 512_000, type: 'pdf' },
        excerpt: 'Tilsynet varsles minst tre uker før det gjennomføres.',
      },
    ),
  ],
  '999888777/nettsider': [
    doc(
      'side-om-oss',
      'Om Testetaten',
      { type: 'Nettside', year: '2026' },
      { url: 'https://testetaten.example.no/om-oss' },
    ),
    doc(
      'side-kontakt',
      'Kontakt oss',
      { type: 'Nettside', year: '2026' },
      { url: 'https://testetaten.example.no/kontakt' },
    ),
  ],
  'digdir/kudos': [
    doc('kudos-1', 'Årsrapport 2025 Testetaten', { type: 'Årsrapport', orgs_long: 'Testetaten' }),
    doc('kudos-2', 'Tildelingsbrev 2026 Testetaten', {
      type: 'Tildelingsbrev',
      orgs_long: 'Testetaten',
    }),
  ],
};

const exampleFound: Record<string, number | undefined> = { 'digdir/kudos': 48312 };

const exampleListing: Record<string, DocumentListing> = {
  'digdir/kudos': { query: true, sort: ['title', 'year'] },
};

const noListing: DocumentListing = { query: false, sort: [] };

const sortValue = (d: DatasetDocumentDetail, key: DocumentSortKey) =>
  key === 'title' ? (d.title ?? d.id) : String(d.fields[key] ?? '');

const slugOk = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const datasetsMock = (options: DatasetsMockOptions = {}): MockHandler => {
  const datasets = structuredClone(options.datasets ?? exampleLiveDatasets);
  const pipelines = new Map(Object.entries(structuredClone(options.pipelines ?? examplePipelines)));
  const executions = new Map(
    Object.entries(structuredClone(options.executions ?? exampleExecutions)),
  );
  const uploads = new Map(Object.entries(structuredClone(options.uploads ?? exampleUploads)));
  const polls = new Map<string, number>();
  const keyed = new Set<string>();
  const until = options.pollsUntilDone ?? 1;
  const documents = structuredClone(options.documents ?? exampleDocuments);
  const found = options.documentsFound ?? exampleFound;
  const listings = options.listing ?? exampleListing;

  const find = (tenant: string, id: string) =>
    datasets.find((d) => d.fullId === id || d.fullId === `${tenant}/${id}`);
  const visible = (tenant: string) =>
    datasets.filter((d) => d.scope === 'platform' || d.scope === tenant || d.searchScope === 'all');
  const foreign = (tenant: string, d: DatasetDetailView) =>
    d.scope !== 'platform' && d.scope !== tenant;
  const seenBy = (tenant: string, d: DatasetDetailView): DatasetDetailView =>
    foreign(tenant, d)
      ? {
          ...d,
          id: d.fullId,
          editable: false,
          source: 'none',
          lastExecution: null,
          nextRunAt: null,
          skipped: [],
          usedBy: [],
        }
      : d;
  const nextRun = (schedule: string) =>
    schedule === 'daily' ? tomorrow() : schedule === 'weekly' ? tomorrow() : null;

  const finish = (dataset: DatasetDetailView, pipelineId: string, running: ExecutionView) => {
    const files = uploads.get(dataset.fullId) ?? [];
    const report =
      options.report ??
      (dataset.source === 'upload'
        ? {
            stored: files.filter((f) => !/skann/i.test(f.name)).length,
            skipped: files
              .filter((f) => /skann/i.test(f.name))
              .map((f) => ({ document: f.name, reason: 'no_text' })),
          }
        : { stored: 6, skipped: [{ document: 'Skannet vedtak 2019.pdf', reason: 'no_text' }] });
    const done: ExecutionView = {
      ...running,
      status: 'succeeded',
      endedAt: new Date().toISOString(),
      report: {
        stored: report.stored,
        skipped: report.skipped.length,
        skippedDocuments: report.skipped,
        failed: [],
      },
    };
    dataset.documents = report.stored;
    dataset.chunks = report.stored * 8;
    dataset.skipped = report.skipped;
    dataset.lastExecution = {
      status: 'succeeded',
      startedAt: done.startedAt,
      endedAt: done.endedAt ?? null,
      stored: report.stored,
      skipped: report.skipped.length,
    };
    const key = `${dataset.fullId}/${pipelineId}`;
    executions.set(
      key,
      (executions.get(key) ?? []).map((e) => (e.id === running.id ? done : e)),
    );
  };

  return (request) => {
    const { path, method, json, notFound } = request;
    const writes = method !== 'GET';
    if (writes && !request.reason) {
      if (
        /^\/tenants\/[^/]+\/(catalog\/dataset\/[^/]+|datasets|datasets\/[^/]+(\/pipelines|\/uploads)(\/.*)?|datasets\/[^/]+)$/.test(
          path,
        )
      )
        return request.reasonMissing();
    }

    const create = /^\/tenants\/([^/]+)\/catalog\/dataset\/([^/]+)$/.exec(path);
    if (create && method === 'PUT') {
      const tenant = decodeURIComponent(create[1] ?? '');
      const id = decodeURIComponent(create[2] ?? '');
      const spec = request.body<NewDatasetSpec>();
      const fresh: DatasetDetailView = {
        id,
        fullId: `${tenant}/${id}`,
        name: spec.name,
        ...(spec.description ? { description: spec.description } : {}),
        scope: tenant,
        editable: true,
        ...(spec.residency
          ? { residency: spec.residency, effectiveResidency: spec.residency }
          : {}),
        index: { endpoint: spec.endpoint },
        facets: [],
        searchScope: spec.searchScope ?? 'tenant',
        source: 'none',
        documents: 0,
        chunks: 0,
        lastExecution: null,
        nextRunAt: null,
      };
      const at = datasets.findIndex((d) => d.fullId === fresh.fullId);
      if (at >= 0) datasets[at] = { ...datasets[at], ...fresh };
      else datasets.push(fresh);
      return json({ kind: 'dataset', id: fresh.fullId, version: 1, spec });
    }

    const list = /^\/tenants\/([^/]+)\/datasets$/.exec(path);
    if (list && method === 'POST') {
      const tenant = decodeURIComponent(list[1] ?? '');
      const input = request.body<NewEndpointDataset>();
      const source = input.endpointSource;
      const invalid = (path: string, message: string) =>
        json({ title: 'Invalid request', status: 400, errors: [{ path, message }] }, 400);
      if (!/^https:\/\//.test(source?.url ?? ''))
        return invalid('endpointSource.url', 'Invalid URL');
      if (
        source.auth.kind === 'api-key' &&
        source.auth.header !== undefined &&
        !/^[A-Za-z0-9-]{1,64}$/.test(source.auth.header)
      )
        return invalid('endpointSource.auth.header', 'Invalid string');
      const url = new URL(source.url);
      if (
        url.username ||
        url.password ||
        /^[\d.]+$|^\[|(^|\.)(localhost|local|internal)$/i.test(url.hostname) ||
        !url.hostname.includes('.')
      )
        return json(
          {
            type: 'urn:genai:problem:endpoint-not-allowed',
            title: 'genki does not call this address',
            status: 422,
            errors: [{ path: 'endpointSource.url', message: 'not a public host name' }],
          },
          422,
        );
      const id = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (find(tenant, id))
        return json(
          {
            title: 'Conflict',
            status: 409,
            errors: [{ path: 'id', message: `dataset ${id} exists` }],
          },
          409,
        );
      const fresh: DatasetDetailView = {
        id,
        fullId: `${tenant}/${id}`,
        name: input.name,
        scope: tenant,
        editable: true,
        residency: input.residency,
        index: { endpoint: `endpoint-${id}` },
        facets: [],
        searchScope: input.searchScope ?? 'tenant',
        source: 'endpoint',
        state: 'external',
        documents: null,
        chunks: null,
        lastExecution: null,
        nextRunAt: null,
        usedBy: [],
      };
      datasets.push(fresh);
      if (source.auth.kind === 'api-key') keyed.add(fresh.fullId);
      return json(fresh, 201);
    }
    if (list && method === 'GET')
      return json({
        data: visible(decodeURIComponent(list[1] ?? ''))
          .map((d) => seenBy(decodeURIComponent(list[1] ?? ''), d))
          .map(({ skipped: _, usedBy, ...d }) => ({
            ...d,
            documents: d.documents ?? (d.state === 'external' ? null : (found[d.fullId] ?? null)),
            ...ownerFacts(decodeURIComponent(list[1] ?? ''), d),
            usedByCount: usedBy?.length ?? 0,
          })),
      });

    const content =
      /^\/tenants\/([^/]+)\/datasets\/([^/]+)\/(documents|search)(?:\/([^/]+))?$/.exec(path);
    if (content) {
      const tenant = decodeURIComponent(content[1] ?? '');
      const dataset = find(tenant, decodeURIComponent(content[2] ?? ''));
      if (!dataset) return notFound();
      const own = dataset.scope === tenant;
      const all = (documents[dataset.fullId] ?? []).map(
        ({ original, ...d }): DatasetDocumentDetail => (own && original ? { ...d, original } : d),
      );
      const matches = (d: DatasetDocumentDetail, filters: [string, unknown][]) =>
        filters.every(([field, wanted]) =>
          [wanted].flat().some((w) => [d.fields[field]].flat().map(String).includes(String(w))),
        );
      if (content[3] === 'search' && method === 'POST') {
        const body = request.body<{ query: string; filters?: Record<string, unknown> }>();
        const words = body.query.toLowerCase().split(/\s+/).filter(Boolean);
        const filters = Object.entries(body.filters ?? {});
        const hits: DatasetSearchHit[] = all
          .filter((d) =>
            words.every((w) =>
              `${d.title ?? ''} ${Object.values(d.fields).join(' ')} ${d.original?.name ?? ''}`
                .toLowerCase()
                .includes(w),
            ),
          )
          .filter((d) => matches(d, filters))
          .map((d, i) => ({
            id: `${d.id}#0`,
            document: d.id,
            ...(d.title ? { title: d.title } : {}),
            ...(d.url ? { url: d.url } : {}),
            score: 1 - i / 100,
            text: d.excerpt ?? '',
            fields: d.fields,
          }));
        return json({ dataset: dataset.fullId, limit: 100, found: hits.length, hits });
      }
      if (content[3] !== 'documents' || method !== 'GET') return undefined;
      const item = content[4] ? decodeURIComponent(content[4]) : undefined;
      const invalid = (errors: { path: string; message: string }[]) =>
        json({ title: 'Invalid request', status: 422, errors }, 422);
      const shown = ({ excerpt: _, chunks, ...rest }: DatasetDocumentDetail) => ({
        ...rest,
        ...(rest.chunkCount === undefined && chunks ? { chunkCount: chunks.length } : {}),
      });
      if (item) {
        const one = all.find((d) => d.id === item);
        if (!one)
          return json(
            {
              type: 'urn:genai:problem:dataset-document-not-found',
              title: 'The dataset has no such document',
              status: 404,
            },
            404,
          );
        const range = request.url.searchParams.get('chunks');
        if (range === null)
          return json({ ...shown(one), ...(one.excerpt ? { excerpt: one.excerpt } : {}) });
        const [from, to] = /^(\d+)-(\d+)$/.exec(range)?.slice(1).map(Number) ?? [];
        if (from === undefined || to === undefined || to < from || to - from >= 50)
          return invalid([{ path: 'chunks', message: 'chunks must be from-to, at most 50' }]);
        return json({
          ...shown(one),
          ...(one.excerpt ? { excerpt: one.excerpt } : {}),
          chunks: (one.chunks ?? []).slice(from, to + 1),
        });
      }
      const params = request.url.searchParams;
      const limit = Number(params.get('limit') ?? 50);
      const offset = Number(params.get('offset') ?? 0);
      const query = params.get('query') ?? '';
      const sort = params.get('sort') as DocumentSortKey | null;
      const order = params.get('order') === 'desc' ? 'desc' : 'asc';
      const status = params.get('status') ?? 'indexed';
      const listing = listings[dataset.fullId] ?? noListing;
      if (offset % limit !== 0)
        return invalid([{ path: 'offset', message: 'offset must be a multiple of limit' }]);
      const raw = params.get('filters');
      if ((status === 'failed' || status === 'pending') && (raw || sort))
        return invalid([
          { path: raw ? 'filters' : 'sort', message: 'only query, limit and offset' },
        ]);
      if (query && (status === 'indexed' || status === 'all') && !listing.query)
        return invalid([{ path: 'query', message: 'The engine cannot search titles' }]);
      if (sort && !listing.sort.includes(sort))
        return invalid([{ path: 'sort', message: `The engine cannot sort by ${sort}` }]);
      let filters: Record<string, unknown> | undefined;
      if (raw) {
        const parsed: unknown = (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return invalid([{ path: 'filters', message: 'filters must be a JSON object' }]);
        filters = parsed as Record<string, unknown>;
        const undeclared = Object.keys(filters).filter((f) => !(dataset.facets ?? []).includes(f));
        if (undeclared.length)
          return invalid(
            undeclared.map((field) => ({
              path: `filters.${field}`,
              message: `The dataset ${dataset.fullId} has no filter ${field}`,
            })),
          );
      }
      const failed: DatasetDocumentDetail[] = own
        ? (dataset.skipped ?? []).map((s) => ({
            id: s.document,
            title: s.document,
            fields: {},
            status: 'failed',
            reason: s.reason,
          }))
        : [];
      const needle = query.toLowerCase();
      const titled = (d: DatasetDocumentDetail) =>
        !needle || `${d.title ?? ''} ${d.id}`.toLowerCase().includes(needle);
      const indexedCount = found[dataset.fullId] ?? all.length;
      const statusCounts = { indexed: indexedCount, failed: failed.length, pending: 0 };
      const pool = status === 'failed' ? failed : status === 'pending' ? [] : all;
      const indexedKept = pool
        .filter(titled)
        .filter((d) => !filters || matches(d, Object.entries(filters)));
      if (sort) {
        indexedKept.sort((a, b) => sortValue(a, sort).localeCompare(sortValue(b, sort), 'nb'));
        if (order === 'desc') indexedKept.reverse();
      }
      const head = status === 'all' && !filters ? failed.filter(titled) : [];
      const kept = [...head, ...indexedKept];
      const total =
        (status === 'indexed' || status === 'all') && !filters && !query && dataset.fullId in found
          ? head.length + (found[dataset.fullId] ?? indexedKept.length)
          : kept.length;
      return json({
        dataset: dataset.fullId,
        limit,
        offset,
        found: total,
        total,
        totalExact: true,
        status,
        statusCounts,
        listing,
        ...(query ? { query } : {}),
        ...(sort ? { sort: { key: sort, order } } : {}),
        ...(filters ? { filters } : {}),
        documents: kept.slice(offset, offset + limit).map(shown),
      });
    }

    const one =
      /^\/tenants\/([^/]+)\/datasets\/([^/]+)(?:\/(pipelines|uploads)(?:\/([^/]+))?(?:\/(execute|executions)(?:\/([^/]+)\/cancel)?)?)?$/.exec(
        path,
      );
    if (!one) return undefined;
    const tenant = decodeURIComponent(one[1] ?? '');
    const dataset = find(tenant, decodeURIComponent(one[2] ?? ''));
    const area = one[3];
    const item = one[4] ? decodeURIComponent(one[4]) : undefined;
    const action = one[5];
    const cancelling = one[6] ? decodeURIComponent(one[6]) : undefined;
    if (!dataset || !visible(tenant).includes(dataset)) return notFound();
    if (foreign(tenant, dataset) && (area || method !== 'GET')) return notFound();

    if (!area) {
      if (method === 'GET')
        return json({ ...seenBy(tenant, dataset), ...ownerFacts(tenant, dataset) });
      if (method === 'PUT') {
        const change = request.body<DatasetChange>();
        const empty = (['name', 'description'] as const).filter((k) => change[k] === '');
        if (empty.length)
          return json(
            {
              title: 'Invalid request',
              status: 400,
              errors: empty.map((path) => ({
                path,
                message: 'Too small: expected string to have >=1 characters',
              })),
            },
            400,
          );
        if (change.name) dataset.name = change.name;
        if (change.description !== undefined) dataset.description = change.description;
        if (change.searchScope) dataset.searchScope = change.searchScope;
        return json(dataset);
      }
      if (method === 'DELETE') {
        if (dataset.usedBy?.length)
          return json(
            {
              title: 'Conflict',
              status: 409,
              errors: dataset.usedBy.map((r) => ({
                path: 'usedBy',
                message: `${r.kind} ${r.tenant}/${r.id}`,
              })),
            },
            409,
          );
        datasets.splice(datasets.indexOf(dataset), 1);
        const own = pipelines.get(dataset.fullId) ?? [];
        const result: DatasetDeleteResult = {
          deleted: dataset.fullId,
          removed: {
            catalogEntry: true,
            pipelines: own.map((p) => p.id),
            uploads: (uploads.get(dataset.fullId) ?? []).map((f) => f.name),
            generations: own.flatMap((p) =>
              (executions.get(`${dataset.fullId}/${p.id}`) ?? []).map((e) => e.id),
            ),
            ...(dataset.source === 'endpoint'
              ? {
                  endpoint: `endpoint-${dataset.id}`,
                  ...(keyed.has(dataset.fullId) ? { secret: `endpoint-${dataset.id}-key` } : {}),
                }
              : {}),
          },
          kept: { knowledgeRecords: dataset.index?.endpoint === 'knowledge-pg', generations: [] },
        };
        pipelines.delete(dataset.fullId);
        uploads.delete(dataset.fullId);
        for (const p of own) executions.delete(`${dataset.fullId}/${p.id}`);
        return json(result);
      }
      return undefined;
    }

    if (area === 'uploads') {
      const files = uploads.get(dataset.fullId) ?? [];
      if (!item && method === 'GET') return json({ data: files });
      if (item && method === 'GET') {
        const file = files.find((f) => f.name === item);
        if (!file)
          return json(
            {
              type: 'urn:genai:problem:original-not-kept',
              title: 'The original file is not kept',
              status: 404,
            },
            404,
          );
        return new Response(new Blob([`original ${file.name}`]), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
          },
        });
      }
      if (!item && method === 'POST') {
        const body = request.init?.body;
        const sent = body instanceof FormData ? (body.getAll('files') as File[]) : [];
        const result: UploadResult = { uploaded: [], skipped: [] };
        for (const file of sent) {
          if (!uploadTypes.test(file.name))
            result.skipped.push({ name: file.name, reason: 'unsupported_type' });
          else if (file.size > maxUploadBytes)
            result.skipped.push({ name: file.name, reason: 'too_large' });
          else
            result.uploaded.push({
              name: file.name,
              size: file.size,
              type: file.name.split('.').pop() ?? '',
            });
        }
        uploads.set(dataset.fullId, [
          ...files.filter((f) => !result.uploaded.some((u) => u.name === f.name)),
          ...result.uploaded,
        ]);
        return json(result, 201);
      }
      if (item && method === 'DELETE') {
        if (!files.some((f) => f.name === item)) return notFound();
        uploads.set(
          dataset.fullId,
          files.filter((f) => f.name !== item),
        );
        return json({ deleted: item });
      }
      return undefined;
    }

    const own = pipelines.get(dataset.fullId) ?? [];
    if (!item) {
      if (method === 'GET') return json({ data: own });
      if (method === 'POST') {
        const input = request.body<PipelineView['spec'] & { id?: string }>();
        const { id, ...spec } = input;
        if (!id || !slugOk.test(id))
          return json(
            {
              title: 'Invalid request',
              status: 400,
              errors: [{ path: 'id', message: 'id is required' }],
            },
            400,
          );
        if (own.some((p) => p.id === id))
          return json(
            {
              title: 'Conflict',
              status: 409,
              errors: [{ path: 'id', message: `pipeline ${id} exists` }],
            },
            409,
          );
        if (spec.source.kind === 'kudos' && !spec.source.types.length && !spec.source.since)
          return json(
            {
              title: 'Invalid pipeline',
              status: 422,
              errors: [
                {
                  path: 'source',
                  message: 'Velg minst én dokumenttype eller et år å lese fra.',
                },
              ],
            },
            422,
          );
        const created: PipelineView = { id, version: 1, spec };
        pipelines.set(dataset.fullId, [...own, created]);
        dataset.source = spec.source.kind;
        dataset.nextRunAt = nextRun(spec.schedule);
        return json(created);
      }
      return undefined;
    }

    const pipeline = own.find((p) => p.id === item);
    if (!pipeline) return notFound();
    const key = `${dataset.fullId}/${pipeline.id}`;
    if (!action) {
      if (method === 'GET') return json(pipeline);
      if (method === 'PUT') {
        const spec = request.body<PipelineView['spec']>();
        const saved: PipelineView = { ...pipeline, version: pipeline.version + 1, spec };
        pipelines.set(
          dataset.fullId,
          own.map((p) => (p.id === pipeline.id ? saved : p)),
        );
        dataset.source = spec.source.kind;
        dataset.nextRunAt = nextRun(spec.schedule);
        return json(saved);
      }
      return undefined;
    }
    if (action === 'executions' && cancelling && method === 'POST') {
      const key = `${dataset.fullId}/${pipeline.id}`;
      const found = (executions.get(key) ?? []).find((e) => e.id === cancelling);
      if (!found || !isOpen(found))
        return json({ title: 'Conflict', status: 409, errors: [] }, 409);
      const cancelled: ExecutionView = {
        ...found,
        status: 'cancelled',
        endedAt: new Date().toISOString(),
      };
      executions.set(
        key,
        (executions.get(key) ?? []).map((e) => (e.id === cancelled.id ? cancelled : e)),
      );
      polls.delete(cancelled.id);
      dataset.lastExecution = {
        status: 'cancelled',
        startedAt: cancelled.startedAt,
        endedAt: cancelled.endedAt ?? null,
        stored: 0,
        skipped: 0,
      };
      return json(cancelled);
    }
    if (action === 'execute' && method === 'POST') {
      const running: ExecutionView = {
        id: `ex-${Date.now()}-${Math.round(Math.random() * 1000)}`,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      executions.set(key, [running, ...(executions.get(key) ?? [])]);
      polls.set(running.id, until);
      dataset.lastExecution = {
        status: 'running',
        startedAt: running.startedAt,
        endedAt: null,
        stored: 0,
        skipped: 0,
      };
      return json(running, 202);
    }
    if (action === 'executions' && method === 'GET') {
      for (const running of (executions.get(key) ?? []).filter((e) => e.status === 'running')) {
        const left = (polls.get(running.id) ?? 0) - 1;
        polls.set(running.id, left);
        if (left <= 0) finish(dataset, pipeline.id, running);
      }
      return json({ data: executions.get(key) ?? [], nextRunAt: dataset.nextRunAt });
    }
    return undefined;
  };
};
