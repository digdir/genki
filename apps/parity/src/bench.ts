import type { FixedRetrieval, Retriever, RetrieveRequest } from './diagnostics.js';
import { matchesSource, type QualityCase } from './quality.js';
import { meanWithCi } from './sweep.js';
import type { JsonValue } from './types.js';

export interface CaseRetrieval {
  id: string;
  rank?: number;
  chunkRecall: Record<number, number>;
  documentRecall: Record<number, number>;
  ms: number;
  detectedFilter?: JsonValue;
  rerank?: string;
  error?: string;
}

export interface RetrievalScore {
  cases: number;
  errors: number;
  chunkRecall: Record<number, number | undefined>;
  documentRecall: Record<number, number | undefined>;
  meanRank: number | undefined;
  latencyMs: number | undefined;
  perCase: CaseRetrieval[];
}

const average = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;

export const goldenRank = (chunks: FixedRetrieval['chunks'], c: QualityCase) => {
  const index = chunks.findIndex((h) => c.sources.some((s) => matchesSource(h, s)));
  return index === -1 ? undefined : index + 1;
};

const recall = (
  chunks: FixedRetrieval['chunks'],
  c: QualityCase,
  k: number,
  byDocument: boolean,
) => {
  const top = chunks.slice(0, k);
  const found = c.sources.filter((s) =>
    byDocument
      ? s.document !== undefined && top.some((h) => h.document === s.document)
      : top.some((h) => matchesSource(h, s)),
  ).length;
  return found / c.sources.length;
};

export const scoreCase = async (
  c: QualityCase,
  retriever: Retriever,
  request: Omit<RetrieveRequest, 'queries'>,
  ks: number[],
): Promise<CaseRetrieval> => {
  try {
    const result = await retriever({ ...request, queries: [c.question] });
    const rank = goldenRank(result.chunks, c);
    return {
      id: c.id,
      ...(rank === undefined ? {} : { rank }),
      chunkRecall: Object.fromEntries(ks.map((k) => [k, recall(result.chunks, c, k, false)])),
      documentRecall: Object.fromEntries(ks.map((k) => [k, recall(result.chunks, c, k, true)])),
      ms: result.ms,
      ...(result.detectedFilter === undefined ? {} : { detectedFilter: result.detectedFilter }),
      ...(result.rerank ? { rerank: result.rerank } : {}),
    };
  } catch (error) {
    return {
      id: c.id,
      chunkRecall: {},
      documentRecall: {},
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const summarizeScores = (perCase: CaseRetrieval[], ks: number[]): RetrievalScore => {
  const ok = perCase.filter((p) => !p.error);
  return {
    cases: perCase.length,
    errors: perCase.length - ok.length,
    chunkRecall: Object.fromEntries(
      ks.map((k) => [k, average(ok.map((p) => p.chunkRecall[k] as number))]),
    ),
    documentRecall: Object.fromEntries(
      ks.map((k) => [k, average(ok.map((p) => p.documentRecall[k] as number))]),
    ),
    meanRank: average(ok.flatMap((p) => (p.rank === undefined ? [] : [p.rank]))),
    latencyMs: average(ok.map((p) => p.ms)),
    perCase,
  };
};

export const scoreRetrieval = async (
  cases: QualityCase[],
  retriever: Retriever,
  request: Omit<RetrieveRequest, 'queries'> = {},
  ks: number[] = [10, 30],
): Promise<RetrievalScore> => {
  const perCase: CaseRetrieval[] = [];
  for (const c of cases.filter((x) => x.sources.length > 0))
    perCase.push(await scoreCase(c, retriever, request, ks));
  return summarizeScores(perCase, ks);
};

export interface ToggleComparison {
  name: string;
  off: RetrievalScore;
  on: RetrievalScore;
  recallDifference: { mean: number; ci: [number, number]; n: number } | undefined;
  gate: { maxAcceptableRank: number; failures: string[] };
  valid: boolean;
}

export const compareToggle = async (
  name: string,
  cases: QualityCase[],
  retriever: Retriever,
  toggle: (on: boolean) => Omit<RetrieveRequest, 'queries'>,
  maxAcceptableRank = 10,
): Promise<ToggleComparison> => {
  const off = await scoreRetrieval(cases, retriever, toggle(false));
  const on = await scoreRetrieval(cases, retriever, toggle(true));
  const offById = new Map(off.perCase.map((p) => [p.id, p]));
  const diffs = on.perCase.flatMap((p) => {
    const before = offById.get(p.id);
    return p.error || !before || before.error
      ? []
      : [(p.chunkRecall[10] ?? 0) - (before.chunkRecall[10] ?? 0)];
  });
  const failures = on.perCase.flatMap((p) =>
    p.error
      ? [`${p.id}: ${p.error}`]
      : p.rank === undefined || p.rank > maxAcceptableRank
        ? [`${p.id}: expected source at rank ${p.rank ?? 'none'}`]
        : [],
  );
  const stats = diffs.length ? meanWithCi(diffs) : undefined;
  return {
    name,
    off,
    on,
    recallDifference: stats ? { ...stats, n: diffs.length } : undefined,
    gate: { maxAcceptableRank, failures },
    valid: off.errors === 0 && on.errors === 0,
  };
};

const detectedText = (filter: JsonValue | undefined) =>
  filter === undefined || filter === null ? '' : JSON.stringify(filter).toLowerCase();

export interface AutoFilterCase {
  id: string;
  expected: string[];
  detected: JsonValue | undefined;
  missed: string[];
}

export const autoFilterDetections = (
  cases: QualityCase[],
  on: RetrievalScore,
): { checked: number; matched: number; perCase: AutoFilterCase[] } => {
  const byId = new Map(on.perCase.map((p) => [p.id, p]));
  const perCase = cases.flatMap((c) => {
    const expected = c.tags.flatMap((t) => {
      const year = /^year-(\d{4})$/.exec(t);
      return year ? [year[1] as string] : [];
    });
    const run = byId.get(c.id);
    if (expected.length === 0 || !run || run.error) return [];
    const text = detectedText(run.detectedFilter);
    return [
      {
        id: c.id,
        expected,
        detected: run.detectedFilter,
        missed: expected.filter((e) => !text.includes(e)),
      },
    ];
  });
  return {
    checked: perCase.length,
    matched: perCase.filter((p) => p.missed.length === 0).length,
    perCase,
  };
};

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export const renderScore = (label: string, score: RetrievalScore) =>
  `${label.padEnd(26)} chunk@10 ${pct(score.chunkRecall[10])}  chunk@30 ${pct(score.chunkRecall[30])}  doc@10 ${pct(score.documentRecall[10])}  doc@30 ${pct(score.documentRecall[30])}  rank ${score.meanRank?.toFixed(1) ?? 'n/a'}  ${score.latencyMs === undefined ? '' : `${Math.round(score.latencyMs)} ms`}  errors ${score.errors}/${score.cases}`;
