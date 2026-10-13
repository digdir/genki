import { describe, expect, it } from 'vitest';
import { blockDefFromSchema } from '../../data/step-blocks';
import { registerBlocks } from '../../data/stepflows';
import { platformStepBlocks } from '../../mock/step-blocks';
import { translator } from '../../i18n';
import { editorBuiltFlow } from './fixtures/editor-built-flow';
import editorBuilt from './fixtures/editor-built-flow.json';
import maloppnaelse from './fixtures/maloppnaelse-flyt.json';
import { platformRecipes } from '../../mock/recipes';
import { analyse, fromDefinition, toDefinition } from './model';

const withoutDefaultStop = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutDefaultStop)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k, v]) => !(k === 'onError' && v === 'stop'))
            .map(([k, v]) => [k, withoutDefaultStop(v)]),
        )
      : value;

registerBlocks(Object.fromEntries(platformStepBlocks.map((b) => [b.name, blockDefFromSchema(b)])));

describe('the step flow editor and the API agree', () => {
  it('round-trips the måloppnåelse example without changing its meaning', () => {
    const back = toDefinition(fromDefinition(maloppnaelse), maloppnaelse.metadata.tenant, {});

    expect(withoutDefaultStop(back.spec.steps)).toEqual(maloppnaelse.spec.steps);
  });

  it('writes the flow the API validates in its own test', () => {
    expect(toDefinition(editorBuiltFlow, '991825827', {})).toEqual(editorBuilt);
  });

  it('keeps the templated arguments of a tool step through the editor', () => {
    const definition = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: '991825827', id: 'saksoppslag' },
      spec: {
        purpose: 'Slå opp saker',
        steps: [
          {
            id: 'sok',
            name: 'sok',
            block: 'tool@1',
            params: {
              source: 'saker',
              tool: 'sok',
              arguments: { q: '{{input.query}}', limit: 5 },
              timeoutMs: 20000,
            },
            onError: 'use-default',
            default: { text: 'ingen' },
          },
        ],
      },
    };

    const back = toDefinition(fromDefinition(definition), '991825827', {});

    expect(withoutDefaultStop(back.spec.steps)).toEqual(definition.spec.steps);
  });

  it('keeps a recipe and its settings through the editor, and reads settings.<name> as a known value', () => {
    const recipe = platformRecipes.find((r) => r.id === 'ordered-sources-answer');
    if (!recipe) throw new Error('no ordered-sources-answer recipe');
    const definition = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: '991825827', id: recipe.id },
      spec: {
        purpose: recipe.purpose,
        recipe: { title: recipe.title, summary: recipe.summary },
        settings: recipe.settings,
        steps: recipe.steps,
      },
    };

    const flow = fromDefinition(definition);
    const back = toDefinition(flow, '991825827', {});

    expect(back.spec).toMatchObject({
      recipe: definition.spec.recipe,
      settings: definition.spec.settings,
    });
    expect([...analyse(flow, { [flow.id]: flow }).errors.values()].flat()).toEqual([]);
  });

  it('labels the tool block and its fields in both languages', () => {
    const schema = platformStepBlocks.find((b) => b.name === 'tool');
    if (!schema) throw new Error('the catalogue has no tool block');

    const nb = blockDefFromSchema(schema, translator('nb'));
    const en = blockDefFromSchema(schema, translator('en'));

    expect(nb.name).toBe('Kall et verktøy');
    expect(en.name).toBe('Call a tool');
    expect(nb.params.map((p) => p.label)).toEqual([
      'Verktøykilde',
      'Verktøy',
      'Verdier til verktøyet',
      'Tidsavbrudd (millisekunder)',
    ]);
    expect(en.params.map((p) => p.label)).toEqual([
      'Tool source',
      'Tool',
      'Values for the tool',
      'Timeout (milliseconds)',
    ]);
    expect(en.params.filter((p) => p.required).map((p) => p.name)).toEqual(['source', 'tool']);
  });
});
