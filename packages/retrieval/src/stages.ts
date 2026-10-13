import type { FacetValue, Hit } from '@genai/port-knowledge';
import { selectedOptions, type FilterInput } from './filters.js';
import {
  containsWord,
  intersect,
  metadataMap,
  numbersIn,
  tokenize,
  yearsIn,
  javaBoundary,
} from './text.js';

export interface Chunk {
  id: string;
  document?: string;
  position?: number;
  title?: string;
  url?: string;
  text?: string;
  metadata?: string;
  snippet?: string;
  matchedQuestions?: string[];
  searchTypes: string[];
  hitCount: number;
  originalRank: number;
  originalIndex: number;
  typeRanks: Record<string, number>;
  fileDigests: string[];
  orgs: string[];
  retrievalPrior?: number;
  retrievalBoosts?: Record<string, number>;
  rerankScore?: number;
  rerankRank?: number;
  fields: Record<string, unknown>;
}

const nested = (fields: Record<string, unknown>, name: string): unknown => {
  if (name in fields) return fields[name];
  for (const value of Object.values(fields)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && name in value)
      return (value as Record<string, unknown>)[name];
  }
  return undefined;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export const fileDigestsOf = (hit: Hit): string[] => {
  const flat = strings(nested(hit.fields, 'file_sha256'));
  if (flat.length > 0) return flat;
  const files = nested(hit.fields, 'files');
  return Array.isArray(files)
    ? files.flatMap((f: unknown) => {
        const sha = (f as { sha256?: unknown } | null)?.sha256;
        return typeof sha === 'string' ? [sha] : [];
      })
    : [];
};

export const orgsOf = (hit: Hit, orgFields: string[]): string[] => {
  const fromDoc = orgFields.flatMap((f) => strings(nested(hit.fields, f)));
  const parsed = metadataMap(hit.fields.metadata);
  const fromMetadata = parsed ? orgFields.flatMap((f) => strings(parsed.get(f))) : [];
  return [...new Set([...fromDoc, ...fromMetadata])];
};

export interface BoostWeights {
  titleOverlapPerToken: number;
  titleOverlapMax: number;
  contentOverlapPerToken: number;
  contentOverlapMax: number;
  yearMatch: number;
  orgFilterMatch: number;
  contentSearchType: number;
  phraseSearchType: number;
  metadataSearchType: number;
  numericEvidence: number;
  originalRankWeight: number;
}

const numericQuery = new RegExp(
  `${javaBoundary}(hvor mange|kor mange|how many|antall|number of)${javaBoundary}|${javaBoundary}(årsverk|ansatte|employees|fte|stillinger)${javaBoundary}`,
  'u',
);

export const isNumericFactQuery = (queries: string[]) =>
  numericQuery.test(queries.join(' ').toLowerCase());

export const queryYears = (queries: string[]) => {
  const years = new Set<string>();
  for (const q of queries) for (const y of yearsIn(q)) years.add(y);
  return years;
};

