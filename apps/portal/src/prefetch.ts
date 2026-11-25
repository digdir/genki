import type { ApiClient } from './api';
import { prefetchSignal } from './api/cache';
import { daysThisMonth, failedRunsRequest } from './usage-window';
import { noFilters, runsRequest } from './screens/log/filters';

type Load = (
  api: ApiClient,
  tenant: string,
  live: boolean,
  signal: AbortSignal,
  rights: ReadonlySet<string>,
) => Promise<unknown>;

interface Area {
  chunk?: () => Promise<unknown>;
  list?: readonly Load[];
  item?: (id: string) => readonly Load[];
  sections?: Readonly<Record<string, readonly Load[]>>;
}

const serviceNames: Load = (api, tenant, live, signal) =>
  live ? api.services(tenant, signal) : Promise.resolve(undefined);

const withRight =
  (right: string, load: Load): Load =>
  (api, tenant, live, signal, rights) =>
    rights.has(right) ? load(api, tenant, live, signal, rights) : Promise.resolve(undefined);

const strategies: Load = (api, tenant, _live, signal) => api.listStrategies(tenant, signal);

const logRuns: readonly Load[] = [
  (api, tenant, _live, signal) => api.tasks(tenant, runsRequest(noFilters, new Date()), signal),
  (api, tenant, _live, signal) =>
    api.tasks(tenant, { ...runsRequest(noFilters, new Date()), origin: 'playground' }, signal),
  serviceNames,
];

const areas: Partial<Record<string, Area>> = {
  overview: {
    list: [
      (api, tenant, _live, signal) => api.overview(tenant, signal),
      (api, tenant, _live, signal) => api.usage(tenant, daysThisMonth(), signal),
      (api, tenant, _live, signal) => api.tenantEffectiveSettings(tenant, signal),
      (api, tenant, _live, signal) => api.datasets.list(tenant, signal),
      (api, tenant, _live, signal) => api.tasks(tenant, failedRunsRequest(), signal),
      withRight('manage-services', (api, tenant, _live, signal) => api.audit(tenant, signal)),
      (api, tenant, _live, signal) => api.services(tenant, signal),
      (api, tenant, _live, signal) => api.quality.drafts(tenant, signal),
      withRight('manage-services', (api, tenant, _live, signal) => api.access(tenant, signal)),
    ],
  },
  services: {
    chunk: () => import('./screens/Services'),
    list: [
      strategies,
      (api, tenant, live, signal) =>
        live ? api.services(tenant, signal) : api.listDefinitions(tenant, signal),
    ],
    item: (id) => [
      strategies,
      (api, tenant, _live, signal) => api.getDefinition(tenant, 'Service', id, signal),
      (api, tenant, _live, signal) => api.usage(tenant, 30, signal),
      (api, tenant, _live, signal) => api.tasks(tenant, { service: id }, signal),
    ],
  },
  log: {
    chunk: () => import('./screens/Log'),
    list: logRuns,
    sections: { runs: logRuns, changes: [] },
    item: (id) => [
      serviceNames,
      (api, tenant, _live, signal) => api.task(tenant, id, signal),
      (api, tenant, _live, signal) => api.getTaskTimeline(tenant, id, signal),
    ],
  },
  access: {
    chunk: () => import('./screens/Access'),
    list: [
      (api, tenant, _live, signal) => api.access(tenant, signal),
      (api, tenant, live, signal) =>
        live ? api.services(tenant, signal) : Promise.resolve(undefined),
    ],
  },
  statistics: {
    chunk: () => import('./screens/Usage'),
    list: [
      (api, tenant, _live, signal) => api.usage(tenant, 190, signal),
      (api, tenant, _live, signal) => api.tenantEffectiveSettings(tenant, signal),
      (api, _tenant, _live, signal) => api.listModels({ all: true }, signal),
    ],
  },
  playground: {
    chunk: () => import('./screens/Playground'),
    list: [(api, tenant, _live, signal) => api.playground.options(tenant, signal)],
  },
  datasets: {
    chunk: () => import('./screens/Datasets'),
    list: [
      (api, tenant, live, signal) =>
        live ? api.datasets.list(tenant, signal) : api.listDatasets(signal),
      (api, tenant, live, signal) =>
        live
          ? api.configList(`/tenants/${encodeURIComponent(tenant)}/catalog?kind=dataset`, signal)
          : Promise.resolve(undefined),
    ],
  },
  'shared-services': { chunk: () => import('./screens/SharedServices') },
  'building-blocks': { chunk: () => import('./screens/BuildingBlocks') },
  design: { chunk: () => import('./screens/design/Design') },
  developer: { chunk: () => import('./screens/DeveloperTools') },
  settings: {
    chunk: () => import('./screens/Settings'),
    list: [
      (api, _tenant, _live, signal) => api.settingsCatalog(signal),
      (api, tenant, live, signal) =>
        live ? api.tenantEffectiveSettings(tenant, signal) : Promise.resolve(undefined),
    ],
  },
};

/** Starts the code and the first requests of a screen, so opening it waits for neither in turn. */
export const prefetchPath = (
  path: string,
  api: ApiClient,
  tenant: string,
  live: boolean,
  rights: ReadonlySet<string> = new Set(),
) => {
  const [area = '', id, ...rest] = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const found = areas[area];
  if (!found) return;
  found.chunk?.().catch(() => undefined);
  const section =
    id !== undefined && found.sections && Object.hasOwn(found.sections, id)
      ? found.sections[id]
      : undefined;
  const loads =
    id === undefined
      ? found.list
      : rest.length > 0
        ? undefined
        : (section ?? (id === 'new' ? undefined : found.item?.(id)));
  for (const load of loads ?? [])
    load(api, tenant, live, prefetchSignal(), rights).catch(() => undefined);
};

const linkPath = (target: EventTarget | null) => {
  const link = target instanceof Element ? target.closest('a[href^="#/"]') : null;
  return link?.getAttribute('href')?.slice(1);
};

/** Prefetches the screen behind an in-app link the pointer rests on or the keyboard focuses. */
export const prefetchOnIntent = (
  root: Document,
  prefetch: (path: string) => void,
  delayMs = 80,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = (event: Event) => {
    const path = linkPath(event.target);
    clearTimeout(timer);
    if (path) timer = setTimeout(() => prefetch(path), delayMs);
  };
  const stop = () => clearTimeout(timer);
  root.addEventListener('pointerover', start);
  root.addEventListener('focusin', start);
  root.addEventListener('pointerout', stop);
  return () => {
    stop();
    root.removeEventListener('pointerover', start);
    root.removeEventListener('focusin', start);
    root.removeEventListener('pointerout', stop);
  };
};
