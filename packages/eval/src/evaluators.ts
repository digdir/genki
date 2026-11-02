import { sameSource, type Observation } from './observe.js';
import { compilePattern } from './pattern.js';
import type { Score, TestCase } from './schema.js';

export interface EvalContext {
  servedModels: string[];
  modelFamily(model: string): string | undefined;
  /** Aborts when the eval run is cancelled. */
  signal?: AbortSignal;
}

export interface PendingScore {
  case: string;
  repeat: number;
  task: string;
  score: Score;
}

export interface CollectedScore {
  case: string;
  repeat: number;
  score: Score;
}

/**
 * evaluator@2: scores come back at once, or as pending, which the runner asks for again with
 * collect. What is not ready yet is left out or answered pending again.
 */
export interface Evaluator {
  id: string;
  version: string;
  kind: 'deterministic' | 'model' | 'human';
  judge?: string | undefined;
  evaluate(testCase: TestCase, observation: Observation, ctx: EvalContext): Promise<Score[]>;
  /** The signal aborts when the run's wait for scores ends or the run is cancelled. */
  collect?(pending: PendingScore[], options?: { signal?: AbortSignal }): Promise<CollectedScore[]>;
}

/**
 * The evaluator a judge in a run's provenance belongs to: a judge that names its version and model,
 * judge:criteria@1+foundry/claude, is the evaluator judge:criteria; any other judge is itself.
 * Labels and calibration are kept per evaluator.
 */
export const evaluatorOfJudge = (judge: string) => /^([^@+]+)@[^+]+\+/.exec(judge)?.[1] ?? judge;

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

const scored = (
  evaluator: Evaluator,
  metric: string,
  value: number,
  details?: Record<string, unknown>,
): Score => ({
  evaluator: evaluator.id,
  version: evaluator.version,
  metric,
  value,
  applicable: true,
  state: 'scored',
  ...(details ? { details } : {}),
});

const skipped = (evaluator: Evaluator, metric: string, reason: string): Score => ({
  evaluator: evaluator.id,
  version: evaluator.version,
  metric,
  value: null,
  applicable: false,
  state: 'not-applicable',
  reason,
});

export const defaultRefusalPatterns = [
  '(?i)\\b(vet ikke|finner ikke|fant ikke|har ikke (nok )?informasjon|kan ikke svare|ikke dekket)\\b',
  "(?i)\\b(i don't know|i do not know|could not find|couldn't find|no information|cannot answer|not covered)\\b",
];

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** What a judge reads as the answer: its text, or a structured answer's fields as JSON. */
export const answerText = (o: Observation) =>
  o.answer.trim() === '' && o.fields !== undefined ? JSON.stringify(o.fields, null, 2) : o.answer;

/** v2: an exact case's text, and an empty answer counts as a refusal, as the portal graded them. */
export const contractAssertions = (refusalPatterns = defaultRefusalPatterns): Evaluator => {
  const refusals = refusalPatterns.map(compilePattern);
  const self: Evaluator = {
    id: 'contract',
    version: '2',
    kind: 'deterministic',
    evaluate: async (c, o) => {
      const scores: Score[] = [];
      // No answer at all is a refusal; a structured answer has no text but is still an answer.
      const refused =
        (o.answer.trim() === '' && o.fields === undefined) ||
        refusals.some((r) => r.test(o.answer));
      if (c.grounding === 'refusal-expected' || c.type === 'must_reject') {
        scores.push(scored(self, 'refusal', refused ? 1 : 0));
        scores.push(skipped(self, 'answer-pattern', 'a refusal is expected'));
      } else {
        scores.push(scored(self, 'non-empty-answer', o.answer.length > 0 ? 1 : 0));
        scores.push(
          c.expected.answerPattern === undefined
            ? skipped(self, 'answer-pattern', 'the case has no answer pattern')
            : scored(
                self,
                'answer-pattern',
                compilePattern(c.expected.answerPattern).test(o.answer) ? 1 : 0,
              ),
        );
      }
      if (c.type === 'exact') {
        const expected = c.expected.referenceAnswer ?? c.expected.answerPattern;
        // An exact case without its text cannot pass, as the portal grades it.
        scores.push(
          expected === undefined || expected.trim() === ''
            ? { ...scored(self, 'exact-text', 0), reason: 'the case has no text to find' }
            : scored(
                self,
                'exact-text',
                normalized(o.answer).includes(normalized(expected)) ? 1 : 0,
              ),
        );
      }
      if (c.expected.fields !== undefined) {
        const expected = Object.entries(c.expected.fields);
        const matched = expected.filter(
          ([k, v]) => JSON.stringify(o.fields?.[k]) === JSON.stringify(v),
        ).length;
        scores.push(
          scored(self, 'fields-match', expected.length === 0 ? 1 : matched / expected.length),
        );
      }
      return scores;
    },
  };
  return self;
};

export const retrievalRecall = (k: number): Evaluator => {
  if (!Number.isInteger(k) || k < 1) throw new EvalError('k must be a positive integer');
  const self: Evaluator = {
    id: 'retrieval',
    version: '1',
    kind: 'deterministic',
    evaluate: async (c, o) => {
      const metric = `recall@${k}`;
      const scores: Score[] = [];
      if (c.grounding !== 'sources-and-answer' || c.expected.sources.length === 0) {
        scores.push(
          skipped(
            self,
            metric,
            `grounding is ${c.grounding} with ${c.expected.sources.length} expected sources`,
          ),
        );
      } else {
        const top = o.retrieved.slice(0, k);
        const found = c.expected.sources.filter((g) => top.some((r) => sameSource(g, r))).length;
        scores.push(
          scored(self, metric, found / c.expected.sources.length, {
            found,
            expected: c.expected.sources.length,
          }),
        );
      }
      if (o.citations.length === 0) {
        scores.push(skipped(self, 'citations-grounded', 'the answer has no citations'));
      } else {
        const grounded = o.citations.filter((cite) =>
          o.retrieved.some((r) => sameSource(cite, r)),
        ).length;
        scores.push(
          scored(self, 'citations-grounded', grounded / o.citations.length, {
            grounded,
            citations: o.citations.length,
          }),
        );
      }
      return scores;
    },
  };
  return self;
};

