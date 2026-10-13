import { ApiError } from './api';
import type {
  Project,
  ProjectDetail,
  ProjectLogEntry,
  ProjectPoint,
  ProjectRun,
  ProjectsApi,
  ProjectSource,
  Subscription,
} from './projects-api';

const per = 'employee:test:per';
const kari = 'employee:test:kari';

export const exampleProjectSources: ProjectSource[] = [
  {
    id: 'digdir/kudos',
    name: 'Kudos-rapporter',
    filters: [
      {
        field: 'type',
        values: [
          { value: 'Årsrapport', count: 120 },
          { value: 'Tildelingsbrev', count: 118 },
        ],
      },
      {
        field: 'concerned_years',
        values: [
          { value: '2025', count: 80 },
          { value: '2024', count: 158 },
        ],
      },
    ],
  },
];

export const exampleProject = (): ProjectDetail => ({
  id: 'maloppnaelse-2025',
  name: 'Måloppnåelse i etatene under Testdepartementet 2025',
  purpose:
    'Hvordan har de 12 underliggende etatene nådd målene i tildelingsbrevene for 2025, og hvor rapporterer de svakt?',
  selections: [
    {
      id: 'arsrapporter-2025',
      name: 'Årsrapporter 2025 fra underliggende etater',
      dataset: 'digdir/kudos',
      filters: { type: ['Årsrapport'], concerned_years: ['2025'] },
    },
  ],
  services: ['maloppnaelse'],
  version: 1,
  by: per,
  at: '2026-09-30T08:00:00.000Z',
  reason: 'Opprettet prosjektet',
  changedBy: 'Per Hansen',
  subscriptions: [
    {
      project: 'maloppnaelse-2025',
      selection: 'arsrapporter-2025',
      mode: 'notify',
      cap: {},
      status: 'active',
      fresh: [
        ['m', 'Årsrapport 2025, Mønstertilsynet', '2026-10-07T03:12:00.000Z'],
        ['p', 'Årsrapport 2025, Prøvedirektoratet', '2026-10-06T03:12:00.000Z'],
        ['s', 'Årsrapport 2025, Skogverket', '2026-10-05T03:12:00.000Z'],
      ].map(([id, title, arrivedAt]) => ({
        document: { id: `ar-${id}`, title: title ?? '' },
        arrivedAt: arrivedAt ?? '',
      })),
      waiting: 0,
      checkedAt: '2026-10-08T05:12:00.000Z',
      spentThisMonth: { costMicroNok: 0, tokens: 0 },
    },
  ],
});

export const exampleProjectRuns = (): ProjectRun[] => [
  {
    id: 'run-auto',
    service: 'maloppnaelse',
    version: 4,
    status: 'succeeded',
    total: 3,
    startedAt: '2026-10-08T03:12:00.000Z',
    endedAt: '2026-10-08T03:14:00.000Z',
    costMicroNok: 9_600_000,
    counts: { succeeded: 3 },
    trigger: 'subscription',
    selection: 'arsrapporter-2025',
    newSince: 0,
    approval: { status: 'pending' },
  },
  {
    id: 'run-alle',
    service: 'maloppnaelse',
    version: 4,
    status: 'succeeded',
    total: 23,
    startedAt: '2026-10-02T09:00:00.000Z',
    endedAt: '2026-10-02T09:20:00.000Z',
    costMicroNok: 38_000_000,
    counts: { succeeded: 23 },
    trigger: 'manual',
    selection: 'arsrapporter-2025',
    newSince: 3,
  },
];

export interface ProjectsMockOptions {
  projects?: ProjectDetail[];
  runs?: ProjectRun[];
  points?: ProjectPoint[];
  noAccess?: boolean;
  delayMs?: number;
}

