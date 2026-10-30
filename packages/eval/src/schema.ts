import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { compilePattern } from './pattern.js';

export const splits = ['train', 'validation', 'holdout'] as const;
export type Split = (typeof splits)[number];

export const groundings = ['sources-and-answer', 'answer-only', 'refusal-expected'] as const;

export const caseTypes = ['criteria', 'exact', 'must_reject'] as const;
export const caseLanguages = ['nb', 'nn', 'en'] as const;
export type CaseType = (typeof caseTypes)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/);

const pattern = z.string().refine((p) => {
  try {
    compilePattern(p);
    return true;
  } catch {
    return false;
  }
}, 'not a supported regular expression');

export const sourceRef = z
  .strictObject({
    chunkId: z.string().min(1).optional(),
    document: z.string().min(1).optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine(
    (s) => s.chunkId !== undefined || s.document !== undefined,
    'a source needs a chunk id or a document',
  );
export type SourceRef = z.infer<typeof sourceRef>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Before expected.criteria, a criteria case kept its criteria in referenceAnswer (ADR 0003). */
const withCriteriaMoved = (raw: unknown) => {
  if (!isRecord(raw) || raw.type !== 'criteria' || !isRecord(raw.expected)) return raw;
  const { referenceAnswer, criteria, ...expected } = raw.expected;
  if (criteria !== undefined || typeof referenceAnswer !== 'string') return raw;
  return { ...raw, expected: { ...expected, criteria: { criteria: referenceAnswer } } };
};

/** A criteria field, named as judges read it: criteria, supporting_quotes. */
const criterionName = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const testCase = z.preprocess(
  withCriteriaMoved,
  z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    split: z.enum(splits),
    input: z.union([
      z.string().min(1),
      z.strictObject({ data: z.unknown().optional(), parts: z.array(z.unknown()).optional() }),
    ]),
    expected: z
      .strictObject({
        sources: z.array(sourceRef).default([]),
        answerPattern: pattern.optional(),
        referenceAnswer: z.string().min(1).optional(),
        criteria: z.record(criterionName, z.string().min(1)).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
      })
      .prefault({}),
    grounding: z.enum(groundings).default('sources-and-answer'),
    type: z.enum(caseTypes).optional(),
    language: z.enum(caseLanguages).optional(),
    tags: z.array(z.string()).default([]),
    origin: z.record(z.string(), z.string()).optional(),
    needsReview: z.boolean().default(false),
    notes: z.string().optional(),
  }),
);
export type TestCase = z.infer<typeof testCase>;

/** One text for a new case: a criteria case's criteria, otherwise its reference answer. */
/** What a case in the portal's simple form may expect besides a text: an answer and named criteria. */
export const caseExpectation = z.strictObject({
  referenceAnswer: z.string().trim().min(1).optional(),
  criteria: z.record(criterionName, z.string().trim().min(1)).optional(),
});
export type CaseExpectation = z.infer<typeof caseExpectation>;

export const expectedFor = (type: CaseType, text: string | undefined) =>
  !text ? {} : type === 'criteria' ? { criteria: { criteria: text } } : { referenceAnswer: text };

export const testSet = z
  .strictObject({
    apiVersion: z.literal('genai/v1'),
    kind: z.literal('TestSet'),
    metadata: z.strictObject({
      tenant: z.string().regex(/^\d{9}$/),
      id: slug,
      name: z.string().min(1),
      version: z.number().int().positive(),
    }),
    spec: z.strictObject({
      service: slug.optional(),
      corpus: z.string().optional(),
      provenance: z.record(z.string(), z.unknown()).optional(),
      cases: z.array(testCase),
    }),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    set.spec.cases.forEach((c, i) => {
      if (seen.has(c.id))
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'cases', i, 'id'],
          message: `duplicate case ${c.id}`,
        });
      seen.add(c.id);
    });
  });
export type TestSet = z.infer<typeof testSet>;

/**
 * Only a scored score has a value. Pending waits to be collected, missing never arrived in time,
 * failed is the evaluator's own failure; all three still apply to the case, unlike not-applicable.
 */
export const scoreStates = ['scored', 'not-applicable', 'pending', 'failed', 'missing'] as const;
export type ScoreState = (typeof scoreStates)[number];

/** A score stored before scores had a state: a value is scored, otherwise it failed or did not apply. */
const withState = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || 'state' in raw) return raw;
  const s = raw as { value?: unknown; applicable?: unknown };
  return {
    ...raw,
    state:
      typeof s.value === 'number' ? 'scored' : s.applicable === false ? 'not-applicable' : 'failed',
  };
};

export const score = z.preprocess(
  withState,
  z
    .strictObject({
      evaluator: z.string(),
      version: z.string(),
      metric: z.string(),
      value: z.number().min(0).max(1).nullable(),
      applicable: z.boolean(),
      state: z.enum(scoreStates),
      reason: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .refine(
      (s) =>
        (s.state === 'scored') === (s.value !== null) &&
        (s.state === 'not-applicable') === !s.applicable,
      'only a scored score has a value, and only a not-applicable one does not apply',
    ),
);
export type Score = z.infer<typeof score>;

export const feedback = z.strictObject({
  task: z.string(),
  rating: z.enum(['up', 'down']),
  comment: z.string().max(4000).optional(),
  reasons: z.array(z.string().min(1).max(200)).max(10).optional(),
  by: z.strictObject({ kind: z.string(), id: z.string() }),
  at: z.iso.datetime(),
});
export type Feedback = z.infer<typeof feedback>;

export const gate = z
  .strictObject({
    id: slug,
    metric: z.string().min(1),
    kind: z.enum(['threshold', 'no-regression']),
    threshold: z.number().min(0).max(1).optional(),
    maxRegression: z.number().min(0).max(1).default(0),
    perTag: z.boolean().default(false),
    languages: z.array(z.enum(caseLanguages)).optional(),
    split: z.enum(splits).default('validation'),
  })
  .refine(
    (g) => g.kind !== 'threshold' || g.threshold !== undefined,
    'a threshold gate needs a threshold',
  );
export type Gate = z.infer<typeof gate>;

export const metricSummary = z.strictObject({
  mean: z.number(),
  ci: z.tuple([z.number(), z.number()]),
  n: z.number().int(),
});
export type MetricSummary = z.infer<typeof metricSummary>;

export const evalRun = z.strictObject({
  id: z.string(),
  testSet: z.strictObject({ tenant: z.string(), id: z.string(), version: z.number() }),
  capability: z.string(),
  splits: z.array(z.enum(splits)),
  repeats: z.number().int().positive(),
  startedAt: z.string(),
  endedAt: z.string(),
  provenance: z.strictObject({
    commit: z.string().min(1),
    data: z.string().min(1),
    servedModels: z.array(z.string()).min(1),
    judges: z.array(z.string()),
    services: z.array(z.string()),
  }),
  results: z.array(
    z.strictObject({
      case: z.string(),
      split: z.enum(splits),
      repeat: z.number().int(),
      task: z.string(),
      tags: z.array(z.string()),
      language: z.enum(caseLanguages).optional(),
      scores: z.array(score),
    }),
  ),
  metrics: z.record(z.string(), metricSummary),
  byTag: z.record(z.string(), z.record(z.string(), metricSummary)),
  incomplete: z
    .array(
      z.strictObject({
        evaluator: z.string(),
        missing: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        of: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type EvalRun = z.infer<typeof evalRun>;

export const parseTestSet = (input: unknown): TestSet => testSet.parse(input);

export const parseTestSetYaml = (text: string): TestSet => parseTestSet(parseYaml(text));
