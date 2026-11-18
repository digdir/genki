import type { FacetValue, Hit } from '@genai/port-knowledge';
import { selectedOptions, type FilterInput } from './filters.js';
import {
  containsFoldedWord,
  foldCase,
  foldNordic,
  intersect,
  metadataMap,
  numbersIn,
  queryYearsIn,
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
  for (const q of queries) for (const y of queryYearsIn(q)) years.add(y);
  return years;
};

export const prioritize = (
  chunks: Chunk[],
  queries: string[],
  filters: Record<string, FilterInput>,
  orgFields: string[],
  weights: BoostWeights,
  useContent: boolean,
  detectedOrgs: string[] = [],
): Chunk[] => {
  const queryTokens = new Set(queries.flatMap((q) => [...tokenize(q)]));
  const years = queryYears(queries);
  const numeric = isNumericFactQuery(queries);
  const filterOrgs = new Set([
    ...orgFields.flatMap((f) => selectedOptions(filters, f)),
    ...detectedOrgs,
  ]);
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

export type DetectionUse = 'boost' | 'hint' | 'filter';

export interface Detection {
  kind: 'organisation' | 'year' | 'rule';
  field: string;
  values: string[];
  queries: string[];
  use: DetectionUse;
}

export type Detected = Pick<Detection, 'field' | 'values' | 'queries'>;

export type AliasTable = Record<string, string[]>;

interface MatchName {
  plain: string;
  nordic?: string;
  reports: string[];
}

const matchNames = (
  facetValues: FacetValue[],
  minLength: number,
  aliases: AliasTable,
): MatchName[] => {
  const indexed = new Map<string, string>();
  for (const { value } of facetValues) {
    const key = foldCase(value);
    if (key !== '' && !indexed.has(key)) indexed.set(key, value);
  }
  const reportsByName = new Map<string, { name: string; reports: Set<string> }>();
  const add = (name: string, report: string) => {
    const key = foldCase(name);
    const entry = reportsByName.get(key) ?? { name, reports: new Set<string>() };
    entry.reports.add(report);
    reportsByName.set(key, entry);
  };
  for (const [key, value] of indexed) if (key.length >= minLength) add(value, value);
  for (const [head, rest] of Object.entries(aliases)) {
    const group = [head, ...rest].map((n) => n.trim()).filter((n) => n !== '');
    const reports = group.flatMap((n) => indexed.get(foldCase(n)) ?? []);
    for (const name of group) for (const report of reports) add(name, report);
  }
  const entries = [...reportsByName.entries()].map(([plain, { reports }]) => ({
    plain,
    folded: foldNordic(plain),
    reports: [...reports],
  }));
  const signatures = new Map<string, Set<string>>();
  for (const e of entries) {
    const seen = signatures.get(e.folded) ?? new Set<string>();
    seen.add(e.reports.join('\u0000'));
    signatures.set(e.folded, seen);
  }
  return entries.map(({ plain, folded, reports }) => ({
    plain,
    reports,
    ...([...plain].length >= 3 && signatures.get(folded)?.size === 1 ? { nordic: folded } : {}),
  }));
};

export const detectOrganisations = (
  queries: string[],
  facets: Record<string, FacetValue[]>,
  orgFields: string[],
  minLength: number,
  aliases: AliasTable = {},
): Detected[] => {
  const plain = queries.map(foldCase);
  const nordic = queries.map(foldNordic);
  return orgFields.flatMap((field) => {
    const values = new Set<string>();
    const found = new Set<number>();
    for (const name of matchNames(facets[field] ?? [], minLength, aliases)) {
      const naming = queries.flatMap((_, i) =>
        containsFoldedWord(plain[i] as string, name.plain) ||
        (name.nordic !== undefined && containsFoldedWord(nordic[i] as string, name.nordic))
          ? [i]
          : [],
      );
      if (naming.length === 0) continue;
      for (const value of name.reports) values.add(value);
      for (const i of naming) found.add(i);
    }
    return values.size > 0
      ? [{ field, values: [...values], queries: queries.filter((_, i) => found.has(i)) }]
      : [];
  });
};

export const detectYears = (queries: string[]): string[] => [...queryYears(queries)];

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
