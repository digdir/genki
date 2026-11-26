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
  | 'definition'
  | 'advanced';

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
  advanced: 'service.tabAdvanced',
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
  'advanced',
];

const forNew: ServiceSection[] = [
  'setup',
  'interface',
  'test',
  'channels',
  'definition',
  'advanced',
];

export type ServiceTab =
  'overview' | 'setup' | 'interface' | 'quality' | 'history' | 'developer' | 'advanced';

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
  advanced: ['advanced'],
};

export const tabLabels: Record<ServiceTab, PlainKey> = {
  overview: 'service.sectionOverview',
  setup: 'service.sectionSetup',
  interface: 'service.sectionInterface',
  quality: 'service.sectionQuality',
  history: 'service.sectionVersions',
  developer: 'service.tabDeveloper',
  advanced: 'service.tabAdvanced',
};

/** The parts of the Avansert tab, in the order of its menu. */
export const advancedItems = [
  'how',
  'tools',
  'variants',
  'limits',
  'channels',
  'json',
  'yaml',
] as const;

export type AdvancedItem = (typeof advancedItems)[number];

export const advancedItemOf = (detail: string | undefined): AdvancedItem =>
  advancedItems.find((item) => item === detail?.split('/')[0]) ?? 'how';

const movedToAdvanced: Partial<Record<ServiceSection, AdvancedItem>> = {
  channels: 'channels',
  definition: 'yaml',
  settings: 'limits',
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
  (isNew ? order.filter((s) => forNew.includes(s)) : order).filter((s) => !movedToAdvanced[s]);

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
  const go = (wanted: ServiceSection, wantedRest = '') => {
    const moved = allowed.includes(wanted) ? undefined : movedToAdvanced[wanted];
    const into = moved && allowed.includes('advanced');
    const section: ServiceSection = into ? 'advanced' : wanted;
    // Kanaler keeps the client it was opened on: /channels/<frontend> → /advanced/channels/<frontend>.
    const rest = into ? `/${moved}${moved === 'channels' ? wantedRest : ''}` : wantedRest;
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
  if (raw === 'how-it-works') return go('advanced', '/how');
  if (raw === 'settings') return go('settings');
  if (raw === 'channels' && detail) return go('channels', `/${detail}`);
  if (raw === 'setup' && detail && (advancedItems as readonly string[]).includes(detail))
    return go('advanced', `/${detail}`);
  if (raw === 'setup' && (detail === 'risk' || detail === 'guards')) return go('setup', '/publish');
  if (raw === 'setup' && detail === 'start') return go('advanced', '/channels');
  const known = (Object.keys(sectionLabels) as ServiceSection[]).find((s) => s === raw);
  if (!raw || !known) return { section: fallback, detail: undefined };
  if (!allowed.includes(known)) {
    if (movedToAdvanced[known] && allowed.includes('advanced')) return go(known);
    return { section: fallback, detail: undefined, redirect: servicePath(id, fallback) };
  }
  // Avansert's items keep what comes after them: /advanced/channels/<frontend> opens that client.
  const rest = known === 'advanced' ? segments.slice(3).join('/') || undefined : detail;
  return { section: known, detail: rest };
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
