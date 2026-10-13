import type { Format, PlainKey, T } from '../i18n';
import type { Residency } from '../types';

export interface EngineCapabilityRow {
  id: 'text' | 'vector' | 'hybrid' | 'filters' | 'facets' | 'full' | 'ordered';
  name: PlainKey;
  can: PlainKey;
  consequence: PlainKey;
  has: (capabilities: readonly string[]) => boolean;
}

export const engineCapabilities: readonly EngineCapabilityRow[] = [
  {
    id: 'text',
    name: 'searchEngine.capTextName',
    can: 'searchEngine.capTextCan',
    consequence: 'searchEngine.capTextConsequence',
    has: (c) => c.includes('text_search'),
  },
  {
    id: 'vector',
    name: 'searchEngine.capVectorName',
    can: 'searchEngine.capVectorCan',
    consequence: 'searchEngine.capVectorConsequence',
    has: (c) => c.includes('vector_search'),
  },
  {
    id: 'hybrid',
    name: 'searchEngine.capHybridName',
    can: 'searchEngine.capHybridCan',
    consequence: 'searchEngine.capHybridConsequence',
    has: (c) => c.includes('hybrid'),
  },
  {
    id: 'filters',
    name: 'searchEngine.capFiltersName',
    can: 'searchEngine.capFiltersCan',
    consequence: 'searchEngine.capFiltersConsequence',
    has: (c) => c.includes('filters'),
  },
  {
    id: 'facets',
    name: 'searchEngine.capFacetsName',
    can: 'searchEngine.capFacetsCan',
    consequence: 'searchEngine.capFacetsConsequence',
    has: (c) => c.includes('facets'),
  },
  {
    id: 'full',
    name: 'searchEngine.capFullName',
    can: 'searchEngine.capFullCan',
    consequence: 'searchEngine.capFullConsequence',
    has: (c) => c.includes('full_document'),
  },
  {
    id: 'ordered',
    name: 'searchEngine.capOrderedName',
    can: 'searchEngine.capOrderedCan',
    consequence: 'searchEngine.capOrderedConsequence',
    has: (c) => c.includes('ordered_passages'),
  },
];

export const locationNames: Record<Residency, PlainKey> = {
  norway: 'searchEngine.locationNorway',
  eu: 'searchEngine.locationEu',
  global: 'searchEngine.locationGlobal',
};

export const switchSteps: readonly PlainKey[] = [
  'searchEngine.stepEngine',
  'searchEngine.stepMethod',
  'searchEngine.stepTransfer',
  'searchEngine.stepCompare',
  'searchEngine.stepAdopt',
];

export const verdictLabels: Record<'same' | 'better' | 'worse', PlainKey> = {
  same: 'searchEngine.verdictSame',
  better: 'searchEngine.verdictBetter',
  worse: 'searchEngine.verdictWorse',
};

export const verdictColors = { same: 'neutral', better: 'success', worse: 'warning' } as const;

export const seconds = (t: T, f: Format, ms: number) =>
  t('common.seconds', { value: f.decimal(ms / 1000, 2) });

export const decimal = (f: Format, n: number) => f.decimal(n, 1);

export const costText = (t: T, f: Format, { min, max }: { min: number; max: number }) =>
  min === max
    ? t('searchEngine.costOne', { amount: f.number(max) })
    : t('searchEngine.costRange', { min: f.number(min), max: f.number(max) });

export const durationText = (t: T, f: Format, { min, max }: { min: number; max: number }) => {
  if (max < 60) return t('searchEngine.minutes', { count: max });
  const hours = (m: number) => Math.round(m / 60);
  return hours(min) === hours(max)
    ? t('searchEngine.hours', { count: hours(max) })
    : t('searchEngine.hoursRange', { min: f.number(hours(min)), max: f.number(hours(max)) });
};

export const datasetEnginePath = (tenant: string, id: string) =>
  `/api/tenants/${encodeURIComponent(tenant)}/datasets/${encodeURIComponent(id)}`;
