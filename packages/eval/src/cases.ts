import { splitFor } from './drafting.js';
import {
  contractAssertions,
  rubricJudge,
  type EvalContext,
  type JudgeModel,
  type JudgePrompt,
} from './evaluators.js';
import type { TestCaseCandidate } from './feedback.js';
import { caseTypes, expectedFor, type CaseType, type Split, type TestCase } from './schema.js';

export const caseSplits = ['locked', 'open'] as const;
export type CaseSplit = (typeof caseSplits)[number];

export const caseSplitOf = (split: Split): CaseSplit => (split === 'holdout' ? 'locked' : 'open');

export const splitsFor = (split: CaseSplit): Split[] =>
  split === 'locked' ? ['holdout'] : ['train', 'validation'];

export interface CaseView {
  id: string;
  input: string;
  expected: string;
  type: CaseType;
  split: CaseSplit;
}

export const caseTypeOf = (c: TestCase): CaseType =>
  c.type ?? (c.grounding === 'refusal-expected' ? 'must_reject' : 'criteria');

const textOf = (input: TestCase['input']) =>
  typeof input === 'string' ? input : JSON.stringify(input);

/** What a criteria judge reads: the case's criteria, or its reference answer when it has none. */
export const criteriaOf = (c: TestCase) =>
  c.expected.criteria?.criteria ?? c.expected.referenceAnswer;

export const caseView = (c: TestCase): CaseView => ({
  id: c.id,
  input: textOf(c.input),
  expected:
    (caseTypeOf(c) === 'criteria' ? criteriaOf(c) : c.expected.referenceAnswer) ??
    c.expected.answerPattern ??
    '',
  type: caseTypeOf(c),
  split: caseSplitOf(c.split),
});

export interface NewCase {
  id: string;
  input: string;
  expected?: string;
  type?: CaseType;
  split?: CaseSplit;
}

export const isCaseType = (value: unknown): value is CaseType => caseTypes.some((t) => t === value);

export const isCaseSplit = (value: unknown): value is CaseSplit =>
  caseSplits.some((s) => s === value);

export const caseFrom = (input: NewCase) => {
  const type = input.type ?? 'criteria';
  const split: Split =
    input.split === undefined ? splitFor(input.id) : input.split === 'locked' ? 'holdout' : 'train';
  return {
    id: input.id,
    split,
    input: input.input,
    expected: expectedFor(type, input.expected),
    grounding: type === 'must_reject' ? 'refusal-expected' : 'answer-only',
    type,
  };
};

export type CandidateState = 'new' | 'accepted' | 'rejected';

export interface CandidateView {
  id: string;
  input: string;
  expected?: string;
  origin: NonNullable<TestCaseCandidate['origin']>;
  status: CandidateState;
  createdAt: string;
  service?: string;
  testSet?: string;
}

export const candidateView = (c: TestCaseCandidate): CandidateView | undefined => {
  if (c.status === 'expired') return undefined;
  const testSet = c.testSet?.id ?? c.targetTestSet;
  return {
    id: c.id,
    input: c.question,
    ...(c.answer ? { expected: c.answer } : {}),
    origin: c.origin ?? 'feedback',
    status: c.status === 'pending-review' ? 'new' : c.status,
    createdAt: c.proposedAt,
    ...(c.service ? { service: c.service } : {}),
    ...(testSet ? { testSet } : {}),
  };
};

export const criteriaJudgePrompt = (criteria: string): JudgePrompt => ({
  id: 'skill-criteria',
  version: '1',
  system:
    'You check whether an answer from a public-sector assistant meets the given criteria. Reply with JSON only: {"scores": {"criteria": <1 when every criterion is met, otherwise 0>}, "rationale": "<one sentence>"}.',
  template: 'Question:\n{{question}}\n\nAnswer to check:\n{{answer}}\n\nCriteria:\n{{criteria}}',
  criteria: [{ id: 'criteria', description: criteria }],
  scale: { min: 0, max: 1 },
});

export interface CaseGrade {
  pass: boolean;
  score: number | null;
  reason?: string;
}

export interface GradeOptions {
  judge?: JudgeModel;
  context: EvalContext;
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const gradeAnswer = async (
  c: TestCase,
  answer: { text: string; noAnswer?: boolean },
  options: GradeOptions,
): Promise<CaseGrade> => {
  const type = caseTypeOf(c);
  const observation = { answer: answer.text, retrieved: [], citations: [] };
  if (type === 'must_reject') {
    const scores = await contractAssertions().evaluate(
      { ...c, grounding: 'refusal-expected' },
      observation,
      options.context,
    );
    const refused =
      answer.noAnswer === true || scores.some((s) => s.metric === 'refusal' && s.value === 1);
    return refused
      ? { pass: true, score: 1 }
      : { pass: false, score: 0, reason: 'Svaret avviste ikke forespørselen.' };
  }
  if (type === 'exact') {
    const expected = c.expected.referenceAnswer ?? c.expected.answerPattern ?? '';
    const pass = expected !== '' && normalized(answer.text).includes(normalized(expected));
    return pass
      ? { pass, score: 1 }
      : { pass, score: 0, reason: 'Svaret inneholder ikke den forventede teksten.' };
  }
  const criteria = criteriaOf(c);
  if (!criteria) return { pass: false, score: null, reason: 'Testtilfellet mangler kriterier.' };
  if (!options.judge)
    return {
      pass: false,
      score: null,
      reason: 'Ingen dommermodell fra en annen modellfamilie er tilgjengelig.',
    };
  try {
    const scores = await rubricJudge(options.judge, criteriaJudgePrompt(criteria)).evaluate(
      c,
      observation,
      options.context,
    );
    const overall = scores.find((s) => s.metric === 'judge.overall');
    const score = overall?.value ?? null;
    const rationale = overall?.details?.rationale;
    return {
      pass: score === 1,
      score,
      ...(typeof rationale === 'string' ? { reason: rationale } : {}),
    };
  } catch (error) {
    return { pass: false, score: null, reason: messageOf(error) };
  }
};
