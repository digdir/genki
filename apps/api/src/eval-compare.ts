import { caseView, mean, runState, type EvalRun, type TestSet } from '@genai/eval';
import { passes, verdictOf } from './service-eval.js';

export const caseChanges = ['worse', 'better', 'new', 'missing', 'pending', 'same'] as const;
export type CaseChange = (typeof caseChanges)[number];

export const isCaseChange = (value: unknown): value is CaseChange =>
  caseChanges.includes(value as CaseChange);

interface CaseOutcome {
  pass: boolean;
  score: number | null;
  reason?: string;
}

export interface ComparedCase {
  case: string;
  input: string;
  type: string;
  split: string;
  change: CaseChange;
  baseline: CaseOutcome | null;
  candidate: CaseOutcome | null;
}

const outcomesOf = (run: EvalRun) => {
  const byCase = new Map<string, EvalRun['results']>();
  for (const result of run.results)
    byCase.set(result.case, [...(byCase.get(result.case) ?? []), result]);
  return new Map(
    [...byCase].map(([id, results]): [string, CaseOutcome] => {
      const verdicts = results.map((r) => verdictOf(r.scores));
      const values = verdicts.flatMap((v) =>
        v?.state === 'scored' && typeof v.value === 'number' ? [v.value] : [],
      );
      const reason = verdicts.find((v) => v?.reason)?.reason;
      return [
        id,
        {
          pass: results.every((r) => passes(r.scores)),
          score: values.length > 0 ? mean(values) : null,
          ...(reason ? { reason } : {}),
        },
      ];
    }),
  );
};

const stillRunning = (run: EvalRun) => {
  const state = runState(run);
  return state === 'running' || state === 'waiting-for-scores';
};

const changeOf = (
  before: CaseOutcome | undefined,
  after: CaseOutcome | undefined,
  baseline: EvalRun,
  candidate: EvalRun,
): CaseChange => {
  if (before && after) return before.pass === after.pass ? 'same' : after.pass ? 'better' : 'worse';
  if (after) return stillRunning(baseline) ? 'pending' : 'new';
  return stillRunning(candidate) ? 'pending' : 'missing';
};

export const runSide = (run: EvalRun) => {
  const outcomes = outcomesOf(run);
  const passed = [...outcomes.values()].filter((o) => o.pass).length;
  const state = runState(run);
  return {
    id: run.id,
    status: state,
    version: run.tested?.version ?? 'draft',
    ...(run.tested?.variant ? { variant: run.tested.variant } : {}),
    ...(run.tested?.environment ? { environment: run.tested.environment } : {}),
    ...(run.tested?.split ? { split: run.tested.split } : {}),
    ...(run.tested?.selected ? { selected: run.tested.selected } : {}),
    testSetVersion: run.testSet.version,
    startedAt: run.startedAt,
    endedAt: stillRunning(run) ? null : run.endedAt,
    score: state === 'completed' && outcomes.size > 0 ? passed / outcomes.size : null,
    passed,
    cases: outcomes.size,
    judges: run.provenance.judges,
  };
};

export const compareCases = (
  baseline: { run: EvalRun; set: TestSet | undefined },
  candidate: { run: EvalRun; set: TestSet | undefined },
) => {
  const before = outcomesOf(baseline.run);
  const after = outcomesOf(candidate.run);
  const ids = [...new Set([...after.keys(), ...before.keys()])];
  const viewOf = (id: string) => {
    const found =
      candidate.set?.spec.cases.find((c) => c.id === id) ??
      baseline.set?.spec.cases.find((c) => c.id === id);
    return found ? caseView(found) : undefined;
  };
  const covers = (run: EvalRun, id: string, split: string | undefined) =>
    (!run.tested?.split || split === undefined || run.tested.split === split) &&
    (!run.tested?.selected || run.tested.selected.includes(id));
  const shared = ids.filter((id) => {
    const split = viewOf(id)?.split;
    return (
      (before.has(id) || covers(baseline.run, id, split)) &&
      (after.has(id) || covers(candidate.run, id, split))
    );
  });
  const compared = shared.map((id): ComparedCase => {
    const view = viewOf(id);
    return {
      case: id,
      input: view?.input ?? '',
      type: view?.type ?? 'criteria',
      split: view?.split ?? 'open',
      change: changeOf(before.get(id), after.get(id), baseline.run, candidate.run),
      baseline: before.get(id) ?? null,
      candidate: after.get(id) ?? null,
    };
  });
  const rank = (c: ComparedCase) => caseChanges.indexOf(c.change);
  const sorted = compared
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
  const counts = Object.fromEntries(caseChanges.map((c) => [c, 0])) as Record<CaseChange, number>;
  for (const c of compared) counts[c.change] += 1;
  return { cases: sorted, counts };
};
