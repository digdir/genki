import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategyKey, toCapabilities, validateService, type PluginSchemas } from './index.js';

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
  ]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map([['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream'] }]]),
};

const service = (fields: unknown[], datasets: string[] = ['kudos']) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '991825827', id: 'maloppnaelse' },
  spec: {
    purpose: 'Vurder måloppnåelse',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'], fields },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Vurder.' } },
    knowledge: { datasets: datasets.map((dataset) => ({ dataset })) },
    model: { primary: 'foundry/gpt-4o', residency: 'norway' },
  },
});

const ministry = {
  id: 'ministry',
  label: 'Departement',
  kind: 'choice',
  required: true,
  options: ['Digitaliserings- og forvaltningsdepartementet', 'Kunnskapsdepartementet'],
};
const agency = {
  id: 'agency',
  label: 'Virksomhet',
  kind: 'organisation',
  optionsFrom: { dataset: 'kudos', facet: 'organisation' },
};

const errorsOf = (fields: unknown[], datasets?: string[]) => {
  const result = validateService(service(fields, datasets), plugins);
  return result.ok ? [] : result.errors;
};

describe('service input fields', () => {
  it('accepts a form with choices, an organisation from facets and a year', () => {
    const result = validateService(
      service([ministry, agency, { id: 'year', label: 'År', kind: 'year' }]),
      plugins,
    );

    expect(result.ok).toBe(true);
  });

  it('keeps the free-text question when no fields are declared', () => {
    const result = validateService(service([]), plugins);
    if (!result.ok) throw new Error('expected a valid service');
    const [compiled] = toCapabilities(result.definition, 1);

    expect(compiled?.capability.descriptor.input).toEqual({});
    expect(compiled?.capability.descriptor.inputFields).toBeUndefined();
  });

  it('compiles fields into an input schema with the required fields', () => {
    const result = validateService(service([ministry, agency]), plugins);
    if (!result.ok) throw new Error('expected a valid service');
    const [compiled] = toCapabilities(result.definition, 1);
    const schema = compiled?.capability.descriptor.input as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };

    expect(schema.required).toEqual(['ministry']);
    expect(schema.properties.ministry?.enum).toEqual(ministry.options);
    expect(Object.keys(schema.properties)).toEqual(['ministry', 'agency', 'query']);
    expect(compiled?.capability.descriptor.inputFields?.map((f) => f.id)).toEqual([
      'ministry',
      'agency',
    ]);
  });

  it('rejects duplicate and reserved ids', () => {
    expect(
      errorsOf([ministry, ministry, { id: 'query', label: 'Spørsmål', kind: 'text' }]),
    ).toEqual([
      { path: 'spec.input.fields[1].id', message: 'duplicate input field ministry' },
      { path: 'spec.input.fields[2].id', message: 'query is reserved for the platform' },
    ]);
  });

  it('rejects ids that cannot be read as input.<id> in a step flow', () => {
    expect(errorsOf([{ id: 'Mål-år', label: 'År', kind: 'year' }])[0]?.path).toBe(
      'spec.input.fields[0].id',
    );
  });

  it('needs options on a choice and refuses them on a text field', () => {
    expect(
      errorsOf([
        { id: 'type', label: 'Type', kind: 'choice' },
        { id: 'note', label: 'Merknad', kind: 'text', options: ['a'] },
      ]),
    ).toEqual([
      { path: 'spec.input.fields[0]', message: 'a choice field needs options or optionsFrom' },
      { path: 'spec.input.fields[1]', message: 'a text field takes no options' },
    ]);
  });

  it('refuses options drawn from a dataset the service does not search', () => {
    expect(errorsOf([agency], ['nettsider'])).toEqual([
      {
        path: 'spec.input.fields[0].optionsFrom.dataset',
        message: 'dataset kudos is not in spec.knowledge.datasets',
      },
    ]);
  });

  it('takes min, max and a pattern on options drawn from a facet, and refuses broken ones', () => {
    const years = (from: Record<string, unknown>) => [
      { ...agency, kind: 'multi-choice', optionsFrom: { ...agency.optionsFrom, ...from } },
    ];
    expect(errorsOf(years({ min: 1900, max: 2031, pattern: '^\\d{4}$' }))).toEqual([]);
    expect(errorsOf(years({ pattern: '([' }))).toEqual([
      {
        path: 'spec.input.fields[0].optionsFrom.pattern',
        message: 'must be a valid regular expression',
      },
    ]);
    expect(errorsOf(years({ min: 2030, max: 2020 }))).toEqual([
      { path: 'spec.input.fields[0].optionsFrom.min', message: 'min must not be greater than max' },
    ]);
  });

  it('refuses an unknown kind', () => {
    expect(errorsOf([{ id: 'file', label: 'Fil', kind: 'upload' }])[0]?.path).toBe(
      'spec.input.fields[0].kind',
    );
  });

  it('lets a field depend on an earlier field with choices, and nothing else', () => {
    expect(errorsOf([ministry, { ...agency, dependsOn: 'ministry' }])).toEqual([]);
    expect(errorsOf([{ ...agency, dependsOn: 'ministry' }, ministry])).toEqual([
      {
        path: 'spec.input.fields[0].dependsOn',
        message: 'ministry is not an earlier input field',
      },
    ]);
    expect(
      errorsOf([
        { id: 'note', label: 'Merknad', kind: 'text' },
        { ...agency, dependsOn: 'note' },
      ]),
    ).toEqual([
      { path: 'spec.input.fields[1].dependsOn', message: 'note has no choices to depend on' },
    ]);
  });

  it('checks the default value against the field', () => {
    expect(errorsOf([{ id: 'aar', label: 'År', kind: 'year', default: 2025 }])).toEqual([]);
    expect(errorsOf([{ id: 'aar', label: 'År', kind: 'year', default: 'i fjor' }])).toEqual([
      {
        path: 'spec.input.fields[0].default',
        message: '«År» må være et årstall, for eksempel 2025.',
      },
    ]);
  });

  it('takes years from a dataset facet but no fixed list of years', () => {
    const year = { id: 'aar', label: 'År', kind: 'year' };
    expect(errorsOf([{ ...year, optionsFrom: { dataset: 'kudos', facet: 'year' } }])).toEqual([]);
    expect(errorsOf([{ ...year, options: ['2025'] }])).toEqual([
      { path: 'spec.input.fields[0]', message: 'a year field takes optionsFrom, not options' },
    ]);
  });
});
