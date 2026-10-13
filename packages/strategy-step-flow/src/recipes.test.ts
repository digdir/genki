import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toCapabilities, validateService, type StepFlowDefinition } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { builtinBlocks } from './builtins.js';
import {
  chunk,
  fakeModels,
  loadFlow,
  plugins,
  run,
  stubRetrieval,
  tenant,
} from './harness.test-utils.js';
import { checkFlow } from './validate.js';

const flowsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apps',
  'api',
  'config',
  'local',
  'flows',
);
const shipped = () =>
  readdirSync(flowsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => loadFlow(join(flowsDir, f)));
const recipes = () => shipped().filter((f) => f.spec.recipe);
const recipe = (id: string) => recipes().find((f) => f.metadata.id === id) as StepFlowDefinition;

const filtersOf = (calls: { method: string; args: unknown[] }[]) =>
  calls
    .filter((c) => c.method === 'retrieve')
    .map((c) => (c.args[1] as { filters?: unknown }).filters ?? null);

const userPrompt = (models: ReturnType<typeof fakeModels>) =>
  models.seen[0]?.request.messages[1]?.content ?? '';

describe('recipes', () => {
  it('ships at least three recipes, each a valid flow with labelled settings', () => {
    const shippedRecipes = recipes();
    expect(shippedRecipes.map((f) => f.metadata.id).sort()).toEqual([
      'answer-briefly-with-sources',
      'compare-documents',
      'ordered-sources-answer',
    ]);
    for (const flow of shippedRecipes) expect(checkFlow(flow, builtinBlocks())).toEqual([]);
  });

  it('settings reach the steps: each chosen document type is searched in order, then answered briefly', async () => {
    const retrieval = stubRetrieval([chunk('c1'), chunk('c2')]);
    const models = fakeModels({ primary: ['Årsrapporten sier [1].'] });

    const out = await run({
      flows: [recipe('ordered-sources-answer')],
      entry: 'ordered-sources-answer@1',
      models,
      retrieval,
      strategy: { settings: { documentTypes: ['Årsrapport', 'Evaluering'] } },
    });

    expect(out.task.status).toBe('completed');
    expect(filtersOf(retrieval.calls)).toEqual([
      { type: ['Årsrapport'] },
      { type: ['Evaluering'] },
    ]);
    expect(retrieval.calls.some((c) => c.method === 'rerank')).toBe(false);
    expect(userPrompt(models)).toContain('Answer briefly: at most three sentences.');
  });

  it('a recipe with no document types chosen searches once, without a filter', async () => {
    const retrieval = stubRetrieval([chunk('c1')]);
    const models = fakeModels({ primary: ['Svar [1].'] });

    await run({
      flows: [recipe('ordered-sources-answer')],
      entry: 'ordered-sources-answer@1',
      models,
      retrieval,
    });

    expect(filtersOf(retrieval.calls)).toEqual([null]);
  });

  it('answer briefly with sources keeps only as many sources as the setting allows', async () => {
    const retrieval = stubRetrieval([chunk('c1'), chunk('c2'), chunk('c3')]);
    const models = fakeModels({ primary: ['Svar [1].'] });

    await run({
      flows: [recipe('answer-briefly-with-sources')],
      entry: 'answer-briefly-with-sources@1',
      models,
      retrieval,
      strategy: { settings: { maxSources: 1, answerLength: 'long' } },
    });

    expect(userPrompt(models)).toContain('Tekst for c1.');
    expect(userPrompt(models)).not.toContain('Tekst for c2.');
    expect(userPrompt(models)).toContain('Answer thoroughly');
  });

  it('a variant runs a recipe with its settings', async () => {
    const service = validateService(
      {
        apiVersion: 'genai/v1',
        kind: 'Service',
        metadata: { tenant, id: 'kunnskapsassistenten' },
        spec: {
          purpose: 'Svar med kilder',
          riskClass: 'limited',
          input: { accepts: ['text/plain'] },
          output: { kind: 'answer', withSources: true },
          strategy: { id: 'step-flow', version: 1, config: { flow: 'basic-rag@1' } },
          knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
          model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
          variants: [
            'default',
            {
              id: 'arsrapporter-forst',
              title: { nb: 'Årsrapporter først', en: 'Annual reports first' },
              strategy: {
                id: 'step-flow',
                version: 1,
                config: {
                  flow: 'compare-documents@1',
                  settings: {
                    documentTypes: ['Tildelingsbrev', 'Årsrapport'],
                    focus: 'Se på mål.',
                  },
                },
              },
            },
          ],
        },
      },
      plugins,
    );
    if (!service.ok) throw new Error(JSON.stringify(service.errors));
    const variant = toCapabilities(service.definition, 1).find(
      (c) => c.variant === 'arsrapporter-forst',
    );
    const strategy = (variant?.capability.config as { strategy: Record<string, unknown> }).strategy;
    const retrieval = stubRetrieval([chunk('c1')]);
    const models = fakeModels({ primary: ['De er enige [1].'] });

    const out = await run({
      flows: [recipe('compare-documents')],
      entry: String(strategy.flow),
      models,
      retrieval,
      strategy,
    });

    expect(out.task.status).toBe('completed');
    expect(filtersOf(retrieval.calls)).toEqual([
      { type: ['Tildelingsbrev'] },
      { type: ['Årsrapport'] },
    ]);
    expect(userPrompt(models)).toContain(
      'First say where they agree, then where they differ. Se på mål.',
    );
  });
});