export const prioritize = (
  chunks: Chunk[],
  queries: string[],
  filters: Record<string, FilterInput>,
  orgFields: string[],
  weights: BoostWeights,
  useContent: boolean,
): Chunk[] => {
  const queryTokens = new Set(queries.flatMap((q) => [...tokenize(q)]));
  const years = queryYears(queries);
  const numeric = isNumericFactQuery(queries);
  const filterOrgs = new Set(orgFields.flatMap((f) => selectedOptions(filters, f)));
  return chunks
    .map((chunk) => {
      const title = chunk.title ?? '';
      const titleBoost = Math.min(
        weights.titleOverlapMax,
        weights.titleOverlapPerToken * intersect(queryTokens, tokenize(title)).size,
      );
      const yearBoost = intersect(years, yearsIn(title)).size > 0 ? weights.yearMatch : 0;
      const orgBoost = chunk.orgs.some((o) => filterOrgs.has(o)) ? weights.orgFilterMatch : 0;
      const searchable = [title, chunk.metadata ?? '', useContent ? (chunk.text ?? '') : '']
        .filter((s) => s.trim() !== '')
        .join(' ');
      const overlap = intersect(queryTokens, tokenize(searchable)).size;
      const overlapBoost = Math.min(
        weights.contentOverlapMax,
        weights.contentOverlapPerToken * overlap,
      );
      const hasYear = years.size > 0 && intersect(years, yearsIn(searchable)).size > 0;
      const hasNumber = numbersIn(searchable).some((n) => !years.has(n.trim()));
      const numericBoost =
        numeric && hasYear && hasNumber && overlap > 0 ? weights.numericEvidence : 0;
      const types = new Set(chunk.searchTypes);
      const strategyBoost =
        (types.has('content') ? weights.contentSearchType : 0) +
        (types.has('phrase') ? weights.phraseSearchType : 0) +
        (types.has('metadata') ? weights.metadataSearchType : 0);
      const prior =
        chunk.hitCount +
        weights.originalRankWeight * chunk.originalRank +
        titleBoost +
        yearBoost +
        orgBoost +
        strategyBoost +
        overlapBoost +
        numericBoost;
      return {
        ...chunk,
        retrievalPrior: prior,
        retrievalBoosts: {
          title: titleBoost,
          year: yearBoost,
          org: orgBoost,
          searchType: strategyBoost,
          contentOverlap: overlapBoost,
          numericEvidence: numericBoost,
        },
      };
    })
    .sort(
      (a, b) =>
        (b.retrievalPrior ?? 0) - (a.retrievalPrior ?? 0) ||
        b.hitCount - a.hitCount ||
        b.originalRank - a.originalRank ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
};

export interface DiversityConfig {
  relaxMinTotal: number;
  relaxMinDocs: number;
  relaxMinTopDocCount: number;
  relaxMinTopDocShare: number;
  relaxedMaxPerDocument: number;
  defaultMaxPerDocument: number;
}

const docKey = (c: Chunk) => c.document ?? c.id;

export const relaxedCap = (
  chunks: Chunk[],
  defaultCap: number,
  config: DiversityConfig,
): number => {
  const freqs = new Map<string, number>();
  for (const c of chunks) freqs.set(docKey(c), (freqs.get(docKey(c)) ?? 0) + 1);
  const total = chunks.length;
  const top = freqs.size > 0 ? Math.max(...freqs.values()) : 0;
  const share = total > 0 ? top / total : 0;
  return defaultCap === config.defaultMaxPerDocument &&
    total >= config.relaxMinTotal &&
    freqs.size >= config.relaxMinDocs &&
    top >= config.relaxMinTopDocCount &&
    share >= config.relaxMinTopDocShare
    ? config.relaxedMaxPerDocument
    : defaultCap;
};

export const capPerDocument = (chunks: Chunk[], max: number): Chunk[] => {
  if (!(max > 0)) return chunks;
  const counts = new Map<string, number>();
  return chunks.filter((c) => {
    const n = counts.get(docKey(c)) ?? 0;
    if (n >= max) return false;
    counts.set(docKey(c), n + 1);
    return true;
  });
};

export const suppressDuplicateFiles = (chunks: Chunk[]): Chunk[] => {
  const claimed = new Map<string, string | undefined>();
  return chunks.filter((c) => {
    if (c.fileDigests.length !== 1) return true;
    const digest = c.fileDigests[0] as string;
    if (!claimed.has(digest)) {
      claimed.set(digest, c.document);
      return true;
    }
    return claimed.get(digest) === c.document;
  });
};

export const detectOrgFilter = (
  queries: string[],
  facets: Record<string, FacetValue[]>,
  orgFields: string[],
  minLength: number,
): { field: string; values: string[] } | undefined => {
  if (queries.length === 0) return undefined;
  const text = queries.join(' ');
  for (const field of orgFields) {
    const matches = [
      ...new Set(
        (facets[field] ?? [])
          .filter((f) => f.value.length >= minLength && containsWord(text, f.value))
          .map((f) => f.value),
      ),
    ];
    if (matches.length > 0) return { field, values: matches };
  }
  return undefined;
};

export const detectYears = (queries: string[]): string[] =>
  queries.length === 0 ? [] : [...yearsIn(queries.join(' '))];

export const unionModes = ['cap', 'interleave', 'rrf'] as const;
export type UnionMode = (typeof unionModes)[number];

const interleave = (a: Chunk[], b: Chunk[]): Chunk[] => {
  const out: Chunk[] = [];
  const seen = new Set<string>();
  let ai = 0;
  let bi = 0;
  while (ai < a.length || bi < b.length) {
    const fromA = ai < a.length && (bi >= b.length || (ai + bi) % 2 === 0);
    const x = (fromA ? a[ai++] : b[bi++]) as Chunk;
    if (!seen.has(x.id)) {
      out.push(x);
      seen.add(x.id);
    }
  }
  return out;
};

const capMerge = (a: Chunk[], b: Chunk[], n: number): Chunk[] => {
  const prefix = a.slice(0, n);
  const ids = new Set(prefix.map((c) => c.id));
  return [...prefix, ...b.filter((c) => !ids.has(c.id))];
};

const rrfMerge = (a: Chunk[], b: Chunk[], k: number): Chunk[] => {
  const scores = (list: Chunk[]) => new Map(list.map((c, i) => [c.id, 1 / (k + i + 1)]));
  const sa = scores(a);
  const sb = scores(b);
  const byId = new Map<string, Chunk>();
  for (const c of [...b, ...a]) byId.set(c.id, c);
  const ids = [...new Set([...a.map((c) => c.id), ...b.map((c) => c.id)])];
  return ids
    .map((id) => ({ chunk: byId.get(id) as Chunk, score: (sa.get(id) ?? 0) + (sb.get(id) ?? 0) }))
    .sort((x, y) => y.score - x.score)
    .map((x) => x.chunk);
};

export const unionMerge = (
  intent: Chunk[],
  expansion: Chunk[],
  mode: UnionMode,
  capN: number,
  rrfK: number,
): Chunk[] =>
  mode === 'interleave'
    ? interleave(intent, expansion)
    : mode === 'rrf'
      ? rrfMerge(intent, expansion, rrfK)
      : capMerge(intent, expansion, capN);
