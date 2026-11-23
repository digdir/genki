import type { PlainKey } from '../../i18n';

export type ServiceSection =
  | 'overview'
  | 'setup'
  | 'interface'
  | 'test'
  | 'channels'
  | 'settings'
  | 'quality'
  | 'batch'
  | 'versions'
  | 'log'
  | 'environments'
  | 'definition';

export const sectionLabels: Record<ServiceSection, PlainKey> = {
  overview: 'service.sectionOverview',
  setup: 'service.sectionSetup',
  interface: 'service.sectionInterface',
  test: 'service.sectionTest',
  channels: 'service.sectionChannels',
  settings: 'service.sectionSettings',
  quality: 'service.sectionQuality',
  batch: 'service.sectionBatch',
  versions: 'service.sectionVersions',
  log: 'service.sectionLog',
  environments: 'service.sectionEnvironments',
  definition: 'service.sectionDefinition',
};

const order: ServiceSection[] = [
  'overview',
  'setup',
  'interface',
  'test',
  'settings',
  'quality',
  'versions',
  'log',
  'channels',
  'environments',
  'batch',
  'definition',
];

const forNew: ServiceSection[] = ['setup', 'interface', 'test', 'channels', 'definition'];

export type ServiceTab = 'overview' | 'setup' | 'interface' | 'quality' | 'history' | 'developer';

export const historyHasOwnTab = true;

const historySections: ServiceSection[] = ['versions'];

const tabSections: Record<ServiceTab, ServiceSection[]> = {
  overview: ['overview'],
  setup: ['setup', 'test', 'settings'],
  interface: ['interface'],
  quality: ['quality'],
  history: historyHasOwnTab ? historySections : [],
  developer: [
    ...(historyHasOwnTab ? [] : historySections),
    'log',
    'channels',
    'environments',
    'batch',
    'definition',
  ],
};

export const tabLabels: Record<ServiceTab, PlainKey> = {
  overview: 'service.sectionOverview',
  setup: 'service.sectionSetup',
  interface: 'service.sectionInterface',
  quality: 'service.sectionQuality',
  history: 'service.sectionVersions',
  developer: 'service.tabDeveloper',
};

const notListed: ServiceSection[] = ['test', 'settings'];

export const tabOf = (section: ServiceSection): ServiceTab =>
  (Object.keys(tabSections) as ServiceTab[]).find((tab) => tabSections[tab].includes(section)) ??
  'overview';

export const serviceTabs = (sections: ServiceSection[]) =>
  (Object.keys(tabSections) as ServiceTab[]).flatMap((tab) => {
    const target = tabSections[tab].find((s) => sections.includes(s));
    return target ? [{ tab, target }] : [];
  });

export const subSections = (tab: ServiceTab, sections: ServiceSection[]) =>
  tabSections[tab].filter((s) => sections.includes(s) && !notListed.includes(s));

export const availableSections = ({ isNew }: { isNew: boolean }) =>
  isNew ? order.filter((s) => forNew.includes(s)) : order;

export const servicePath = (id: string, section?: ServiceSection, rest = '') => {
  const base = `/services/${encodeURIComponent(id)}`;
  if (!section || (section === 'overview' && id !== 'new')) return `${base}${rest}`;
  return `${base}/${section}${rest}`;
};

const legacyTabs: Record<string, ServiceSection> = {
  oppsett: 'setup',
  test: 'test',
  yaml: 'definition',
  versjoner: 'versions',
};

export interface ServiceLocation {
  section: ServiceSection;
  detail: string | undefined;
  redirect?: string;
}

export const locate = (
  id: string,
  segments: string[],
  query: URLSearchParams,
  allowed: ServiceSection[],
): ServiceLocation => {
  const [, , raw, detail] = segments;
  const fallback: ServiceSection = allowed.includes('overview') ? 'overview' : 'setup';
  const keep = new URLSearchParams(query);
  keep.delete('tab');
  const suffix = () => (keep.size ? `?${keep.toString()}` : '');
  const go = (section: ServiceSection, rest = '') => {
    const target = allowed.includes(section) ? section : fallback;
    return {
      section: target,
      detail: target === section && rest ? rest.slice(1) : undefined,
      redirect: servicePath(id, target, `${target === section ? rest : ''}${suffix()}`),
    };
  };
  const tab = query.get('tab');
  const legacy = !raw && tab ? legacyTabs[tab] : undefined;
  if (legacy) return go(legacy);
  if (raw === 'versions' && query.get('view') === 'yaml') {
    keep.delete('view');
    return go('definition');
  }
  if (raw === 'how-it-works') return go('setup', '/how');
  if (raw === 'settings' && allowed.includes('setup')) return go('setup', '/limits');
  const known = (Object.keys(sectionLabels) as ServiceSection[]).find((s) => s === raw);
  if (!raw || !known) return { section: fallback, detail: undefined };
  if (!allowed.includes(known))
    return { section: fallback, detail: undefined, redirect: servicePath(id, fallback) };
  return { section: known, detail };
};

export type Edition = 'test' | 'inUse';

export type EditionView = Edition | 'both' | 'shared';

const inUseQuery = 'edition=in-use';

export const editionOf = (query: URLSearchParams): Edition =>
  query.get('edition') === 'in-use' ? 'inUse' : 'test';

export const editionView = (section: ServiceSection, edition: Edition): EditionView => {
  const tab = tabOf(section);
  if (tab === 'developer') return 'both';
  return tab === 'history' ? 'inUse' : edition;
};

export const editionPath = (id: string, section: ServiceSection, edition: Edition) =>
  edition === 'inUse' && editionView(section, 'test') === 'test'
    ? servicePath(id, section, `?${inUseQuery}`)
    : servicePath(id, section);

export const switchPaths = (id: string, section: ServiceSection) => ({
  test: servicePath(id, editionView(section, 'test') === 'test' ? section : 'overview'),
  inUse: editionPath(id, section, 'inUse'),
});
