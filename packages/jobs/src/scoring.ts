import type { EvalContext, Evaluator, Observation, Score, TestSet } from '@genai/eval';
import type { BatchResult } from './batch.js';

export interface BatchScore {
  testSet: string;
  cases: { id: string; scores: Score[] }[];
  metrics: Record<string, { mean: number; n: number }>;
  unmatched: string[];
}

export const scoreBatch = async (
  result: BatchResult,
  testSet: TestSet,
  evaluators: Evaluator[],
  ctx: EvalContext,
): Promise<BatchScore> => {
  const cases = new Map(testSet.spec.cases.map((c) => [c.id, c]));
  const scored: BatchScore['cases'] = [];
  const unmatched: string[] = [];
  for (const item of result.items) {
    const testCase = cases.get(item.id);
    if (!testCase || item.status !== 'succeeded') {
      unmatched.push(item.id);
      continue;
    }
    const fields =
      item.json && typeof item.json === 'object' && !Array.isArray(item.json)
        ? (item.json as Record<string, unknown>)
        : undefined;
    const observation: Observation = {
      answer: item.text ?? (typeof fields?.text === 'string' ? fields.text : ''),
      retrieved: [],
      citations: [],
      ...(fields ? { fields } : {}),
    };
    const scores = (
      await Promise.all(evaluators.map((e) => e.evaluate(testCase, observation, ctx)))
    ).flat();
    scored.push({ id: item.id, scores });
  }
  const sums = new Map<string, { total: number; n: number }>();
  for (const c of scored)
    for (const s of c.scores) {
      if (!s.applicable || s.value === null) continue;
      const entry = sums.get(s.metric) ?? { total: 0, n: 0 };
      entry.total += s.value;
      entry.n += 1;
      sums.set(s.metric, entry);
    }
  return {
    testSet: testSet.metadata.id,
    cases: scored,
    metrics: Object.fromEntries([...sums].map(([m, { total, n }]) => [m, { mean: total / n, n }])),
    unmatched,
  };
};
