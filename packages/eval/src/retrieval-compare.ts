import { sameSource } from './observe.js';
import type { SourceRef, TestCase } from './schema.js';

export interface RetrievalCase {
  id: string;
  question: string;
  expected: SourceRef[];
}

export interface RetrievedHit extends SourceRef {
  title?: string;
  text?: string;
}

export interface RetrievalRun {
  hits: RetrievedHit[];
  latencyMs: number;
  error?: string;
}

export type RetrievalVerdict = 'same' | 'better' | 'worse';

export interface RetrievalSideExample {
  first?: string;
  rank: number | null;
}

export interface RetrievalExample {
  case: string;
  question: string;
  old: RetrievalSideExample;
  new: RetrievalSideExample;
  verdict: RetrievalVerdict;
}

export interface RetrievalComparison {
  testSets: string[];
  cases: number;
  k: number;
  hitAt5: [number, number];
  meanRank: [number | null, number | null];
  latencyMs: [number, number];
  errors: [number, number];
  verdict: RetrievalVerdict;
  examples: RetrievalExample[];
}

export interface CompareRetrievalInput {
  cases: RetrievalCase[];
  old: Record<string, RetrievalRun>;
  new: Record<string, RetrievalRun>;
  testSets?: string[];
  k?: number;
  maxExamples?: number;
}

const textOf = (input: TestCase['input']): string | undefined => {
  if (typeof input === 'string') return input;
  for (const part of input.parts ?? []) {
    const p = part as { kind?: string; text?: unknown };
    if (p.kind === 'text' && typeof p.text === 'string' && p.text.trim()) return p.text;
  }
  const data = input.data as Record<string, unknown> | undefined;
  for (const key of ['query', 'question', 'text'])
    if (typeof data?.[key] === 'string' && data[key]) return data[key];
  return undefined;
};

export const retrievalCases = (cases: TestCase[]): RetrievalCase[] =>
  cases.flatMap((c) => {
    const question = textOf(c.input);
    return c.grounding === 'sources-and-answer' && c.expected.sources.length > 0 && question
      ? [{ id: c.id, question, expected: c.expected.sources }]
      : [];
  });

const rankOf = (expected: SourceRef[], run: RetrievalRun | undefined): number | null => {
  const at = (run?.hits ?? []).findIndex((hit) => expected.some((e) => sameSource(e, hit)));
  return at < 0 ? null : at + 1;
};

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const mean = (values: number[]) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

const rounded = (value: number, digits = 3) => Number(value.toFixed(digits));

const caseVerdict = (old: number | null, next: number | null): RetrievalVerdict => {
  const a = old ?? Number.POSITIVE_INFINITY;
  const b = next ?? Number.POSITIVE_INFINITY;
  return a === b ? 'same' : b < a ? 'better' : 'worse';
};

const sideOf = (run: RetrievalRun | undefined, rank: number | null): RetrievalSideExample => {
  const hit = run?.hits[0];
  const first = hit ? (hit.title ?? hit.document ?? hit.chunkId) : undefined;
  return { ...(first ? { first } : {}), rank };
};

const order: Record<RetrievalVerdict, number> = { worse: 0, better: 1, same: 2 };

export const compareRetrieval = (input: CompareRetrievalInput): RetrievalComparison => {
  const k = input.k ?? 5;
  const ranks = input.cases.map((c) => ({
    c,
    old: rankOf(c.expected, input.old[c.id]),
    new: rankOf(c.expected, input.new[c.id]),
  }));
  const hitRate = (side: 'old' | 'new') =>
    ranks.length === 0
      ? 0
      : rounded(
          ranks.filter((r) => r[side] !== null && (r[side] as number) <= k).length / ranks.length,
        );
  const meanRank = (side: 'old' | 'new') => {
    const found = mean(ranks.flatMap((r) => (r[side] === null ? [] : [r[side] as number])));
    return found === null ? null : rounded(found, 2);
  };
  const latency = (runs: Record<string, RetrievalRun>) =>
    rounded(
      median(input.cases.flatMap((c) => (runs[c.id] ? [runs[c.id]?.latencyMs as number] : []))),
      1,
    );
  const errors = (runs: Record<string, RetrievalRun>) =>
    input.cases.filter((c) => runs[c.id]?.error !== undefined).length;

  const hitAt5: [number, number] = [hitRate('old'), hitRate('new')];
  const ranksMean: [number | null, number | null] = [meanRank('old'), meanRank('new')];
  let verdict: RetrievalVerdict = 'same';
  if (hitAt5[1] !== hitAt5[0]) verdict = hitAt5[1] > hitAt5[0] ? 'better' : 'worse';
  else if (
    ranksMean[0] !== null &&
    ranksMean[1] !== null &&
    Math.abs(ranksMean[1] - ranksMean[0]) >= 0.5
  )
    verdict = ranksMean[1] < ranksMean[0] ? 'better' : 'worse';

  const examples = ranks
    .map((r): RetrievalExample => ({
      case: r.c.id,
      question: r.c.question,
      old: sideOf(input.old[r.c.id], r.old),
      new: sideOf(input.new[r.c.id], r.new),
      verdict: caseVerdict(r.old, r.new),
    }))
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .slice(0, input.maxExamples ?? 5);

  return {
    testSets: input.testSets ?? [],
    cases: input.cases.length,
    k,
    hitAt5,
    meanRank: ranksMean,
    latencyMs: [latency(input.old), latency(input.new)],
    errors: [errors(input.old), errors(input.new)],
    verdict,
    examples,
  };
};
