import { describe, expect, it } from 'vitest';
import type { Event, Part } from '@genai/contracts';
import { gradeAnswer, parseTestSet } from '@genai/eval';
import { usageByModel } from './draft-runner.js';
import { markedNotFound, notFoundOf } from './not-found.js';
import { answeringModel, judgedModels, writerOf, writersOf } from './service-eval.js';

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
    expect(markedNotFound(marked)).toBe(true);
    expect(markedNotFound(unmarked)).toBe(false);
    expect(
      await gradeAnswer(reject, { text: worded, noAnswer: notFoundOf(marked) }, { context }),
    ).toEqual({ pass: true, score: 1 });
    expect(
      (await gradeAnswer(reject, { text: worded, noAnswer: notFoundOf(unmarked) }, { context }))
        .pass,
    ).toBe(false);
  });
});

describe('the model a test run records', () => {
  const definition = {
    spec: {
      model: { primary: 'foundry-openai/gpt-4o-2m-tps', fallback: 'foundry-openai/gpt-4.1-mini' },
      variants: [{ id: 'default' }, { id: 'sonnet', model: 'foundry-claude/claude-sonnet-5-5' }],
    },
  };

  it('is the own model of the first variant when none is chosen, as the draft runner runs it', () => {
    const first = {
      spec: {
        model: { primary: 'foundry-openai/gpt-4o-2m-tps' },
        variants: [{ id: 'sonnet', model: 'foundry-claude/claude-sonnet-5-5' }, 'default'],
      },
    };

    expect(answeringModel({ definition: first, files: {}, version: 'draft' })).toBe(
      'foundry-claude/claude-sonnet-5-5',
    );
    expect(
      answeringModel({ definition: first, files: {}, version: 'draft', variant: 'default' }),
    ).toBe('foundry-openai/gpt-4o-2m-tps');
  });

  it('is the own model of the variant, else the primary model', () => {
    const run = (variant?: string) =>
      answeringModel({ definition, files: {}, version: 'draft', ...(variant ? { variant } : {}) });

    expect(run()).toBe('foundry-openai/gpt-4o-2m-tps');
    expect(run('default')).toBe('foundry-openai/gpt-4o-2m-tps');
    expect(run('sonnet')).toBe('foundry-claude/claude-sonnet-5-5');
  });
});

describe('the model that wrote the answers', () => {
  const used = (model: string, inputTokens: number, kind = 'model') => ({
    model,
    kind,
    inputTokens,
    outputTokens: 0,
    costMicroNok: 0,
  });

  it('is the model that used the most tokens in a case, not a check on the side or the embedder', () => {
    expect(
      writerOf([
        used('foundry/text-embedding-3-small', 900, 'embedder'),
        used('foundry-openai/gpt-4.1-mini', 40),
        used('foundry-openai/gpt-4o-2m-tps', 500),
      ]),
    ).toBe('foundry-openai/gpt-4o-2m-tps');
    expect(writerOf([])).toBeUndefined();
  });

  it('names a fallback that wrote some answers, after the model that wrote the most', () => {
    expect(
      writersOf([
        'foundry-openai/gpt-4o-2m-tps',
        'foundry-openai/gpt-4.1-mini',
        undefined,
        'foundry-openai/gpt-4.1-mini',
      ]),
    ).toEqual(['foundry-openai/gpt-4.1-mini', 'foundry-openai/gpt-4o-2m-tps']);
    expect(writersOf(['foundry-openai/gpt-4o-2m-tps'])).toEqual(['foundry-openai/gpt-4o-2m-tps']);
  });
});

describe('a test run that grades a refusal', () => {
  it('does not take a blank or short answer for one, unless the run or its strategy marked it', () => {
    expect(markedNotFound({ noAnswer: false, answer: '', parts: [] })).toBe(false);
    expect(markedNotFound({ noAnswer: false, answer: 'Det er ikke nevnt her.', parts: [] })).toBe(
      false,
    );
    expect(markedNotFound({ noAnswer: true, answer: '', parts: [] })).toBe(true);
  });
});
