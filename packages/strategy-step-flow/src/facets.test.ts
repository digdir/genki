import { describe, expect, it } from 'vitest';
import { builtinBlocks } from './builtins.js';
import { chunk, fakeModels, run, steps, stubRetrieval } from './harness.test-utils.js';
import type { FlowRetrieval } from './services.js';
import { checkFlow } from './validate.js';

const textOf = (result: unknown) =>
  (result as { body: { json: { text: string } } }[])[0]?.body.json.text ?? '';

const entries = [
  { value: 'Norway', count: 4 },
  { value: 'Sweden', count: 3 },
  { value: '{{input.query}}', count: 1 },
];
const faceted = () => {
  const base = stubRetrieval([]);
  const calls: unknown[][] = [];
  const backend: FlowRetrieval = {
    ...base.factory(undefined, undefined),
    facets: async (fields, maxValues, signal) => {
      calls.push([fields, maxValues, signal.aborted]);
      // Deliberately ignore the cap and include an unrequested field.
      return { jurisdiction: entries, secret: [{ value: 'hidden', count: 9 }] };
    },
  };
  return { ...base, facetCalls: calls, factory: () => backend };
};

const facetStep = (params: Record<string, unknown> = {}) => ({
  id: 'facets',
  block: 'facets@1',
  params: { fields: ['jurisdiction'], ...params },
});

describe('facets in step flows', () => {
  it('facet values reach a later template and remain an array in an extract schema enum', async () => {
    const retrieval = faceted();
    const models = fakeModels({ primary: ['{"jurisdictions":["Norway"]}'] });
    const flow = steps('compare', [
      facetStep(),
      {
        id: 'jurisdictions',
        block: 'extract@1',
        input: { prompt: 'Choose from {{facets.values.jurisdiction}}' },
        params: {
          schema: {
            type: 'object',
            properties: {
              jurisdictions: {
                type: 'array',
                items: { type: 'string', enum: '{{facets.values.jurisdiction}}' },
              },
            },
            required: ['jurisdictions'],
            additionalProperties: false,
          },
        },
      },
      {
        id: 'answer',
        block: 'template@1',
        input: { text: '{{jurisdictions.jurisdictions}} {{facets.facets.jurisdiction.0.count}}' },
      },
    ]);
    expect(checkFlow(flow, builtinBlocks())).toEqual([]);

    const out = await run({ flows: [flow], entry: 'compare@1', models, retrieval });

    expect(out.task.status).toBe('completed');
    expect(models.seen[0]?.request.jsonSchema).toMatchObject({
      schema: {
        properties: {
          jurisdictions: { items: { enum: entries.map((entry) => entry.value) } },
        },
      },
    });
    expect(models.seen[0]?.request.messages.at(-1)?.content).toContain(
      '["Norway","Sweden","{{input.query}}"]',
    );
    expect(textOf(out.result)).toBe('["Norway"] 4');
    expect(retrieval.facetCalls).toEqual([[['jurisdiction'], 200, false]]);
  });

  it('the cap bounds each returned field even when a backend ignores it and drops extra fields', async () => {
    const flow = steps('bounded', [
      facetStep({ fields: ['jurisdiction', 'jurisdiction'], maxValues: 1 }),
      { id: 'answer', block: 'template@1', input: { text: 'Facets: {{facets}}' } },
    ]);
    const retrieval = faceted();

    const out = await run({ flows: [flow], entry: 'bounded@1', retrieval });

    expect(out.task.status).toBe('completed');
    expect(JSON.parse(textOf(out.result).slice('Facets: '.length))).toEqual({
      values: { jurisdiction: ['Norway'] },
      facets: { jurisdiction: [{ value: 'Norway', count: 4 }] },
    });
    expect(retrieval.facetCalls).toEqual([[['jurisdiction'], 1, false]]);
  });

  it.each([
    { maxValues: 0 },
    { maxValues: 1001 },
    { maxValues: 1.5 },
    { fields: [] },
    { fields: [''] },
    { fields: Array.from({ length: 21 }, (_, i) => `f${i}`) },
    { dataset: 'other/secret' },
  ])('validation refuses invalid facet bounds and dataset overrides: %j', (params) => {
    expect(
      checkFlow(steps('invalid', [facetStep(params)]), builtinBlocks()).length,
    ).toBeGreaterThan(0);
  });

  it('a rendered cap above the maximum is refused before facets are called', async () => {
    const retrieval = faceted();
    const out = await run({
      flows: [steps('invalid', [facetStep({ maxValues: '{{config.cap}}' })])],
      entry: 'invalid@1',
      config: { cap: 1001 },
      retrieval,
    });
    expect(out.task.status).toBe('failed');
    expect(retrieval.facetCalls).toEqual([]);
  });

  it('missing facet support fails the step and follows its explicit error policy', async () => {
    const flow = steps('unsupported', [
      { ...facetStep(), onError: 'use-default', default: { values: { jurisdiction: [] } } },
      {
        id: 'answer',
        block: 'template@1',
        input: { text: 'Values: {{facets.values.jurisdiction}}' },
      },
    ]);
    const out = await run({ flows: [flow], entry: 'unsupported@1', retrieval: stubRetrieval([]) });
    expect(out.task.status).toBe('completed');
    expect(textOf(out.result)).toBe('Values: []');
  });

  it('exact inOrder matching is unchanged: names and numeric values pass through in order', async () => {
    const retrieval = stubRetrieval([chunk('same')]);
    const flow = steps('exact', [
      {
        id: 'retrieve',
        block: 'retrieve@1',
        input: { query: 'AI' },
        params: {
          plan: false,
          inOrder: { field: 'jurisdiction', values: ['Norway', 'norway', 42] },
        },
      },
    ]);

    const out = await run({ flows: [flow], entry: 'exact@1', retrieval });

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls.map((call) => call.args)).toEqual([
      [['AI'], { filters: { jurisdiction: ['Norway'] } }],
      [['AI'], { filters: { jurisdiction: ['norway'] } }],
      [['AI'], { filters: { jurisdiction: [42] } }],
    ]);
  });

  it('contains mode is refused by block validation because this feature keeps exact matching', () => {
    const flow = steps('contains', [
      {
        id: 'retrieve',
        block: 'retrieve@1',
        params: { inOrder: { field: 'jurisdiction', values: ['Nor'], match: 'contains' } },
      },
    ]);
    expect(checkFlow(flow, builtinBlocks())).toEqual([
      expect.objectContaining({
        path: 'spec.steps[0].params.inOrder',
        message: expect.stringContaining('match'),
      }),
    ]);
  });
});
