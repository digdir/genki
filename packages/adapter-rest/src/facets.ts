import type { FacetValue, KnowledgePort } from '@genai/port-knowledge';
import { toPortFilters, type FieldSpec } from './filters.js';

export interface FacetOption {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetField {
  field: string;
  options: FacetOption[];
}

const byValue = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const merge = (lists: FacetValue[][], selected: Set<string>): FacetOption[] => {
  const seen = new Map<string, number[]>();
  for (const list of lists) {
    for (const { value, count } of list) {
      const key = String(value);
      seen.set(key, [...(seen.get(key) ?? []), count]);
    }
  }
  return [...seen]
    .map(([value, counts]) => ({
      value,
      count: counts.length > 1 ? Math.max(...counts.slice(1)) : 0,
      selected: selected.has(value),
    }))
    .sort((a, b) => byValue(a.value, b.value));
};

export const disjunctiveFacets = async (
  port: KnowledgePort,
  fields: string[],
  specs: FieldSpec[],
): Promise<FacetField[]> => {
  const withSelections = specs.filter((s) => s.selected.length > 0);
  const main =
    withSelections.length > 0
      ? await port.facets(fields, toPortFilters(withSelections))
      : undefined;
  const all = await port.facets(fields);
  const own = new Map<string, FacetValue[]>();
  for (const spec of withSelections) {
    if (!fields.includes(spec.field) || own.has(spec.field)) continue;
    const others = toPortFilters(withSelections.filter((s) => s.field !== spec.field));
    const result = await port.facets(
      [spec.field],
      Object.keys(others).length > 0 ? others : undefined,
    );
    own.set(spec.field, result[spec.field] ?? []);
  }
  return fields.map((field) => {
    const spec = specs.find((s) => s.field === field);
    return {
      field,
      options: merge(
        [
          all[field] ?? [],
          (main ?? all)[field] ?? [],
          ...(own.has(field) ? [own.get(field) ?? []] : []),
        ],
        new Set(spec?.selected ?? []),
      ),
    };
  });
};
