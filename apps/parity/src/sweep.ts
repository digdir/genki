import { send } from './http.js';
import type { JsonValue, Target } from './types.js';

export interface SweepCase {
  id: string;
  question: string;
  reference?: string;
  tags?: string[];
}

export interface Answer {
  text: string;
  citations: string[];
  servedModel?: string;
}

export interface Judgement {
  score: number;
  reasons?: string;
}

export interface Judge {
  id: string;
  model: string;
  score(testCase: SweepCase, answer: Answer): Promise<Judgement>;
}

export type Asker = (target: Target, testCase: SweepCase) => Promise<Answer>;

export interface SweepOptions {
  targets: [Target, Target];
  cases: SweepCase[];
  ask: Asker;
  judge: Judge;
  repeats?: number;
}

export interface TargetSummary {
  target: string;
  mean: number;
  ci: [number, number];
  servedModels: string[];
  errors: number;
}

export interface SweepReport {
  judge: { id: string; model: string };
  repeats: number;
  valid: boolean;
  problems: string[];
  targets: [TargetSummary, TargetSummary];
  paired: { meanDifference: number; ci: [number, number]; n: number };
  cases: { id: string; scores: [number[], number[]] }[];
}

const record = (v: JsonValue | string | undefined): Record<string, JsonValue> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;

export const openAiAsker =
  (model: string | Record<string, string>): Asker =>
  async (target, testCase) => {
    const response = await send(target, {
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: typeof model === 'string' ? model : (model[target.name] ?? ''),
        stream: false,
        messages: [{ role: 'user', content: testCase.question }],
      },
    });
    const body = record(response.body);
    if (response.status !== 200 || !body)
      throw new Error(`HTTP ${response.status} from ${target.name}`);
    const message = record(record((body.choices as JsonValue[] | undefined)?.[0])?.message);
    const citations = Array.isArray(body.citations)
      ? body.citations.filter((c): c is string => typeof c === 'string')
      : [];
    const served = body.served_model ?? body.model;
    return {
      text: typeof message?.content === 'string' ? message.content : '',
      citations,
      ...(typeof served === 'string' ? { servedModel: served } : {}),
    };
  };

const tTable: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  12: 2.179,
  15: 2.131,
  20: 2.086,
  25: 2.06,
  30: 2.042,
};

export const tQuantile = (df: number) => {
  if (df > 30) return 1.96;
  const known = Object.keys(tTable)
    .map(Number)
    .filter((k) => k <= df);
  return tTable[Math.max(...known, 1)] as number;
};

export const meanWithCi = (values: number[]): { mean: number; ci: [number, number] } => {
  const n = values.length;
  if (n === 0) return { mean: Number.NaN, ci: [Number.NaN, Number.NaN] };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, ci: [mean, mean] };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const half = tQuantile(n - 1) * Math.sqrt(variance / n);
  return { mean, ci: [mean - half, mean + half] };
};

const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const runSweep = async (options: SweepOptions): Promise<SweepReport> => {
  const repeats = options.repeats ?? 3;
  const problems: string[] = [];
  const served: [Set<string>, Set<string>] = [new Set(), new Set()];
  const errors: [number, number] = [0, 0];
  const cases: SweepReport['cases'] = [];

  for (const testCase of options.cases) {
    const scores: [number[], number[]] = [[], []];
    for (const [t, target] of options.targets.entries()) {
      for (let r = 0; r < repeats; r++) {
        try {
          const answer = await options.ask(target, testCase);
          if (answer.servedModel) served[t as 0 | 1].add(answer.servedModel);
          else problems.push(`${target.name} did not report a served model for ${testCase.id}`);
          const { score } = await options.judge.score(testCase, answer);
          if (!Number.isFinite(score) || score < 0 || score > 1)
            throw new Error(`judge score ${score} is outside 0..1`);
          scores[t as 0 | 1].push(score);
        } catch (error) {
          errors[t as 0 | 1]++;
          problems.push(`${target.name} ${testCase.id}: ${(error as Error).message}`);
        }
      }
    }
    cases.push({ id: testCase.id, scores });
  }

  const [a, b] = served.map((s) => [...s].sort()) as [string[], string[]];
  if (a.length > 0 && b.length > 0 && JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(`served models differ: ${a.join(', ')} vs ${b.join(', ')}`);
  }
  const summary = (t: 0 | 1): TargetSummary => ({
    target: options.targets[t].name,
    ...meanWithCi(cases.flatMap((c) => c.scores[t])),
    servedModels: t === 0 ? a : b,
    errors: errors[t],
  });
  const pairs = cases.filter((c) => c.scores[0].length > 0 && c.scores[1].length > 0);
  const differences = pairs.map((c) => average(c.scores[1]) - average(c.scores[0]));
  const paired = meanWithCi(differences);

  return {
    judge: { id: options.judge.id, model: options.judge.model },
    repeats,
    valid: problems.length === 0,
    problems: [...new Set(problems)],
    targets: [summary(0), summary(1)],
    paired: { meanDifference: paired.mean, ci: paired.ci, n: pairs.length },
    cases,
  };
};

const judgeInstructions =
  'Score the answer from 0 to 1 for correctness against the reference and for being supported by its citations. Reply as JSON {"score": number, "reasons": string}.';

const judgeInput = (testCase: SweepCase, answer: { text: string; citations: unknown }) =>
  JSON.stringify({
    question: testCase.question,
    reference: testCase.reference ?? null,
    answer: answer.text,
    citations: answer.citations,
  });

const parseJudgement = (text: string): Judgement => {
  const parsed = JSON.parse(
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) || '{}',
  ) as Judgement;
  if (typeof parsed.score !== 'number') throw new Error('judge returned no score');
  return parsed;
};

export const anthropicJudge = (options: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Judge => ({
  id: 'rubric-v1',
  model: options.model,
  score: async (testCase, answer) => {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 4000,
        system: judgeInstructions,
        messages: [{ role: 'user', content: judgeInput(testCase, answer) }],
      }),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    return parseJudgement(body.content?.find((c) => c.type === 'text')?.text ?? '');
  },
});

export const openAiJudge = (options: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Judge => ({
  id: 'rubric-v1',
  model: options.model,
  score: async (testCase, answer) => {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: judgeInstructions,
          },
          {
            role: 'user',
            content: JSON.stringify({
              question: testCase.question,
              reference: testCase.reference ?? null,
              answer: answer.text,
              citations: answer.citations,
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as Judgement;
    if (typeof parsed.score !== 'number') throw new Error('judge returned no score');
    return parsed;
  },
});
