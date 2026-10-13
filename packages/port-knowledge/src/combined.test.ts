import { describe, expect, it } from 'vitest';
import { combineKnowledge, type Hit, type KnowledgePort, type SearchRequest } from './index.js';

const port = (
  id: string,
  options: { residency?: 'norway' | 'eu'; filters?: Record<string, 'select'> } = {},
) => {
  const seen: SearchRequest[] = [];
  const hit = (n: number): Hit => ({
    id: `c${n}`,
    score: 100 - n,
    text: `${id} ${n}`,
    document: `d${n}`,
    position: n,
    fields: {},
  });
  const knowledge: KnowledgePort = {
    info: () => ({
      id,
      residency: options.residency ?? 'eu',
      filters: options.filters ?? {},
      profiles: ['content'],
    }),
    search: async (r) => (await knowledge.searchMany([r]))[0] ?? { hits: [] },
    searchMany: async (requests) => {
      seen.push(...requests);
      return requests.map(() => ({ hits: [hit(1), hit(2), hit(3)], found: 3 }));
    },
    fetch: async (ids) => ids.map((i) => ({ ...hit(Number(i.slice(1))), id: i })),
    range: async (document, from, to) =>
      Array.from({ length: to - from + 1 }, (_, k) => ({ ...hit(from + k), document })),
    facets: async (fields) =>
      Object.fromEntries(fields.map((f) => [f, [{ value: 'Digdir', count: 2 }]])),
  };
  return { knowledge, seen };
};

describe('combineKnowledge', () => {
  it('returns the only port unchanged when there is one dataset', () => {
    const a = port('a');
    expect(combineKnowledge({ a: a.knowledge })).toBe(a.knowledge);
  });

  it('searches every dataset and interleaves the hits by rank', async () => {
    const a = port('a');
    const b = port('b');
    const combined = combineKnowledge({ a: a.knowledge, b: b.knowledge });
    const result = await combined.search({ query: 'tilskudd', profile: 'content', limit: 4 });
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
    expect(result.hits.map((h) => h.id)).toEqual(['a::c1', 'b::c1', 'a::c2', 'b::c2']);
    expect(result.found).toBe(6);
    expect(result.hits[1]?.document).toBe('b::d1');
    expect(result.hits[1]?.fields.dataset).toBe('b');
  });

  it('routes fetch and range back to the dataset a hit came from', async () => {
    const combined = combineKnowledge({ a: port('a').knowledge, b: port('b').knowledge });
    const fetched = await combined.fetch(['b::c2', 'a::c1', 'x::c1']);
    expect(fetched.map((h) => [h.id, h.text])).toEqual([
      ['b::c2', 'b 2'],
      ['a::c1', 'a 1'],
    ]);
    const range = await combined.range('a::d1', 1, 2);
    expect(range.map((h) => h.id)).toEqual(['a::c1', 'a::c2']);
  });

  it('skips datasets that lack a filtered field and adds facet counts', async () => {
    const a = port('a', { filters: { org: 'select' }, residency: 'norway' });
    const b = port('b');
    const combined = combineKnowledge({ a: a.knowledge, b: b.knowledge });
    await combined.search({ query: 'q', filters: { org: ['Digdir'] } });
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(0);
    expect(combined.info().residency).toBe('norway');
    expect(combined.info().filters).toEqual({ org: 'select' });
    expect(await combined.facets(['org'])).toEqual({ org: [{ value: 'Digdir', count: 2 }] });
  });
});
