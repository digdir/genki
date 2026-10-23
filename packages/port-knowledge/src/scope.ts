import type { FilterValue, Hit, KnowledgePort, SearchRequest, SearchResult } from './port.js';

export interface DocumentScopeOptions {
  field?: string;
  maxChunks?: number;
}

const rangeWindow = 50;

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export const unreachableKnowledge = (port: KnowledgePort): KnowledgePort => ({
  info: () => port.info(),
  search: async () => ({ hits: [] }),
  searchMany: async (requests) => requests.map(() => ({ hits: [] })),
  fetch: async () => [],
  range: async () => [],
  facets: async (fields) => Object.fromEntries(fields.map((f) => [f, []])),
  documents: async () => ({ documents: [], found: 0 }),
});

export const scopeToDocument = (
  port: KnowledgePort,
  document: string,
  options: DocumentScopeOptions = {},
): KnowledgePort => {
  const field = options.field ?? 'doc_num';
  const maxChunks = options.maxChunks ?? 400;
  const filtered = field in port.info().filters;
  let chunks: Promise<Hit[]> | undefined;

  const read = () => {
    chunks ??= (async () => {
      const out: Hit[] = [];
      for (let from = 0; from < maxChunks; from += rangeWindow) {
        const window = await port.range(document, from, from + rangeWindow - 1);
        out.push(...window);
        if (window.length < rangeWindow) break;
      }
      return out;
    })();
    return chunks;
  };

  const own = (hit: Hit) => (hit.document ?? document) === document;

  const withScope = (filters: Record<string, FilterValue> = {}) => ({
    ...filters,
    [field]: [document],
  });

  const ranked = async (request: SearchRequest): Promise<SearchResult> => {
    const wanted = words(request.query);
    const all = await read();
    const scored = all
      .map((hit) => ({
        hit,
        score: [...words(hit.text)].filter((w) => wanted.has(w)).length,
      }))
      .sort((a, b) => b.score - a.score || (a.hit.position ?? 0) - (b.hit.position ?? 0));
    const limit = request.limit ?? 10;
    return {
      hits: scored.slice(0, limit).map(({ hit, score }) => ({ ...hit, score })),
      found: all.length,
    };
  };

  const search = async (request: SearchRequest): Promise<SearchResult> => {
    if (!filtered) return ranked(request);
    const result = await port.search({ ...request, filters: withScope(request.filters) });
    return { ...result, hits: result.hits.filter(own) };
  };

  return {
    info: () => port.info(),
    search,
    searchMany: async (requests) =>
      filtered
        ? (
            await port.searchMany(requests.map((r) => ({ ...r, filters: withScope(r.filters) })))
          ).map((result) => ({ ...result, hits: result.hits.filter(own) }))
        : Promise.all(requests.map(ranked)),
    fetch: async (ids) => (await port.fetch(ids)).filter(own),
    range: async (doc, from, to) => (doc === document ? port.range(doc, from, to) : []),
    facets: (fields, filters) =>
      filtered
        ? port.facets(fields, withScope(filters))
        : Promise.resolve(Object.fromEntries(fields.map((f) => [f, []]))),
    documents: async (request) => {
      if (request.ids && !request.ids.includes(document)) return { documents: [], found: 0 };
      if (!port.documents) return { documents: [], found: 0 };
      return port.documents({ ...request, ids: [document] });
    },
  };
};
