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
        criteria: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1)).optional(),
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

export const score = z
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

export const evalRunStates = [
  'running',
  'waiting-for-scores',
  'completed',
  'failed',
  'interrupted',
] as const;
export type EvalRunState = (typeof evalRunStates)[number];

export const usageSummary = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicroNok: z.number().nonnegative().nullable(),
});
export type UsageSummary = z.infer<typeof usageSummary>;

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
  /** Absent on runs stored before runs kept their state: those are completed. */
  status: z.enum(evalRunStates).optional(),
  error: z.string().optional(),
  progress: z.strictObject({ done: z.number().int(), total: z.number().int() }).optional(),
  usage: z.strictObject({ answers: usageSummary, judges: usageSummary.optional() }).optional(),
  /** For a run started from a service: the version or draft, variant and split it tested. */
  tested: z
    .strictObject({
      version: z.union([z.number().int().positive(), z.literal('draft')]),
      variant: z.string().optional(),
      split: z.enum(['locked', 'open']).optional(),
    })
    .optional(),
  owner: z.string().optional(),
  heartbeatAt: z.string().optional(),
});
export type EvalRun = z.infer<typeof evalRun>;

export const runState = (run: Pick<EvalRun, 'status'>): EvalRunState => run.status ?? 'completed';

export const sumUsage = (parts: UsageSummary[]): UsageSummary => ({
  inputTokens: parts.reduce((n, p) => n + p.inputTokens, 0),
  outputTokens: parts.reduce((n, p) => n + p.outputTokens, 0),
  costMicroNok: parts.some((p) => p.costMicroNok === null)
    ? null
    : parts.reduce((n, p) => n + (p.costMicroNok ?? 0), 0),
});

export const parseTestSet = (input: unknown): TestSet => testSet.parse(input);

export const parseTestSetYaml = (text: string): TestSet => parseTestSet(parseYaml(text));
