import { describe, expect, it } from 'vitest';
import { chunk, fakeModels, run, steps } from './harness.test-utils.js';

const schema = {
  type: 'object',
  required: ['goals'],
  properties: {
    goals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['goal'],
        properties: { goal: { type: 'string' } },
      },
    },
  },
};

const cited = (...goals: [string, number][]) =>
  JSON.stringify({ goals: goals.map(([value, n]) => ({ goal: { value, sources: [n] } })) });

const flow = (chunks: unknown[], params: Record<string, unknown> = {}) =>
  steps('ut', [
    {
      id: 'uthenting',
      block: 'extract@1',
      input: { prompt: 'Hent målene', chunks },
      params: { schema, ...params },
    },
  ]);

const big = (id: string, size: number) => chunk(id, { content: `${id} `.repeat(size) });

describe('extract block', () => {
  it('repairs once when the model returns invalid JSON', async () => {
    const models = fakeModels({ primary: ['Her er svaret: {"goals"', cited(['Mål A', 1])] });

    const out = await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models });

    expect(out.task.status).toBe('completed');
    expect(models.seen).toHaveLength(2);
    expect(models.seen[1]?.request.messages.at(-1)?.content).toMatch(
      /not one complete, valid JSON/,
    );
  });

  it('retries with a larger output budget when the answer is cut off by the token limit', async () => {
    const models = fakeModels({
      primary: [{ truncated: '{"goals":[{"goal":{"val' }, cited(['Mål A', 1])],
    });

    const out = await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models });

    expect(out.task.status).toBe('completed');
    const [first, second] = models.seen.map((s) => s.request.maxTokens ?? 0);
    expect(second).toBe((first ?? 0) * 2);
  });

  it('fails with a coded step error after one repair attempt', async () => {
    const models = fakeModels({ primary: ['ikke json', 'fortsatt ikke json'] });
    const doc = steps('ut', [
      {
        id: 'hver',
        forEach: {
          as: 'd',
          in: 'input.items',
          steps: [
            {
              id: 'uthenting',
              block: 'extract@1',
              input: { prompt: 'Hent', chunks: [chunk('c1')] },
              params: { schema },
            },
          ],
        },
        onError: 'skip',
      },
    ]);

    const out = await run({ flows: [doc], entry: 'ut@1', models }, {
      data: { items: ['a'] },
    } as never);

    expect(models.seen).toHaveLength(2);
    expect(JSON.stringify(out.events)).toContain('"code":"invalid_json"');
  });

  it('fits the output budget to the size of the excerpts when no maxTokens is set', async () => {
    const models = fakeModels({ primary: [cited(['A', 1])] });

    await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models });

    expect(models.seen[0]?.request.maxTokens).toBeGreaterThan(4000);
  });

  it('asks for low reasoning effort only from models that declare reasoning', async () => {
    const plain = fakeModels({ primary: [cited(['A', 1])] });
    const reasoning = fakeModels(
      { primary: [cited(['A', 1])] },
      { capabilities: ['json-schema', 'reasoning'] },
    );

    await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models: plain });
    await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models: reasoning });

    expect(plain.seen[0]?.request.reasoning).toBeUndefined();
    expect(reasoning.seen[0]?.request.reasoning).toBe('low');
  });

  it('puts the schema in the prompt and reads fenced JSON when the model lacks json-schema', async () => {
    const models = fakeModels(
      { primary: ['```json\n' + cited(['A', 1]) + '\n```'] },
      { capabilities: [] },
    );

    const out = await run({ flows: [flow([chunk('c1')])], entry: 'ut@1', models });

    expect(out.task.status).toBe('completed');
    expect(models.seen[0]?.request.jsonSchema).toBeUndefined();
    expect(models.seen[0]?.request.messages.at(-1)?.content).toMatch(/JSON schema/);
  });

  it('reads a document too long for one call window by window and merges the goals with their sources', async () => {
    const models = fakeModels({
      primary: [cited(['Mål 1', 1], ['Mål 2', 2]), cited(['Mål 3', 1])],
    });
    const chunks = [big('a', 200), big('b', 200), big('c', 200)];

    const out = await run({
      flows: [flow(chunks, { maxContextLength: 700 })],
      entry: 'ut@1',
      models,
    });

    expect(out.task.status).toBe('completed');
    expect(models.seen).toHaveLength(2);
    const result = JSON.stringify(out.result);
    expect(result).toContain('Mål 1');
    expect(result).toContain('Mål 3');
    expect(result).toContain('goals.2.goal');
  });

  it('never reads more windows than maxWindows', async () => {
    const models = fakeModels({ primary: [cited()] });
    const chunks = Array.from({ length: 10 }, (_, i) => big(`k${i}`, 100));

    await run({
      flows: [flow(chunks, { maxContextLength: 300, maxWindows: 2 })],
      entry: 'ut@1',
      models,
    });

    expect(models.seen.length).toBeLessThanOrEqual(2);
  });
});
