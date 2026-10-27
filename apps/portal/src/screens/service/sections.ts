import type { PlainKey } from '../../i18n';

export type ServiceSection =
  | 'overview'
  | 'setup'
  | 'blocks'
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
  blocks: 'builderBlocks.sectionLabel',
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
  'blocks',
  'test',
  'channels',
  'settings',
  'quality',
  'batch',
  'versions',
  'log',
];

export const availableSections = ({ isNew }: { isNew: boolean }) =>
  isNew
    ? order.filter((s) => s === 'setup' || s === 'blocks' || s === 'test' || s === 'versions')
    : order.filter((s) => s !== 'blocks');

export const developerSections: ServiceSection[] = ['test', 'versions'];

export const tabSections = ({ isNew }: { isNew: boolean }) =>
  isNew
    ? availableSections({ isNew }).filter((s) => !developerSections.includes(s))
    : availableSections({ isNew });

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
  const fallback: ServiceSection = id === 'new' ? 'setup' : 'overview';
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
  if (!known || !allowed.includes(known))
    return { section: fallback, detail: undefined, redirect: servicePath(id, fallback) };
  return { section: known, detail };
};
