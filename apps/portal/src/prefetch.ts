import type { ApiClient } from './api';
import { prefetchSignal } from './api/cache';

type Load = (
  api: ApiClient,
  tenant: string,
  live: boolean,
  signal: AbortSignal,
) => Promise<unknown>;

interface Area {
  chunk: () => Promise<unknown>;
  list?: readonly Load[];
  item?: (id: string) => readonly Load[];
}

const tasks: Load = (api, tenant, _live, signal) => api.tasks(tenant, {}, signal);
const serviceNames: Load = (api, tenant, live, signal) =>
  live ? api.overview(tenant, signal) : Promise.resolve(undefined);

const strategies: Load = (api, tenant, _live, signal) => api.listStrategies(tenant, signal);

const areas: Partial<Record<string, Area>> = {
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
    list: [tasks, serviceNames],
    item: (id) => [
      tasks,
      serviceNames,
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
      (api, _tenant, _live, signal) => api.listModels({}, signal),
    ],
  },
  playground: {
    chunk: () => import('./screens/Playground'),
    list: [(api, tenant, _live, signal) => api.playground.options(tenant, signal)],
  },
  datasets: { chunk: () => import('./screens/Datasets') },
  'shared-services': { chunk: () => import('./screens/SharedServices') },
  'building-blocks': { chunk: () => import('./screens/BuildingBlocks') },
  developer: { chunk: () => import('./screens/DeveloperTools') },
  settings: { chunk: () => import('./screens/Settings') },
};

/** Starts the code and the first requests of a screen, so opening it waits for neither in turn. */
export const prefetchPath = (path: string, api: ApiClient, tenant: string, live: boolean) => {
  const [area = '', id, ...rest] = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const found = areas[area];
  if (!found) return;
  found.chunk().catch(() => undefined);
  const loads =
    id === undefined
      ? found.list
      : id !== 'new' && rest.length === 0
        ? found.item?.(id)
        : undefined;
  for (const load of loads ?? []) load(api, tenant, live, prefetchSignal()).catch(() => undefined);
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
