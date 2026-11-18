import type { CatalogModel } from './api/models';
import type { ModelOption, ModelPrice, Residency } from './types';

export const modelLabel = (id: string, models: Pick<ModelOption, 'id' | 'name'>[] = []) =>
  models.find((m) => m.id === id)?.name ?? id.slice(id.lastIndexOf('/') + 1);

export const catalogPageSize = 20;
export const inUsePageSize = 15;
export const pickerVisible = 6;
export const compareMax = 3;

export type ModelStatus =
  'in_use' | 'available' | 'requires_approval' | 'pending_approval' | 'not_allowed';

export const modelStatuses: readonly ModelStatus[] = [
  'in_use',
  'available',
  'requires_approval',
  'pending_approval',
  'not_allowed',
];

export interface ModelUser {
  id: string;
  name: string;
}

export interface ModelEntry extends CatalogModel {
  status: ModelStatus;
  usedBy: ModelUser[];
}

export interface ModelBlockFacts {
  id: string;
  status: ModelStatus;
  usedBy: ModelUser[];
}

export const residencies: readonly Residency[] = ['norway', 'eu', 'global'];

export const usable = (m: Pick<CatalogModel, 'available'>) => m.available !== false;

const statusFromModel = (m: CatalogModel): ModelStatus =>
  usable(m) ? 'available' : m.reason === 'not_allowed' ? 'not_allowed' : 'requires_approval';

export const entriesOf = (models: CatalogModel[], blocks: ModelBlockFacts[] = []): ModelEntry[] =>
  models.map((m) => {
    const block = blocks.find((b) => b.id === m.id);
    const fallback = statusFromModel(m);
    const status =
      !block ||
      (!usable(m) && block.status !== 'pending_approval') ||
      (usable(m) && block.status !== 'in_use')
        ? fallback
        : block.status;
    return { ...m, status, usedBy: block?.usedBy ?? [] };
  });

export const displayName = (m: Pick<CatalogModel, 'id' | 'name'>) => m.name || modelLabel(m.id);

export const fitsOperation = (m: Pick<CatalogModel, 'operations'>, operation: string) =>
  !m.operations?.length || m.operations.includes(operation);

export const perMillion = (price: ModelPrice) => ({
  input: price.inputPerThousand * 1000,
  output: price.outputPerThousand * 1000,
});

export type PriceBand = 'under10' | 'from10to50' | 'over50' | 'unpriced';
export const priceBands: readonly PriceBand[] = ['under10', 'from10to50', 'over50', 'unpriced'];

export const priceBandOf = (m: Pick<CatalogModel, 'price'>): PriceBand => {
  if (!m.price) return 'unpriced';
  const input = perMillion(m.price).input;
  return input < 10 ? 'under10' : input <= 50 ? 'from10to50' : 'over50';
};

export type Facet = 'maker' | 'where' | 'use' | 'price' | 'status';
export const facets: readonly Facet[] = ['maker', 'where', 'use', 'price', 'status'];
export const unknownMaker = '';

export const facetValues = (m: ModelEntry, facet: Facet): string[] => {
  if (facet === 'maker') return [m.maker ?? unknownMaker];
  if (facet === 'where') return [m.residency];
  if (facet === 'use') return m.operations?.length ? m.operations : ['chat'];
  if (facet === 'price') return [priceBandOf(m)];
  return [m.status];
};

export type Selection = Record<Facet, string[]>;
export const noSelection = (): Selection => ({
  maker: [],
  where: [],
  use: [],
  price: [],
  status: [],
});

export const matchesQuery = (m: ModelEntry, query: string, words: (m: ModelEntry) => string[]) => {
  const needle = query.trim().toLocaleLowerCase('nb');
  if (!needle) return true;
  return [m.id, displayName(m), m.maker, m.operator?.name, m.operator?.region, ...words(m)]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('nb')
    .includes(needle);
};

export const passes = (m: ModelEntry, selection: Selection, skip?: Facet) =>
  facets.every((facet) => {
    const chosen = selection[facet];
    if (facet === skip || chosen.length === 0) return true;
    return facetValues(m, facet).some((v) => chosen.includes(v));
  });

export type CatalogSort = 'recommended' | 'price' | 'newest';
export const catalogSorts: readonly CatalogSort[] = ['recommended', 'price', 'newest'];

const byName = (a: CatalogModel, b: CatalogModel) =>
  displayName(a).localeCompare(displayName(b), 'nb');

export const recommendedFirst = (a: ModelEntry, b: ModelEntry) =>
  Number(!!b.recommended) - Number(!!a.recommended) ||
  Number(usable(b)) - Number(usable(a)) ||
  Number(b.status === 'in_use') - Number(a.status === 'in_use') ||
  byName(a, b);

const inputPrice = (m: CatalogModel) => (m.price ? m.price.inputPerThousand : Infinity);

export const sortEntries = (list: ModelEntry[], sort: CatalogSort) =>
  [...list].sort((a, b) => {
    if (sort === 'price') return inputPrice(a) - inputPrice(b) || byName(a, b);
    if (sort === 'newest')
      return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || byName(a, b);
    return recommendedFirst(a, b);
  });

export const differs = (cells: string[]) => new Set(cells).size > 1;

export const initialsOf = (maker: string | undefined, fallback: string) => {
  const words = (maker || fallback).split(/[\s/_-]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
};

export const pageOf = <T>(list: T[], page: number, size: number) => {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return {
    pages,
    current,
    from: list.length ? (current - 1) * size + 1 : 0,
    to: Math.min(current * size, list.length),
    items: list.slice((current - 1) * size, current * size),
  };
};
