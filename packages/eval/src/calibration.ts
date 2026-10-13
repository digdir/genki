import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EvalError } from './evaluators.js';
import { minimumJudgeAgreement } from './gates.js';

export const judgeLabel = z.strictObject({
  item: z.string().min(1),
  judge: z.string().min(1),
  judgeLabel: z.string().min(1),
  humanLabel: z.string().min(1),
  labeller: z.string().min(1),
});
export type JudgeLabel = z.infer<typeof judgeLabel>;

export const labelFile = z.array(judgeLabel).min(1);

export interface Agreement {
  judge: string;
  kappa: number;
  observed: number;
  n: number;
  blocking: boolean;
}

export const cohensKappa = (pairs: [string, string][]): { kappa: number; observed: number } => {
  if (pairs.length === 0) throw new EvalError('kappa needs at least one labelled item');
  const categories = [...new Set(pairs.flat())];
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = categories.reduce((sum, c) => {
    const a = pairs.filter(([x]) => x === c).length / n;
    const b = pairs.filter(([, y]) => y === c).length / n;
    return sum + a * b;
  }, 0);
  if (expected === 1) return { kappa: observed === 1 ? 1 : 0, observed };
  return { kappa: (observed - expected) / (1 - expected), observed };
};

export const judgeAgreement = (labels: JudgeLabel[]): Agreement[] => {
  const byJudge = new Map<string, [string, string][]>();
  for (const l of labels) {
    const pairs = byJudge.get(l.judge) ?? [];
    pairs.push([l.judgeLabel, l.humanLabel]);
    byJudge.set(l.judge, pairs);
  }
  return [...byJudge]
    .map(([judge, pairs]) => {
      const { kappa, observed } = cohensKappa(pairs);
      return { judge, kappa, observed, n: pairs.length, blocking: kappa >= minimumJudgeAgreement };
    })
    .sort((a, b) => a.judge.localeCompare(b.judge));
};

export const agreementMap = (labels: JudgeLabel[]) =>
  new Map(judgeAgreement(labels).map((a) => [a.judge, a.kappa]));

export const parseLabels = (text: string): JudgeLabel[] => labelFile.parse(parseYaml(text));

export interface LabelStore {
  add(labels: JudgeLabel[]): Promise<void>;
  list(judge?: string): Promise<JudgeLabel[]>;
}

export class InMemoryLabelStore implements LabelStore {
  readonly #labels: JudgeLabel[] = [];

  async add(labels: JudgeLabel[]) {
    this.#labels.push(...labelFile.parse(labels));
  }

  async list(judge?: string) {
    return this.#labels
      .filter((l) => judge === undefined || l.judge === judge)
      .map((l) => ({ ...l }));
  }
}
