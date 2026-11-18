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
  | 'log';

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
};

const order: ServiceSection[] = [
  'overview',
  'setup',
  'interface',
  'test',
  'channels',
  'settings',
  'quality',
  'batch',
  'versions',
  'log',
];

const forNew: ServiceSection[] = ['setup', 'interface', 'test', 'channels', 'versions'];

export type ServiceTab = 'overview' | 'setup' | 'interface' | 'advanced' | 'quality' | 'developer';

const tabSections: Record<ServiceTab, ServiceSection[]> = {
  overview: ['overview', 'batch'],
  setup: ['setup', 'test'],
  interface: ['interface'],
  advanced: ['settings', 'channels'],
  quality: ['quality'],
  developer: ['versions', 'log'],
};

export const tabLabels: Record<ServiceTab, PlainKey> = {
  overview: 'service.sectionOverview',
  setup: 'service.sectionSetup',
  interface: 'service.sectionInterface',
  advanced: 'service.tabAdvanced',
  quality: 'service.sectionQuality',
  developer: 'service.tabDeveloper',
};

const notListed: ServiceSection[] = ['batch', 'test'];

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

const legacyTabs: Record<string, [ServiceSection, string]> = {
  oppsett: ['setup', ''],
  test: ['test', ''],
  yaml: ['versions', '?view=yaml'],
  versjoner: ['versions', ''],
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
  const tab = query.get('tab');
  const legacy = !raw && tab ? legacyTabs[tab] : undefined;
  const keep = new URLSearchParams(query);
  keep.delete('tab');
  const suffix = (extra: string) => {
    const q = new URLSearchParams(extra.replace(/^\?/, ''));
    keep.forEach((v, k) => q.set(k, v));
    return q.size ? `?${q.toString()}` : '';
  };
  if (legacy) {
    const section = allowed.includes(legacy[0]) ? legacy[0] : fallback;
    return { section, detail: undefined, redirect: servicePath(id, section, suffix(legacy[1])) };
  }
  if (raw === 'how-it-works')
    return { section: 'setup', detail: 'how', redirect: servicePath(id, 'setup', '/how') };
  const known = (Object.keys(sectionLabels) as ServiceSection[]).find((s) => s === raw);
  if (!raw) return { section: fallback, detail: undefined };
  if (!known) return { section: fallback, detail: undefined };
  if (!allowed.includes(known))
    return { section: fallback, detail: undefined, redirect: servicePath(id, fallback) };
  return { section: known, detail };
};
