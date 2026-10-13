import { describe, expect, it } from 'vitest';
import {
  checkInputFields,
  fieldsQuery,
  inputFieldsSchema,
  plausibleYears,
  type InputField,
} from './index.js';

const fields: InputField[] = [
  { id: 'ministry', label: 'Departement', kind: 'choice', required: true, options: ['KD', 'DFD'] },
  { id: 'agency', label: 'Virksomhet', kind: 'organisation' },
  { id: 'topics', label: 'Tema', kind: 'multi-choice', options: ['mål', 'budsjett'] },
  { id: 'year', label: 'År', kind: 'year' },
  { id: 'due', label: 'Frist', kind: 'date' },
  { id: 'amount', label: 'Beløp', kind: 'number' },
];

describe('input fields', () => {
  it('accepts valid values and turns numeric strings into numbers', () => {
    expect(
      checkInputFields(fields, {
        ministry: 'DFD',
        agency: 'Digdir',
        topics: ['mål'],
        year: '2025',
        due: '2026-03-01',
        amount: 12.5,
      }),
    ).toEqual({
      ok: true,
      values: {
        ministry: 'DFD',
        agency: 'Digdir',
        topics: ['mål'],
        year: 2025,
        due: '2026-03-01',
        amount: 12.5,
      },
    });
  });

  it('names the missing field and the wrong options in Norwegian', () => {
    const result = checkInputFields(fields, {
      topics: ['mål', 'lønn'],
      year: 'i fjor',
      due: '2026-02-30',
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: 'ministry', message: '«Departement» må fylles ut.' },
        { path: 'topics', message: '«Tema» har ukjente valg: lønn. Gyldige valg: mål, budsjett.' },
        { path: 'year', message: '«År» må være et årstall, for eksempel 2025.' },
        { path: 'due', message: '«Frist» må være en dato på formen ÅÅÅÅ-MM-DD.' },
      ],
    });
  });

  it('refuses a choice outside the options', () => {
    expect(checkInputFields(fields, { ministry: 'FIN' })).toEqual({
      ok: false,
      errors: [{ path: 'ministry', message: '«Departement» må være ett av valgene: KD, DFD.' }],
    });
  });

  it('renders the values as labelled lines before the question', () => {
    expect(
      fieldsQuery(fields, { ministry: 'DFD', topics: ['mål', 'budsjett'] }, 'Hva er status?'),
    ).toBe('Departement: DFD\nTema: mål, budsjett\n\nHva er status?');
  });

  it('describes the fields as a JSON schema with an optional question', () => {
    const schema = inputFieldsSchema(fields.slice(0, 1)) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.required).toEqual(['ministry']);
    expect(schema.properties.ministry).toEqual({
      title: 'Departement',
      type: 'string',
      minLength: 1,
      enum: ['KD', 'DFD'],
    });
    expect(schema.properties.query).toEqual({
      type: 'string',
      description: 'An optional free-text question or remark.',
    });
  });

  it('fills a blank field with its default value and lists the default in the schema', () => {
    const withDefault: InputField[] = [
      { id: 'year', label: 'År', kind: 'year', required: true, default: 2025 },
    ];

    expect(checkInputFields(withDefault, { year: '' })).toEqual({
      ok: true,
      values: { year: 2025 },
    });
    expect(checkInputFields(withDefault, { year: '2024' })).toEqual({
      ok: true,
      values: { year: 2024 },
    });
    expect(
      (inputFieldsSchema(withDefault) as { properties: Record<string, { default?: unknown }> })
        .properties.year?.default,
    ).toBe(2025);
  });
});

describe('plausibleYears', () => {
  it('lists only plausible years, newest first, for a year filter', () => {
    const values = ['2438', '2024', '2035', '2027', '1899', '1900', 'ukjent', '2026', '2019'].map(
      (value, i) => ({ value, count: i + 1 }),
    );
    expect(plausibleYears(values, new Date('2026-10-12')).map((v) => v.value)).toEqual([
      '2027',
      '2026',
      '2024',
      '2019',
      '1900',
    ]);
  });
});
