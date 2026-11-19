import { untrustedData } from '@genai/port-model';
import { sameSource, type Observation, type ObservedSource } from './observe.js';
import { compilePattern } from './pattern.js';
import type { ReportedUsage, Score, SourceRef, TestCase, UsageSummary } from './schema.js';

export interface EvalContext {
  servedModels: string[];
  modelFamily(model: string): string | undefined;
  /** Aborts when the eval run is cancelled. */
  signal?: AbortSignal;
  /** The eval run and the case's task, for a judge that scores the trace the case sent. */
  run?: string;
  task?: string;
}

export const judgedAgainst = (model: { kind?: unknown }) =>
  model.kind === undefined || model.kind === 'model';

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
  /** What the evaluator's own model calls used, for a judge that calls one. */
  usage?(): UsageSummary;
  /**
   * Its reasons may quote the answer, so they are kept only on the case's task, whose retention
   * purges them with the case; the run keeps its scores without them.
   */
  reasonsOnTheCase?: boolean;
  /** Its scores are shown apart and never count in the run's metrics or its gates. */
  advisory?: boolean;
  /**
   * What a sink reports its judges' calls on the run's cases used, outside the platform's
   * metering: per evaluator, and under the sink's own key for its judges the run does not use.
   */
  reportedUsage?(): Record<string, ReportedUsage>;
  /**
   * For a judge in a sink: whether it can judge the case at all, known before the case is
   * answered. A case none of a run's sink judges can read is not sent, so it is not billed.
   */
  canRead?(testCase: TestCase): boolean;
  /** Once the run's wait for scores is over: a last read of what a sink reports, before the run ends. */
  settle?(options?: { signal?: AbortSignal }): Promise<void>;
}

/** The evaluator of a provenance judge: judge:criteria@2+foundry/claude is judge:criteria. */
export const evaluatorOfJudge = (judge: string) => /^([^@+]+)@[^+]+\+/.exec(judge)?.[1] ?? judge;

export const judgeVersionOf = (judge: string) => /^[^@+]+@([^+]+)\+/.exec(judge)?.[1];

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

/** Two hits are the same chunk: by id when both have one, else by document, position and page. */
const sameHit = (a: SourceRef, b: SourceRef) =>
  a.chunkId !== undefined && b.chunkId !== undefined
    ? a.chunkId === b.chunkId
    : a.document === b.document && a.position === b.position && a.page === b.page;

/** The hits in their order, where a hit seen earlier takes no new rank. */
const ranked = <T extends SourceRef>(hits: T[]) =>
  hits.filter((hit, i) => hits.findIndex((h) => sameHit(h, hit)) === i);

const ndcgCut = 10;

/** The ranks that get an expected source of their own, best first, freeing one where needed. */
const matchedRanks = (expected: SourceRef[], hits: SourceRef[]) => {
  const owner: number[] = expected.map(() => -1);
  const take = (hit: number, seen: Set<number>): boolean =>
    expected.some((source, e) => {
      if (seen.has(e) || !sameSource(source, hits[hit] as SourceRef)) return false;
      seen.add(e);
      if (owner[e] !== -1 && !take(owner[e] as number, seen)) return false;
      owner[e] = hit;
      return true;
    });
  return hits.flatMap((_, hit) => (take(hit, new Set()) ? [hit] : []));
};

/** Recall and hit@5 count places as version 1 did; mrr@10 and binary ndcg@10 rank each hit once. */
const rankScores = (
  expected: SourceRef[],
  hits: SourceRef[],
  cutOffs: readonly number[],
  name: (metric: string) => string,
) => {
  const matches = (hit: SourceRef) => expected.some((e) => sameSource(e, hit));
  const recall = cutOffs.map((k) => {
    const top = hits.slice(0, k);
    const found = expected.filter((e) => top.some((r) => sameSource(e, r))).length;
    return {
      metric: name(`recall@${k}`),
      value: found / expected.length,
      details: { found, expected: expected.length },
    };
  });
  const top = ranked(hits).slice(0, ndcgCut);
  const first = top.findIndex(matches);
  const dcg = matchedRanks(expected, top).reduce((sum, i) => sum + 1 / Math.log2(i + 2), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(expected.length, ndcgCut); i += 1) ideal += 1 / Math.log2(i + 2);
  return [
    ...recall,
    { metric: name('hit@5'), value: hits.slice(0, 5).some(matches) ? 1 : 0 },
    {
      metric: name(`mrr@${ndcgCut}`),
      value: first < 0 ? 0 : 1 / (first + 1),
      ...(first < 0 ? {} : { details: { rank: first + 1 } }),
    },
    { metric: name(`ndcg@${ndcgCut}`), value: dcg / ideal },
  ];
};

