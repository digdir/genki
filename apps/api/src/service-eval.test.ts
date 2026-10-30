import { describe, expect, it } from 'vitest';
import type { Event, Part } from '@genai/contracts';
import { gradeAnswer, parseTestSet } from '@genai/eval';
import { usageByModel } from './draft-runner.js';
import { notFoundOf } from './not-found.js';
import { judgedModels } from './service-eval.js';

const usage = (model: { id: string; kind: string }, inputTokens: number): Event =>
  ({
    type: 'kernel.usage',
    data: { usage: { inputTokens, outputTokens: 0 }, model },
  }) as unknown as Event;

describe('the models a judge is checked against', () => {
  it('keeps the kind of each model in the usage of a run', () => {
    const byModel = usageByModel(
      [
        usage({ kind: 'model', id: 'foundry-openai/gpt-4o' }, 10),
        usage({ kind: 'embedder', id: 'foundry/text-embedding-3-small' }, 4),
        usage({ kind: 'model', id: 'foundry-openai/gpt-4o' }, 5),
      ],
      {},
    );

    expect(byModel).toEqual([
      expect.objectContaining({ model: 'foundry-openai/gpt-4o', kind: 'model', inputTokens: 15 }),
      expect.objectContaining({
        model: 'foundry/text-embedding-3-small',
        kind: 'embedder',
        inputTokens: 4,
      }),
    ]);
  });

  it('leaves out the embedders a run used, since they write no answer to be judged', () => {
    const byModel = usageByModel(
      [
        usage({ kind: 'model', id: 'foundry-openai/gpt-4o' }, 10),
        usage({ kind: 'embedder', id: 'foundry/text-embedding-3-small' }, 4),
      ],
      {},
    );

    expect(judgedModels(byModel)).toEqual(['foundry-openai/gpt-4o']);
  });
});

describe('an answer that found nothing', () => {
  const worded =
    'Jeg fant ingen informasjon om oppskriften på tradisjonell brunost i de gjennomgåtte dokumentene. Det ser ut til at temaet ikke er dekket.';
  const answer = (meta?: Record<string, unknown>): Part[] => [
    { mime: 'text/plain', body: { kind: 'text', text: worded }, ...(meta ? { meta } : {}) },
  ];
  const [reject] = parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: '991825827', id: 'kudos', name: 'Kudos', version: 1 },
    spec: {
      cases: [
        {
          id: 'brunost',
          split: 'train',
          input: 'Hva er oppskriften på tradisjonell brunost?',
          expected: { sources: [], referenceAnswer: 'Kildene i Kudos dekker ikke dette.' },
          grounding: 'refusal-expected',
        },
      ],
    },
  }).spec.cases;
  const context = { servedModels: [], modelFamily: () => undefined };

  it('counts as a refusal when the strategy marks it, though no refusal phrase matches', async () => {
    const marked = { noAnswer: false, answer: worded, parts: answer({ noAnswer: true }) };
    const unmarked = { noAnswer: false, answer: worded, parts: answer() };
    if (!reject) throw new Error('the test set has no case');

    expect(notFoundOf(marked)).toBe(true);
    expect(notFoundOf(unmarked)).toBe(false);
    expect(notFoundOf({ noAnswer: true, answer: '', parts: [] })).toBe(true);
    expect(notFoundOf({ noAnswer: false, answer: 'Fant ikke noe.', parts: [] })).toBe(true);
    expect(
      await gradeAnswer(reject, { text: worded, noAnswer: notFoundOf(marked) }, { context }),
    ).toEqual({ pass: true, score: 1 });
    expect(
      (await gradeAnswer(reject, { text: worded, noAnswer: notFoundOf(unmarked) }, { context }))
        .pass,
    ).toBe(false);
  });
});
