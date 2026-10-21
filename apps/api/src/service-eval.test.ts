import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import { usageByModel } from './draft-runner.js';
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
