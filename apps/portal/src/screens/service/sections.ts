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
  | 'log'
  | 'developer';

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
  developer: 'service.sectionDeveloper',
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
  'developer',
];

export const availableSections = ({ isNew }: { isNew: boolean }) =>
  isNew
    ? order.filter(
        (s) =>
          s === 'setup' || s === 'blocks' || s === 'test' || s === 'versions' || s === 'developer',
      )
    : order.filter((s) => s !== 'blocks');

export const developerSections: ServiceSection[] = ['test', 'versions'];

/** Sections whose content now sits in the Utviklerverktøy tab; their addresses still work. */
const insideDeveloperTab: ServiceSection[] = ['versions', 'log'];

export const tabSections = ({ isNew }: { isNew: boolean }) =>
  availableSections({ isNew }).filter(
    (s) => !insideDeveloperTab.includes(s) && !(isNew && developerSections.includes(s)),
  );

/** The tab that holds a section, so a moved section still marks its tab. */
export const tabFor = (section: ServiceSection): ServiceSection =>
  insideDeveloperTab.includes(section) ? 'developer' : section;

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

/** Setup parts that now live in the Utviklerverktøy tab, by their old address. */
const movedSetup: Record<string, string> = { how: 'model', model: 'model', guards: 'guardrails' };

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
  const moved =
    raw === 'how-it-works'
      ? 'model'
      : raw === 'setup' && !(id === 'new' && detail === 'guards')
        ? movedSetup[detail ?? '']
        : undefined;
  if (moved)
    return {
      section: 'developer',
      detail: moved,
      redirect: servicePath(id, 'developer', `/${moved}${suffix('')}`),
    };
  const known = (Object.keys(sectionLabels) as ServiceSection[]).find((s) => s === raw);
  if (!raw) return { section: fallback, detail: undefined };
  if (!known || !allowed.includes(known))
    return { section: fallback, detail: undefined, redirect: servicePath(id, fallback) };
  return { section: known, detail };
};
