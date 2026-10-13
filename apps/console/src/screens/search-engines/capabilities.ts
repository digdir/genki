import type { PlainKey, T } from '../../i18n';
import type { DataLocation, KnowledgeEngine } from '../../types';

export const capabilityNames: { name: PlainKey; has: (c: readonly string[]) => boolean }[] = [
  { name: 'searchEngines.capabilityText', has: (c) => c.includes('search.text') },
  { name: 'searchEngines.capabilityVector', has: (c) => c.includes('search.vector') },
  { name: 'searchEngines.capabilityHybrid', has: (c) => c.includes('search.hybrid') },
  { name: 'searchEngines.capabilityFilters', has: (c) => c.some((x) => x.startsWith('filter.')) },
  { name: 'searchEngines.capabilityFacets', has: (c) => c.includes('facets') },
  { name: 'searchEngines.capabilityFetch', has: (c) => c.includes('fetch') },
  { name: 'searchEngines.capabilityRange', has: (c) => c.includes('range') },
];

const total = capabilityNames.length;

export const capabilityCount = (engine: KnowledgeEngine) =>
  capabilityNames.filter((c) => c.has(engine.capabilities)).length;

export const capabilitySummary = (engine: KnowledgeEngine, t: T) => {
  const missing = capabilityNames.filter((c) => !c.has(engine.capabilities));
  const count = total - missing.length;
  return missing.length === 0
    ? t('searchEngines.capabilityAll', { count, total })
    : t('searchEngines.capabilitySome', {
        count,
        total,
        missing: missing
          .map((c) => t('searchEngines.capabilityMissing', { name: t(c.name).toLowerCase() }))
          .join(', '),
      });
};

export const capabilityTotal = total;

const locationNames: Record<Exclude<DataLocation, 'global'>, PlainKey> = {
  norway: 'searchEngines.locationNorway',
  eu: 'searchEngines.locationEu',
};

export const dataLocationText = (location: DataLocation, t: T) =>
  location === 'global'
    ? t('searchEngines.dataOutside')
    : t('searchEngines.dataIn', { place: t(locationNames[location]) });
