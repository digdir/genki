import type {
  DatasetDetailView,
  ExecutionView,
  PipelineView,
  SkippedDocument,
  UploadedFile,
  UploadResult,
} from '../api/datasets';
import type { MockHandler } from '../mock';

export interface DatasetsMockOptions {
  datasets?: DatasetDetailView[];
  pipelines?: Record<string, PipelineView[]>;
  executions?: Record<string, ExecutionView[]>;
  uploads?: Record<string, UploadedFile[]>;
  pollsUntilDone?: number;
  report?: { stored: number; skipped: SkippedDocument[] };
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
    description: 'Rapporter fra statlige virksomheter i rapportarkivet Kudos.',
    scope: 'platform',
    editable: false,
    residency: 'norway',
    index: { endpoint: 'typesense-digdir' },
    facets: ['type', 'orgs_long'],
    source: 'kudos',
    documents: 48312,
    chunks: 612400,
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
    description: 'Veiledere og rundskriv lastet opp av fagavdelingen.',
    scope: '999888777',
    editable: true,
    residency: 'global',
    effectiveResidency: 'global',
    index: { endpoint: 'platform-pg' },
    facets: [],
    source: 'upload',
    documents: 6,
    chunks: 48,
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
    index: { endpoint: 'platform-pg' },
    facets: [],
    source: 'website',
    documents: 1240,
    chunks: 9810,
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

const slugOk = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const datasetsMock = (options: DatasetsMockOptions = {}): MockHandler => {
  const datasets = structuredClone(options.datasets ?? exampleLiveDatasets);
  const pipelines = new Map(Object.entries(structuredClone(options.pipelines ?? examplePipelines)));
  const executions = new Map(
    Object.entries(structuredClone(options.executions ?? exampleExecutions)),
  );
  const uploads = new Map(Object.entries(structuredClone(options.uploads ?? exampleUploads)));
  const polls = new Map<string, number>();
  const until = options.pollsUntilDone ?? 1;

  const find = (tenant: string, id: string) =>
    datasets.find((d) => d.fullId === id || d.fullId === `${tenant}/${id}`);
  const visible = (tenant: string) =>
    datasets.filter((d) => d.scope === 'platform' || d.fullId.startsWith(`${tenant}/`));
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
        /^\/tenants\/[^/]+\/(catalog\/dataset\/[^/]+|datasets\/[^/]+(\/pipelines|\/uploads)(\/.*)?|datasets\/[^/]+)$/.test(
          path,
        )
      )
        return request.reasonMissing();
    }

    const create = /^\/tenants\/([^/]+)\/catalog\/dataset\/([^/]+)$/.exec(path);
    if (create && method === 'PUT') {
      const tenant = decodeURIComponent(create[1] ?? '');
      const id = decodeURIComponent(create[2] ?? '');
      const spec = request.body<{
        name: string;
        description?: string;
        endpoint: string;
        residency: DatasetDetailView['residency'];
      }>();
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
    if (list && method === 'GET')
      return json({
        data: visible(decodeURIComponent(list[1] ?? '')).map(({ skipped: _, ...d }) => d),
      });

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
    if (!dataset) return notFound();

    if (!area) {
      if (method === 'GET') return json(dataset);
      if (method === 'PUT') {
        const change = request.body<{ name?: string; description?: string }>();
        if (change.name) dataset.name = change.name;
        if (change.description !== undefined) dataset.description = change.description;
        return json(dataset);
      }
      return undefined;
    }

    if (area === 'uploads') {
      const files = uploads.get(dataset.fullId) ?? [];
      if (!item && method === 'GET') return json({ data: files });
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
      if (!found || found.status !== 'running')
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
