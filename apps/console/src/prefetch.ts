import type { ApiClient } from './api';
import * as Screen from './lazy-screens';
import { prefetchSignal } from './response-cache';

type Load = (api: ApiClient, signal: AbortSignal) => Promise<unknown>;

interface Area {
  chunk: () => Promise<unknown>;
  loads?: readonly Load[];
}

const tenants: Load = (api, signal) => api.listTenants(signal);

const areas: Partial<Record<string, Area>> = {
  '/tenants': {
    chunk: Screen.Tenants.preload,
    loads: [(api, signal) => api.listTenants(signal, { usage: true })],
  },
  '/queue': { chunk: Screen.Inbox.preload, loads: [(api, signal) => api.inbox(signal)] },
  '/quota-requests': {
    chunk: Screen.QuotaRequests.preload,
    loads: [(api, signal) => api.quotaRequests(signal)],
  },
  '/onboarding': { chunk: Screen.Onboarding.preload },
  '/operations': {
    chunk: Screen.Operations.preload,
    loads: [tenants],
  },
  '/audit': { chunk: Screen.Audit.preload, loads: [tenants] },
  '/models': {
    chunk: Screen.Models.preload,
    loads: [
      (api, signal) => api.listModels(signal),
      (api, signal) => api.modelEndpoints(signal),
      (api, signal) => api.modelApis(signal),
      (api, signal) => api.operationKindsOverview(signal),
      (api, signal) => api.operationDescriptors(signal),
      (api, signal) => api.processorRecords(signal),
    ],
  },
  '/catalog': { chunk: Screen.Catalog.preload },
  '/search-engines': { chunk: Screen.SearchEngines.preload },
  '/building-blocks': {
    chunk: Screen.BuildingBlocks.preload,
    loads: [tenants, (api, signal) => api.buildingBlocks(signal)],
  },
  '/block-reviews': { chunk: Screen.BlockReviews.preload },
  '/shared-services': {
    chunk: Screen.SharedServices.preload,
    loads: [(api, signal) => api.sharedServices(signal)],
  },
  '/quality': { chunk: Screen.Quality.preload, loads: [(api, signal) => api.quality(signal)] },
  '/quality-matrix': { chunk: Screen.QualityMatrix.preload },
  '/policies': { chunk: Screen.Policies.preload },
  '/tracing': { chunk: Screen.Tracing.preload, loads: [(api, signal) => api.tracing(signal)] },
  '/flags': {
    chunk: Screen.Flags.preload,
    loads: [tenants, (api, signal) => api.flags(signal)],
  },
  '/demos': { chunk: Screen.Demos.preload },
  '/settings': {
    chunk: Screen.Settings.preload,
    loads: [
      (api, signal) => api.settingsCatalog(signal),
      (api, signal) => api.defaults(signal),
      (api, signal) => api.settingOverrides(signal),
    ],
  },
  '/platform-secrets': {
    chunk: Screen.PlatformSecrets.preload,
    loads: [(api, signal) => api.platformSecrets(signal)],
  },
  '/state-register': {
    chunk: Screen.StateRegister.preload,
    loads: [(api, signal) => api.stateRegister(signal)],
  },
  '/schemas': { chunk: Screen.Schemas.preload },
  '/tenants/services': { chunk: Screen.TenantServices.preload },
  '/support-access': { chunk: Screen.OrgPage.preload },
  '/diagnostics': { chunk: Screen.Diagnostics.preload },
};

export const prefetchCode = (path: string) => {
  const [route = '', query] = path.split('?');
  if (query) return;
  areas[route]?.chunk().catch(() => undefined);
};

export const prefetchPath = (path: string, api: ApiClient) => {
  const [route = '', query] = path.split('?');
  const found = areas[route];
  if (!found || query) return;
  found.chunk().catch(() => undefined);
  for (const load of found.loads ?? []) load(api, prefetchSignal()).catch(() => undefined);
};

const linkPath = (target: EventTarget | null) => {
  const link = target instanceof Element ? target.closest('a[href^="#/"]') : null;
  return link?.getAttribute('href')?.slice(1);
};

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
