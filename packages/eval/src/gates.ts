import { EvalError, evaluatorOfJudge } from './evaluators.js';
import { compareRuns, perCaseMeans, unscoredIn, type ComparableField } from './runner.js';
import { runState, type EvalRun, type Gate } from './schema.js';
import type { EvalRunStore } from './store.js';
import { mean, type BootstrapOptions } from './stats.js';

export const minimumJudgeAgreement = 0.6;

export interface GateResult {
  gate: string;
  testSet: string;
  pass: boolean;
  blocking: boolean;
  reason: string;
  value?: number;
  ci?: [number, number];
}

export interface GateInput {
  evaluation: { testSets: string[]; gates: string[] };
  registry: Map<string, Gate>;
  candidate: Map<string, EvalRun>;
  baseline?: Map<string, EvalRun>;
  judgeAgreement?: Map<string, number>;
  allowDifferent?: ComparableField[];
  bootstrap?: BootstrapOptions;
  /** Judges whose scores never gate: left out of comparisons and calibration. */
  advisoryJudge?: (judge: string) => boolean;
}

export interface GateOutcome {
  pass: boolean;
  results: GateResult[];
}

const usesJudge = (metric: string) => metric.startsWith('judge.');

const inLanguage = (run: EvalRun | undefined, language: string | undefined) =>
  run && language ? { ...run, results: run.results.filter((r) => r.language === language) } : run;

const tagsOf = (run: EvalRun) => [...new Set(run.results.flatMap((r) => r.tags))].sort();

export const evaluateGates = (input: GateInput): GateOutcome => {
  const results: GateResult[] = [];
  for (const name of input.evaluation.gates) {
    const gate = input.registry.get(name);
    if (!gate) {
      results.push({
        gate: name,
        testSet: '*',
        pass: false,
        blocking: true,
        reason: `gate ${name} is not defined`,
      });
      continue;
    }
    const scopes = input.evaluation.testSets.flatMap((set) =>
      gate.languages
        ? gate.languages.map((language) => ({ set, language: language as string | undefined }))
        : [{ set, language: undefined as string | undefined }],
    );
    for (const { set, language } of scopes) {
      const testSet = language ? `${set} (${language})` : set;
      const run = inLanguage(input.candidate.get(set), language);
      const base = { gate: name, testSet };
      if (!run) {
        results.push({
          ...base,
          pass: false,
          blocking: true,
          reason: `no eval run for test set ${set}`,
        });
        continue;
      }
      if (!run.splits.includes(gate.split)) {
        results.push({
          ...base,
          pass: false,
          blocking: true,
          reason: `the run did not cover the ${gate.split} split`,
        });
        continue;
      }
      let blocking = true;
      let note = '';
      if (usesJudge(gate.metric)) {
        // Only the judges that scored the gate's metric; a run whose judges cannot be told apart keeps them all.
        const scoredBy = new Set(
          run.results.flatMap((r) =>
            r.scores.filter((s) => s.metric === gate.metric).map((s) => s.evaluator),
          ),
        );
        const own = run.provenance.judges.filter((j) => scoredBy.has(evaluatorOfJudge(j)));
        const judges = (own.length > 0 ? own : run.provenance.judges).filter(
          (j) => !input.advisoryJudge?.(j),
        );
        const uncalibrated = judges.filter(
          (j) =>
            (input.judgeAgreement?.get(j) ?? input.judgeAgreement?.get(evaluatorOfJudge(j)) ?? 0) <
            minimumJudgeAgreement,
        );
        if (judges.length === 0 || uncalibrated.length > 0) {
          blocking = false;
          note = ` (advisory: judge ${uncalibrated.join(', ') || 'unknown'} is not calibrated to ${minimumJudgeAgreement})`;
        }
      }
      const unscored = unscoredIn(run, gate.metric, gate.split);
      if (unscored.missing > 0) {
        results.push({
          ...base,
          pass: false,
          blocking,
          reason: `${gate.metric}: no score for ${unscored.missing} of ${unscored.of} cases${note}`,
        });
        continue;
      }
      if (gate.kind === 'threshold') {
        const values = [...perCaseMeans(run, gate.metric, undefined, gate.split).values()];
        if (values.length === 0) {
          results.push({
            ...base,
            pass: false,
            blocking,
            reason: `no ${gate.metric} scores in the run${note}`,
          });
          continue;
        }
        const value = mean(values);
        const threshold = gate.threshold as number;
        results.push({
          ...base,
          pass: value >= threshold,
          blocking,
          value,
          reason: `${gate.metric} ${value.toFixed(3)} ${value >= threshold ? '>=' : '<'} ${threshold}${note}`,
        });
        continue;
      }
      const previous = inLanguage(input.baseline?.get(set), language);
      if (!previous) {
        results.push({
          ...base,
          pass: false,
          blocking,
          reason: `no baseline run for test set ${testSet}${note}`,
        });
        continue;
      }
      const baselineUnscored = unscoredIn(previous, gate.metric, gate.split);
      if (baselineUnscored.missing > 0) {
        results.push({
          ...base,
          pass: false,
          blocking,
          reason: `${gate.metric}: no score in the baseline for ${baselineUnscored.missing} of ${baselineUnscored.of} cases${note}`,
        });
        continue;
      }
      const tags = [
        undefined,
        ...(gate.perTag ? tagsOf(run).filter((t) => tagsOf(previous).includes(t)) : []),
      ];
      const regressions: string[] = [];
      let overall: { difference: number; ci: [number, number] } | undefined;
      for (const tag of tags) {
        try {
          const c = compareRuns(previous, run, gate.metric, {
            ...input.bootstrap,
            split: gate.split,
            allowDifferent: input.allowDifferent ?? ['commit', 'services', 'servedModels'],
            ...(input.advisoryJudge ? { advisoryJudge: input.advisoryJudge } : {}),
            ...(tag === undefined ? {} : { tag }),
          });
          if (tag === undefined) overall = { difference: c.difference, ci: c.ci };
          if (c.ci[1] < -gate.maxRegression)
            regressions.push(
              `${tag ?? 'all'} ${c.difference.toFixed(3)} [${c.ci[0].toFixed(3)}, ${c.ci[1].toFixed(3)}]`,
            );
        } catch (error) {
          if (!(error instanceof EvalError) || !error.message.startsWith('no cases scored'))
            throw error;
        }
      }
      results.push({
        ...base,
        pass: regressions.length === 0,
        blocking,
        ...(overall ? { value: overall.difference, ci: overall.ci } : {}),
        reason:
          regressions.length === 0
            ? `no ${gate.metric} regression beyond the confidence interval${note}`
            : `regressed: ${regressions.join('; ')}${note}`,
      });
    }
  }
  return { pass: results.every((r) => r.pass || !r.blocking), results };
};