export const mockProjectsApi = (options: ProjectsMockOptions = {}): ProjectsApi => {
  const projects = structuredClone(options.projects ?? [exampleProject()]);
  const runs = structuredClone(options.runs ?? (options.projects ? [] : exampleProjectRuns()));
  const points: ProjectPoint[] = structuredClone(
    options.points ??
      (options.projects
        ? []
        : [
            {
              id: 'p1',
              text: 'Mål med tall i tildelingsbrevet regnes som nådd bare når årsrapporten oppgir resultatet.',
              by: per,
              byName: 'Per Hansen',
              at: '2026-10-01T10:00:00.000Z',
            },
            {
              id: 'p2',
              text: 'Mål om digitalisering vurderes mot modenhetsmodellen.',
              by: kari,
              byName: 'Kari Nordmann',
              at: '2026-10-02T10:00:00.000Z',
            },
          ]),
  );
  const log: (ProjectLogEntry & { project: string })[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
  const record = (project: string, kind: string, reason: string) =>
    log.unshift({
      project,
      kind,
      id: project,
      version: 1,
      deleted: false,
      by: per,
      byName: 'Per Hansen',
      at: new Date().toISOString(),
      reason,
    });
  const found = (id: string) => {
    const project = projects.find((p) => p.id === id);
    if (!project) throw new ApiError(404, { title: 'Fant ikke prosjektet' });
    return project;
  };
  const summary = (p: ProjectDetail) => ({
    ...p,
    subscriptions: p.subscriptions.length,
    fresh: p.subscriptions.reduce((n, s) => n + s.fresh.length, 0),
    paused: p.subscriptions.filter((s) => s.status === 'paused').length,
    runs: runs.length,
  });
  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'prosjekt';

  return {
    list: async () => {
      await wait();
      return projects.map(summary);
    },
    get: async (_tenant, id) => {
      await wait();
      return structuredClone(found(id));
    },
    sources: async () => {
      await wait();
      return exampleProjectSources;
    },
    create: async (_tenant, body, reason) => {
      await wait();
      const created: ProjectDetail = {
        ...body,
        selections: body.selections.map((s, i) => ({ ...s, id: s.id || `utvalg-${i + 1}` })),
        id: slug(body.name),
        version: 1,
        by: per,
        at: new Date().toISOString(),
        reason,
        changedBy: 'Per Hansen',
        subscriptions: [],
      };
      projects.unshift(created);
      record(created.id, 'project', reason);
      return created;
    },
    update: async (_tenant, id, body, reason) => {
      await wait();
      const project = found(id);
      Object.assign(project, {
        ...body,
        selections: body.selections.map((s, i) => ({ ...s, id: s.id || `utvalg-${i + 1}` })),
        version: project.version + 1,
        at: new Date().toISOString(),
        reason,
      });
      record(id, 'project', reason);
      return project as Project;
    },
    remove: async (_tenant, id) => {
      await wait();
      found(id);
      projects.splice(
        projects.findIndex((p) => p.id === id),
        1,
      );
    },
    documents: async (_tenant, id, selection) => {
      await wait();
      if (options.noAccess)
        throw new ApiError(403, { title: 'Du har ikke tilgang til datasettet' });
      const project = found(id);
      const fresh = project.subscriptions.find((s) => s.selection === selection)?.fresh ?? [];
      return {
        selection,
        datasetName: 'Kudos-rapporter',
        found: 23 + fresh.length,
        documents: [
          ...fresh.map((f) => f.document),
          { id: 'ar-e', title: 'Årsrapport 2025, Statens eksempelverk' },
        ],
      };
    },
    points: async (_tenant, id) => {
      await wait();
      found(id);
      return [...points];
    },
    addPoint: async (_tenant, id, text, reason) => {
      await wait();
      found(id);
      const point = {
        id: `p${points.length + 1}`,
        text,
        by: per,
        byName: 'Per Hansen',
        at: new Date().toISOString(),
      };
      points.push(point);
      record(id, 'project-point', reason);
      return point;
    },
    runs: async (_tenant, id) => {
      await wait();
      found(id);
      return structuredClone(runs);
    },
    estimate: async () => {
      await wait();
      return {
        id: 'est-1',
        items: 26,
        priced: true,
        costMicroNok: { low: 36_000_000, high: 42_000_000 },
        tokens: { low: 1_000_000, high: 1_200_000 },
      };
    },
    start: async (_tenant, id, body, reason) => {
      await wait();
      found(id);
      const run: ProjectRun = {
        id: `run-${runs.length + 1}`,
        service: 'maloppnaelse',
        version: 4,
        status: 'running',
        total: 26,
        startedAt: new Date().toISOString(),
        endedAt: null,
        costMicroNok: 0,
        counts: { queued: 26 },
        trigger: 'manual',
        selection: body.selection,
        newSince: 0,
      };
      runs.unshift(run);
      record(id, 'project-run', reason);
      return { id: run.id };
    },
    review: async (_tenant, id, runId, decision, reason) => {
      await wait();
      const run = runs.find((r) => r.id === runId);
      if (!run) throw new ApiError(404, { title: 'Fant ikke kjøringen' });
      run.approval = {
        status: decision,
        by: per,
        byName: 'Per Hansen',
        at: new Date().toISOString(),
      };
      record(id, 'project-run-review', reason);
      return run.approval;
    },
    subscribe: async (_tenant, id, selection, body, reason) => {
      await wait();
      const project = found(id);
      const existing = project.subscriptions.find((s) => s.selection === selection);
      const next: Subscription = {
        project: id,
        selection,
        mode: body.mode,
        ...(body.service ? { service: body.service } : {}),
        cap: body.maxCostNok ? { maxCostNok: body.maxCostNok } : {},
        status: 'active',
        fresh: existing?.fresh ?? [],
        waiting: 0,
        spentThisMonth: { costMicroNok: 0, tokens: 0 },
      };
      project.subscriptions = [
        ...project.subscriptions.filter((s) => s.selection !== selection),
        next,
      ];
      record(id, 'project-subscription', reason);
      return next;
    },
    unsubscribe: async (_tenant, id, selection, reason) => {
      await wait();
      const project = found(id);
      project.subscriptions = project.subscriptions.filter((s) => s.selection !== selection);
      record(id, 'project-subscription', reason);
    },
    log: async (_tenant, id) => {
      await wait();
      const project = found(id);
      return [
        ...log.filter((l) => l.project === id),
        {
          kind: 'project-run-review',
          id: 'run-alle',
          version: 1,
          deleted: false,
          by: per,
          byName: 'Per Hansen',
          at: '2026-10-02T12:00:00.000Z',
          reason: 'Godkjente tabellen «Måloppnåelse, alle 12 etater»',
        },
        {
          kind: 'project',
          id,
          version: 1,
          deleted: false,
          by: project.by,
          ...(project.changedBy ? { byName: project.changedBy } : {}),
          at: project.at,
          reason: project.reason,
        },
      ];
    },
  };
};
