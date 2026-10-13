import {
  capabilitiesOf,
  KnowledgeError,
  kindsOf,
  residencies,
  searchCapabilities,
  type DatasetInfo,
  type FacetValue,
  type FieldFilter,
  type FilterValue,
  type Hit,
  type KnowledgeCapability,
  type KnowledgePort,
  type SearchRequest,
  type SearchResult,
} from './port.js';

const separator = '::';

const rrf = (rank: number) => 1 / (60 + rank);

export const combineKnowledge = (ports: Record<string, KnowledgePort>): KnowledgePort => {
  const entries = Object.entries(ports);
  const only = entries.length === 1 ? entries[0]?.[1] : undefined;
  if (only) return only;
  if (entries.length === 0) throw new Error('no datasets to combine');

  const tag = (dataset: string, value: string) => `${dataset}${separator}${value}`;
  const untag = (value: string): [string, string] | undefined => {
    const at = value.indexOf(separator);
    return at < 0 ? undefined : [value.slice(0, at), value.slice(at + separator.length)];
  };
  const tagHit = (dataset: string, hit: Hit): Hit => ({
    ...hit,
    id: tag(dataset, hit.id),
    ...(hit.document === undefined ? {} : { document: tag(dataset, hit.document) }),
    fields: { ...hit.fields, dataset },
  });

  const serves = (port: KnowledgePort, request: SearchRequest) => {
    const info = port.info();
    const declared = capabilitiesOf(info);
    if (!searchCapabilities.some((c) => declared.includes(c))) return false;
    if (request.profile !== undefined && !info.profiles.includes(request.profile)) return false;
    return Object.keys(request.filters ?? {}).every((field) => field in info.filters);
  };

  const fuse = (results: [string, SearchResult][], limit: number | undefined): SearchResult => {
    const scored = results.flatMap(([dataset, result]) =>
      result.hits.map((hit, rank) => ({ hit: tagHit(dataset, hit), fused: rrf(rank) })),
    );
    scored.sort((a, b) => b.fused - a.fused || b.hit.score - a.hit.score);
    const hits = scored.map((s) => s.hit);
    const warnings = results.flatMap(([, r]) => (r.warning ? [r.warning] : []));
    const found = results.reduce((n, [, r]) => n + (r.found ?? r.hits.length), 0);
    return {
      hits: limit === undefined ? hits : hits.slice(0, limit),
      found,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  };

  const info = (): DatasetInfo => {
    const infos = entries.map(([, p]) => p.info());
    const filters: Record<string, FieldFilter> = {};
    for (const i of infos)
      for (const [field, declared] of Object.entries(i.filters)) {
        const known = filters[field];
        filters[field] = known ? [...new Set([...kindsOf(known), ...kindsOf(declared)])] : declared;
      }
    const strictest = Math.min(...infos.map((i) => residencies.indexOf(i.residency)));
    const engines = [...new Set(infos.map((i) => i.engine ?? 'unknown'))];
    return {
      id: entries.map(([id]) => id).join('+'),
      residency: residencies[strictest] ?? 'norway',
      filters,
      profiles: [...new Set(infos.flatMap((i) => i.profiles))],
      engine: engines.length === 1 ? (engines[0] as string) : 'combined',
      capabilities: [
        ...new Set(infos.flatMap((i): KnowledgeCapability[] => [...capabilitiesOf(i)])),
      ],
    };
  };

  const searchMany = async (requests: SearchRequest[]): Promise<SearchResult[]> => {
    const perDataset = await Promise.all(
      entries.map(async ([dataset, port]) => {
        const wanted = requests.map((r, i) => [i, r] as const).filter(([, r]) => serves(port, r));
        const results = wanted.length > 0 ? await port.searchMany(wanted.map(([, r]) => r)) : [];
        return new Map(wanted.map(([i], n) => [i, [dataset, results[n]] as const]));
      }),
    );
    return requests.map((r, i) =>
      fuse(
        perDataset.flatMap((m) => {
          const found = m.get(i);
          return found?.[1] ? [[found[0], found[1]] as [string, SearchResult]] : [];
        }),
        r.limit,
      ),
    );
  };

  const byDataset = (values: string[]) => {
    const groups = new Map<string, string[]>();
    for (const value of values) {
      const parts = untag(value);
      if (!parts || !ports[parts[0]]) continue;
      groups.set(parts[0], [...(groups.get(parts[0]) ?? []), parts[1]]);
    }
    return groups;
  };

  return {
    info,
    search: async (request) => (await searchMany([request]))[0] ?? { hits: [] },
    searchMany,
    fetch: async (ids) => {
      const groups = byDataset(ids);
      const fetched = await Promise.all(
        [...groups].map(async ([dataset, local]) =>
          (await (ports[dataset] as KnowledgePort).fetch(local)).map((h) => tagHit(dataset, h)),
        ),
      );
      const all = new Map(fetched.flat().map((h) => [h.id, h]));
      return ids.flatMap((id) => all.get(id) ?? []);
    },
    range: async (document, from, to) => {
      const parts = untag(document);
      const port = parts ? ports[parts[0]] : undefined;
      if (!parts || !port) return [];
      return (await port.range(parts[1], from, to)).map((h) => tagHit(parts[0], h));
    },
    facets: async (fields, filters?: Record<string, FilterValue>) => {
      const merged: Record<string, Map<string, number>> = {};
      const faceted = entries.filter(([, port]) => capabilitiesOf(port.info()).includes('facets'));
      if (faceted.length === 0)
        throw new KnowledgeError('unsupported', 'none of the datasets support facets');
      await Promise.all(
        faceted.map(async ([, port]) => {
          const declared = port.info().filters;
          const own = fields.filter((f) => f in declared);
          if (own.length === 0) return;
          if (Object.keys(filters ?? {}).some((f) => !(f in declared))) return;
          const values = await port.facets(own, filters);
          for (const [field, list] of Object.entries(values)) {
            const counts = (merged[field] ??= new Map());
            for (const v of list) counts.set(v.value, (counts.get(v.value) ?? 0) + v.count);
          }
        }),
      );
      return Object.fromEntries(
        Object.entries(merged).map(([field, counts]): [string, FacetValue[]] => [
          field,
          [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
        ]),
      );
    },
  };
};
