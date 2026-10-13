import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkFlowSettings,
  flowSettingsSchema,
  flowSettingsWithDefaults,
} from './flow-settings.js';
import { InMemoryDefinitionStore } from './store.js';
import { validateDefinition, type PluginSchemas } from './validate.js';

const tenant = '991825827';

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    ['step-flow@1', z.looseObject({ flow: z.string() })],
    ['single-call@1', z.looseObject({})],
  ]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(['retrieve@1', 'synthesize@1']),
  models: new Map([['m', { residency: 'norway' as const, capabilities: ['tools'] }]]),
};

const label = (nb: string, en: string) => ({ nb, en });

const settings = {
  type: 'object',
  properties: {
    documentTypes: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      'x-label': label('Dokumenttyper', 'Document types'),
      'x-widget': 'multiselect',
    },
    answerLength: {
      type: 'string',
      enum: ['short', 'medium', 'long'],
      default: 'short',
      'x-label': label('Lengde på svaret', 'Length of the answer'),
    },
    focus: { type: 'string', maxLength: 20, 'x-label': label('Hva', 'What') },
  },
  required: ['focus'],
};

const recipe = (extra: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id: 'ordered' },
  spec: {
    purpose: 'Søk i rekkefølge',
    recipe: {
      title: label('Søk i rekkefølge', 'Search in order'),
      summary: label('Velg denne når', 'Pick this when'),
    },
    settings,
    steps: [
      {
        id: 'retrieve',
        block: 'retrieve@1',
        input: { query: '{{input.query}}' },
        params: { inOrder: { field: 'type', values: '{{settings.documentTypes}}' } },
      },
      {
        id: 'answer',
        block: 'synthesize@1',
        input: { query: '{{input.query}}', contextDocs: '{{retrieve.chunks}}' },
        params: {
          answerLength: '{{settings.answerLength}}',
          generationPrompt: '{{settings.focus}}',
        },
      },
    ],
    ...extra,
  },
});

const service = (variantSettings: unknown) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'ka' },
  spec: {
    purpose: 'Svar med kilder',
    riskClass: 'limited',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: {} },
    model: { primary: 'm', residency: 'norway' },
    variants: [
      'default',
      {
        id: 'arsrapporter-forst',
        strategy: {
          id: 'step-flow',
          version: 1,
          config: { flow: 'ordered@1', settings: variantSettings },
        },
      },
    ],
  },
});

describe('recipe settings', () => {
  it('a step flow can be marked as a recipe and declare plain settings', () => {
    expect(validateDefinition(recipe(), plugins)).toMatchObject({ ok: true });
  });

  it('a flow that reads a setting it does not declare is refused at publish', () => {
    const result = validateDefinition(
      recipe({ settings: { type: 'object', properties: {} } }),
      plugins,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.message)).toEqual([
      'a step reads settings.documentTypes, which spec.settings does not declare',
      'a step reads settings.answerLength, which spec.settings does not declare',
      'a step reads settings.focus, which spec.settings does not declare',
    ]);
  });

  it('every recipe setting needs a label in bokmål and English', () => {
    const missing = flowSettingsSchema.safeParse({
      type: 'object',
      properties: { focus: { type: 'string', 'x-label': { nb: 'Hva' } } },
    });
    expect(missing.success).toBe(false);
  });

  it('a recipe setting default must fit the setting', () => {
    const wrong = flowSettingsSchema.safeParse({
      type: 'object',
      properties: {
        answerLength: {
          type: 'string',
          enum: ['short'],
          default: 'long',
          'x-label': label('a', 'b'),
        },
      },
    });
    expect(wrong.success).toBe(false);
  });

  it('publish refuses settings the recipe schema refuses', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    expect((await store.publish(recipe(), 'kari', 'oppskriften')).ok).toBe(true);

    const refused = await store.publish(
      service({ answerLength: 'huge', colour: 'red', documentTypes: 'Årsrapport' }),
      'kari',
      'feil innstillinger',
    );

    expect(refused.ok).toBe(false);
    const base = 'spec.variants[1].strategy.config.settings';
    expect(!refused.ok && refused.errors.map((e) => e.path)).toEqual([
      `${base}.colour`,
      `${base}.focus`,
      `${base}.documentTypes`,
      `${base}.answerLength`,
    ]);
    expect(!refused.ok && refused.errors[0]?.message).toBe(
      'colour is not a setting of this step flow (step flow ordered@1)',
    );
  });

  it('publish accepts a variant that picks a recipe and fills its settings', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    await store.publish(recipe(), 'kari', 'oppskriften');

    const published = await store.publish(
      service({ documentTypes: ['Årsrapport', 'Evaluering'], focus: 'mål' }),
      'kari',
      'ny variant',
    );

    expect(published.ok).toBe(true);
  });

  it('settings given to a step flow without settings are refused', () => {
    expect(checkFlowSettings(undefined, { focus: 'x' })).toEqual([
      { path: 'focus', message: 'focus is not a setting of this step flow; it has no settings' },
    ]);
  });

  it('missing settings take the recipe defaults, and given values win', () => {
    const schema = flowSettingsSchema.parse(settings);
    expect(flowSettingsWithDefaults(schema, { answerLength: 'long', focus: 'mål' })).toEqual({
      documentTypes: [],
      answerLength: 'long',
      focus: 'mål',
    });
  });
});
