import { catalogueProblems } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { undescribedPaths } from './described.js';
import { fixtureSchemaFetch, fixtureSchemaList, fixtureSchemas } from './fixtures.js';
import { en, nb } from './i18n.js';
import {
  defaultsOf,
  isWidget,
  resolveText,
  sectionsOf,
  childrenOf,
  setAt,
  shown,
  widgetOf,
  type UiSchema,
} from './schema.js';
import { parseSchemaList, schemaPath } from './schemas.js';
import { problemIssues, validate } from './validate.js';

describe('schema metadata', () => {
  it('has an English text for every bokmål text in its own catalogue', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('resolves a label to the language asked for, falling back to bokmål', () => {
    expect(resolveText({ nb: 'Navn', en: 'Name' }, 'en')).toBe('Name');
    expect(resolveText({ nb: 'Navn' }, 'en')).toBe('Navn');
    expect(resolveText('Allerede løst', 'en')).toBe('Allerede løst');
  });

  it('infers a widget from the type when no x-widget hint is given', () => {
    expect(widgetOf({ type: 'boolean' })).toBe('toggle');
    expect(widgetOf({ type: 'integer' })).toBe('number');
    expect(widgetOf({ type: 'string', enum: ['a'] })).toBe('select');
    expect(widgetOf({ type: 'array', items: { type: 'string', enum: ['a'] } })).toBe('multiselect');
    expect(widgetOf({ type: 'array', items: { type: 'string' } })).toBe('list');
    expect(widgetOf({ type: 'object', additionalProperties: { type: 'string' } })).toBe('map');
    expect(widgetOf({ type: 'string', 'x-sensitive': true })).toBe('secret');
    expect(widgetOf({ anyOf: [{ type: 'number' }, { type: 'null' }] })).toBe('number');
  });

  it('uses only widget hints from the fixed list in the fixtures', () => {
    const hints: unknown[] = [];
    const walk = (s: UiSchema) => {
      if (s['x-widget'] !== undefined) hints.push(s['x-widget']);
      Object.values(s.properties ?? {}).forEach(walk);
      if (s.items) walk(s.items);
    };
    Object.values(fixtureSchemas).forEach(walk);
    expect(hints.filter((h) => !isWidget(h))).toEqual([]);
  });

  it('orders fields by x-order and puts ungrouped fields before groups', () => {
    const fields = childrenOf({
      properties: {
        b: { type: 'string', 'x-order': 2, 'x-group': 'G' },
        a: { type: 'string', 'x-order': 1, 'x-group': 'G' },
        c: { type: 'string', 'x-order': 3 },
      },
    });
    expect(fields.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(sectionsOf(fields).map((s) => s.fields.map((f) => f.name))).toEqual([['c'], ['a', 'b']]);
  });

  it('evaluates x-showIf against a sibling field', () => {
    const value = { temperature: { mode: 'fixed' } };
    const valueSchema: UiSchema = {
      type: 'number',
      'x-showIf': { field: 'mode', equals: 'fixed' },
    };
    expect(shown(valueSchema, value, 'temperature')).toBe(true);
    expect(shown(valueSchema, { temperature: { mode: 'unsupported' } }, 'temperature')).toBe(false);
    expect(shown({ 'x-showIf': { kind: ['mcp', 'a2a'] } }, { kind: 'a2a' }, '')).toBe(true);
  });

  it('takes defaults from the schema but never for a sensitive field', () => {
    expect(
      defaultsOf({
        properties: {
          on: { type: 'boolean', default: true },
          key: { type: 'string', default: 'x', 'x-sensitive': true },
          nested: { type: 'object', properties: { n: { type: 'integer', default: 3 } } },
        },
      }),
    ).toEqual({ on: true, nested: { n: 3 } });
  });

  it('drops empty parents when a nested value is cleared', () => {
    expect(setAt({ model: { primary: 'a' } }, 'model.primary', undefined)).toEqual({});
  });
});

describe('validation', () => {
  const schema: UiSchema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      when: { type: 'string', 'x-widget': 'cron' },
      config: { type: 'object', 'x-widget': 'code' },
      secret: { type: 'string', 'x-sensitive': true },
    },
  };

  it('reports required, range, length, cron and JSON problems by field path', () => {
    expect(validate(schema, {})).toEqual({
      name: { code: 'required' },
      count: { code: 'required' },
    });
    expect(validate(schema, { name: 'a', count: 11, when: 'hver dag', config: '{' })).toEqual({
      name: { code: 'minLength', min: 2 },
      count: { code: 'max', max: 10 },
      when: { code: 'cron' },
      config: { code: 'json' },
    });
    expect(validate(schema, { name: 'ab', count: 2.5 })).toEqual({ count: { code: 'integer' } });
    expect(validate(schema, { name: 'ab', count: 3, when: '0 6 * * 1' })).toEqual({});
  });

  it('skips fields hidden by x-showIf', () => {
    const hidden: UiSchema = {
      properties: {
        mode: { type: 'string' },
        value: { type: 'number', 'x-showIf': { field: 'mode', equals: 'fixed' } },
      },
      required: ['value'],
    };
    expect(validate(hidden, { mode: 'unsupported' })).toEqual({});
    expect(validate(hidden, { mode: 'fixed' })).toEqual({ value: { code: 'required' } });
  });

  it('validates only the chosen variant of a discriminated union', () => {
    const model = fixtureSchemas['Model@v1'] as UiSchema;
    const base = { deployment: 'gpt', residency: 'eu' };
    expect(
      validate(model, { ...base, parameters: { temperature: { mode: 'unsupported' } } }),
    ).toEqual({});
    expect(
      validate(model, { ...base, parameters: { temperature: { mode: 'fixed', value: 3 } } }),
    ).toEqual({
      'parameters.temperature.value': { code: 'max', max: 2 },
    });
  });

  it('maps problem errors from the API to field paths, without the body prefix', () => {
    expect(
      problemIssues(
        {
          errors: [
            { path: 'settings.model.primary', message: 'Ukjent modell' },
            { path: 'steps[0].id', message: 'Mangler' },
          ],
        },
        'settings',
      ),
    ).toEqual({
      'model.primary': { code: 'server', message: 'Ukjent modell' },
      'steps.0.id': { code: 'server', message: 'Mangler' },
    });
  });
});

