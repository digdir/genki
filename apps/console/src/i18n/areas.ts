import type { Catalogue } from '@genai/i18n';
import { addTexts } from '.';

const lane = <K extends string>(
  name: K,
  nb: () => Promise<Record<K, Catalogue[string]>>,
  en: () => Promise<Record<K, Catalogue[string]>>,
) => ({
  nb: () => nb().then((m) => ({ [name]: m[name] }) as Catalogue),
  en: () => en().then((m) => ({ [name]: m[name] }) as Catalogue),
});

export const parts = {
  apis: lane(
    'apis',
    () => import('./nb/apis'),
    () => import('./en/apis'),
  ),
  atlas: lane(
    'atlas',
    () => import('./nb/atlas'),
    () => import('./en/atlas'),
  ),
  audit: lane(
    'audit',
    () => import('./nb/audit'),
    () => import('./en/audit'),
  ),
  auditLog: lane(
    'auditLog',
    () => import('./nb/auditLog'),
    () => import('./en/auditLog'),
  ),
  blockReviews: lane(
    'blockReviews',
    () => import('./nb/blockReviews'),
    () => import('./en/blockReviews'),
  ),
  buildingBlocks: lane(
    'buildingBlocks',
    () => import('./nb/buildingBlocks'),
    () => import('./en/buildingBlocks'),
  ),
  catalog: lane(
    'catalog',
    () => import('./nb/catalog'),
    () => import('./en/catalog'),
  ),
  config: lane(
    'config',
    () => import('./nb/config'),
    () => import('./en/config'),
  ),
  connections: lane(
    'connections',
    () => import('./nb/connections'),
    () => import('./en/connections'),
  ),
  datasetSearch: lane(
    'datasetSearch',
    () => import('./nb/datasetSearch'),
    () => import('./en/datasetSearch'),
  ),
  demos: lane(
    'demos',
    () => import('./nb/demos'),
    () => import('./en/demos'),
  ),
  diagnostics: lane(
    'diagnostics',
    () => import('./nb/diagnostics'),
    () => import('./en/diagnostics'),
  ),
  endpoints: lane(
    'endpoints',
    () => import('./nb/endpoints'),
    () => import('./en/endpoints'),
  ),
  engineSwitch: lane(
    'engineSwitch',
    () => import('./nb/engineSwitch'),
    () => import('./en/engineSwitch'),
  ),
  flags: lane(
    'flags',
    () => import('./nb/flags'),
    () => import('./en/flags'),
  ),
  inbox: lane(
    'inbox',
    () => import('./nb/inbox'),
    () => import('./en/inbox'),
  ),
  modelOperations: lane(
    'modelOperations',
    () => import('./nb/modelOperations'),
    () => import('./en/modelOperations'),
  ),
  modelParameters: lane(
    'modelParameters',
    () => import('./nb/modelParameters'),
    () => import('./en/modelParameters'),
  ),
  models: lane(
    'models',
    () => import('./nb/models'),
    () => import('./en/models'),
  ),
  onboarding: lane(
    'onboarding',
    () => import('./nb/onboarding'),
    () => import('./en/onboarding'),
  ),
  operating: lane(
    'operating',
    () => import('./nb/operating'),
    () => import('./en/operating'),
  ),
  operations: lane(
    'operations',
    () => import('./nb/operations'),
    () => import('./en/operations'),
  ),
  org: lane(
    'org',
    () => import('./nb/org'),
    () => import('./en/org'),
  ),
  platformSecrets: lane(
    'platformSecrets',
    () => import('./nb/platformSecrets'),
    () => import('./en/platformSecrets'),
  ),
  policies: lane(
    'policies',
    () => import('./nb/policies'),
    () => import('./en/policies'),
  ),
  quality: lane(
    'quality',
    () => import('./nb/quality'),
    () => import('./en/quality'),
  ),
  qualityMatrix: lane(
    'qualityMatrix',
    () => import('./nb/qualityMatrix'),
    () => import('./en/qualityMatrix'),
  ),
  quotaRequests: lane(
    'quotaRequests',
    () => import('./nb/quotaRequests'),
    () => import('./en/quotaRequests'),
  ),
  run: lane(
    'run',
    () => import('./nb/run'),
    () => import('./en/run'),
  ),
  schemas: lane(
    'schemas',
    () => import('./nb/schemas'),
    () => import('./en/schemas'),
  ),
  settings: lane(
    'settings',
    () => import('./nb/settings'),
    () => import('./en/settings'),
  ),
  sharedServices: lane(
    'sharedServices',
    () => import('./nb/sharedServices'),
    () => import('./en/sharedServices'),
  ),
  stateRegister: lane(
    'stateRegister',
    () => import('./nb/stateRegister'),
    () => import('./en/stateRegister'),
  ),
  studio: lane(
    'studio',
    () => import('./nb/studio'),
    () => import('./en/studio'),
  ),
  support: lane(
    'support',
    () => import('./nb/support'),
    () => import('./en/support'),
  ),
  supportAccess: lane(
    'supportAccess',
    () => import('./nb/supportAccess'),
    () => import('./en/supportAccess'),
  ),
  tracing: lane(
    'tracing',
    () => import('./nb/tracing'),
    () => import('./en/tracing'),
  ),
  transfer: lane(
    'transfer',
    () => import('./nb/transfer'),
    () => import('./en/transfer'),
  ),
};

export type Part = keyof typeof parts;

export const areas = {
  atlas: ['atlas'],
  audit: ['audit', 'auditLog'],
  blockReviews: ['blockReviews'],
  buildingBlocks: ['buildingBlocks'],
  catalog: ['catalog', 'config', 'datasetSearch', 'engineSwitch'],
  demos: ['demos', 'studio'],
  diagnostics: ['diagnostics', 'settings'],
  flags: ['flags'],
  inbox: ['inbox', 'org', 'support'],
  models: ['apis', 'connections', 'endpoints', 'modelOperations', 'modelParameters', 'models'],
  onboarding: ['onboarding'],
  operations: ['operating', 'operations'],
  orgPage: ['audit', 'auditLog', 'inbox', 'org', 'settings', 'support', 'supportAccess'],
  platformDefaults: ['policies'],
  platformSecrets: ['platformSecrets'],
  policies: ['config', 'policies'],
  quality: ['quality'],
  qualityMatrix: ['qualityMatrix'],
  queue: [],
  quotaRequests: ['quotaRequests'],
  run: ['run'],
  schemas: ['schemas'],
  searchEngines: ['config'],
  settings: ['settings', 'transfer'],
  sharedServices: ['sharedServices'],
  stateRegister: ['stateRegister'],
  tenantServices: [],
  tenants: [],
  tracing: ['tracing'],
} satisfies Record<string, readonly Part[]>;

export type Area = keyof typeof areas;

const loading = new Map<Part, Promise<void>>();

const loadPart = (part: Part) => {
  let pending = loading.get(part);
  if (!pending) {
    pending = Promise.all([parts[part].nb(), parts[part].en()]).then(([nb, en]) =>
      addTexts(nb, en),
    );
    pending.catch(() => loading.delete(part));
    loading.set(part, pending);
  }
  return pending;
};

export const loadArea = async (area: Area) => {
  await Promise.all(areas[area].map(loadPart));
};

export const withTexts =
  <M>(area: Area, screen: () => Promise<M>) =>
  async () => {
    const [module] = await Promise.all([screen(), loadArea(area)]);
    return module;
  };

export const loadAllTexts = async () => {
  await Promise.all((Object.keys(parts) as Part[]).map(loadPart));
};
