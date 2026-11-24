import type { Catalogue } from '@genai/i18n';
import { addTexts } from '.';

type Lane = () => Promise<Catalogue>;

const lane = <K extends string>(
  name: K,
  nb: () => Promise<Record<K, Catalogue>>,
  en: () => Promise<Record<K, Catalogue>>,
) =>
  ({ nb: () => nb().then((m) => m[name]), en: () => en().then((m) => m[name]) }) satisfies Record<
    'nb' | 'en',
    Lane
  >;

export const parts = {
  servicesUi: lane(
    'servicesUi',
    () => import('./nb/build-servicesUi'),
    () => import('./en/build-servicesUi'),
  ),
  setupUi: lane(
    'setupUi',
    () => import('./nb/build-setupUi'),
    () => import('./en/build-setupUi'),
  ),
  serviceUi: lane(
    'serviceUi',
    () => import('./nb/build-serviceUi'),
    () => import('./en/build-serviceUi'),
  ),
  stepflowsUi: lane(
    'stepflowsUi',
    () => import('./nb/build-stepflowsUi'),
    () => import('./en/build-stepflowsUi'),
  ),
  batchUi: lane(
    'batchUi',
    () => import('./nb/build-batchUi'),
    () => import('./en/build-batchUi'),
  ),
  playgroundUi: lane(
    'playgroundUi',
    () => import('./nb/build-playgroundUi'),
    () => import('./en/build-playgroundUi'),
  ),
  assistantUi: lane(
    'assistantUi',
    () => import('./nb/build-assistantUi'),
    () => import('./en/build-assistantUi'),
  ),
  blocksUi: lane(
    'blocksUi',
    () => import('./nb/build-blocksUi'),
    () => import('./en/build-blocksUi'),
  ),
  blocksLane: lane(
    'blocksLane',
    () => import('./nb/data-blocks'),
    () => import('./en/data-blocks'),
  ),
  skillsLane: lane(
    'skillsLane',
    () => import('./nb/data-skills'),
    () => import('./en/data-skills'),
  ),
  connectorsLane: lane(
    'connectorsLane',
    () => import('./nb/connectors'),
    () => import('./en/connectors'),
  ),
  configLane: lane(
    'configLane',
    () => import('./nb/data-config'),
    () => import('./en/data-config'),
  ),
  datasetsLane: lane(
    'datasetsLane',
    () => import('./nb/data-datasets'),
    () => import('./en/data-datasets'),
  ),
  modelsLane: lane(
    'modelsLane',
    () => import('./nb/data-models'),
    () => import('./en/data-models'),
  ),
  integrationsArea: lane(
    'integrationsArea',
    () => import('./nb/operate-integrations'),
    () => import('./en/operate-integrations'),
  ),
  settingsArea: lane(
    'settingsArea',
    () => import('./nb/operate-settings'),
    () => import('./en/operate-settings'),
  ),
  accessArea: lane(
    'accessArea',
    () => import('./nb/operate-access'),
    () => import('./en/operate-access'),
  ),
  logArea: lane(
    'logArea',
    () => import('./nb/operate-log'),
    () => import('./en/operate-log'),
  ),
  usageArea: lane(
    'usageArea',
    () => import('./nb/operate-usage'),
    () => import('./en/operate-usage'),
  ),
  qualityArea: lane(
    'qualityArea',
    () => import('./nb/operate-quality'),
    () => import('./en/operate-quality'),
  ),
  apirefArea: lane(
    'apirefArea',
    () => import('./nb/operate-apiref'),
    () => import('./en/operate-apiref'),
  ),
  statusArea: lane(
    'statusArea',
    () => import('./nb/operate-status'),
    () => import('./en/operate-status'),
  ),
};

export type Part = keyof typeof parts;

/** The texts each lazily loaded screen needs beyond the shell's and the overview's. */
export const areas = {
  access: ['serviceUi', 'accessArea'],
  buildingBlocks: [
    'serviceUi',
    'stepflowsUi',
    'playgroundUi',
    'blocksLane',
    'skillsLane',
    'connectorsLane',
    'modelsLane',
    'qualityArea',
  ],
  contact: [],
  dataHandling: [],
  datasets: ['serviceUi', 'playgroundUi', 'configLane'],
  developerTools: [
    'serviceUi',
    'stepflowsUi',
    'configLane',
    'integrationsArea',
    'apirefArea',
    'blocksLane',
  ],
  integrations: ['serviceUi', 'blocksLane', 'integrationsArea', 'settingsArea'],
  log: ['playgroundUi'],
  onboarding: [],
  playground: ['serviceUi', 'playgroundUi', 'blocksUi', 'modelsLane'],
  pricePage: [],
  profile: [],
  services: [
    'serviceUi',
    'stepflowsUi',
    'batchUi',
    'playgroundUi',
    'blocksUi',
    'blocksLane',
    'skillsLane',
    'modelsLane',
    'configLane',
    'integrationsArea',
    'settingsArea',
    'qualityArea',
  ],
  settings: ['batchUi', 'playgroundUi', 'skillsLane', 'settingsArea'],
  sharedServices: ['blocksLane', 'configLane'],
  skills: ['serviceUi', 'playgroundUi', 'skillsLane', 'modelsLane', 'qualityArea'],
  stepFlows: ['stepflowsUi', 'playgroundUi', 'blocksLane'],
  usage: [],
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
