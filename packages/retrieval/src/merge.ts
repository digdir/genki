export interface StrategyHit {
  id: string;
  rank: number;
  index: number;
  searchType: string;
  document?: string;
  matchedQuestion?: string;
}

export interface MergedHit {
  id: string;
  rank: number;
  index: number;
  searchTypes: string[];
  hitCount: number;
  rawHitCount: number;
  typeRanks: Record<string, number>;
  matchedQuestions?: string[];
}

export const mergeModes = ['weighted-sum', 'rrf', 'rrf-with-score', 'combmnz'] as const;
export type MergeMode = (typeof mergeModes)[number];

export interface MergeOptions {
  mode: MergeMode;
  weights: Record<string, number>;
  caps: Record<string, number>;
  rrfK: number;
}

export const defaultStrategyWeights: Record<string, number> = {
  content: 1.0,
  'doc-title': 0.8,
  phrase: 0.7,
  metadata: 0.2,
  unknown: 0.15,
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const groupBy = <T>(items: T[], key: (t: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
};

export const dedupeHits = (hits: StrategyHit[]): StrategyHit[] =>
  [...groupBy(hits, (h) => h.id).values()]
    .map(
      (group) =>
        [...group].sort((a, b) => num(b.rank) - num(a.rank) || a.index - b.index)[0] as StrategyHit,
    )
    .sort((a, b) => a.index - b.index);

export const normalizeRanks = (hits: StrategyHit[]): StrategyHit[] => {
  if (hits.length === 0) return hits;
  const ranks = hits.map((h) => num(h.rank));
  const min = Math.min(...ranks);
  const range = Math.max(...ranks) - min;
  return hits.map((h) => ({ ...h, rank: range === 0 ? 1.0 : (num(h.rank) - min) / range }));
};

const weight = (options: MergeOptions, type: string) => options.weights[type] ?? 0;
const cap = (options: MergeOptions, type: string) => options.caps[type] ?? 1;

const summarize = (hits: StrategyHit[], options: MergeOptions): Omit<MergedHit, 'id'> => {
  const byType = groupBy(hits, (h) => h.searchType || 'unknown');
  const bestIndex = Math.min(...hits.map((h) => h.index));
  const hitCount = [...byType].reduce(
    (acc, [type, typeHits]) => acc + Math.min(typeHits.length, cap(options, type)),
    0,
  );
  const typeRanks: Record<string, number> = {};
  let rank: number;

  if (options.mode === 'rrf') {
    for (const [type, typeHits] of byType) {
      const best = Math.min(...typeHits.map((h) => h.index)) + 1;
      typeRanks[type] = weight(options, type) * (1 / (options.rrfK + best));
    }
    rank = Object.values(typeRanks).reduce((a, b) => a + b, 0);
  } else if (options.mode === 'rrf-with-score') {
    for (const [type, typeHits] of byType) {
      const best = typeHits.reduce((a, b) => (b.index < a.index ? b : a));
      typeRanks[type] =
        weight(options, type) * num(best.rank) * (1 / (options.rrfK + best.index + 1));
    }
    rank = Object.values(typeRanks).reduce((a, b) => a + b, 0);
  } else {
    for (const [type, typeHits] of byType)
      typeRanks[type] = Math.max(...typeHits.map((h) => num(h.rank)));
    const weighted = Object.entries(typeRanks).reduce(
      (acc, [type, r]) => acc + weight(options, type) * r,
      0,
    );
    if (options.mode === 'combmnz') rank = weighted * byType.size;
    else {
      const bestRank = byType.size > 0 ? Math.max(...Object.values(typeRanks)) : 0;
      rank = weighted > 0 ? weighted : bestRank;
    }
  }
  const matched = [...new Set(hits.flatMap((h) => (h.matchedQuestion ? [h.matchedQuestion] : [])))];
  return {
    ...(matched.length > 0 ? { matchedQuestions: matched } : {}),
    rank,
    index: bestIndex,
    searchTypes: [...byType.keys()],
    hitCount,
    rawHitCount: hits.length,
    typeRanks,
  };
};

export const mergeStrategyLists = (lists: StrategyHit[][], options: MergeOptions): MergedHit[] => {
  const prepared = options.mode === 'rrf' ? lists : lists.map(normalizeRanks);
  return [...groupBy(prepared.flat(), (h) => h.id)]
    .map(([id, hits]) => ({ id, ...summarize(hits, options) }))
    .sort((a, b) => b.rank - a.rank || b.hitCount - a.hitCount || a.index - b.index);
};