/** The share of a case's expected documents, by id or earlier id, among the first ten distinct documents. */
const documentRecall = (expected: SourceRef[], hits: SourceRef[]) => {
  const wanted = [
    ...new Map(
      expected.flatMap((e) => (e.document === undefined ? [] : [[e.document, e] as const])),
    ).values(),
  ];
  if (wanted.length === 0) return undefined;
  const documents: string[] = [];
  for (const hit of hits) {
    if (documents.length === 10) break;
    if (hit.document !== undefined && !documents.includes(hit.document))
      documents.push(hit.document);
  }
  const found = wanted.filter(
    (e) =>
      documents.includes(e.document as string) ||
      (e.earlierDocument !== undefined && documents.includes(e.earlierDocument)),
  ).length;
  return { value: found / wanted.length, details: { found, expected: wanted.length } };
};

const searchedCutOffs = [1, 5, 10, 20] as const;
// The sources a service returns are its top 10 by default, so a deeper cut-off would repeat @10.
const returnedCutOffs = [1, 5, 10] as const;
const returnedName = (metric: string) => `returned-${metric}`;
const searchedMetrics = [
  ...searchedCutOffs.map((k) => `recall@${k}`),
  'hit@5',
  `mrr@${ndcgCut}`,
  `ndcg@${ndcgCut}`,
];
const returnedMetrics = [
  ...returnedCutOffs.map((k) => `recall@${k}`),
  'hit@5',
  `mrr@${ndcgCut}`,
  `ndcg@${ndcgCut}`,
].map(returnedName);

/** Scores the search hits a run reported under today's names, and the sources it returned as `returned-*`. */
export const retrievalRecall = (): Evaluator => {
  const self: Evaluator = {
    id: 'retrieval',
    version: '2',
    kind: 'deterministic',
    evaluate: async (c, o) => {
      const scores: Score[] = [];
      const expected = c.expected.sources;
      if (c.grounding !== 'sources-and-answer' || expected.length === 0) {
        const reason = `grounding is ${c.grounding} with ${expected.length} expected sources`;
        for (const metric of [...searchedMetrics, 'document-recall@10', ...returnedMetrics])
          scores.push(skipped(self, metric, reason));
      } else {
        for (const s of rankScores(expected, o.retrieved, searchedCutOffs, (m) => m))
          scores.push(scored(self, s.metric, s.value, s.details));
        const documents = documentRecall(expected, o.retrieved);
        scores.push(
          documents
            ? scored(self, 'document-recall@10', documents.value, documents.details)
            : skipped(self, 'document-recall@10', 'the expected sources name no document'),
        );
        if (o.returned === undefined)
          for (const metric of returnedMetrics)
            scores.push(skipped(self, metric, 'the run returned no sources'));
        else
          for (const s of rankScores(expected, o.returned, returnedCutOffs, returnedName))
            scores.push(scored(self, s.metric, s.value, s.details));
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

// Bound the entire serialized section, including escaped text and metadata.
const judgeSources = (observation: Observation): string => {
  const heading = '\n\nSources from the run (excerpts; may be truncated):\n';
  const sources: { citations: ObservedSource[]; retrieved: ObservedSource[] } = {
    citations: [],
    retrieved: [],
  };
  for (const kind of ['citations', 'retrieved'] as const) {
    for (const source of observation[kind].slice(0, 10)) {
      const evidence =
        observation.retrieved.find((r) => sameSource(source, r) && r.text !== undefined) ??
        observation.retrieved.find((r) => sameSource(source, r));
      const enriched = { ...evidence, ...source };
      const bounded: ObservedSource = {
        ...(enriched.position === undefined ? {} : { position: enriched.position }),
      };
      for (const field of ['chunkId', 'document', 'url', 'title', 'text'] as const) {
        const value = enriched[field];
        if (value !== undefined) bounded[field] = value.slice(0, field === 'text' ? 2000 : 512);
      }
      sources[kind].push(bounded);
      if (heading.length + untrustedData('sources', JSON.stringify(sources)).length > 16_000) {
        sources[kind].pop();
        break;
      }
    }
  }
  return sources.citations.length || sources.retrieved.length
    ? heading + untrustedData('sources', JSON.stringify(sources))
    : '';
};

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
            sources: judgeSources(o),
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
