import type {
  DocumentsRequest,
  FacetValue,
  FilterValue,
  KnowledgePort,
} from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { sourceFacts, type FactSource } from './source-facts.js';

interface Doc {
  id: string;
  title: string;
  year: number;
  org: string;
  publish_date: string;
}

const kudos: Doc[] = [
  { id: 'd1', title: 'Årsrapport 2024', year: 2024, org: 'DIGDIR', publish_date: '2025-03-01' },
  { id: 'd2', title: 'Tildelingsbrev 2025', year: 2025, org: 'DIGDIR', publish_date: '2025-01-10' },
  { id: 'd3', title: 'Evaluering 2025', year: 2025, org: 'NAV', publish_date: '2025-06-20' },
  { id: 'd4', title: 'Årsrapport 2023', year: 2023, org: 'NAV', publish_date: '2024-03-01' },
  { id: 'd5', title: 'Hemmelig 2026', year: 2026, org: 'SKATT', publish_date: '2026-02-01' },
];

const matches = (doc: Doc, filters: Record<string, FilterValue> = {}) =>
  Object.entries(filters).every(([field, value]) => {
    const clauses =
      typeof value === 'object' && !Array.isArray(value) && 'all' in value ? value.all : [value];
    const own = doc[field as keyof Doc];
    return clauses.every((c) => (Array.isArray(c) ? (c as unknown[]).includes(own) : c === own));
  });

const port = (docs: Doc[], seen: Record<string, FilterValue>[] = []): KnowledgePort => {
  const within = (filters?: Record<string, FilterValue>) => {
    seen.push(filters ?? {});
    return docs.filter((d) => matches(d, filters));
  };
  const unused = () => Promise.reject(new Error('not used'));
  return {
    info: () => ({
      id: 'digdir/kudos',
      residency: 'norway',
      filters: { year: 'multiselect', org: 'multiselect', doc_num: 'multiselect', title: 'text' },
      profiles: [],
      capabilities: ['facets', 'filter.multiselect', 'filter.text'],
    }),
    search: unused,
    searchMany: unused,
    fetch: unused,
    range: unused,
    facets: async (fields, filters) => {
      const found = within(filters);
      return Object.fromEntries(
        fields.map((field): [string, FacetValue[]] => {
          const counts = new Map<string, number>();
          for (const d of found) {
            const value = String(d[field as keyof Doc]);
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [field, [...counts].map(([value, count]) => ({ value, count }))];
        }),
      );
    },
    documents: async (request: DocumentsRequest) => {
      const found = within(request.filters);
      const offset = request.offset ?? 0;
      return {
        documents: found.slice(offset, offset + (request.limit ?? 100)).map((d) => ({
          id: d.id,
          title: d.title,
          url: `https://kudos.dfo.no/${d.id}`,
          fields: { publish_date: d.publish_date },
        })),
        found: found.length,
      };
    },
  };
};

const signal = new AbortController().signal;

const source = (knowledge: KnowledgePort): FactSource => ({
  id: 'digdir/kudos',
  name: 'Kudos',
  knowledge,
  valueTypes: { year: 'integer' },
  lastImport: async () => '2026-11-15T03:12:00.000Z',
});

describe('source facts', () => {
  it("returns the count, last import, newest documents and filter values of a service's source", async () => {
    const [facts] = await sourceFacts([source(port(kudos))], undefined, { newest: 3 }, signal);

    expect(facts).toMatchObject({
      id: 'digdir/kudos',
      name: 'Kudos',
      inScope: true,
      documents: 5,
      lastImport: '2026-11-15T03:12:00.000Z',
      yearField: 'year',
      newestOrder: 'date-within-latest-years',
    });
    expect(facts?.newest.map((d) => [d.id, d.date, d.year])).toEqual([
      ['d5', '2026-02-01', '2026'],
      ['d3', '2025-06-20', '2025'],
      ['d2', '2025-01-10', '2025'],
    ]);
    expect(facts?.filterValues.year?.map((v) => v.value)).toEqual(['2026', '2025', '2024', '2023']);
    expect(facts?.filterValues.org).toContainEqual({ value: 'NAV', count: 2 });
    expect(Object.keys(facts?.filterValues ?? {})).toEqual(['year', 'org']);
  });

  it("never counts, lists or names documents outside the service's filter scope", async () => {
    const seen: Record<string, FilterValue>[] = [];
    const scope = { org: ['DIGDIR', 'NAV'] };

    const [facts] = await sourceFacts([source(port(kudos, seen))], scope, { newest: 10 }, signal);

    expect(facts?.documents).toBe(4);
    expect(facts?.newest.map((d) => d.id)).not.toContain('d5');
    expect(JSON.stringify(facts)).not.toContain('SKATT');
    expect(JSON.stringify(facts)).not.toContain('Hemmelig');
    expect(seen.every((filters) => JSON.stringify(filters.org) === '["DIGDIR","NAV"]')).toBe(true);
  });

  it('keeps a scope on the year field when it narrows to the newest years', async () => {
    const [facts] = await sourceFacts(
      [source(port(kudos))],
      { year: [2023, 2024] },
      { newest: 5 },
      signal,
    );

    expect(facts?.documents).toBe(2);
    expect(facts?.newest.map((d) => d.id)).toEqual(['d1', 'd4']);
  });

  it('reports a source that cannot hold the service filter as out of scope, with nothing from it', async () => {
    const [facts] = await sourceFacts(
      [source(port(kudos))],
      { product: ['Maskinporten'] },
      { newest: 5 },
      signal,
    );

    expect(facts).toEqual({
      id: 'digdir/kudos',
      name: 'Kudos',
      inScope: false,
      documents: 0,
      newest: [],
      filterValues: {},
    });
  });
});