describe('undescribed values', () => {
  const schema = fixtureSchemas['ToolConnection@v1'] as UiSchema;

  it('finds a value the schema does not describe', () => {
    expect(
      undescribedPaths(schema, { name: 'x', kind: 'mcp', url: 'https://a', colour: 'blå' }),
    ).toEqual(['colour']);
    expect(undescribedPaths(schema, { name: 'x', kind: 'ftp' })).toEqual(['kind']);
    expect(undescribedPaths(schema, { name: 'x', headers: { a: 'b' } })).toEqual([]);
    expect(undescribedPaths(schema, { name: 'x', headers: { a: 1 } })).toEqual(['headers.a']);
  });
});

describe('schema list', () => {
  it('reads the list of kinds and versions and builds the schema path', () => {
    const fetch = fixtureSchemaFetch();
    const list = parseSchemaList(fetch('/schemas'));
    expect(list).toHaveLength(fixtureSchemaList.length);
    expect(
      parseSchemaList({ data: [{ kind: 'Service', versions: ['genai/v1', 'genai/v2'] }] }),
    ).toEqual([
      { kind: 'Service', version: 'genai/v1' },
      { kind: 'Service', version: 'genai/v2' },
    ]);
    expect(schemaPath('Service', 'v1')).toBe('/schemas/Service@v1');
    expect(fetch(schemaPath('Service', 'v1'))).toBe(fixtureSchemas['Service@v1']);
  });

  it('gives every fixture property an x-label in both languages', () => {
    const missing: string[] = [];
    const walk = (s: UiSchema, path: string) =>
      Object.entries(s.properties ?? {}).forEach(([name, p]) => {
        const label = p['x-label'];
        if (typeof label !== 'object' || !label.nb || !label.en) missing.push(`${path}${name}`);
        walk(p, `${path}${name}.`);
      });
    for (const [key, s] of Object.entries(fixtureSchemas)) walk(s, `${key}:`);
    expect(missing).toEqual([]);
  });
});