export interface JudgeMessage {
  role: 'system' | 'user';
  content: string;
}

export interface JudgeModel {
  id: string;
  family: string;
  complete(messages: JudgeMessage[]): Promise<string>;
}

export interface JudgePrompt {
  id: string;
  version: string;
  system: string;
  template: string;
  criteria: { id: string; description: string }[];
  scale: { min: number; max: number };
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined)
      throw new EvalError(`the judge template uses {{${key}}}, which has no value`);
    return value;
  });

const parseJson = (text: string, judge: string): Record<string, unknown> => {
  const body = /\{[\s\S]*\}/.exec(text)?.[0];
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    throw new EvalError(`judge ${judge} did not return JSON`);
  }
  throw new EvalError(`judge ${judge} did not return a JSON object`);
};

const assertOtherFamily = (judge: JudgeModel, ctx: EvalContext) => {
  for (const model of ctx.servedModels) {
    const family = ctx.modelFamily(model);
    if (family === undefined)
      throw new EvalError(`no model family known for ${model}; the judge cannot be checked`);
    if (family === judge.family)
      throw new EvalError(
        `judge ${judge.id} is the same family (${family}) as the system under test`,
      );
  }
};

const criteriaText = (prompt: JudgePrompt) =>
  prompt.criteria.map((c) => `- ${c.id}: ${c.description}`).join('\n');

export const rubricJudge = (judge: JudgeModel, prompt: JudgePrompt): Evaluator => {
  const self: Evaluator = {
    id: `judge:${prompt.id}`,
    version: `${prompt.version}+${judge.id}`,
    kind: 'model',
    judge: judge.id,
    evaluate: async (c, o, ctx) => {
      assertOtherFamily(judge, ctx);
      if (prompt.template.includes('{{reference}}') && c.expected.referenceAnswer === undefined) {
        return [
          ...prompt.criteria.map((cr) =>
            skipped(self, `judge.${cr.id}`, 'the case has no reference answer'),
          ),
          skipped(self, 'judge.overall', 'the case has no reference answer'),
        ];
      }
      const question = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
      const reply = await judge.complete([
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: fill(prompt.template, {
            question,
            answer: answerText(o),
            criteria: criteriaText(prompt),
            min: String(prompt.scale.min),
            max: String(prompt.scale.max),
            ...(c.expected.referenceAnswer === undefined
              ? {}
              : { reference: c.expected.referenceAnswer }),
          }),
        },
      ]);
      const parsed = parseJson(reply, judge.id);
      const raw = (parsed.scores ?? {}) as Record<string, unknown>;
      const scores = prompt.criteria.map((cr) => {
        const value = raw[cr.id];
        if (typeof value !== 'number' || value < prompt.scale.min || value > prompt.scale.max)
          throw new EvalError(`judge ${judge.id} gave no valid score for ${cr.id}`);
        return scored(
          self,
          `judge.${cr.id}`,
          (value - prompt.scale.min) / (prompt.scale.max - prompt.scale.min),
        );
      });
      const overall = scores.reduce((a, s) => a + (s.value ?? 0), 0) / scores.length;
      return [
        ...scores,
        scored(
          self,
          'judge.overall',
          overall,
          typeof parsed.rationale === 'string' ? { rationale: parsed.rationale } : undefined,
        ),
      ];
    },
  };
  return self;
};

export interface PairwiseVerdict {
  winner: 'baseline' | 'candidate' | 'tie';
  positionBias: boolean;
  value: number;
}

export const pairwiseJudge = (judge: JudgeModel, prompt: Omit<JudgePrompt, 'scale'>) => {
  const ask = async (question: string, first: string, second: string) => {
    const reply = await judge.complete([
      { role: 'system', content: prompt.system },
      {
        role: 'user',
        content: fill(prompt.template, {
          question,
          a: first,
          b: second,
          criteria: criteriaText({ ...prompt, scale: { min: 0, max: 1 } }),
        }),
      },
    ]);
    const winner = parseJson(reply, judge.id).winner;
    if (winner !== 'A' && winner !== 'B' && winner !== 'tie')
      throw new EvalError(`judge ${judge.id} gave no winner`);
    return winner;
  };
  return async (
    testCase: TestCase,
    baseline: Observation,
    candidate: Observation,
    ctx: EvalContext,
  ): Promise<PairwiseVerdict> => {
    assertOtherFamily(judge, ctx);
    const question =
      typeof testCase.input === 'string' ? testCase.input : JSON.stringify(testCase.input);
    const forward = await ask(question, baseline.answer, candidate.answer);
    const backward = await ask(question, candidate.answer, baseline.answer);
    const first = forward === 'A' ? 'baseline' : forward === 'B' ? 'candidate' : 'tie';
    const second = backward === 'A' ? 'candidate' : backward === 'B' ? 'baseline' : 'tie';
    if (first !== second)
      return { winner: 'tie', positionBias: first !== 'tie' && second !== 'tie', value: 0.5 };
    return {
      winner: first,
      positionBias: false,
      value: first === 'candidate' ? 1 : first === 'tie' ? 0.5 : 0,
    };
  };
};