export interface PublishGateInput {
  tenant: string;
  service: string;
  candidate: string;
  baseline?: string;
  evaluation: { testSets: string[]; gates: string[] };
  runs: EvalRunStore;
  registry: Map<string, Gate>;
  judgeAgreement?: Map<string, number>;
  bootstrap?: BootstrapOptions;
  advisoryJudge?: (judge: string) => boolean;
}

export interface PublishDecision {
  allow: boolean;
  refused: string[];
  advisory: string[];
  results: GateResult[];
}

const latestBySet = async (
  runs: EvalRunStore,
  tenant: string,
  service: string,
  subject: string,
  testSets: string[],
) => {
  const found = new Map<string, EvalRun>();
  for (const testSet of testSets) {
    const latest = (await runs.list({ tenant, service, subject, testSet })).find(
      (s) => runState(s.run) === 'completed',
    );
    if (latest) found.set(testSet, latest.run);
  }
  return found;
};

export const publishGate = async (input: PublishGateInput): Promise<PublishDecision> => {
  if (input.evaluation.gates.length === 0)
    return { allow: true, refused: [], advisory: [], results: [] };
  const candidate = await latestBySet(
    input.runs,
    input.tenant,
    input.service,
    input.candidate,
    input.evaluation.testSets,
  );
  const baseline = input.baseline
    ? await latestBySet(
        input.runs,
        input.tenant,
        input.service,
        input.baseline,
        input.evaluation.testSets,
      )
    : undefined;
  const outcome = evaluateGates({
    evaluation: input.evaluation,
    registry: input.registry,
    candidate,
    ...(baseline ? { baseline } : {}),
    ...(input.judgeAgreement ? { judgeAgreement: input.judgeAgreement } : {}),
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    ...(input.advisoryJudge ? { advisoryJudge: input.advisoryJudge } : {}),
  });
  const label = (r: GateResult) => `${r.gate} on ${r.testSet}: ${r.reason}`;
  return {
    allow: outcome.pass,
    refused: outcome.results.filter((r) => !r.pass && r.blocking).map(label),
    advisory: outcome.results.filter((r) => !r.pass && !r.blocking).map(label),
    results: outcome.results,
  };
};
